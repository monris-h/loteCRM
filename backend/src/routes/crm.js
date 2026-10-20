// Contactos, leads (embudo de ventas) y actividades
import { Router } from 'express';
import { z } from 'zod';
import { insertRow, query, updateById, withTransaction } from '../db.js';
import {
  HttpError, currentUserId, notFound, optEnum, optInt, optNum, optStr, optUuid, pageParams, parse,
} from '../http.js';

const r = Router();

const CONTACT_NAME = "concat_ws(' ', c.first_name, c.last_name, c.company_name)";

const contactSchema = z.object({
  contact_type: z.enum(['person', 'company']).optional(),
  first_name: optStr, last_name: optStr, company_name: optStr,
  email: z.preprocess((v) => (v === '' ? null : v), z.string().email().nullable().optional()),
  phone: optStr, mobile: optStr, tax_id: optStr,
  address_line: optStr, city: optStr, state: optStr, postal_code: optStr,
  preferred_contact: optEnum(['phone', 'email', 'whatsapp', 'sms']),
  source: optStr, marketing_opt_in: z.boolean().optional(), owner_user_id: optUuid, notes: optStr,
  attributes: z.record(z.any()).optional(),
});
const CONTACT_COLS = Object.keys(contactSchema.shape);

// ---------------- Contactos ----------------
r.get('/contacts', async (req, res) => {
  const { limit, offset } = pageParams(req.query);
  const params = [];
  let where = '';
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    where = `WHERE ${CONTACT_NAME} ILIKE $1 OR c.email ILIKE $1 OR c.phone ILIKE $1 OR c.tax_id ILIKE $1`;
  }
  const { rows } = await query(`
    SELECT c.*, ${CONTACT_NAME} AS display_name,
           (SELECT count(*) FROM leads l WHERE l.contact_id = c.id AND l.status NOT IN ('won','lost')) AS open_leads,
           (SELECT count(*) FROM sales s WHERE s.contact_id = c.id AND s.status <> 'cancelled') AS purchases,
           count(*) OVER () AS total_count
    FROM contacts c ${where}
    ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  res.json({ items: rows.map(({ total_count, ...c }) => c), total: rows[0]?.total_count ?? 0 });
});

r.get('/contacts/:id', async (req, res) => {
  const { rows: [contact] } = await query(
    `SELECT c.*, ${CONTACT_NAME} AS display_name FROM contacts c WHERE c.id = $1`, [req.params.id]);
  if (!contact) throw notFound('Contacto');
  const [leads, sales, activities] = await Promise.all([
    query(`SELECT l.*, v.stock_number, concat_ws(' ', mk.name, md.name, v.year) AS vehicle_label
           FROM leads l LEFT JOIN vehicles v ON v.id = l.vehicle_id
           LEFT JOIN makes mk ON mk.id = v.make_id LEFT JOIN models md ON md.id = v.model_id
           WHERE l.contact_id = $1 ORDER BY l.created_at DESC`, [req.params.id]),
    query(`SELECT s.*, v.stock_number, concat_ws(' ', mk.name, md.name, v.year) AS vehicle_label
           FROM sales s JOIN vehicles v ON v.id = s.vehicle_id
           JOIN makes mk ON mk.id = v.make_id JOIN models md ON md.id = v.model_id
           WHERE s.contact_id = $1 ORDER BY s.sale_date DESC`, [req.params.id]),
    query(`SELECT a.*, u.full_name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id
           WHERE a.contact_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [req.params.id]),
  ]);
  res.json({ ...contact, leads: leads.rows, sales: sales.rows, activities: activities.rows });
});

function checkContact(d) {
  const type = d.contact_type ?? (d.company_name && !d.first_name ? 'company' : 'person');
  if (type === 'person' && !d.first_name) throw new HttpError(400, 'El nombre es obligatorio');
  if (type === 'company' && !d.company_name) throw new HttpError(400, 'La razón social es obligatoria');
  return { ...d, contact_type: type };
}

async function createContact(client, d, userId) {
  return insertRow(client, 'contacts', { owner_user_id: userId, ...checkContact(d) }, CONTACT_COLS);
}

r.post('/contacts', async (req, res) => {
  const d = parse(contactSchema, req.body);
  res.status(201).json(await withTransaction((c) => createContact(c, d, currentUserId(req))));
});

r.patch('/contacts/:id', async (req, res) => {
  const d = parse(contactSchema, req.body);
  const row = await withTransaction((c) => updateById(c, 'contacts', req.params.id, d, CONTACT_COLS));
  if (!row) throw notFound('Contacto');
  res.json(row);
});

// ---------------- Leads ----------------
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'test_drive', 'negotiation', 'won', 'lost'];
const leadSchema = z.object({
  contact_id: optUuid,
  contact: contactSchema.optional(),               // alta rápida de contacto junto con el lead
  vehicle_id: optUuid, assigned_user_id: optUuid,
  status: z.enum(LEAD_STATUSES).optional(),
  source: z.enum(['walk_in', 'website', 'phone', 'referral', 'marketplace', 'social', 'other']).optional(),
  budget_min: optNum, budget_max: optNum,
  desired_make: optStr, desired_model: optStr, desired_year_min: optInt, desired_year_max: optInt,
  lost_reason: optStr, notes: optStr,
});
const LEAD_COLS = ['contact_id', 'vehicle_id', 'assigned_user_id', 'status', 'source', 'budget_min', 'budget_max',
  'desired_make', 'desired_model', 'desired_year_min', 'desired_year_max', 'lost_reason', 'notes'];

