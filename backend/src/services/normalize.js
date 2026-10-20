// Normalización de valores heterogéneos (otros sistemas, scraping, APIs) a los códigos del schema.

export const stripAccents = (s) =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Clave comparable: sin acentos, minúsculas, sólo [a-z0-9]. */
export const normKey = (s) => stripAccents(s).replace(/[^a-z0-9]+/g, '');

const SYNONYMS = {
  transmission: {
    automatic: ['automatic', 'automatica', 'automatico', 'auto', 'at', 'tiptronic'],
    manual: ['manual', 'estandar', 'standard', 'std', 'mt'],
    cvt: ['cvt', 'continuously variable'],
    dct: ['dct', 'dsg', 'dual-clutch', 'doble embrague'],
  },
  fuel_type: {
    gasoline: ['gasoline', 'gasolina', 'nafta', 'petrol', 'gas'],
    diesel: ['diesel'],
    hybrid: ['hybrid', 'hibrido', 'hev'],
    plug_in_hybrid: ['plug_in_hybrid', 'plug-in', 'phev', 'hibrido enchufable'],
    electric: ['electric', 'electrico', 'bev', 'ev'],
    lpg: ['lpg', 'gas lp', 'glp'],
    cng: ['cng', 'gnv', 'gas natural'],
  },
  drivetrain: {
    fwd: ['fwd', 'front-wheel drive', 'traccion delantera', 'delantera', '4x2', '4 x 2'],
    rwd: ['rwd', 'rear-wheel drive', 'traccion trasera', 'trasera'],
    awd: ['awd', 'all-wheel drive', 'traccion integral', 'integral'],
    '4wd': ['4wd', '4x4', '4 x 4', '4-wheel drive'],
  },
  body_type: {
    sedan: ['sedan', 'saloon'],
    suv: ['suv', 'sport utility', 'camioneta', 'crossover'],
    pickup: ['pickup', 'pick up', 'pick-up'],
    hatchback: ['hatchback', 'hb', 'liftback'],
    coupe: ['coupe'],
    convertible: ['convertible', 'cabrio', 'cabriolet'],
    minivan: ['minivan'],
    van: ['van'],
    wagon: ['wagon', 'vagoneta', 'station wagon'],
    truck: ['truck', 'camion'],
    motorcycle: ['motorcycle', 'motocicleta', 'moto'],
  },
  condition: {
    new: ['new', 'nuevo', '0km', '0 km'],
    certified: ['certified', 'certificado', 'cpo'],
    used: ['used', 'usado', 'seminuevo'],
  },
  title_status: {
    clean: ['clean', 'limpio', 'regular', 'en regla'],
    salvage: ['salvage', 'siniestro', 'perdida total'],
    rebuilt: ['rebuilt', 'reconstruido', 'recuperado'],
    lien: ['lien', 'gravamen', 'adeudo'],
  },
  status: {
    incoming: ['incoming', 'en transito', 'transito', 'comprado', 'por recibir'],
    reconditioning: ['reconditioning', 'preparacion', 'reacondicionamiento', 'taller'],
    available: ['available', 'disponible', 'en venta', 'activo', 'publicado'],
    on_hold: ['on_hold', 'on hold', 'en pausa', 'pausa', 'retenido'],
    reserved: ['reserved', 'apartado', 'reservado'],
    sold: ['sold', 'vendido'],
    delivered: ['delivered', 'entregado'],
    archived: ['archived', 'baja', 'inactivo', 'retirado'],
  },
  odometer_unit: { km: ['km', 'kms', 'kilometros'], mi: ['mi', 'millas', 'miles'] },
  contact_type: { person: ['person', 'persona', 'fisica', 'individual'], company: ['company', 'empresa', 'moral', 'business'] },
};

// Lista plana ordenada por longitud de sinónimo (el más específico gana)
const FLAT = Object.fromEntries(
  Object.entries(SYNONYMS).map(([field, map]) => [
    field,
    Object.entries(map)
      .flatMap(([code, words]) => words.map((w) => [stripAccents(w), code]))
      .sort((a, b) => b[0].length - a[0].length),
  ]),
);

const ALLOWS_OTHER = new Set(['transmission', 'fuel_type', 'drivetrain', 'body_type']);

/** Convierte un valor libre ("Automática", "4x4", "Seminuevo") al código del schema. */
export function normEnum(field, value) {
  if (value == null || value === '') return null;
  const k = stripAccents(value);
  const list = FLAT[field];
  if (!list) return value;
  const exact = list.find(([w]) => w === k);
  if (exact) return exact[1];
  const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
  const partial = list.find(([w]) => w.length > 2 && wordRe(w).test(k));
  if (partial) return partial[1];
  return ALLOWS_OTHER.has(field) ? 'other' : null;
}

/** "$289,000.00" | "289.000" | "45,000 km" -> número */
export function parseNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).replace(/[^\d.,-]/g, '');
  if (!s || s === '-') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // el separador que aparece al final es el decimal
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma > -1 || lastDot > -1) {
    const sep = lastComma > -1 ? ',' : '.';
    const parts = s.split(sep);
    const isThousands = parts.length > 2 || parts[parts.length - 1].length === 3;
    s = isThousands ? parts.join('') : parts.join('.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "2024-03-01" | "01/03/2024" | "1-3-2024" -> "YYYY-MM-DD" */
export function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

export function parseBool(value) {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return null;
  return ['1', 'true', 'si', 'yes', 'y', 'x', 'verdadero'].includes(stripAccents(value));
}

export function normVin(vin) {
  if (vin == null) return vin;
  const v = String(vin).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return v || null;
}

/** "TOYOTA" -> "Toyota", pero respeta "BMW", "CR-V", "RAV4". */
export function cleanName(name) {
  if (name == null) return null;
  const s = String(name).trim().replace(/\s+/g, ' ');
  if (s.length > 3 && s === s.toUpperCase() && /^[A-Z ]+$/.test(s)) {
    return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return s;
}

export function extractYear(text) {
  const m = String(text ?? '').match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  return m ? Number(m[1]) : null;
}
