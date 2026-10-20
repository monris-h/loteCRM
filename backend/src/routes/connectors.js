// Conectar un endpoint externo: vista previa con mapeo automático, y guardar/importar.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, parse } from '../http.js';
import { fetchJson } from '../ingestion/providers/externalApi.js';
import { runSourceNow } from '../ingestion/runner.js';
import {
  TARGET_FIELDS, describeFields, findItems, getPath, mapItem, missingRequired, suggestAvailabilityMap, suggestMapping,
} from '../services/autoMap.js';

const r = Router();

const configSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
  items_path: z.string().nullable().optional(),       // si no se indica, se detecta
  mapping: z.record(z.string().nullable()).optional(), // si no se indica, se sugiere
  availability_map: z.record(z.enum(['available', 'reserved', 'sold', 'unavailable'])).optional(),
  destination: z.enum(['partner', 'listings']).default('partner'),
  partner_code: z.string().optional(),
  max_pages: z.coerce.number().int().min(1).max(100).optional(),
  archive_missing: z.boolean().optional(),
});

r.get('/fields', (req, res) => {
  res.json(TARGET_FIELDS.map(({ key, label, required }) => ({ key, label, required: Boolean(required) })));
});

/** Consulta el endpoint y devuelve la estructura detectada, el mapeo sugerido y una vista previa. */
r.post('/preview', async (req, res) => {
  const c = parse(configSchema, req.body);
  let json;
  try {
    json = await fetchJson(c.url.replace('{page}', '1'), c.headers);
  } catch (err) {
    throw new HttpError(422, `No se pudo leer el endpoint: ${err.message}`, undefined, 'fetch_failed');
  }

  let itemsPath = c.items_path ?? null;
  let items;
  if (itemsPath != null) {
    items = getPath(json, itemsPath);
    if (!Array.isArray(items)) throw new HttpError(422, `"${itemsPath}" no es una lista en la respuesta`);
  } else {
    const found = findItems(json);
    if (!found.items) throw new HttpError(422, 'No se encontró ninguna lista de elementos en la respuesta', undefined, 'no_items');
    itemsPath = found.path;
    items = found.items;
  }

  const fields = describeFields(items);
  const suggested = suggestMapping(fields);
  const mapping = c.mapping ?? suggested.mapping;
  const availabilityMap = c.availability_map ?? suggestAvailabilityMap(items, mapping.availability);
  const mapped = items.map((it) => mapItem(it, mapping, availabilityMap));
  const usable = mapped.filter((m) => missingRequired(m, c.destination).length === 0).length;

  res.json({
    items_path: itemsPath,
    total_items: items.length,
    usable_items: usable,
    fields,
    mapping,
    confidence: suggested.confidence,
    availability_map: availabilityMap,
    preview: mapped.slice(0, 8).map((m) => ({ ...m, missing: missingRequired(m, c.destination) })),
    sample_raw: items[0],
  });
});

/** Guarda la conexión como fuente de datos y la ejecuta. */
r.post('/', async (req, res) => {
  const d = parse(configSchema.extend({
    name: z.string().trim().min(1),
    code: z.string().regex(/^[a-z0-9_]{2,40}$/, 'Código: minúsculas, números y _'),
  }), req.body);
  if (!d.mapping || d.items_path == null) throw new HttpError(400, 'Primero prueba la conexión para obtener el mapeo');
  for (const k of ['external_id', 'make', 'model', 'year']) {
    if (!d.mapping[k]) throw new HttpError(400, `Falta mapear el campo obligatorio "${TARGET_FIELDS.find((f) => f.key === k).label}"`);
  }
  if (d.destination === 'partner') {
    const { rows } = await query('SELECT can_publish_inventory FROM partners WHERE code = $1', [d.partner_code ?? '']);
    if (!rows[0]) throw new HttpError(400, 'Elige el socio dueño de esos vehículos');
    if (!rows[0].can_publish_inventory) throw new HttpError(400, 'Ese socio no tiene permiso para publicar inventario');
  }
  const { name, code, ...config } = d;
  const mapping = Object.fromEntries(Object.entries(config.mapping).filter(([, v]) => v));
  const { rows: [source] } = await query(
    `INSERT INTO data_sources (code, name, kind, provider, config, is_enabled)
     VALUES ($1, $2, 'api', 'external_api', $3, true)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config, is_enabled = true
     RETURNING *`, [code, name, JSON.stringify({ ...config, mapping })]);
  const run = await runSourceNow(source.id);
  res.status(201).json({ source_id: source.id, run });
});

export default r;
