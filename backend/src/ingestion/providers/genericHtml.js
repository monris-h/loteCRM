// Scraper de sitios de agencias / concesionarias (configurable, sin código nuevo por sitio).
//
// Dos modos para leer el listado:
//   "css"    → selectores CSS por campo (cualquier sitio).
//   "jsonld" → datos estructurados schema.org (Car / Vehicle / Product) que traen muchos
//              sitios de agencias; no requiere configurar selectores.
// Opcional "detail": entra a la ficha de cada auto para completar color, transmisión, etc.
// leyendo líneas "Etiqueta: valor" (p.ej. "Color exterior: Negro").
//
// Buenas prácticas incluidas: respeta robots.txt y su Crawl-delay, pausa entre peticiones,
// se identifica con SCRAPER_USER_AGENT y se detiene ante 403/429.
// Revisa los términos de uso del sitio antes de habilitar una fuente.
//
// Ejemplo de config (modo css):
// {
//   "mode": "css",
//   "start_urls": ["https://sitio-agencia.mx/seminuevos?page={page}"],
//   "max_pages": 2,
//   "item_selector": ".auto",
//   "fields": {
//     "external_id": { "selector": "a", "attr": "href", "regex": "/(\\d+)$" },
//     "url": { "selector": "a", "attr": "href" },
//     "make": { "selector": ".marca" }, "model": { "selector": ".modelo" }, "year": { "selector": ".anio" },
//     "odometer": { "selector": ".km" }, "price": { "selector": ".precio" }, "location": { "selector": ".ciudad" },
//     "exterior_color": { "selector": ".color" }
//   },
//   "detail": { "labels": { "exterior_color": ["Color exterior", "Color"], "transmission": ["Transmisión"] } },
//   "delay_ms": 3000
// }
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { config as appConfig } from '../../config.js';
import { query } from '../../db.js';
import { extractYear, normEnum, parseNumber } from '../../services/normalize.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// robots.txt (comodines * y $)
// ---------------------------------------------------------------------
const robotsCache = new Map();

function patternToRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function parseRobots(text, userAgent) {
  const ua = userAgent.split('/')[0].toLowerCase();
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [], crawlDelay: 0 }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if ((key === 'allow' || key === 'disallow') && value) {
      current.rules.push({ allow: key === 'allow', pattern: value, re: patternToRegex(value) });
    } else if (key === 'crawl-delay') {
      current.crawlDelay = (Number(value) || 0) * 1000;
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return { rules: chosen.flatMap((g) => g.rules), crawlDelay: Math.max(0, ...chosen.map((g) => g.crawlDelay)) };
}

