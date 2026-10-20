// Mapeo automático de un JSON externo a nuestros campos de vehículo.
// 1) findItems: encuentra la lista de vehículos dentro de la respuesta (aunque venga anidada).
// 2) describeFields: aplana cada elemento en rutas ("marca.nombre", "fotos[].url") con ejemplos.
// 3) suggestMapping: elige para cada campo nuestro la ruta más probable, por nombre (es/en)
//    y por el tipo de valor (un VIN, un año, un precio, una lista de URLs de fotos…).
// 4) mapItem: aplica el mapeo y normaliza los valores ("$245,000" -> 245000, "Automática" -> automatic).
import { extractYear, normEnum, normKey, parseNumber } from './normalize.js';

// ---------------------------------------------------------------------
// Campos de interés (los "ideales") con sinónimos y validación del valor
// ---------------------------------------------------------------------
const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
const num = (v) => parseNumber(v);

export const TARGET_FIELDS = [
  { key: 'external_id', label: 'ID en su sistema', required: true,
    names: ['id', '_id', 'uuid', 'codigo', 'clave', 'folio', 'sku', 'stock', 'stocknumber', 'noinventario', 'inventario', 'idvehiculo', 'vehicleid', 'idauto'],
    test: (v) => v != null && v !== '' && typeof v !== 'object' },
  { key: 'make', label: 'Marca', required: true,
    names: ['marca', 'make', 'brand', 'fabricante', 'manufacturer', 'marcanombre', 'brandname', 'makename'],
    test: (v) => typeof v === 'string' && v.length <= 40 && /\p{L}/u.test(v) },
  { key: 'model', label: 'Modelo', required: true,
    names: ['modelo', 'model', 'submarca', 'linea', 'modelname', 'modelonombre'],
    test: (v) => (typeof v === 'string' || typeof v === 'number') && String(v).length <= 60 && !(num(v) >= 1950 && num(v) <= 2100) },
  { key: 'year', label: 'Año', required: true,
    names: ['anio', 'ano', 'year', 'modelyear', 'aniomodelo', 'anomodelo', 'yearmodel'],
    test: (v) => { const n = num(v); return Number.isInteger(n) && n >= 1950 && n <= 2100; } },
  { key: 'version', label: 'Versión',
    names: ['version', 'trim', 'acabado', 'paquete', 'versionnombre', 'submodelo', 'series'],
    test: (v) => typeof v === 'string' && v.length <= 80 },
  { key: 'price', label: 'Precio',
    names: ['precio', 'price', 'precioventa', 'preciolista', 'listprice', 'saleprice', 'precioactual', 'monto', 'importe', 'amount', 'valor'],
    test: (v) => { const n = num(v); return n != null && n >= 1000 && n < 100_000_000; } },
  { key: 'odometer', label: 'Kilometraje',
    names: ['km', 'kms', 'kilometraje', 'kilometros', 'mileage', 'odometro', 'odometer', 'recorrido', 'millaje'],
    test: (v) => { const n = num(v); return n != null && n >= 0 && n < 2_000_000; } },
  { key: 'color', label: 'Color',
    names: ['color', 'colorexterior', 'exteriorcolor', 'colorext', 'colour', 'pintura'],
    test: (v) => typeof v === 'string' && v.length <= 40 },
  { key: 'transmission', label: 'Transmisión',
    names: ['transmision', 'transmission', 'caja', 'tipotransmision', 'gearbox'],
    test: (v) => typeof v === 'string' && normEnum('transmission', v) !== 'other' },
  { key: 'fuel_type', label: 'Combustible',
    names: ['combustible', 'fuel', 'fueltype', 'tipocombustible', 'energia'],
    test: (v) => typeof v === 'string' && normEnum('fuel_type', v) !== 'other' },
  { key: 'vin', label: 'VIN / No. de serie',
    names: ['vin', 'niv', 'numeroserie', 'noserie', 'serie', 'chasis', 'vinnumber'],
    test: (v) => typeof v === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/i.test(v.replace(/[\s-]/g, '')) },
  { key: 'availability', label: 'Disponibilidad',
    names: ['estatus', 'status', 'estado', 'disponibilidad', 'availability', 'situacion', 'disponible', 'vendido', 'sold'],
    test: (v) => typeof v === 'string' || typeof v === 'boolean' },
  { key: 'photos', label: 'Fotos',
    names: ['fotos', 'imagenes', 'images', 'photos', 'gallery', 'galeria', 'pictures', 'media', 'foto', 'imagen', 'image', 'thumbnail'],
    test: (v) => (Array.isArray(v) ? v.some(isUrl) : isUrl(v) && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(v)) },
  { key: 'url', label: 'Enlace al anuncio',
    names: ['url', 'link', 'enlace', 'permalink', 'href', 'detailurl'],
    test: (v) => isUrl(v) && !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(v) },
  { key: 'location_city', label: 'Ciudad',
    names: ['ciudad', 'city', 'ubicacion', 'location', 'municipio', 'sucursal', 'plaza'],
    test: (v) => typeof v === 'string' && v.length <= 60 },
  { key: 'description', label: 'Descripción',
    names: ['descripcion', 'description', 'comentarios', 'observaciones', 'detalle', 'notes'],
    test: (v) => typeof v === 'string' },
];