const LEAD_SELECT = `
  SELECT l.*, ${CONTACT_NAME} AS contact_name, c.phone AS contact_phone, c.email AS contact_email,
         u.full_name AS assigned_user_name,
         v.stock_number, v.status AS vehicle_status, v.list_price AS vehicle_price,
         concat_ws(' ', mk.name, md.name, v.year) AS vehicle_label,
         (SELECT min(a.due_at) FROM activities a WHERE a.lead_id = l.id AND a.completed_at IS NULL) AS next_activity_at
  FROM leads l
  JOIN contacts c ON c.id = l.contact_id
  LEFT JOIN users u ON u.id = l.assigned_user_id
  LEFT JOIN vehicles v ON v.id = l.vehicle_id
  LEFT JOIN makes mk ON mk.id = v.make_id
  LEFT JOIN models md ON md.id = v.model_id`;

r.get('/leads', async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`l.status = ANY($${params.length})`); }
  if (req.query.assigned_user_id) { params.push(req.query.assigned_user_id); where.push(`l.assigned_user_id = $${params.length}`); }
  if (req.query.open === 'true') where.push("l.status NOT IN ('won','lost')");
  const { rows } = await query(
    `${LEAD_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.updated_at DESC LIMIT 500`, params);
  res.json(rows);
});

r.get('/leads/:id', async (req, res) => {
  const { rows: [lead] } = await query(`${LEAD_SELECT} WHERE l.id = $1`, [req.params.id]);
  if (!lead) throw notFound('Lead');
  const { rows: activities } = await query(
    `SELECT a.*, u.full_name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.lead_id = $1 ORDER BY coalesce(a.due_at, a.created_at) DESC`, [req.params.id]);
  res.json({ ...lead, activities });
});

r.post('/leads', async (req, res) => {
  const d = parse(leadSchema, req.body);
  const userId = currentUserId(req);
  const lead = await withTransaction(async (c) => {
    let contactId = d.contact_id;
    if (!contactId) {
      if (!d.contact) throw new HttpError(400, 'Indica contact_id o los datos del contacto');
      contactId = (await createContact(c, d.contact, userId)).id;
    }
    return insertRow(c, 'leads', { assigned_user_id: userId, ...d, contact_id: contactId }, LEAD_COLS);
  });
  res.status(201).json(lead);
});

r.patch('/leads/:id', async (req, res) => {
  const d = parse(leadSchema, req.body);
  const lead = await withTransaction(async (c) => {
    const row = await updateById(c, 'leads', req.params.id, d, LEAD_COLS.filter((k) => k !== 'contact_id'));
    if (!row) throw notFound('Lead');
    if (d.status) {
      const closed = ['won', 'lost'].includes(d.status);
      await c.query(
        `UPDATE leads SET closed_at = CASE WHEN $2 THEN coalesce(closed_at, now()) END WHERE id = $1`,
        [row.id, closed]);
    }
    return row;
  });
  res.json(lead);
});

// ---------------- Actividades ----------------
const activitySchema = z.object({
  activity_type: z.enum(['call', 'email', 'whatsapp', 'meeting', 'test_drive', 'note', 'task']),
  subject: z.string().trim().min(1),
  notes: optStr,
  due_at: z.preprocess((v) => (v === '' ? null : v), z.string().nullable().optional()),
  completed: z.boolean().optional(),
});

r.post('/leads/:id/activities', async (req, res) => {
  const d = parse(activitySchema, req.body);
  const { rows: [lead] } = await query('SELECT id, contact_id FROM leads WHERE id = $1', [req.params.id]);
  if (!lead) throw notFound('Lead');
  const { rows } = await query(
    `INSERT INTO activities (lead_id, contact_id, user_id, activity_type, subject, notes, due_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END) RETURNING *`,
    [lead.id, lead.contact_id, currentUserId(req) ?? null, d.activity_type, d.subject, d.notes ?? null,
      d.due_at ?? null, Boolean(d.completed)]);
  // registrar actividad hace avanzar un lead nuevo a "contactado"
  await query("UPDATE leads SET status = 'contacted' WHERE id = $1 AND status = 'new'", [lead.id]);
  res.status(201).json(rows[0]);
});

r.post('/activities/:id/complete', async (req, res) => {
  const { rows } = await query(
    'UPDATE activities SET completed_at = coalesce(completed_at, now()) WHERE id = $1 RETURNING *', [req.params.id]);
  if (!rows[0]) throw notFound('Actividad');
  res.json(rows[0]);
});

r.get('/activities/upcoming', async (req, res) => {
  const { rows } = await query(`
    SELECT a.*, ${CONTACT_NAME} AS contact_name, u.full_name AS user_name
    FROM activities a
    LEFT JOIN contacts c ON c.id = a.contact_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.completed_at IS NULL AND a.due_at IS NOT NULL
    ORDER BY a.due_at LIMIT 20`);
  res.json(rows);
});

export default r;