export function isAllowed(robots, pathAndQuery) {
  let best = null;
  for (const r of robots.rules) {
    if (!r.re.test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

async function robotsFor(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let robots = { rules: [], crawlDelay: 0 };
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': appConfig.scraperUserAgent }, signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) robots = parseRobots(await res.text(), appConfig.scraperUserAgent);
  } catch {
    // sin robots.txt accesible: se asume permitido
  }
  robotsCache.set(origin, robots);
  return robots;
}

// ---------------------------------------------------------------------
// Descarga "educada": robots + pausa + alto ante bloqueo
// ---------------------------------------------------------------------
class Politeness {
  constructor(ctx, delayMs, respectRobots) {
    this.ctx = ctx;
    this.delayMs = delayMs;
    this.respectRobots = respectRobots;
    this.requests = 0;
    this.stopped = false;
  }

  async fetchHtml(url) {
    if (this.stopped) return null;
    const target = new URL(url);
    const robots = await robotsFor(target.origin);
    if (this.respectRobots && !isAllowed(robots, target.pathname + target.search)) {
      this.ctx.log(`robots.txt no permite ${target.pathname}${target.search}; se omite`, 'warn');
      return null;
    }
    if (this.requests > 0) await sleep(Math.max(this.delayMs, robots.crawlDelay));
    this.requests += 1;
    const res = await fetch(target, {
      headers: { 'User-Agent': appConfig.scraperUserAgent, Accept: 'text/html', 'Accept-Language': 'es-MX,es' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 403 || res.status === 429) {
      this.ctx.log(`${target.href} respondió ${res.status}; se detiene la fuente para no saturar el sitio`, 'warn');
      this.stopped = true;
      return null;
    }
    if (!res.ok) {
      this.ctx.log(`${target.href} respondió ${res.status}`, 'warn');
      return null;
    }
    return { $: cheerio.load(await res.text()), url: target.href };
  }
}

// ---------------------------------------------------------------------
// Extracción
// ---------------------------------------------------------------------
function extractCss($, el, spec, baseUrl) {
  if (!spec) return null;
  const node = spec.selector === ':self' ? $(el) : $(el).find(spec.selector).first();
  if (!node.length) return null;
  let value = spec.attr ? node.attr(spec.attr) : node.text();
  value = value?.replace(/\s+/g, ' ').trim() || null;
  if (value && spec.regex) {
    value = value.match(new RegExp(spec.regex))?.[1]?.trim() ?? null;
  } else if (value && (spec.attr === 'href' || spec.attr === 'src')) {
    try { value = new URL(value, baseUrl).href; } catch { /* valor inválido */ }
  }
  return value;
}

function itemsFromCss($, c, pageUrl) {
  return $(c.item_selector).toArray().map((el) => Object.fromEntries(
    Object.entries(c.fields).map(([k, spec]) => [k, extractCss($, el, spec, pageUrl)])));
}

// schema.org: Car / Vehicle / Product (con o sin @graph / ItemList)
const VEHICLE_TYPES = new Set(['car', 'vehicle', 'motorizedbicycle', 'product', 'individualproduct']);
const str = (v) => (v == null ? null : typeof v === 'object' ? (v.name ?? v['@value'] ?? null) : String(v));

function* walkJsonLd(node) {
  if (Array.isArray(node)) { for (const n of node) yield* walkJsonLd(n); return; }
  if (!node || typeof node !== 'object') return;
  const types = [].concat(node['@type'] ?? []).map((t) => String(t).toLowerCase());
  if (types.some((t) => VEHICLE_TYPES.has(t)) && (node.offers || node.brand || node.vehicleModelDate || node.mileageFromOdometer)) {
    yield node;
    return;
  }
  for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity']) if (node[key]) yield* walkJsonLd(node[key]);
}

function itemsFromJsonLd($, pageUrl) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, s) => {
    let data;
    try { data = JSON.parse($(s).html()); } catch { return; }
    for (const v of walkJsonLd(data)) {
      const offer = [].concat(v.offers ?? [])[0] ?? {};
      const url = v.url ?? offer.url ?? null;
      out.push({
        external_id: str(v.vehicleIdentificationNumber) ?? str(v.sku) ?? str(v.productID) ?? url,
        url: url ? new URL(url, pageUrl).href : null,
        title: str(v.name),
        make: str(v.brand) ?? str(v.manufacturer),
        model: str(v.model),
        year: str(v.vehicleModelDate) ?? str(v.modelDate) ?? str(v.productionDate),
        trim: str(v.vehicleConfiguration),
        odometer: str(v.mileageFromOdometer?.value ?? v.mileageFromOdometer),
        price: str(offer.price ?? offer.lowPrice),
        currency: str(offer.priceCurrency),
        exterior_color: str(v.color),
        transmission: str(v.vehicleTransmission),
        fuel_type: str(v.fuelType),
        drivetrain: str(v.driveWheelConfiguration),
        doors: str(v.numberOfDoors),
        vin: str(v.vehicleIdentificationNumber),
        seller: str(offer.seller),
        location: str(offer.availableAtOrFrom?.address?.addressLocality ?? v.availableAtOrFrom?.address?.addressLocality),
      });
    }
  });
  return out;
}

/**
 * Lee las especificaciones de la ficha del auto buscando cada etiqueta:
 *  1) como elemento suelto ("Color") cuyo valor está en el elemento siguiente (tablas / cuadrículas);
 *  2) como línea de texto "Color exterior: Negro".
 */
function readLabels($, detail) {
  const leaves = new Map(); // etiqueta -> todos los elementos con ese texto
  $('body *').each((_, el) => {
    const node = $(el);
    if (node.children().length > 0) return;
    const t = node.text().trim().replace(/:$/, '').toLowerCase();
    if (t.length >= 2 && t.length <= 40) leaves.set(t, [...(leaves.get(t) ?? []), node]);
  });
  const lines = new Map();
  for (const line of $(detail.text_selector ?? 'body').text().split(/\r?\n/)) {
    const m = line.trim().match(/^([^:]{2,40}):\s*(.{1,80})$/);
    if (m) lines.set(m[1].trim().toLowerCase(), m[2].trim());
  }
  const clean = (v) => v?.replace(/\s+/g, ' ').trim().slice(0, 80) || null;

  const found = {};
  for (const [field, labels] of Object.entries(detail.labels ?? {})) {
    for (const label of labels) {
      const key = label.toLowerCase();
      let v = null;
      for (const el of leaves.get(key) ?? []) {
        v = clean(el.next().text()) ?? clean(el.parent().next().text());
        if (v) break;
      }
      if (v || lines.get(key)) { found[field] = v ?? lines.get(key); break; }
    }
  }
  // respaldo: primera línea de un bloque de texto (p.ej. "Mazda CX-50 2024 5p Signature L4/2.5 Aut.")
  const fl = detail.first_line;
  if (fl?.field && !found[fl.field]) {
    const first = $(fl.selector).first().text().split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.includes(':'));
    if (first) found[fl.field] = clean(first);
  }
  return found;
}

