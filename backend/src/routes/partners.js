// Administración de socios desde la UI
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, notFound, optStr, parse } from '../http.js';
import { issueApiKey } from '../services/partners.js';

const r = Router();

const partnerSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]{2,30}$/, 'Sólo minúsculas, números y _ (2 a 30)').optional(),
  name: z.string().trim().min(1).optional(),
  contact_name: optStr,
  contact_email: z.preprocess((v) => (v === '' ? null : v), z.string().email().nullable().optional()),
  contact_phone: optStr,
  can_sell_inventory: z.boolean().optional(),
  can_publish_inventory: z.boolean().optional(),
  commission_pct: z.coerce.number().min(0).max(100).optional(),
  is_active: z.boolean().optional(),
});
const COLS = Object.keys(partnerSchema.shape);

r.get('/', async (req, res) => {
  const { rows } = await query(`
    SELECT p.id, p.code, p.name, p.contact_name, p.contact_email, p.contact_phone, p.can_sell_inventory,
           p.can_publish_inventory, p.commission_pct, p.api_key_prefix, p.last_api_call_at, p.is_active, p.created_at,
           (SELECT count(*) FROM vehicles v JOIN vehicle_statuses s ON s.code = v.status
             WHERE v.owner_partner_id = p.id AND s.is_in_stock) AS vehicles_in_stock,
           (SELECT count(*) FROM sales s WHERE s.selling_partner_id = p.id AND s.status <> 'cancelled') AS sales_by_partner
    FROM partners p ORDER BY p.name`);
  res.json(rows);
});

r.post('/', async (req, res) => {
  const d = parse(partnerSchema.required({ code: true, name: true }), req.body);
  const cols = COLS.filter((c) => d[c] !== undefined);
  const { rows: [p] } = await query(
    `INSERT INTO partners (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, code, name`,
    cols.map((c) => d[c]));
  // la llave sólo se muestra en esta respuesta
  res.status(201).json({ ...p, api_key: await issueApiKey(p.id) });
});

r.patch('/:id', async (req, res) => {
  const d = parse(partnerSchema, req.body);
  delete d.code;
  const cols = COLS.filter((c) => d[c] !== undefined);
  if (!cols.length) throw new HttpError(400, 'Nada que actualizar');
  const { rows } = await query(
    `UPDATE partners SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING id`,
    [req.params.id, ...cols.map((c) => d[c])]);
  if (!rows[0]) throw notFound('Socio');
  res.json(rows[0]);
});

// Genera una llave nueva (la anterior deja de funcionar)
r.post('/:id/key', async (req, res) => {
  const { rows } = await query('SELECT id FROM partners WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw notFound('Socio');
  res.json({ api_key: await issueApiKey(req.params.id) });
});

export default r;
