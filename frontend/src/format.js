const moneyFmt = new Map();

export function money(value, currency = 'MXN', { compact = false } = {}) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const key = `${currency}-${compact}`;
  if (!moneyFmt.has(key)) {
    moneyFmt.set(key, new Intl.NumberFormat('es-MX', {
      style: 'currency', currency, maximumFractionDigits: 0,
      ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}),
    }));
  }
  return moneyFmt.get(key).format(Number(value));
}

const numFmt = new Intl.NumberFormat('es-MX');
export const num = (v) => (v == null ? '—' : numFmt.format(Number(v)));

export const km = (v, unit = 'km') => (v == null ? '—' : `${num(v)} ${unit}`);

export function date(v, opts = { dateStyle: 'medium' }) {
  if (!v) return '—';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  return new Intl.DateTimeFormat('es-MX', opts).format(d);
}

export const dateTime = (v) => date(v, { dateStyle: 'medium', timeStyle: 'short' });

export function relative(v) {
  if (!v) return '—';
  const diff = (new Date(v).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export const VEHICLE_STATUS = {
  incoming: 'En tránsito',
  reconditioning: 'En preparación',
  available: 'Disponible',
  on_hold: 'En pausa',
  reserved: 'Apartado',
  sold: 'Vendido',
  delivered: 'Entregado',
  archived: 'Baja',
};

export const LEAD_STATUS = {
  new: 'Nuevo',
  contacted: 'Contactado',
  qualified: 'Calificado',
  test_drive: 'Prueba de manejo',
  negotiation: 'Negociación',
  won: 'Ganado',
  lost: 'Perdido',
};

export const LEAD_SOURCE = {
  walk_in: 'Visita al lote', website: 'Sitio web', phone: 'Teléfono', referral: 'Referido',
  marketplace: 'Marketplace', social: 'Redes sociales', other: 'Otro',
};

export const SALE_STATUS = { pending: 'Por entregar', completed: 'Entregada', cancelled: 'Cancelada' };

export const SALE_TYPE = {
  direct: 'Venta propia',
  partner_sold_ours: 'Socio vendió lo nuestro',
  we_sold_partner: 'Vendimos de un socio',
  partner_own: 'Venta del socio (reflejada)',
};

export const PAYMENT_METHOD = {
  cash: 'Contado', financing: 'Financiamiento', transfer: 'Transferencia', card: 'Tarjeta',
  mixed: 'Mixto', other: 'Otro', check: 'Cheque',
};

export const BODY_TYPE = {
  sedan: 'Sedán', suv: 'SUV', pickup: 'Pickup', hatchback: 'Hatchback', coupe: 'Coupé',
  convertible: 'Convertible', van: 'Van', minivan: 'Minivan', wagon: 'Vagoneta', truck: 'Camión',
  motorcycle: 'Motocicleta', other: 'Otro',
};
export const FUEL = {
  gasoline: 'Gasolina', diesel: 'Diésel', hybrid: 'Híbrido', plug_in_hybrid: 'Híbrido enchufable',
  electric: 'Eléctrico', lpg: 'Gas LP', cng: 'Gas natural', other: 'Otro',
};
export const TRANSMISSION = { manual: 'Manual', automatic: 'Automática', cvt: 'CVT', dct: 'Doble embrague', other: 'Otra' };
export const DRIVETRAIN = { fwd: 'Delantera', rwd: 'Trasera', awd: 'Integral (AWD)', '4wd': '4x4', other: 'Otra' };
export const CONDITION = { new: 'Nuevo', used: 'Seminuevo', certified: 'Certificado' };
export const COST_CATEGORY = {
  reconditioning: 'Reacondicionamiento', transport: 'Traslado', fees: 'Trámites', parts: 'Refacciones',
  labor: 'Mano de obra', detailing: 'Detallado', inspection: 'Inspección', other: 'Otro',
};
export const ACTIVITY_TYPE = {
  call: 'Llamada', email: 'Correo', whatsapp: 'WhatsApp', meeting: 'Cita', test_drive: 'Prueba de manejo',
  note: 'Nota', task: 'Tarea',
};

export const MX_STATES = [
  'Aguascalientes', 'Baja California', 'Baja California Sur', 'Campeche', 'Chiapas', 'Chihuahua',
  'Ciudad de México', 'Coahuila', 'Colima', 'Durango', 'Estado de México', 'Guanajuato', 'Guerrero', 'Hidalgo',
  'Jalisco', 'Michoacán', 'Morelos', 'Nayarit', 'Nuevo León', 'Oaxaca', 'Puebla', 'Querétaro', 'Quintana Roo',
  'San Luis Potosí', 'Sinaloa', 'Sonora', 'Tabasco', 'Tamaulipas', 'Tlaxcala', 'Veracruz', 'Yucatán', 'Zacatecas',
];

export const vehicleLabel =(v) => [v.make, v.model, v.year, v.trim].filter(Boolean).join(' ');
