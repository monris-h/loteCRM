import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import {
  currentUserId, notFound, optDate, optEnum, optInt, optNum, optStr, optUuid, pageParams, parse,
} from '../http.js';
import * as inv from '../services/inventory.js';

const r = Router();

const BODY = ['sedan', 'suv', 'pickup', 'hatchback', 'coupe', 'convertible', 'van', 'minivan', 'wagon', 'truck', 'motorcycle', 'other'];
const FUEL = ['gasoline', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric', 'lpg', 'cng', 'other'];
const TRANS = ['manual', 'automatic', 'cvt', 'dct', 'other'];
const DRIVE = ['fwd', 'rwd', 'awd', '4wd', 'other'];
const STATUSES = ['incoming', 'reconditioning', 'available', 'on_hold', 'reserved', 'sold', 'delivered', 'archived'];

const vehicleSchema = z.object({
  make: optStr, model: optStr, make_id: optUuid, model_id: optUuid,
  vin: optStr, stock_number: optStr, plate_number: optStr, lot_id: optUuid,
  year: optInt, trim: optStr, body_type: optEnum(BODY),
  exterior_color: optStr, interior_color: optStr,
  odometer: optInt, odometer_unit: optEnum(['km', 'mi']),
  fuel_type: optEnum(FUEL), transmission: optEnum(TRANS), drivetrain: optEnum(DRIVE),
  engine: optStr, cylinders: optInt, displacement_l: optNum, doors: optInt, seats: optInt,
  condition: optEnum(['new', 'used', 'certified']),
  title_status: optEnum(['clean', 'salvage', 'rebuilt', 'lien', 'unknown']),
  owners_count: optInt,
  status: optEnum(STATUSES),
  currency: optStr,
  acquisition_cost: optNum, acquisition_source: optEnum(['purchase', 'trade_in', 'auction', 'consignment', 'other']),
  acquired_at: optDate, list_price: optNum, min_price: optNum,
  description: optStr,
  features: z.array(z.string()).optional(),
  attributes: z.record(z.any()).optional(),
  syndicate: z.boolean().optional(),
  price_note: optStr,
});

// columnas NOT NULL con default: un null del formulario significa "usa el default"
const dropNulls = (o, keys) => {
  for (const k of keys) if (o[k] === null) delete o[k];
  return o;
};
const NOT_NULL_DEFAULTS = ['condition', 'title_status', 'odometer_unit', 'currency', 'features', 'attributes', 'stock_number', 'syndicate'];

const SORTS = {
  created_at: 'created_at', year: 'year', list_price: 'list_price', odometer: 'odometer',
  days_in_stock: 'days_in_stock', make: 'make', expected_margin: 'expected_margin', stock_number: 'stock_number',
};

r.get('/', async (req, res) => {
  const q = req.query;
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (q.q) add(`(make || ' ' || model || ' ' || coalesce(trim, '') || ' ' || coalesce(vin, '') || ' ' || stock_number) ILIKE ?`, `%${q.q}%`);
  if (q.status) add('status = ANY(?)', String(q.status).split(','));
  if (q.in_stock === 'true') where.push('is_in_stock');
  if (q.lot_id) add('lot_id = ?', q.lot_id);
  if (q.make_id) add('make_id = ?', q.make_id);
  if (q.model_id) add('model_id = ?', q.model_id);
  if (q.year_min) add('year >= ?', Number(q.year_min));
  if (q.year_max) add('year <= ?', Number(q.year_max));
  if (q.price_min) add('list_price >= ?', Number(q.price_min));
  if (q.price_max) add('list_price <= ?', Number(q.price_max));
  if (q.aging_days) add('days_in_stock >= ?', Number(q.aging_days));
  if (q.owner === 'own') where.push('is_own');
  else if (q.owner === 'partners') where.push('NOT is_own');
  else if (q.owner) add('owner_partner_id = ?', q.owner);

  const { limit, offset } = pageParams(q);
  const sort = SORTS[q.sort] ?? 'created_at';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const sql = `
    SELECT id, stock_number, vin, make, model, year, trim, body_type, exterior_color, odometer, odometer_unit,
           transmission, fuel_type, condition, status, status_label, is_in_stock, lot_id, lot_code, lot_name,
           currency, list_price, min_price, total_cost, expected_margin, market_value, days_in_stock,
           primary_image_url, created_at, is_own, owner_partner_id, owner_partner_code, owner_partner_name, syndicate,
           count(*) OVER () AS total_count
    FROM v_inventory
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${sort} ${dir} NULLS LAST, id
    LIMIT ${limit} OFFSET ${offset}`;
  const { rows } = await query(sql, params);
  res.json({ items: rows.map(({ total_count, ...v }) => v), total: rows[0]?.total_count ?? 0, limit, offset });
});

r.post('/revalue', async (req, res) => {
  res.json(await withTransaction((c) => inv.revalueInventory(c)));
});

r.get('/:id', async (req, res) => {
  const { id } = req.params;
  const { rows: [vehicle] } = await query('SELECT * FROM v_inventory WHERE id = $1', [id]);
  if (!vehicle) throw notFound('Vehículo');

  const [costs, events, media, valuations, reservation, sale, leads, transitions] = await Promise.all([
    query('SELECT * FROM vehicle_costs WHERE vehicle_id = $1 ORDER BY incurred_at DESC, created_at DESC', [id]),
    query(`SELECT e.*, u.full_name AS user_name, fl.code AS from_lot_code, tl.code AS to_lot_code
           FROM vehicle_events e
           LEFT JOIN users u ON u.id = e.user_id
           LEFT JOIN lots fl ON fl.id = e.from_lot_id
           LEFT JOIN lots tl ON tl.id = e.to_lot_id
           WHERE e.vehicle_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 100`, [id]),
    query('SELECT * FROM vehicle_media WHERE vehicle_id = $1 ORDER BY is_primary DESC, position', [id]),
    query('SELECT * FROM vehicle_valuations WHERE vehicle_id = $1 ORDER BY valued_at DESC LIMIT 10', [id]),
    query(`SELECT r.*, concat_ws(' ', c.first_name, c.last_name, c.company_name) AS contact_name
           FROM reservations r JOIN contacts c ON c.id = r.contact_id
           WHERE r.vehicle_id = $1 AND r.status = 'active'`, [id]),
    query(`SELECT s.*, coalesce(nullif(concat_ws(' ', c.first_name, c.last_name, c.company_name), ''), s.buyer_name) AS contact_name,
                  p.name AS selling_partner_name
           FROM sales s LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN partners p ON p.id = s.selling_partner_id
           WHERE s.vehicle_id = $1 AND s.status <> 'cancelled'`, [id]),
    query(`SELECT l.id, l.status, l.created_at, concat_ws(' ', c.first_name, c.last_name, c.company_name) AS contact_name
           FROM leads l JOIN contacts c ON c.id = l.contact_id
           WHERE l.vehicle_id = $1 ORDER BY l.created_at DESC`, [id]),
    inv.manualTransitions({ query }, vehicle),
  ]);
  const { rows: [ext] } = await query(
    `SELECT external_id FROM external_refs WHERE entity_type = 'vehicle' AND entity_id = $1 AND system LIKE 'partner:%' LIMIT 1`, [id]);

  res.json({
    ...vehicle,
    costs: costs.rows,
    events: events.rows,
    media: media.rows,
    valuations: valuations.rows,
    reservation: reservation.rows[0] ?? null,
    sale: sale.rows[0] ?? null,
    leads: leads.rows,
    allowed_transitions: transitions,
    partner_external_id: ext?.external_id ?? null,
  });
});

r.post('/', async (req, res) => {
  const data = dropNulls(parse(vehicleSchema, req.body), NOT_NULL_DEFAULTS);
  const v = await withTransaction((c) => inv.createVehicle(c, data), { userId: currentUserId(req), note: 'Alta de vehículo' });
  res.status(201).json(v);
});

r.patch('/:id', async (req, res) => {
  const data = dropNulls(parse(vehicleSchema, req.body), NOT_NULL_DEFAULTS);
  delete data.status;
  res.json(await withTransaction((c) => inv.updateVehicle(c, req.params.id, data), { userId: currentUserId(req) }));
});

r.post('/:id/status', async (req, res) => {
  const { status, notes } = parse(z.object({ status: z.enum(STATUSES), notes: optStr }), req.body);
  res.json(await withTransaction((c) => inv.changeStatus(c, req.params.id, status, notes), { userId: currentUserId(req) }));
});

r.post('/:id/transfer', async (req, res) => {
  const { lot_id: lotId, notes } = parse(z.object({ lot_id: z.string().uuid(), notes: optStr }), req.body);
  res.json(await withTransaction((c) => inv.transferVehicle(c, req.params.id, lotId, notes), { userId: currentUserId(req) }));
});

const costSchema = z.object({
  category: z.enum(['reconditioning', 'transport', 'fees', 'parts', 'labor', 'detailing', 'inspection', 'other']),
  description: optStr, vendor: optStr,
  amount: z.coerce.number().nonnegative(),
  incurred_at: optDate,
});

r.post('/:id/costs', async (req, res) => {
  const data = dropNulls(parse(costSchema, req.body), ['incurred_at']);
  res.status(201).json(await withTransaction((c) => inv.addCost(c, req.params.id, data)));
});

r.delete('/:id/costs/:costId', async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM vehicle_costs c USING vehicles v
     WHERE c.id = $1 AND c.vehicle_id = $2 AND v.id = c.vehicle_id AND v.status NOT IN ('sold','delivered')`,
    [req.params.costId, req.params.id]);
  if (!rowCount) throw notFound('Costo');
  res.status(204).end();
});

r.post('/:id/media', async (req, res) => {
  const data = parse(z.object({
    url: z.string().url(), caption: optStr, media_type: z.enum(['image', 'video', 'document']).default('image'),
    is_primary: z.boolean().default(false),
  }), req.body);
  const m = await withTransaction(async (c) => {
    if (data.is_primary) await c.query('UPDATE vehicle_media SET is_primary = false WHERE vehicle_id = $1', [req.params.id]);
    const { rows } = await c.query(
      `INSERT INTO vehicle_media (vehicle_id, url, caption, media_type, is_primary, position)
       VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(position) + 1, 0) FROM vehicle_media WHERE vehicle_id = $1))
       RETURNING *`, [req.params.id, data.url, data.caption ?? null, data.media_type, data.is_primary]);
    return rows[0];
  });
  res.status(201).json(m);
});

r.delete('/:id/media/:mediaId', async (req, res) => {
  await query('DELETE FROM vehicle_media WHERE id = $1 AND vehicle_id = $2', [req.params.mediaId, req.params.id]);
  res.status(204).end();
});

r.post('/:id/valuate', async (req, res) => {
  const valuation = await withTransaction((c) => inv.valueVehicle(c, req.params.id));
  res.json({ valuation });
});

r.get('/:id/comparables', async (req, res) => {
  const window = Math.min(Math.max(Number(req.query.year_window ?? 1), 0), 5);
  const { rows } = await query(
    'SELECT * FROM market_comparables($1, $2) ORDER BY adjusted_price LIMIT 100', [req.params.id, window]);
  res.json(rows);
});

export default r;
