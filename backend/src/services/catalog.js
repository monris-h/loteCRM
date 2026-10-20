import { HttpError } from '../http.js';
import { query } from '../db.js';
import { cleanName, normKey } from './normalize.js';

const MAKE_ALIASES = { vw: 'volkswagen', chevy: 'chevrolet', mercedes: 'mercedesbenz', benz: 'mercedesbenz' };

/** Busca (o crea) marca y modelo por nombre. Devuelve { make_id, model_id, created }. */
export async function resolveMakeModel(client, makeName, modelName, { create = true } = {}) {
  const make = cleanName(makeName);
  const model = cleanName(modelName);
  if (!make || !model) throw new HttpError(400, 'Marca y modelo son obligatorios');

  let { rows } = await client.query('SELECT id FROM makes WHERE name = $1', [make]);
  let makeId = rows[0]?.id;
  if (!makeId) {
    if (!create) return null;
    ({ rows } = await client.query(
      `INSERT INTO makes (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = makes.name RETURNING id`, [make]));
    makeId = rows[0].id;
    invalidateCatalogCache();
  }

  ({ rows } = await client.query('SELECT id FROM models WHERE make_id = $1 AND name = $2', [makeId, model]));
  let modelId = rows[0]?.id;
  let created = false;
  if (!modelId) {
    if (!create) return null;
    ({ rows } = await client.query(
      `INSERT INTO models (make_id, name) VALUES ($1, $2)
       ON CONFLICT (make_id, name) DO UPDATE SET name = models.name RETURNING id, (xmax = 0) AS inserted`,
      [makeId, model]));
    modelId = rows[0].id;
    created = rows[0].inserted;
    invalidateCatalogCache();
  }
  return { make_id: makeId, model_id: modelId, created };
}

// ---- Coincidencia de marca/modelo en texto libre (títulos de anuncios) ----
let cache = null;
let cacheAt = 0;

export function invalidateCatalogCache() {
  cache = null;
}

async function loadCatalog() {
  if (cache && Date.now() - cacheAt < 5 * 60_000) return cache;
  const { rows } = await query(`
    SELECT mk.id AS make_id, mk.name::text AS make, md.id AS model_id, md.name::text AS model
    FROM makes mk LEFT JOIN models md ON md.make_id = mk.id`);
  const byMake = new Map();
  for (const r of rows) {
    if (!byMake.has(r.make_id)) byMake.set(r.make_id, { id: r.make_id, name: r.make, key: normKey(r.make), models: [] });
    if (r.model_id) byMake.get(r.make_id).models.push({ id: r.model_id, name: r.model, key: normKey(r.model) });
  }
  for (const m of byMake.values()) m.models.sort((a, b) => b.key.length - a.key.length);
  cache = [...byMake.values()].sort((a, b) => b.key.length - a.key.length);
  cacheAt = Date.now();
  return cache;
}

/** "Toyota Corolla LE 2021 automático" -> { make_id, model_id, make, model } (o null) */
export async function matchMakeModel(text) {
  const catalog = await loadCatalog();
  const words = String(text ?? '').split(/[\s/,|()-]+/).map(normKey).filter(Boolean);
  const joined = words.join(' ');
  const expanded = words.map((w) => MAKE_ALIASES[w] ?? w);

  const make = catalog.find((m) => expanded.includes(m.key) || joined.replace(/ /g, '').startsWith(m.key));
  if (!make) return null;
  const compact = expanded.join('');
  const model = make.models.find((md) => expanded.includes(md.key) || compact.includes(md.key));
  return {
    make_id: make.id,
    make: make.name,
    model_id: model?.id ?? null,
    model: model?.name ?? null,
  };
}
