// Lógica de inventario: ciclo de vida del vehículo, apartados y ventas.
// Todas las funciones reciben un `client` dentro de una transacción y
// bloquean la fila del vehículo (SELECT ... FOR UPDATE) para evitar que dos
// vendedores (nuestros o de un socio) vendan la misma unidad.
//
// Vehículos de socios (owner_partner_id): su estado lo controla el socio por API.
// Aquí sólo se pueden apartar y vender (cobrando comisión), no editar.
import { config } from '../config.js';
import { insertRow, setEventNote, updateById } from '../db.js';
import { HttpError, conflict, notFound } from '../http.js';
import { resolveMakeModel } from './catalog.js';
import { normVin } from './normalize.js';

export const VEHICLE_COLUMNS = [
  'stock_number', 'vin', 'plate_number', 'lot_id', 'owner_partner_id', 'syndicate', 'make_id', 'model_id', 'year',
  'trim', 'body_type', 'exterior_color', 'interior_color', 'odometer', 'odometer_unit', 'fuel_type', 'transmission',
  'drivetrain', 'engine', 'cylinders', 'displacement_l', 'doors', 'seats', 'condition', 'title_status',
  'owners_count', 'status', 'currency', 'acquisition_cost', 'acquisition_source', 'acquired_at', 'list_price',
  'min_price', 'description', 'features', 'attributes',
];
const VEHICLE_EDITABLE = VEHICLE_COLUMNS.filter((c) => !['status', 'owner_partner_id'].includes(c));

/** Estados que sólo se alcanzan mediante el flujo de apartado/venta. */
const FLOW_STATUSES = ['reserved', 'sold', 'delivered'];

export const SALE_COLUMNS = [
  'vehicle_id', 'contact_id', 'lead_id', 'reservation_id', 'salesperson_id', 'sale_type', 'selling_partner_id',
  'partner_reference', 'buyer_name', 'commission_amount', 'status', 'sale_date', 'currency', 'sale_price',
  'discount_amount', 'fees_amount', 'tax_amount', 'cost_at_sale', 'down_payment', 'payment_method',
  'financing_institution', 'financing_term_months', 'financing_rate', 'trade_in_vehicle_id', 'trade_in_value',
  'delivered_at', 'notes', 'attributes',
];

export async function lockVehicle(client, id) {
  const { rows } = await client.query('SELECT * FROM vehicles WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Vehículo');
  return rows[0];
}

const partnerOwned = (v) => v.owner_partner_id != null;

function assertOwn(v, action) {
  if (partnerOwned(v)) {
    throw conflict(`Este vehículo pertenece a un socio: no se puede ${action} desde LotesCRM`, undefined, 'partner_owned');
  }
}

