// Apartados y ventas
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { currentUserId, notFound, optDate, optInt, optNum, optStr, optUuid, parse } from '../http.js';
import * as inv from '../services/inventory.js';

const r = Router();

const CONTACT_NAME = "nullif(concat_ws(' ', c.first_name, c.last_name, c.company_name), '')";
const VEHICLE_LABEL = "concat_ws(' ', mk.name, md.name, v.year, v.trim)";

// ---------------- Apartados ----------------
r.get('/reservations', async (req, res) => {
  const status = req.query.status ?? 'active';
  const { rows } = await query(`
    SELECT r.*, ${CONTACT_NAME} AS contact_name, v.stock_number, ${VEHICLE_LABEL} AS vehicle_label,
           v.list_price, u.full_name AS user_name, r.expires_at < now() + interval '24 hours' AS expiring_soon
    FROM reservations r
    JOIN contacts c ON c.id = r.contact_id
    JOIN vehicles v ON v.id = r.vehicle_id
    JOIN makes mk ON mk.id = v.make_id JOIN models md ON md.id = v.model_id
    LEFT JOIN users u ON u.id = r.user_id
    WHERE r.status = ANY($1)
    ORDER BY r.expires_at`, [String(status).split(',')]);
  res.json(rows);
});

r.post('/reservations', async (req, res) => {
  const d = parse(z.object({
    vehicle_id: z.string().uuid(), contact_id: z.string().uuid(), lead_id: optUuid,
    deposit_amount: optNum, days: optInt, expires_at: optStr, notes: optStr,
  }), req.body);
  const userId = currentUserId(req);
  const reservation = await withTransaction(
    (c) => inv.reserveVehicle(c, { ...d, deposit_amount: d.deposit_amount ?? 0, user_id: userId }),
    { userId });
  res.status(201).json(reservation);
});

r.post('/reservations/:id/cancel', async (req, res) => {
  const { reason } = parse(z.object({ reason: optStr }), req.body);
  res.json(await withTransaction((c) => inv.cancelReservation(c, req.params.id, reason), { userId: currentUserId(req) }));
});

r.post('/reservations/expire', async (req, res) => {
  res.json({ expired: await withTransaction((c) => inv.expireReservations(c)) });
});

// ---------------- Ventas ----------------
const SALE_SELECT = `
  SELECT s.*, coalesce(${CONTACT_NAME}, s.buyer_name) AS contact_name, v.stock_number, v.vin, ${VEHICLE_LABEL} AS vehicle_label,
         u.full_name AS salesperson_name,
         sp.name AS selling_partner_name, op.name AS owner_partner_name,
         coalesce(p.paid, 0) AS amount_paid,
         CASE WHEN s.sale_type = 'partner_own' THEN 0 ELSE s.total_amount - coalesce(p.paid, 0) END AS balance_due,
         tv.stock_number AS trade_in_stock_number
  FROM sales s
  LEFT JOIN contacts c ON c.id = s.contact_id
  LEFT JOIN partners sp ON sp.id = s.selling_partner_id
  JOIN vehicles v ON v.id = s.vehicle_id
  LEFT JOIN partners op ON op.id = v.owner_partner_id
  JOIN makes mk ON mk.id = v.make_id JOIN models md ON md.id = v.model_id
  LEFT JOIN users u ON u.id = s.salesperson_id
  LEFT JOIN vehicles tv ON tv.id = s.trade_in_vehicle_id
  LEFT JOIN (SELECT sale_id, sum(amount) AS paid FROM sale_payments GROUP BY sale_id) p ON p.sale_id = s.id`;

r.get('/sales', async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`s.status = ANY($${params.length})`); }
  if (req.query.from) { params.push(req.query.from); where.push(`s.sale_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); where.push(`s.sale_date <= $${params.length}`); }
  if (req.query.sale_type) { params.push(String(req.query.sale_type).split(',')); where.push(`s.sale_type = ANY($${params.length})`); }
  const { rows } = await query(
    `${SALE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.sale_date DESC, s.created_at DESC LIMIT 500`,
    params);
  res.json(rows);
});

r.get('/sales/:id', async (req, res) => {
  const { rows: [sale] } = await query(`${SALE_SELECT} WHERE s.id = $1`, [req.params.id]);
  if (!sale) throw notFound('Venta');
  const { rows: payments } = await query('SELECT * FROM sale_payments WHERE sale_id = $1 ORDER BY paid_at', [req.params.id]);
  res.json({ ...sale, payments });
});

const tradeInSchema = z.object({
  make: z.string().min(1), model: z.string().min(1), year: z.coerce.number().int(),
  vin: optStr, trim: optStr, odometer: optInt, exterior_color: optStr,
  value: z.coerce.number().positive(),
});

r.post('/sales', async (req, res) => {
  const d = parse(z.object({
    vehicle_id: z.string().uuid(), contact_id: z.string().uuid(), lead_id: optUuid, salesperson_id: optUuid,
    sale_date: optDate,
    sale_price: z.coerce.number().nonnegative(),
    discount_amount: optNum, fees_amount: optNum, tax_amount: optNum, down_payment: optNum,
    payment_method: z.enum(['cash', 'financing', 'transfer', 'card', 'mixed', 'other']).default('cash'),
    financing_institution: optStr, financing_term_months: optInt, financing_rate: optNum,
    trade_in: tradeInSchema.nullable().optional(),
    approve_below_min: z.boolean().optional(),
    override_reservation: z.boolean().optional(),
    notes: optStr,
  }), req.body);
  for (const k of ['discount_amount', 'fees_amount', 'tax_amount', 'down_payment', 'sale_date']) {
    if (d[k] === null) delete d[k];
  }
  delete d.selling_partner; // sólo la API de socios puede registrar ventas a nombre de un socio
  const userId = currentUserId(req);
  const sale = await withTransaction((c) => inv.createSale(c, d, userId), { userId });
  res.status(201).json(sale);
});

r.post('/sales/:id/deliver', async (req, res) => {
  res.json(await withTransaction((c) => inv.deliverSale(c, req.params.id), { userId: currentUserId(req) }));
});

r.post('/sales/:id/cancel', async (req, res) => {
  const { reason } = parse(z.object({ reason: optStr }), req.body);
  res.json(await withTransaction((c) => inv.cancelSale(c, req.params.id, reason), { userId: currentUserId(req) }));
});

r.post('/sales/:id/payments', async (req, res) => {
  const d = parse(z.object({
    amount: z.coerce.number().positive(),
    method: z.enum(['cash', 'transfer', 'card', 'check', 'financing', 'other']),
    reference: optStr,
    paid_at: optStr,
  }), req.body);
  if (d.paid_at === null) delete d.paid_at;
  res.status(201).json(await withTransaction((c) => inv.addPayment(c, req.params.id, d)));
});

export default r;