const titleCase = (s) => (s ? s.toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()) : s);

function toListing(f, c) {
  const title = f.title ?? [f.make, f.model, f.year].filter(Boolean).join(' ');
  const price = parseNumber(f.price);
  if (!title || !price) return null;
  let trim = f.trim ?? null;
  if (trim) {
    // "Mazda CX-50 2024 5p Signature" → "5p Signature"
    for (const w of [f.make, f.model, f.year]) {
      if (w) trim = trim.replace(new RegExp(`(^|\\s)${String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'gi'), ' ');
    }
    trim = trim.replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.)]+$/gu, '').trim().slice(0, 80);
    if (trim.replace(/[^\p{L}\p{N}]/gu, '').length < 2) trim = null;
  }
  return {
    external_id: f.external_id ?? f.url ?? createHash('sha1').update(`${title}|${price}|${f.odometer}`).digest('hex'),
    url: f.url,
    title,
    make: f.make,
    model: f.model,
    trim,
    year: parseNumber(f.year) ?? extractYear(title),
    odometer: parseNumber(f.odometer),
    odometer_unit: /\bmi(les|llas)?\b/i.test(f.odometer ?? '') ? 'mi' : 'km',
    price,
    currency: (f.currency ?? c.currency ?? 'MXN').toUpperCase().slice(0, 3),
    location_city: f.location,
    seller_name: f.seller,
    seller_type: c.seller_type ?? 'dealer',
    exterior_color: titleCase(f.exterior_color),
    transmission: f.transmission ? normEnum('transmission', f.transmission) : null,
    fuel_type: f.fuel_type ? normEnum('fuel_type', f.fuel_type) : null,
    drivetrain: f.drivetrain ? normEnum('drivetrain', f.drivetrain) : null,
    doors: parseNumber(f.doors),
    raw: { vin: f.vin ?? undefined },
  };
}

// ---------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------
export async function run(ctx) {
  const c = ctx.config;
  const mode = c.mode ?? (c.item_selector ? 'css' : 'jsonld');
  if (!c.start_urls?.length) throw new Error('Configura start_urls');
  if (mode === 'css' && (!c.item_selector || !c.fields)) throw new Error('El modo css requiere item_selector y fields');

  const web = new Politeness(ctx, c.delay_ms ?? 3000, c.respect_robots !== false);
  const detail = c.detail;
  let detailBudget = detail?.max_items ?? 150;

  for (const start of c.start_urls) {
    const templated = start.includes('{page}');
    const seen = new Set();
    for (let page = 1; page <= (templated ? c.max_pages ?? 1 : 1); page++) {
      const doc = await web.fetchHtml(templated ? start.replace('{page}', String(page)) : start);
      if (!doc) break;
      const raw = mode === 'jsonld' ? itemsFromJsonLd(doc.$, doc.url) : itemsFromCss(doc.$, c, doc.url);
      let fresh = 0;

      for (const f of raw) {
        // Segunda pasada: ficha del auto (sólo si aún no tenemos el color guardado)
        if (detail && f.url && detailBudget > 0 && !f.exterior_color) {
          const ext = f.external_id ?? f.url;
          const { rows } = await query(
            'SELECT 1 FROM market_listings WHERE source_id = $1 AND external_id = $2 AND exterior_color IS NOT NULL',
            [ctx.source.id, String(ext)]);
          if (rows.length === 0) {
            detailBudget -= 1;
            const page2 = await web.fetchHtml(f.url);
            if (page2) Object.assign(f, Object.fromEntries(Object.entries(readLabels(page2.$, detail)).filter(([k]) => !f[k])));
          }
        }
        const listing = toListing(f, c);
        if (!listing || seen.has(listing.external_id)) continue;
        seen.add(listing.external_id);
        fresh += 1;
        await ctx.saveListing(listing);
      }
      ctx.log(`${doc.url}: ${raw.length} elementos, ${fresh} anuncios`);
      if (fresh === 0 || web.stopped) break;
    }
    if (web.stopped) break;
  }
  if (web.requests === 0) throw new Error('No se pudo descargar ninguna página (revisa URLs o robots.txt)');
}
