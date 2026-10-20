import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { HttpError, notFound, pageParams, parse } from '../http.js';
import { PROVIDERS, startRun } from '../ingestion/runner.js';
import * as inv from '../services/inventory.js';
import { ENTITIES, readRows, runImport, suggestMapping } from '../services/importer.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ---------------- Fuentes de datos ----------------
r.get('/sources', async (req, res) => {
  const { rows } = await query(`
    SELECT s.*,
           (SELECT count(*) FROM market_listings l WHERE l.source_id = s.id AND l.is_active) AS active_listings,
           (SELECT row_to_json(x) FROM (
              SELECT id, status, started_at, finished_at, items_found, items_inserted, items_updated, items_failed, error_message
              FROM ingestion_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1) x) AS last_run
    FROM data_sources s ORDER BY s.kind, s.name`);
  res.json({ sources: rows, providers: Object.keys(PROVIDERS) });
});

const sourceSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]+$/).optional(),
  name: z.string().min(1).optional(),
  kind: z.enum(['api', 'scraper', 'file', 'manual']).optional(),
  provider: z.string().optional(),
  config: z.record(z.any()).optional(),
  is_enabled: z.boolean().optional(),
});

r.post('/sources', async (req, res) => {
  const d = parse(sourceSchema.required({ code: true, name: true, kind: true, provider: true }), req.body);
  if (!PROVIDERS[d.provider]) throw new HttpError(400, `Proveedor desconocido. Opciones: ${Object.keys(PROVIDERS).join(', ')}`);
  const { rows } = await query(
    `INSERT INTO data_sources (code, name, kind, provider, config, is_enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [d.code, d.name, d.kind, d.provider, JSON.stringify(d.config ?? {}), d.is_enabled ?? false]);
  res.status(201).json(rows[0]);
});

r.patch('/sources/:id', async (req, res) => {
  const d = parse(sourceSchema, req.body);
  const { rows } = await query(
    `UPDATE data_sources SET name = coalesce($2, name), config = coalesce($3, config),
       is_enabled = coalesce($4, is_enabled) WHERE id = $1 RETURNING *`,
    [req.params.id, d.name ?? null, d.config ? JSON.stringify(d.config) : null, d.is_enabled ?? null]);
  if (!rows[0]) throw notFound('Fuente');
  res.json(rows[0]);
});

r.post('/sources/:id/run', async (req, res) => {
  res.status(202).json(await startRun(req.params.id));
});

r.get('/runs', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.source_id) { params.push(req.query.source_id); where = 'WHERE r.source_id = $1'; }
  const { rows } = await query(`
    SELECT r.id, r.source_id, s.name AS source_name, r.status, r.started_at, r.finished_at,
           r.items_found, r.items_inserted, r.items_updated, r.items_failed, r.error_message
    FROM ingestion_runs r JOIN data_sources s ON s.id = r.source_id ${where}
    ORDER BY r.started_at DESC LIMIT 50`, params);
  res.json(rows);
});

r.get('/runs/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM ingestion_runs WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw notFound('Corrida');
  res.json(rows[0]);
});

// ---------------- Anuncios de mercado ----------------
r.get('/listings', async (req, res) => {
  const { limit, offset } = pageParams(req.query);
  const where = ['l.is_active'];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (req.query.q) add("(l.title ILIKE ? OR coalesce(l.make_raw,'') ILIKE ? OR coalesce(l.model_raw,'') ILIKE ?)", `%${req.query.q}%`);
  if (req.query.source_id) add('l.source_id = ?', req.query.source_id);
  if (req.query.make_id) add('l.make_id = ?', req.query.make_id);
  if (req.query.unmatched === 'true') where.push('l.model_id IS NULL');
  if (req.query.in_inventory === 'false') where.push('l.vehicle_id IS NULL');
  const { rows } = await query(`
    SELECT l.id, l.title, l.url, l.year, l.trim, l.odometer, l.odometer_unit, l.price, l.currency, l.location_city,
           l.location_state, l.seller_type, l.seller_name, l.exterior_color, l.transmission, l.fuel_type,
           l.drivetrain, l.doors, l.vehicle_id, l.first_seen_at, l.last_seen_at,
           mk.name::text AS make, md.name::text AS model, s.name AS source_name,
           count(*) OVER () AS total_count
    FROM market_listings l
    JOIN data_sources s ON s.id = l.source_id
    LEFT JOIN makes mk ON mk.id = l.make_id
    LEFT JOIN models md ON md.id = l.model_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.last_seen_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ items: rows.map(({ total_count, ...x }) => x), total: rows[0]?.total_count ?? 0 });
});

