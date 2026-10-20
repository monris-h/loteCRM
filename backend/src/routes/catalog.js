import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { HttpError, notFound, optInt, optStr, parse } from '../http.js';
import { decodeVin } from '../ingestion/providers/nhtsa.js';
import { resolveMakeModel } from '../services/catalog.js';
import { normVin } from '../services/normalize.js';

const r = Router();

r.get('/statuses', async (req, res) => {
  const [statuses, transitions] = await Promise.all([
    query('SELECT * FROM vehicle_statuses ORDER BY sort_order'),
    query('SELECT * FROM vehicle_status_transitions'),
  ]);
  res.json({ statuses: statuses.rows, transitions: transitions.rows });
});

r.get('/makes', async (req, res) => {
  const { rows } = await query(`
    SELECT mk.id, mk.name::text AS name, count(md.id) AS models
    FROM makes mk LEFT JOIN models md ON md.make_id = mk.id
    GROUP BY mk.id ORDER BY mk.name`);
  res.json(rows);
});

r.get('/makes/:id/models', async (req, res) => {
  const { rows } = await query('SELECT id, name::text AS name FROM models WHERE make_id = $1 ORDER BY name', [req.params.id]);
  res.json(rows);
});

r.post('/models', async (req, res) => {
  const { make, model } = parse(z.object({ make: z.string().min(1), model: z.string().min(1) }), req.body);
  res.status(201).json(await withTransaction((c) => resolveMakeModel(c, make, model)));
});

// Decodifica VIN con NHTSA vPIC
r.get('/vin/:vin', async (req, res) => {
  const vin = normVin(req.params.vin);
  if (!vin || vin.length !== 17) throw new HttpError(400, 'El VIN debe tener 17 caracteres');
  try {
    res.json(await decodeVin(vin));
  } catch (err) {
    throw new HttpError(422, err.message);
  }
});

// ---- Lotes ----
const lotSchema = z.object({
  code: z.string().trim().min(1).optional(), name: z.string().trim().min(1).optional(),
  address_line: optStr, city: optStr, state: optStr, postal_code: optStr, phone: optStr,
  capacity: optInt, is_active: z.boolean().optional(),
});
const LOT_COLS = ['code', 'name', 'address_line', 'city', 'state', 'postal_code', 'phone', 'capacity', 'is_active'];

r.get('/lots', async (req, res) => {
  const { rows } = await query(`
    SELECT l.*, count(v.id) FILTER (WHERE s.is_in_stock) AS units_in_stock
    FROM lots l
    LEFT JOIN vehicles v ON v.lot_id = l.id
    LEFT JOIN vehicle_statuses s ON s.code = v.status
    GROUP BY l.id ORDER BY l.code`);
  res.json(rows);
});

r.post('/lots', async (req, res) => {
  const data = parse(lotSchema.required({ code: true, name: true }), req.body);
  const cols = LOT_COLS.filter((c) => data[c] !== undefined);
  const { rows } = await query(
    `INSERT INTO lots (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    cols.map((c) => data[c]));
  res.status(201).json(rows[0]);
});

r.patch('/lots/:id', async (req, res) => {
  const data = parse(lotSchema, req.body);
  const cols = LOT_COLS.filter((c) => data[c] !== undefined);
  if (!cols.length) throw new HttpError(400, 'Nada que actualizar');
  const { rows } = await query(
    `UPDATE lots SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [req.params.id, ...cols.map((c) => data[c])]);
  if (!rows[0]) throw notFound('Lote');
  res.json(rows[0]);
});

// ---- Usuarios ----
r.get('/users', async (req, res) => {
  const { rows } = await query('SELECT * FROM users ORDER BY full_name');
  res.json(rows);
});

r.post('/users', async (req, res) => {
  const d = parse(z.object({
    full_name: z.string().trim().min(1), email: z.string().email(), phone: optStr,
    role: z.enum(['admin', 'manager', 'sales', 'staff']).default('sales'),
  }), req.body);
  const { rows } = await query(
    'INSERT INTO users (full_name, email, phone, role) VALUES ($1, $2, $3, $4) RETURNING *',
    [d.full_name, d.email, d.phone ?? null, d.role]);
  res.status(201).json(rows[0]);
});

r.patch('/users/:id', async (req, res) => {
  const d = parse(z.object({ is_active: z.boolean().optional(), role: z.enum(['admin', 'manager', 'sales', 'staff']).optional() }), req.body);
  const { rows } = await query(
    'UPDATE users SET is_active = coalesce($2, is_active), role = coalesce($3, role) WHERE id = $1 RETURNING *',
    [req.params.id, d.is_active ?? null, d.role ?? null]);
  if (!rows[0]) throw notFound('Usuario');
  res.json(rows[0]);
});

export default r;
