// Socios (otros lotes / agencias conectados por API).
//  - Una llave de API por socio (se guarda sólo su hash).
//  - Sus vehículos se reflejan aquí con owner_partner_id; su estado lo controla el socio.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { insertRow, query, setEventNote, updateById } from '../db.js';
import { HttpError, conflict, notFound } from '../http.js';
import { resolveMakeModel } from './catalog.js';
import { VEHICLE_COLUMNS, cancelSale, forceStatus, lockVehicle } from './inventory.js';
import { normEnum, normVin, parseNumber } from './normalize.js';

// ---------------------------------------------------------------------
// Llave de API: "lcrm_<prefijo>.<secreto>"
// ---------------------------------------------------------------------
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Genera (o reemplaza) la llave del socio. La llave completa sólo se devuelve aquí. */
export async function issueApiKey(partnerId) {
  const prefix = `lcrm_${randomBytes(5).toString('hex')}`;
  const key = `${prefix}.${randomBytes(24).toString('base64url')}`;
  await query('UPDATE partners SET api_key_prefix = $2, api_key_hash = $3 WHERE id = $1', [partnerId, prefix, sha256(key)]);
  return key;
}

export async function authenticate(token) {
  if (!token?.includes('.')) return null;
  const { rows } = await query('SELECT * FROM partners WHERE api_key_prefix = $1 AND is_active', [token.split('.')[0]]);
  const p = rows[0];
  if (!p) return null;
  const a = Buffer.from(p.api_key_hash, 'hex');
  const b = Buffer.from(sha256(token), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  query('UPDATE partners SET last_api_call_at = now() WHERE id = $1', [p.id]).catch(() => {});
  return p;
}

// ---------------------------------------------------------------------
// Inventario del socio reflejado aquí
// ---------------------------------------------------------------------
// disponibilidad que reporta el socio -> estado interno
const STATUS_OF = { available: 'available', reserved: 'reserved', sold: 'sold', unavailable: 'on_hold' };

export const systemOf = (partner) => `partner:${partner.code}`;

export async function findPartnerVehicle(client, partner, externalId) {
  const { rows } = await client.query(
    `SELECT entity_id FROM external_refs WHERE system = $1 AND entity_type = 'vehicle' AND external_id = $2`,
    [systemOf(partner), String(externalId)]);
  if (!rows[0]) throw notFound('Vehículo');
  return rows[0].entity_id;
}

async function activeSaleOf(client, vehicleId) {
  const { rows } = await client.query(
    "SELECT * FROM sales WHERE vehicle_id = $1 AND status <> 'cancelled' FOR UPDATE", [vehicleId]);
  return rows[0] ?? null;
}

/**
 * Crea o actualiza un vehículo del socio.
 * payload: { external_id, make, model, year, version, vin, price, odometer, color, transmission,
 *            fuel_type, availability, photos[], sold_price, buyer_name }
 */
export async function upsertPartnerVehicle(client, partner, payload) {
  if (!partner.can_publish_inventory) {
    throw new HttpError(403, 'El socio no tiene permiso para publicar inventario', undefined, 'forbidden');
  }
  const ext = String(payload.external_id ?? '').trim();
  const availability = payload.availability ?? 'available';
  if (!ext) throw new HttpError(400, 'Falta external_id', undefined, 'validation_error');
  if (!STATUS_OF[availability]) {
    throw new HttpError(400, 'availability debe ser available, reserved, sold o unavailable', undefined, 'validation_error');
  }

  const year = parseNumber(payload.year);
  const vehicle = {
    vin: payload.vin !== undefined ? normVin(payload.vin) : undefined,
    year: year != null ? Math.trunc(year) : undefined,
    trim: payload.version ?? payload.trim,
    exterior_color: payload.color ?? payload.exterior_color,
    odometer: payload.odometer != null ? Math.round(parseNumber(payload.odometer)) : undefined,
    transmission: payload.transmission !== undefined ? normEnum('transmission', payload.transmission) : undefined,
    fuel_type: payload.fuel_type !== undefined ? normEnum('fuel_type', payload.fuel_type) : undefined,
    list_price: payload.price != null ? parseNumber(payload.price) : undefined,
    description: payload.description,
  };
  if (vehicle.vin && !/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vehicle.vin)) vehicle.vin = undefined;
  if (payload.make && payload.model) Object.assign(vehicle, await resolveMakeModel(client, payload.make, payload.model));

  let id = await findPartnerVehicle(client, partner, ext).catch(() => null);
  let action = 'updated';
  if (id) {
    await lockVehicle(client, id);
    const sale = await activeSaleOf(client, id);
    if (sale?.sale_type === 'we_sold_partner' && availability !== 'sold') {
      throw conflict('LotesCRM ya vendió este vehículo; no se puede volver a publicar como disponible',
        { sale_number: sale.sale_number }, 'sold_by_lotescrm');
    }
    await setEventNote(client, `Actualizado por ${partner.name}`);
    await updateById(client, 'vehicles', id, vehicle, VEHICLE_COLUMNS.filter((c) => c !== 'status' && c !== 'owner_partner_id'));
  } else {
    if (!payload.make || !payload.model || !vehicle.year) {
      throw new HttpError(400, 'Para un vehículo nuevo se requieren make, model y year', undefined, 'validation_error');
    }
    const created = await insertRow(client, 'vehicles', {
      ...vehicle,
      owner_partner_id: partner.id,
      syndicate: false,
      stock_number: `${partner.code.toUpperCase()}-${ext}`.slice(0, 40),
      status: availability === 'sold' ? 'available' : STATUS_OF[availability],
    }, VEHICLE_COLUMNS);
    id = created.id;
    await client.query(
      `INSERT INTO external_refs (system, entity_type, external_id, entity_id) VALUES ($1, 'vehicle', $2, $3)`,
      [systemOf(partner), ext, id]);
    action = 'created';
  }

  await applyAvailability(client, partner, id, availability, payload);
  if (Array.isArray(payload.photos)) {
    await client.query('DELETE FROM vehicle_media WHERE vehicle_id = $1', [id]);
    const urls = payload.photos.map(String).filter((u) => /^https?:\/\//.test(u)).slice(0, 30);
    for (let i = 0; i < urls.length; i++) {
      await client.query('INSERT INTO vehicle_media (vehicle_id, url, position, is_primary) VALUES ($1, $2, $3, $4)',
        [id, urls[i], i, i === 0]);
    }
  }
  return { id, action };
}

/** Aplica la disponibilidad que reporta el socio (y refleja su venta si dice "sold"). */
async function applyAvailability(client, partner, vehicleId, availability, payload) {
  const v = await lockVehicle(client, vehicleId);
  const sale = await activeSaleOf(client, vehicleId);

  if (availability === 'sold') {
    if (!sale) {
      await recordPartnerOwnSale(client, partner, v, {
        sale_price: parseNumber(payload.sold_price) ?? v.list_price ?? 0,
        reference: `vehicle:${payload.external_id}`,
        buyer_name: payload.buyer_name,
      });
    }
    return;
  }
  // el socio reabrió la venta en su sistema
  if (sale?.sale_type === 'partner_own') await cancelSale(client, sale.id, 'Cancelada en el sistema del socio');
  // si nosotros lo tenemos apartado, nuestro apartado se respeta
  const { rows: holds } = await client.query(
    "SELECT 1 FROM reservations WHERE vehicle_id = $1 AND status = 'active'", [vehicleId]);
  if (holds.length) return;

  const { rows: [now] } = await client.query('SELECT status FROM vehicles WHERE id = $1', [vehicleId]);
  if (now.status !== STATUS_OF[availability]) {
    await setEventNote(client, `Estado reportado por ${partner.name}`);
    await forceStatus(client, vehicleId, STATUS_OF[availability]);
  }
}

/** Venta que el socio hizo de SU vehículo: sólo se refleja (no es ingreso nuestro). */
export async function recordPartnerOwnSale(client, partner, vehicle, data) {
  await client.query(
    "UPDATE reservations SET status = 'cancelled', notes = concat_ws(' | ', notes, 'Vendido por el socio') WHERE vehicle_id = $1 AND status = 'active'",
    [vehicle.id]);
  const sale = await insertRow(client, 'sales', {
    vehicle_id: vehicle.id,
    sale_type: 'partner_own',
    selling_partner_id: partner.id,
    partner_reference: data.reference,
    buyer_name: data.buyer_name,
    status: 'completed',
    delivered_at: new Date().toISOString(),
    sale_date: data.sale_date,
    currency: vehicle.currency,
    sale_price: data.sale_price,
  }, ['vehicle_id', 'sale_type', 'selling_partner_id', 'partner_reference', 'buyer_name', 'status', 'delivered_at',
    'sale_date', 'currency', 'sale_price']);
  await setEventNote(client, `Vendido por ${partner.name}`);
  await forceStatus(client, vehicle.id, 'delivered');
  return sale;
}

export async function archivePartnerVehicle(client, partner, externalId) {
  const id = await findPartnerVehicle(client, partner, externalId);
  await lockVehicle(client, id);
  const sale = await activeSaleOf(client, id);
  if (sale?.sale_type === 'we_sold_partner') {
    throw conflict('LotesCRM ya vendió este vehículo', { sale_number: sale.sale_number }, 'sold_by_lotescrm');
  }
  if (sale) return { id, action: 'unchanged' };
  await client.query("UPDATE reservations SET status = 'cancelled' WHERE vehicle_id = $1 AND status = 'active'", [id]);
  await setEventNote(client, `Retirado por ${partner.name}`);
  await forceStatus(client, id, 'archived');
  return { id, action: 'archived' };
}