// ---------------- De anuncio encontrado a inventario ----------------
// Crea vehículos "en tránsito" con los datos del anuncio (marca, modelo, año, versión, color, km,
// transmisión, combustible, precio). El precio del anuncio se usa como precio de lista sugerido.
r.post('/listings/to-inventory', async (req, res) => {
  const d = parse(z.object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    lot_id: z.string().uuid().nullable().optional(),
    use_price_as: z.enum(['list_price', 'acquisition_cost']).default('list_price'),
  }), req.body);

  const created = [];
  const skipped = [];
  for (const id of d.ids) {
    try {
      const vehicle = await withTransaction(async (c) => {
        const { rows: [l] } = await c.query('SELECT * FROM market_listings WHERE id = $1 FOR UPDATE', [id]);
        if (!l) throw new Error('Anuncio no encontrado');
        if (l.vehicle_id) throw new Error('Ya está en el inventario');
        if (!l.make_id || !l.model_id || !l.year) throw new Error('Faltan marca, modelo o año');
        const v = await inv.createVehicle(c, {
          make_id: l.make_id, model_id: l.model_id, year: l.year, trim: l.trim,
          exterior_color: l.exterior_color, odometer: l.odometer, odometer_unit: l.odometer_unit,
          transmission: l.transmission, fuel_type: l.fuel_type, drivetrain: l.drivetrain, doors: l.doors,
          lot_id: d.lot_id ?? undefined,
          status: 'incoming',
          acquisition_source: 'other',
          [d.use_price_as]: l.price,
          attributes: { origen: 'ingesta', anuncio_url: l.url, vendedor: l.seller_name, ciudad: l.location_city },
        });
        await c.query('UPDATE market_listings SET vehicle_id = $2 WHERE id = $1', [id, v.id]);
        return v;
      }, { note: 'Agregado desde un anuncio encontrado' });
      created.push({ listing_id: id, vehicle_id: vehicle.id, stock_number: vehicle.stock_number });
    } catch (err) {
      skipped.push({ listing_id: id, error: err.message });
    }
  }
  res.json({ created, skipped });
});

r.get('/market/summary', async (req, res) => {
  const { rows } = await query(`
    SELECT mk.name::text AS make, md.name::text AS model, l.year, count(*) AS listings,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price)::numeric, -2) AS median_price,
           min(l.price) AS min_price, max(l.price) AS max_price
    FROM market_listings l JOIN makes mk ON mk.id = l.make_id JOIN models md ON md.id = l.model_id
    WHERE l.is_active AND l.price > 0
    GROUP BY 1, 2, 3 HAVING count(*) >= 2 ORDER BY 1, 2, 3 DESC LIMIT 200`);
  res.json(rows);
});

// ---------------- Importación / migración ----------------
r.get('/import/entities', (req, res) => {
  res.json(Object.fromEntries(Object.entries(ENTITIES).map(([k, fields]) => [k,
    fields.map(({ key, label, required }) => ({ key, label, required: Boolean(required) }))])));
});

function rowsFromRequest(req) {
  if (req.file) return readRows(req.file);
  if (Array.isArray(req.body?.rows)) return req.body.rows;
  throw new HttpError(400, 'Envía un archivo (campo "file") o un arreglo "rows"');
}

r.post('/import/:entity/preview', upload.single('file'), async (req, res) => {
  if (!ENTITIES[req.params.entity]) throw notFound('Entidad');
  const rows = rowsFromRequest(req);
  const headers = [...new Set(rows.slice(0, 50).flatMap((row) => Object.keys(row)))];
  res.json({
    total_rows: rows.length,
    headers,
    sample: rows.slice(0, 5),
    suggested_mapping: suggestMapping(req.params.entity, headers),
  });
});

r.post('/import/:entity', upload.single('file'), async (req, res) => {
  const rows = rowsFromRequest(req);
  const mapping = typeof req.body.mapping === 'string' ? JSON.parse(req.body.mapping) : req.body.mapping;
  const result = await runImport({
    entity: req.params.entity,
    rows,
    mapping: mapping ?? suggestMapping(req.params.entity, Object.keys(rows[0] ?? {})),
    system: req.body.system,
    fileName: req.file?.originalname,
    dryRun: req.body.dry_run === true || req.body.dry_run === 'true',
  });
  res.json(result);
});

r.get('/import/batches', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

export default r;
