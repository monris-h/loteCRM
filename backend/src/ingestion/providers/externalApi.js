// Conector a un endpoint JSON externo (p.ej. la API de un socio o de una agencia).
// Lee la lista de vehículos, aplica el mapeo de campos y la empata en nuestra BD:
//   destination "partner"  -> inventario del socio (vehículos marcados como "Socio")
//   destination "listings" -> autos encontrados (para agregarlos después al inventario)
//
// config:
// {
//   "url": "https://api.socio.mx/autos?page={page}",   // {page} opcional para paginar
//   "headers": { "Authorization": "Bearer ..." },
//   "items_path": "data.autos",
//   "mapping": { "external_id": "id", "make": "marca.nombre", "price": "precio_venta", ... },
//   "availability_map": { "DISPONIBLE": "available", "VENDIDO": "sold" },
//   "destination": "partner", "partner_code": "autos_norte",
//   "max_pages": 20, "archive_missing": false
// }
import { query, withTransaction } from '../../db.js';
import { getPath, mapItem, missingRequired } from '../../services/autoMap.js';
import { normEnum } from '../../services/normalize.js';
import { archivePartnerVehicle, upsertPartnerVehicle } from '../../services/partners.js';

export const producesListings = true;

const MAX_BYTES = 10 * 1024 * 1024;

/** Descarga y parsea JSON de un endpoint externo (con límite de tamaño y tiempo). */
export async function fetchJson(url, headers = {}) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Sólo se permiten URLs http(s)');
  const res = await fetch(target, {
    headers: { Accept: 'application/json', 'User-Agent': 'LotesCRM/1.0', ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('La respuesta es demasiado grande (más de 10 MB)');
  if (!res.ok) throw new Error(`El endpoint respondió ${res.status}: ${text.slice(0, 150)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('La respuesta no es JSON válido');
  }
}

export async function run(ctx) {
  const c = ctx.config;
  if (!c.url || !c.mapping) throw new Error('Configura url y mapping');
  const destination = c.destination ?? 'partner';

  let partner = null;
  if (destination === 'partner') {
    const { rows } = await query('SELECT * FROM partners WHERE code = $1 AND is_active', [c.partner_code]);
    partner = rows[0];
    if (!partner) throw new Error(`No existe un socio activo con código "${c.partner_code}"`);
  }

  const templated = c.url.includes('{page}');
  const seen = new Set();
  for (let page = 1; page <= (templated ? c.max_pages ?? 20 : 1); page++) {
    const url = c.url.replace('{page}', String(page));
    const items = getPath(await fetchJson(url, c.headers), c.items_path) ?? [];
    if (!Array.isArray(items)) throw new Error(`"${c.items_path}" no es una lista en la respuesta`);
    ctx.log(`${url}: ${items.length} vehículos`);
    if (items.length === 0) break;

    for (const item of items) {
      const v = mapItem(item, c.mapping, c.availability_map);
      const missing = missingRequired(v, destination);
      if (missing.length) {
        ctx.stats.items_found += 1;
        ctx.stats.items_failed += 1;
        ctx.log(`Elemento ${v.external_id ?? '?'} omitido: falta ${missing.join(', ')}`, 'warn');
        continue;
      }
      if (seen.has(v.external_id)) continue;
      seen.add(v.external_id);

      if (destination === 'listings') {
        await ctx.saveListing({
          external_id: v.external_id, url: v.url, title: [v.make, v.model, v.year].join(' '),
          make: v.make, model: v.model, year: v.year, trim: v.version, odometer: v.odometer, price: v.price,
          exterior_color: v.color, location_city: v.location_city,
          transmission: v.transmission ? normEnum('transmission', v.transmission) : null,
          fuel_type: v.fuel_type ? normEnum('fuel_type', v.fuel_type) : null,
          raw: { vin: v.vin, photos: v.photos },
        });
        continue;
      }
      ctx.stats.items_found += 1;
      try {
        const r = await withTransaction((client) => upsertPartnerVehicle(client, partner, v), { note: `Sincronizado de ${partner.name}` });
        ctx.stats[r.action === 'created' ? 'items_inserted' : 'items_updated'] += 1;
      } catch (err) {
        ctx.stats.items_failed += 1;
        ctx.log(`Vehículo ${v.external_id}: ${err.message}`, 'error');
      }
    }
    if (!templated) break;
  }

  // Lo que ya no viene en su lista se retira (sólo si se pidió y la lectura fue completa)
  if (destination === 'partner' && c.archive_missing && seen.size > 0) {
    const { rows } = await query(
      `SELECT r.external_id FROM external_refs r JOIN vehicles v ON v.id = r.entity_id
       WHERE r.system = $1 AND r.entity_type = 'vehicle' AND v.status NOT IN ('sold','delivered','archived')`,
      [`partner:${partner.code}`]);
    let archived = 0;
    for (const { external_id: ext } of rows) {
      if (seen.has(ext)) continue;
      await withTransaction((client) => archivePartnerVehicle(client, partner, ext)).then(() => { archived += 1; }).catch(() => {});
    }
    if (archived) ctx.log(`${archived} vehículos ya no aparecen en su lista: retirados`);
  }
}