/** Cambia el estado sin validar la máquina de estados (vehículos de socios: ellos mandan). */
export async function forceStatus(client, id, status) {
  await client.query("SELECT set_config('app.skip_transition_check', 'on', true)");
  const { rows } = await client.query('UPDATE vehicles SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
  await client.query("SELECT set_config('app.skip_transition_check', 'off', true)");
  return rows[0];
}

export async function allowedTransitions(client, fromStatus) {
  const { rows } = await client.query(
    'SELECT to_status FROM vehicle_status_transitions WHERE from_status = $1', [fromStatus]);
  return rows.map((r) => r.to_status);
}

/** Transiciones que el usuario puede disparar manualmente desde la ficha. */
export async function manualTransitions(client, vehicle) {
  if (partnerOwned(vehicle) || FLOW_STATUSES.includes(vehicle.status)) return [];
  return (await allowedTransitions(client, vehicle.status)).filter((s) => !FLOW_STATUSES.includes(s));
}

async function totalCost(client, vehicleId) {
  const { rows } = await client.query('SELECT total_cost FROM v_inventory WHERE id = $1', [vehicleId]);
  return rows[0]?.total_cost ?? null;
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------
// Alta / edición
// ---------------------------------------------------------------------
export async function createVehicle(client, data) {
  const ids = data.make_id && data.model_id
    ? { make_id: data.make_id, model_id: data.model_id }
    : await resolveMakeModel(client, data.make, data.model);
  const status = data.status ?? 'incoming';
  if (FLOW_STATUSES.includes(status)) {
    throw new HttpError(400, 'Un vehículo nuevo no puede darse de alta como apartado o vendido');
  }
  if (status === 'available' && data.list_price == null) {
    throw new HttpError(400, 'Para darlo de alta como disponible necesita precio de lista');
  }
  const { owner_partner_id: _ignored, ...rest } = data;
  return insertRow(client, 'vehicles', { ...rest, ...ids, vin: normVin(data.vin), status }, VEHICLE_COLUMNS);
}

export async function updateVehicle(client, id, data) {
  const v = await lockVehicle(client, id);
  assertOwn(v, 'editar (los cambios llegan desde el sistema del socio)');
  const patch = { ...data };
  if (patch.vin !== undefined) patch.vin = normVin(patch.vin);
  if (patch.make || patch.model) {
    Object.assign(patch, await resolveMakeModel(client, patch.make, patch.model));
  }
  if (['sold', 'delivered'].includes(v.status) && patch.list_price !== undefined && patch.list_price !== v.list_price) {
    throw conflict('No se puede cambiar el precio de un vehículo vendido');
  }
  if (v.status === 'available' && patch.list_price === null) {
    throw conflict('Un vehículo disponible debe tener precio de lista');
  }
  if (patch.list_price !== undefined && patch.list_price !== v.list_price) {
    await setEventNote(client, patch.price_note ?? 'Ajuste de precio');
  }
  return updateById(client, 'vehicles', id, patch, VEHICLE_EDITABLE);
}

// ---------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------
export async function changeStatus(client, id, to, notes) {
  const v = await lockVehicle(client, id);
  assertOwn(v, 'cambiar su estado');
  if (v.status === to) return v;
  if (FLOW_STATUSES.includes(to)) {
    throw conflict(`El estado "${to}" sólo se asigna desde un apartado o una venta`);
  }
  if (FLOW_STATUSES.includes(v.status)) {
    throw conflict('Primero cancela el apartado o la venta para liberar el vehículo');
  }
  const allowed = await allowedTransitions(client, v.status);
  if (!allowed.includes(to)) {
    throw conflict(`No se puede pasar de "${v.status}" a "${to}"`, { allowed }, 'invalid_transition');
  }
  if (to === 'available' && v.list_price == null) {
    throw conflict('Asigna un precio de lista antes de ponerlo a la venta');
  }
  await setEventNote(client, notes);
  const { rows } = await client.query('UPDATE vehicles SET status = $2 WHERE id = $1 RETURNING *', [id, to]);
  return rows[0];
}

export async function transferVehicle(client, id, lotId, notes) {
  const v = await lockVehicle(client, id);
  assertOwn(v, 'trasladar');
  if (['sold', 'delivered', 'archived'].includes(v.status)) {
    throw conflict('Sólo se pueden trasladar vehículos en inventario');
  }
  if (v.lot_id === lotId) return v;
  await setEventNote(client, notes ?? 'Traslado entre lotes');
  const { rows } = await client.query('UPDATE vehicles SET lot_id = $2 WHERE id = $1 RETURNING *', [id, lotId]);
  return rows[0];
}

export async function addCost(client, vehicleId, data) {
  const v = await lockVehicle(client, vehicleId);
  assertOwn(v, 'registrar costos');
  if (['delivered', 'archived'].includes(v.status)) {
    throw conflict('No se pueden agregar costos a un vehículo entregado o dado de baja');
  }
  return insertRow(client, 'vehicle_costs', { ...data, vehicle_id: vehicleId },
    ['vehicle_id', 'category', 'description', 'vendor', 'amount', 'incurred_at']);
}

// ---------------------------------------------------------------------
// Apartados
// ---------------------------------------------------------------------
export async function reserveVehicle(client, data) {
  const v = await lockVehicle(client, data.vehicle_id);
  if (v.status !== 'available') {
    throw conflict(`Sólo se pueden apartar vehículos disponibles (estado actual: ${v.status})`,
      { status: v.status }, 'not_available');
  }
  const days = data.days ?? config.reservationDays;
  const expiresAt = data.expires_at ?? new Date(Date.now() + days * 86_400_000).toISOString();

  const reservation = await insertRow(client, 'reservations', {
    ...data, currency: v.currency, expires_at: expiresAt,
  }, ['vehicle_id', 'contact_id', 'lead_id', 'user_id', 'deposit_amount', 'currency', 'expires_at', 'notes']);

  await setEventNote(client, `Apartado hasta ${new Date(expiresAt).toLocaleDateString('es-MX')}`);
  await client.query("UPDATE vehicles SET status = 'reserved' WHERE id = $1", [v.id]);

  if (data.lead_id) {
    await client.query(
      `UPDATE leads SET status = 'negotiation', vehicle_id = coalesce(vehicle_id, $2)
       WHERE id = $1 AND status NOT IN ('won','lost')`, [data.lead_id, v.id]);
  }
  return reservation;
}

export async function cancelReservation(client, id, reason) {
  const { rows } = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [id]);
  const r = rows[0];
  if (!r) throw notFound('Apartado');
  if (r.status !== 'active') throw conflict(`El apartado ya está ${r.status}`, undefined, 'not_active');

  await client.query(
    `UPDATE reservations SET status = 'cancelled', notes = concat_ws(' | ', notes, $2::text) WHERE id = $1`,
    [id, reason ?? null]);
  const v = await lockVehicle(client, r.vehicle_id);
  if (v.status === 'reserved') {
    await setEventNote(client, `Apartado cancelado${reason ? `: ${reason}` : ''}`);
    await client.query("UPDATE vehicles SET status = 'available' WHERE id = $1", [v.id]);
  }
  return { ...r, status: 'cancelled' };
}

export async function expireReservations(client) {
  const { rows } = await client.query('SELECT expire_reservations() AS n');
  return rows[0].n;
}

// ---------------------------------------------------------------------
// Ventas
// ---------------------------------------------------------------------
/**
 * Registra una venta sobre un vehículo disponible o apartado.
 * - Venta nuestra de un vehículo propio ............ sale_type 'direct'
 * - Venta nuestra de un vehículo de socio .......... 'we_sold_partner' (comisión a cobrar)
 * - Venta de un socio sobre un vehículo nuestro .... 'partner_sold_ours' (comisión a pagar)
 *   (data.selling_partner = { id, name, commission_pct })
 */
export async function createSale(client, data, userId) {
  const v = await lockVehicle(client, data.vehicle_id);
  const seller = data.selling_partner ?? null;
  if (!['available', 'reserved'].includes(v.status)) {
    throw conflict(`El vehículo no está a la venta (estado actual: ${v.status})`, { status: v.status }, 'not_available');
  }
  if (seller && partnerOwned(v)) {
    throw conflict('Un socio sólo puede vender aquí vehículos propios de LotesCRM', undefined, 'not_shared');
  }

  // ¿Quién lo tiene apartado?
  let reservation = null;
  if (v.status === 'reserved') {
    const { rows } = await client.query(
      "SELECT * FROM reservations WHERE vehicle_id = $1 AND status = 'active' FOR UPDATE", [v.id]);
    reservation = rows[0] ?? null;
    if (!reservation && partnerOwned(v)) {
      throw conflict('El socio tiene este vehículo apartado en su sistema', undefined, 'held_by_other');
    }
    // un auto apartado sólo lo compra ese cliente (un socio nunca puede saltarse el apartado)
    if (reservation && (seller || (reservation.contact_id !== data.contact_id && !data.override_reservation))) {
      throw conflict('El vehículo está apartado para otro cliente',
        seller ? undefined : { reservation_id: reservation.id, requires: 'override_reservation' }, 'held_by_other');
    }
  }

  const net = data.sale_price - (data.discount_amount ?? 0);
  if (v.min_price != null && net < v.min_price && (seller || !data.approve_below_min)) {
    throw conflict(
      seller ? 'El precio está por debajo del mínimo autorizado' : `El precio neto (${net}) está por debajo del mínimo autorizado (${v.min_price})`,
      seller ? undefined : { min_price: v.min_price, requires: 'approve_below_min' },
      'below_minimum');
  }

  // Tipo de venta y comisión
  let saleType = 'direct';
  let commission;
  let costAtSale = await totalCost(client, v.id);
  if (seller) {
    saleType = 'partner_sold_ours';
    commission = round2(net * (seller.commission_pct / 100));
  } else if (partnerOwned(v)) {
    saleType = 'we_sold_partner';
    const { rows: [owner] } = await client.query('SELECT commission_pct FROM partners WHERE id = $1', [v.owner_partner_id]);
    commission = round2(net * ((owner?.commission_pct ?? 0) / 100));
    costAtSale = null;
  }

  // Auto recibido a cuenta: entra al inventario propio como "incoming"
  let tradeIn = null;
  if (data.trade_in && !seller) {
    await setEventNote(client, 'Recibido a cuenta de venta');
    tradeIn = await createVehicle(client, {
      ...data.trade_in,
      lot_id: data.trade_in.lot_id ?? v.lot_id,
      status: 'incoming',
      acquisition_source: 'trade_in',
      acquisition_cost: data.trade_in.value,
      acquired_at: new Date().toISOString().slice(0, 10),
      currency: v.currency,
    });
  }

  if (reservation) {
    await client.query('UPDATE reservations SET status = $2 WHERE id = $1',
      [reservation.id, reservation.contact_id === data.contact_id ? 'converted' : 'cancelled']);
  }

  const { selling_partner: _s, trade_in: _t, ...fields } = data;
  const sale = await insertRow(client, 'sales', {
    ...fields,
    sale_type: saleType,
    selling_partner_id: seller?.id,
    commission_amount: commission,
    currency: v.currency,
    cost_at_sale: costAtSale,
    reservation_id: reservation?.id,
    lead_id: data.lead_id ?? reservation?.lead_id ?? undefined,
    salesperson_id: seller ? undefined : (data.salesperson_id ?? userId),
    trade_in_vehicle_id: tradeIn?.id,
    trade_in_value: tradeIn ? data.trade_in.value : undefined,
  }, SALE_COLUMNS);

  if (sale.down_payment > 0) {
    await client.query(
      'INSERT INTO sale_payments (sale_id, amount, method, reference) VALUES ($1, $2, $3, $4)',
      [sale.id, sale.down_payment, paymentMethodOf(sale.payment_method), 'Enganche']);
  }
  if (reservation?.deposit_amount > 0 && sale.reservation_id) {
    await client.query(
      'INSERT INTO sale_payments (sale_id, amount, method, reference, paid_at) VALUES ($1, $2, $3, $4, $5)',
      [sale.id, reservation.deposit_amount, 'other', 'Anticipo de apartado', reservation.reserved_at]);
  }
  if (tradeIn) {
    await client.query(
      'INSERT INTO sale_payments (sale_id, amount, method, reference) VALUES ($1, $2, $3, $4)',
      [sale.id, data.trade_in.value, 'other', `Auto a cuenta ${tradeIn.stock_number}`]);
  }

  await setEventNote(client, `Venta ${sale.sale_number}${seller ? ` por ${seller.name}` : ''}`);
  await client.query("UPDATE vehicles SET status = 'sold' WHERE id = $1", [v.id]);

  if (sale.lead_id) {
    await client.query("UPDATE leads SET status = 'won', closed_at = now() WHERE id = $1", [sale.lead_id]);
  }
  return sale;
}

const paymentMethodOf = (m) => (['cash', 'transfer', 'card', 'financing'].includes(m) ? m : 'other');

async function lockSale(client, id) {
  const { rows } = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Venta');
  return rows[0];
}

export async function deliverSale(client, id) {
  const sale = await lockSale(client, id);
  if (sale.status !== 'pending') throw conflict(`La venta ya está ${sale.status}`, undefined, 'invalid_state');
  await lockVehicle(client, sale.vehicle_id);
  await setEventNote(client, `Entrega de venta ${sale.sale_number}`);
  await client.query("UPDATE vehicles SET status = 'delivered' WHERE id = $1", [sale.vehicle_id]);
  const { rows } = await client.query(
    "UPDATE sales SET status = 'completed', delivered_at = now() WHERE id = $1 RETURNING *", [id]);
  return rows[0];
}

export async function cancelSale(client, id, reason) {
  const sale = await lockSale(client, id);
  if (sale.status === 'cancelled') throw conflict('La venta ya está cancelada', undefined, 'invalid_state');
  if (sale.status === 'completed' && sale.sale_type !== 'partner_own') {
    throw conflict('Una venta entregada no se puede cancelar; registra la devolución como nueva compra', undefined, 'invalid_state');
  }
  await lockVehicle(client, sale.vehicle_id);
  await setEventNote(client, `Venta ${sale.sale_number} cancelada${reason ? `: ${reason}` : ''}`);
  if (sale.sale_type === 'partner_own') await forceStatus(client, sale.vehicle_id, 'available');
  else await client.query("UPDATE vehicles SET status = 'available' WHERE id = $1", [sale.vehicle_id]);

  if (sale.trade_in_vehicle_id) {
    // El auto a cuenta se regresa al cliente: se da de baja si aún no se ha vendido
    await setEventNote(client, `Devuelto al cliente por cancelación de ${sale.sale_number}`);
    await client.query(
      `UPDATE vehicles SET status = 'archived'
       WHERE id = $1 AND status IN ('incoming','reconditioning','available','on_hold')`,
      [sale.trade_in_vehicle_id]);
  }
  if (sale.lead_id) {
    await client.query("UPDATE leads SET status = 'negotiation', closed_at = NULL WHERE id = $1 AND status = 'won'", [sale.lead_id]);
  }
  const { rows } = await client.query(
    "UPDATE sales SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1 RETURNING *",
    [id, reason ?? null]);
  return rows[0];
}

export async function addPayment(client, saleId, data) {
  const sale = await lockSale(client, saleId);
  if (sale.status === 'cancelled') throw conflict('No se pueden registrar pagos en una venta cancelada');
  return insertRow(client, 'sale_payments', { ...data, sale_id: saleId },
    ['sale_id', 'amount', 'method', 'reference', 'paid_at']);
}

// ---------------------------------------------------------------------
// Valuación con datos de mercado
// ---------------------------------------------------------------------
export async function valueVehicle(client, vehicleId) {
  const { rows } = await client.query('SELECT * FROM value_vehicle($1)', [vehicleId]);
  return rows[0]?.id ? rows[0] : null;
}

export async function revalueInventory(client) {
  const { rows } = await client.query(`
    SELECT count(*) FILTER (WHERE r.id IS NOT NULL) AS valued, count(*) AS total
    FROM vehicles v
    JOIN vehicle_statuses s ON s.code = v.status AND s.is_in_stock
    CROSS JOIN LATERAL value_vehicle(v.id) r`);
  return rows[0];
}