// ---------------------------------------------------------------------
// Lectura de rutas: "a.b", "fotos[].url", "fotos[0]"
// ---------------------------------------------------------------------
export function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    const part = parts[i];
    if (part.endsWith('[]')) {
      const arr = cur[part.slice(0, -2)];
      if (!Array.isArray(arr)) return undefined;
      const rest = parts.slice(i + 1).join('.');
      return rest ? arr.map((x) => getPath(x, rest)).filter((x) => x != null) : arr;
    }
    cur = cur[part];
  }
  return cur;
}

/** Busca la lista de vehículos: el arreglo de objetos más grande (máx. 4 niveles). */
export function findItems(json) {
  let best = { path: null, items: null };
  const visit = (node, path, depth) => {
    if (depth > 4 || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length > 0 && objs.length >= node.length / 2 && objs.length > (best.items?.length ?? 0)) {
        best = { path, items: objs };
      }
      return;
    }
    for (const [k, v] of Object.entries(node)) visit(v, path ? `${path}.${k}` : k, depth + 1);
  };
  visit(json, '', 0);
  return best;
}

/** Aplana un elemento en rutas con un valor de ejemplo. */
function flatten(item, prefix = '', depth = 0, out = new Map()) {
  for (const [k, v] of Object.entries(item ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) {
      flatten(v, path, depth + 1, out);
    } else if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
      // lista de objetos (p.ej. fotos: [{url}]) -> "fotos[].url"
      for (const [k2, v2] of Object.entries(v[0])) {
        if (typeof v2 !== 'object') out.set(`${path}[].${k2}`, v.map((x) => x?.[k2]).filter((x) => x != null));
      }
    } else {
      out.set(path, v);
    }
  }
  return out;
}

/** Rutas disponibles con ejemplos (de varios elementos). */
export function describeFields(items) {
  const fields = new Map();
  for (const item of items.slice(0, 25)) {
    for (const [path, value] of flatten(item)) {
      const f = fields.get(path) ?? { path, samples: [] };
      if (value != null && value !== '' && f.samples.length < 3) f.samples.push(value);
      fields.set(path, f);
    }
  }
  return [...fields.values()];
}

// ---------------------------------------------------------------------
// Sugerencia de mapeo
// ---------------------------------------------------------------------
// hojas genéricas: "marca.nombre" se califica por "marca", "fotos[].url" por "fotos"
const GENERIC_LEAVES = new Set(['nombre', 'name', 'descripcion', 'label', 'valor', 'value', 'text', 'texto', 'title',
  'titulo', 'url', 'src', 'href']);

function nameScore(field, path) {
  const segs = path.replace(/\[\]/g, '').split('.').map(normKey);
  const leaf = segs[segs.length - 1];
  // "marca.nombre" -> se califica como "marca"
  const meaningful = GENERIC_LEAVES.has(leaf) && segs.length > 1 ? segs[segs.length - 2] : leaf;
  const joined = segs.join('');
  let best = 0;
  for (const n of field.names) {
    if (meaningful === n || joined === n) best = Math.max(best, 100);
    else if (meaningful.startsWith(n) || meaningful.endsWith(n)) best = Math.max(best, 70);
    else if (n.length >= 4 && meaningful.includes(n)) best = Math.max(best, 50);
  }
  return best;
}

function valueScore(field, samples) {
  if (samples.length === 0) return 0;
  const ok = samples.filter((s) => field.test(s)).length;
  return ok / samples.length;
}

/**
 * Devuelve { mapping: {campo: ruta}, confidence: {campo: 0-100} }.
 * Un campo se asigna por nombre (validado con los valores) o, si no hay nombre, sólo por valor.
 */
