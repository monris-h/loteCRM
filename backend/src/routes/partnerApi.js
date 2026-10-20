// API sencilla para otros lotes / agencias (socios): /partner/v1
// Autenticación: header  Authorization: Bearer <llave>
// Guía: docs/API_SOCIOS.md
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { HttpError, conflict, notFound, parse } from '../http.js';
import * as inv from '../services/inventory.js';
import {
  archivePartnerVehicle, authenticate, findPartnerVehicle, recordPartnerOwnSale, upsertPartnerVehicle,
} from '../services/partners.js';

const r = Router();
const forbidden = (what) => new HttpError(403, `El socio no tiene permiso para ${what}`, undefined, 'forbidden');

r.use(async (req, res, next) => {
  const header = req.get('authorization') ?? '';
  const partner = await authenticate(header.startsWith('Bearer ') ? header.slice(7).trim() : null);
  if (!partner) return res.status(401).json({ error: 'Llave de API inválida', code: 'unauthorized' });
  req.partner = partner;
  return next();
});

const tx = (fn) => withTransaction(fn, { note: 'API de socio' });

const publicVehicle = ({ owner_partner_id: _o, syndicate: _s, ...v }) => v;

const publicSale = (s) => ({
  id: s.id, sale_number: s.sale_number, vehicle_id: s.vehicle_id, sale_type: s.sale_type, status: s.status,
  sale_date: s.sale_date, sale_price: s.sale_price, commission_amount: s.commission_amount,
  reference: s.partner_reference, buyer_name: s.buyer_name,
});

// ---- Quién soy ----
r.get('/me', (req, res) => {
  const p = req.partner;
  res.json({
    code: p.code, name: p.name, commission_pct: p.commission_pct,
    can_sell_inventory: p.can_sell_inventory, can_publish_inventory: p.can_publish_inventory,
  });
});

// ---- 1) Nuestro inventario compartido ----
r.get('/inventory', async (req, res) => {
  if (!req.partner.can_sell_inventory) throw forbidden('ver nuestro inventario');
  const params = [];
  let since = "AND availability IN ('available','reserved')";
  if (req.query.updated_since) {
    // para sincronizar: incluye también los que ya se vendieron o retiraron
    params.push(req.query.updated_since);
    since = 'AND updated_at > $1::timestamptz';
  }
  const { rows } = await query(
    `SELECT * FROM v_public_inventory WHERE owner_partner_id IS NULL AND syndicate ${since}
     ORDER BY updated_at DESC LIMIT 500`, params);
  res.json({ data: rows.map(publicVehicle) });
});

// ---- 2) Registrar una venta (de un auto nuestro o de uno suyo) ----
r.post('/sales', async (req, res) => {
  const p = req.partner;
  const d = parse(z.object({
    vehicle_id: z.string().uuid().optional(),                          // auto de LotesCRM
    vehicle_external_id: z.union([z.string(), z.number()]).optional(), // auto del socio
    sale_price: z.coerce.number().positive(),
    reference: z.string().min(1).max(100),                             // id de la venta en su sistema
    buyer_name: z.string().max(200).optional(),
  }).refine((x) => Boolean(x.vehicle_id) !== (x.vehicle_external_id != null), {
    message: 'Indica vehicle_id (auto de LotesCRM) o vehicle_external_id (tu auto)',
  }), req.body);

  // la misma referencia es la misma venta: reenviarla no duplica
  const { rows: dup } = await query('SELECT * FROM sales WHERE selling_partner_id = $1 AND partner_reference = $2', [p.id, d.reference]);
  if (dup[0]) return res.json(publicSale(dup[0]));

  let sale;
  if (d.vehicle_id) {
    if (!p.can_sell_inventory) throw forbidden('vender nuestro inventario');
    const { rows } = await query('SELECT 1 FROM vehicles WHERE id = $1 AND owner_partner_id IS NULL AND syndicate', [d.vehicle_id]);
    if (!rows[0]) throw notFound('Vehículo');
    sale = await tx((c) => inv.createSale(c, {
      vehicle_id: d.vehicle_id, sale_price: d.sale_price, payment_method: 'other',
      partner_reference: d.reference, buyer_name: d.buyer_name,
      selling_partner: { id: p.id, name: p.name, commission_pct: p.commission_pct },
    }));
  } else {
    if (!p.can_publish_inventory) throw forbidden('reportar ventas de su inventario');
    sale = await tx(async (c) => {
      const id = await findPartnerVehicle(c, p, d.vehicle_external_id);
      const v = await inv.lockVehicle(c, id);
      const { rows } = await c.query("SELECT sale_number, sale_type FROM sales WHERE vehicle_id = $1 AND status <> 'cancelled'", [id]);
      if (rows[0]) {
        throw conflict(rows[0].sale_type === 'we_sold_partner' ? 'LotesCRM ya vendió este vehículo' : 'El vehículo ya tiene una venta',
          { sale_number: rows[0].sale_number }, rows[0].sale_type === 'we_sold_partner' ? 'sold_by_lotescrm' : 'already_sold');
      }
      return recordPartnerOwnSale(c, p, v, { sale_price: d.sale_price, reference: d.reference, buyer_name: d.buyer_name });
    });
  }
  return res.status(201).json(publicSale(sale));
});

// ventas donde participa el socio (las suyas y las nuestras de sus autos)
r.get('/sales', async (req, res) => {
  const { rows } = await query(
    `SELECT s.* FROM sales s JOIN vehicles v ON v.id = s.vehicle_id
     WHERE s.selling_partner_id = $1 OR v.owner_partner_id = $1 ORDER BY s.created_at DESC LIMIT 500`, [req.partner.id]);
  res.json({ data: rows.map(publicSale) });
});

// ---- 3) Publicar / actualizar / retirar su inventario ----
r.put('/vehicles/:externalId', async (req, res) => {
  const result = await tx((c) => upsertPartnerVehicle(c, req.partner, { ...req.body, external_id: req.params.externalId }));
  const { rows } = await query('SELECT * FROM v_public_inventory WHERE id = $1', [result.id]);
  res.status(result.action === 'created' ? 201 : 200).json({ action: result.action, vehicle: publicVehicle(rows[0]) });
});

r.delete('/vehicles/:externalId', async (req, res) => {
  if (!req.partner.can_publish_inventory) throw forbidden('publicar inventario');
  res.json(await tx((c) => archivePartnerVehicle(c, req.partner, req.params.externalId)));
});

r.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada', code: 'not_found' }));

export default r;