export function suggestMapping(fields) {
  const candidates = [];
  for (const target of TARGET_FIELDS) {
    for (const f of fields) {
      const byName = nameScore(target, f.path);
      const byValue = valueScore(target, f.samples);
      let score = 0;
      if (byName > 0) score = byName * (0.4 + 0.6 * byValue);          // nombre parecido y valores coherentes
      else if (['vin', 'year', 'photos'].includes(target.key) && byValue === 1) score = 45; // sólo por forma del valor
      if (score >= 30) candidates.push({ key: target.key, path: f.path, score: Math.round(score) });
    }
  }
  // asignación voraz: el par (campo, ruta) más fuerte primero; cada ruta y cada campo una sola vez
  candidates.sort((a, b) => b.score - a.score);
  const mapping = {};
  const confidence = {};
  const usedPaths = new Set();
  for (const c of candidates) {
    if (mapping[c.key] || usedPaths.has(c.path)) continue;
    mapping[c.key] = c.path;
    confidence[c.key] = Math.min(100, c.score);
    usedPaths.add(c.path);
  }
  return { mapping, confidence };
}

// ---------------------------------------------------------------------
// Disponibilidad: sus valores ("DISPONIBLE", "Vendido", true…) -> los nuestros
// ---------------------------------------------------------------------
const PUBLIC_OF_STATUS = { available: 'available', reserved: 'reserved', sold: 'sold', delivered: 'sold' };

export function guessAvailability(value) {
  if (typeof value === 'boolean') return value ? 'available' : 'unavailable';
  const s = String(value ?? '').trim();
  if (!s) return 'available';
  if (/^(true|si|sí|1|activo|active|publicado|en venta|for sale|in stock)$/i.test(s)) return 'available';
  return PUBLIC_OF_STATUS[normEnum('status', s)] ?? 'unavailable';
}

export function suggestAvailabilityMap(items, path) {
  if (!path) return {};
  const values = [...new Set(items.map((i) => getPath(i, path)).filter((v) => v != null).map(String))].slice(0, 20);
  return Object.fromEntries(values.map((v) => [v, guessAvailability(v)]));
}

// ---------------------------------------------------------------------
// Aplicar el mapeo a un elemento
// ---------------------------------------------------------------------
const first = (v) => (Array.isArray(v) ? v[0] : v);

// colores en inglés -> español (el resto se deja como viene)
const COLORS = {
  white: 'Blanco', black: 'Negro', gray: 'Gris', grey: 'Gris', silver: 'Plata', red: 'Rojo', blue: 'Azul',
  green: 'Verde', yellow: 'Amarillo', orange: 'Naranja', brown: 'Café', beige: 'Beige', gold: 'Dorado',
  purple: 'Morado', wine: 'Vino', burgundy: 'Vino',
};
const toSpanishColor = (c) => (c == null ? c : COLORS[normKey(c)] ?? String(c).trim());

export function mapItem(item, mapping, availabilityMap = {}) {
  const raw = Object.fromEntries(Object.entries(mapping).filter(([, p]) => p).map(([k, p]) => [k, getPath(item, p)]));
  const photos = raw.photos == null ? undefined : [].concat(raw.photos).filter(isUrl);
  const availabilityRaw = first(raw.availability);
  const title = [first(raw.make), first(raw.model), first(raw.year)].filter(Boolean).join(' ');
  return {
    external_id: raw.external_id != null ? String(first(raw.external_id)) : undefined,
    make: first(raw.make) != null ? String(first(raw.make)).trim() : undefined,
    model: first(raw.model) != null ? String(first(raw.model)).trim() : undefined,
    year: num(first(raw.year)) ?? extractYear(title),
    version: first(raw.version) ?? undefined,
    price: num(first(raw.price)) ?? undefined,
    odometer: num(first(raw.odometer)) ?? undefined,
    color: toSpanishColor(first(raw.color)) ?? undefined,
    transmission: first(raw.transmission) ?? undefined,
    fuel_type: first(raw.fuel_type) ?? undefined,
    vin: first(raw.vin) ?? undefined,
    availability: availabilityRaw == null
      ? 'available'
      : (availabilityMap[String(availabilityRaw)] ?? guessAvailability(availabilityRaw)),
    photos,
    url: first(raw.url) ?? undefined,
    location_city: first(raw.location_city) ?? undefined,
    description: first(raw.description) ?? undefined,
  };
}

/** Faltantes que impiden empatar el registro (para anuncios también se exige el precio). */
export function missingRequired(mapped, destination = 'partner') {
  const keys = ['external_id', 'make', 'model', 'year', ...(destination === 'listings' ? ['price'] : [])];
  return keys.filter((k) => mapped[k] == null || mapped[k] === '');
}
