// Importador genérico para migrar datos desde otros sistemas (CSV / JSON).
// - Cada entidad declara sus campos canónicos con sinónimos para auto-mapear columnas.
// - Los valores se normalizan (enums en español/inglés, números con formato, fechas dd/mm/aaaa).
// - Las columnas NO mapeadas se guardan en `attributes` (jsonb): no se pierde información.
// - external_refs guarda (sistema, id origen) -> id local, así re-importar actualiza en vez de duplicar.
import { parse as parseCsv } from 'csv-parse/sync';
import { pool, query, insertRow, updateById } from '../db.js';
import { HttpError } from '../http.js';
import { upsertListing } from '../ingestion/runner.js';
import { resolveMakeModel } from './catalog.js';
import { VEHICLE_COLUMNS } from './inventory.js';
import { normEnum, normKey, normVin, parseBool, parseDate, parseNumber } from './normalize.js';

const f = (key, label, aliases = [], extra = {}) => ({ key, label, aliases, ...extra });

export const ENTITIES = {
  vehicles: [
    f('external_id', 'ID en sistema origen', ['id', 'codigo', 'clave', 'id vehiculo']),
    f('vin', 'VIN / Número de serie', ['numero de serie', 'no serie', 'serie', 'niv', 'chasis']),
    f('stock_number', 'No. de inventario', ['stock', 'inventario', 'no inventario', 'no economico']),
    f('make', 'Marca', ['marca', 'brand', 'fabricante'], { required: true }),
    f('model', 'Modelo', ['modelo', 'submarca', 'linea', 'model name'], { required: true }),
    f('year', 'Año', ['ano', 'anio', 'year', 'model year', 'ano modelo'], { required: true }),
    f('trim', 'Versión', ['version', 'trim', 'acabado', 'paquete']),
    f('body_type', 'Carrocería', ['carroceria', 'tipo', 'body', 'segmento']),
    f('exterior_color', 'Color exterior', ['color', 'color exterior']),
    f('interior_color', 'Color interior', ['color interior', 'vestiduras']),
    f('odometer', 'Kilometraje', ['km', 'kms', 'kilometraje', 'millaje', 'mileage', 'odometro']),
    f('odometer_unit', 'Unidad (km/mi)', ['unidad', 'unidad km']),
    f('fuel_type', 'Combustible', ['combustible', 'fuel']),
    f('transmission', 'Transmisión', ['transmision', 'caja']),
    f('drivetrain', 'Tracción', ['traccion', 'drive', 'drive type']),
    f('engine', 'Motor', ['motor']),
    f('doors', 'Puertas', ['puertas']),
    f('seats', 'Asientos', ['asientos', 'pasajeros']),
    f('condition', 'Condición (nuevo/usado)', ['condicion', 'estado fisico', 'nuevo usado']),
    f('status', 'Estatus inventario', ['estatus', 'status', 'situacion', 'estado']),
    f('plate_number', 'Placas', ['placas', 'placa', 'matricula']),
    f('currency', 'Moneda', ['moneda']),
    f('acquisition_cost', 'Costo de adquisición', ['costo', 'costo compra', 'precio compra', 'cost']),
    f('acquired_at', 'Fecha de compra', ['fecha compra', 'fecha ingreso', 'fecha alta']),
    f('list_price', 'Precio de lista', ['precio', 'precio venta', 'precio lista', 'price']),
    f('min_price', 'Precio mínimo', ['precio minimo', 'piso']),
    f('lot_code', 'Lote / sucursal', ['lote', 'sucursal', 'ubicacion', 'patio']),
    f('description', 'Descripción', ['descripcion', 'comentarios', 'observaciones']),
    f('features', 'Equipamiento (separado por ;)', ['equipamiento', 'extras', 'features']),
  ],
  contacts: [
    f('external_id', 'ID en sistema origen', ['id', 'codigo', 'clave', 'id cliente']),
    f('full_name', 'Nombre completo', ['nombre completo', 'cliente', 'full name']),
    f('first_name', 'Nombre(s)', ['nombre', 'nombres', 'first name']),
    f('last_name', 'Apellidos', ['apellido', 'apellidos', 'last name']),
    f('company_name', 'Empresa / Razón social', ['empresa', 'razon social', 'compania']),
    f('email', 'Correo', ['correo', 'email', 'e mail', 'mail']),
    f('phone', 'Teléfono', ['telefono', 'tel', 'phone']),
    f('mobile', 'Celular', ['celular', 'movil', 'whatsapp']),
    f('tax_id', 'RFC / ID fiscal', ['rfc', 'nit', 'rut', 'tax id']),
    f('address_line', 'Dirección', ['direccion', 'domicilio', 'calle']),
    f('city', 'Ciudad', ['ciudad', 'municipio']),
    f('state', 'Estado', ['estado', 'provincia']),
    f('postal_code', 'Código postal', ['cp', 'codigo postal', 'zip']),
    f('source', 'Origen', ['origen', 'fuente', 'medio']),
    f('marketing_opt_in', 'Acepta publicidad', ['acepta publicidad', 'opt in']),
    f('notes', 'Notas', ['notas', 'comentarios', 'observaciones']),
  ],
  market_listings: [
    f('external_id', 'ID del anuncio', ['id', 'id anuncio'], { required: true }),
    f('title', 'Título', ['titulo', 'anuncio']),
    f('url', 'URL', ['link', 'enlace', 'url']),
    f('make', 'Marca', ['marca']),
    f('model', 'Modelo', ['modelo', 'submarca']),
    f('year', 'Año', ['ano', 'anio']),
    f('odometer', 'Kilometraje', ['km', 'kilometraje']),
    f('price', 'Precio', ['precio'], { required: true }),
    f('currency', 'Moneda', ['moneda']),
    f('location_city', 'Ciudad', ['ciudad', 'ubicacion']),
    f('location_state', 'Estado', ['estado']),
  ],
};

// ---------------------------------------------------------------------
// Lectura de archivos
// ---------------------------------------------------------------------
function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('latin1').decode(buffer); // CSV exportado por Excel en Windows
  }
}

export function readRows(file) {
  const text = decode(file.buffer).replace(/^﻿/, '');
  if (/\.json$/i.test(file.originalname) || /^\s*[[{]/.test(text)) {
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : data.rows ?? data.data ?? [];
    if (!Array.isArray(rows)) throw new HttpError(400, 'El JSON debe ser un arreglo de objetos');
    return rows;
  }
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = [',', ';', '\t', '|']
    .map((d) => [d, firstLine.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];
  return parseCsv(text, {
    columns: true, delimiter, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true,
  });
}

export function suggestMapping(entity, headers) {
  const fields = ENTITIES[entity];
  const used = new Set();
  const mapping = {};
  for (const field of fields) {
    const candidates = [field.key, field.label, ...field.aliases].map(normKey);
    const header = headers.find((h) => !used.has(h) && candidates.includes(normKey(h)));
    if (header) {
      mapping[field.key] = header;
      used.add(header);
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------
// Importación
// ---------------------------------------------------------------------
export async function runImport({ entity, rows, mapping, system, fileName, dryRun }) {
  const fields = ENTITIES[entity];
  if (!fields) throw new HttpError(400, `Entidad no soportada: ${entity}`);
  if (!system) throw new HttpError(400, 'Indica el nombre del sistema origen (system)');
  const missing = fields.filter((fl) => fl.required && !mapping[fl.key]).map((fl) => fl.label);
  if (missing.length) {
    throw new HttpError(400, `Faltan columnas obligatorias: ${missing.join(', ')}`);
  }

  const mappedHeaders = new Set(Object.values(mapping));
  const result = { total_rows: rows.length, inserted: 0, updated: 0, failed: 0, errors: [] };
  const client = await pool.connect();
  let batchId = null;
  try {
    if (!dryRun) {
      const { rows: [b] } = await client.query(
        `INSERT INTO import_batches (entity_type, system, file_name, mapping, total_rows)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [entity, system, fileName ?? null, JSON.stringify(mapping), rows.length]);
      batchId = b.id;
    }

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.skip_transition_check', 'on', true)");
    await client.query("SELECT set_config('app.event_note', $1, true)", [`Importado desde ${system}`]);

    const handler = { vehicles: importVehicle, contacts: importContact, market_listings: importListing }[entity];
    const ctx = { client, system, dryRun, lotCache: new Map(), source: null };

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const data = {};
      for (const [key, header] of Object.entries(mapping)) {
        if (header && raw[header] !== undefined && raw[header] !== '') data[key] = raw[header];
      }
      const extras = Object.fromEntries(
        Object.entries(raw).filter(([h, v]) => !mappedHeaders.has(h) && v !== '' && v != null));

      await client.query('SAVEPOINT row_sp');
      try {
        const action = await handler(ctx, data, extras, raw);
        result[action] += 1;
        await client.query('RELEASE SAVEPOINT row_sp');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT row_sp');
        result.failed += 1;
        if (result.errors.length < 200) result.errors.push({ row: i + 2, error: err.message });
      }
    }

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (batchId) {
      const status = result.failed === 0 ? 'success' : (result.inserted + result.updated > 0 ? 'partial' : 'failed');
      await client.query(
        `UPDATE import_batches SET status = $2, inserted = $3, updated = $4, failed = $5, errors = $6,
           finished_at = now() WHERE id = $1`,
        [batchId, status, result.inserted, result.updated, result.failed, JSON.stringify(result.errors)]);
    }
    client.release();
  }
  return { ...result, batch_id: batchId, dry_run: Boolean(dryRun) };
}

async function findRef(client, system, entityType, externalId) {
  if (!externalId) return null;
  const { rows } = await client.query(
    'SELECT entity_id FROM external_refs WHERE system = $1 AND entity_type = $2 AND external_id = $3',
    [system, entityType, String(externalId)]);
  return rows[0]?.entity_id ?? null;
}

async function saveRef(client, system, entityType, externalId, entityId, raw) {
  if (!externalId) return;
  await client.query(
    `INSERT INTO external_refs (system, entity_type, external_id, entity_id, raw) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (system, entity_type, external_id) DO UPDATE SET entity_id = EXCLUDED.entity_id,
       raw = EXCLUDED.raw, imported_at = now()`,
    [system, entityType, String(externalId), entityId, JSON.stringify(raw)]);
}

async function lotIdFor(ctx, code) {
  if (!code) return undefined;
  const key = String(code).trim();
  if (ctx.lotCache.has(key)) return ctx.lotCache.get(key);
  const { rows } = await ctx.client.query(
    `INSERT INTO lots (code, name) VALUES ($1, $1)
     ON CONFLICT (code) DO UPDATE SET code = lots.code RETURNING id`, [key]);
  ctx.lotCache.set(key, rows[0].id);
  return rows[0].id;
}

async function importVehicle(ctx, d, extras, raw) {
  const { client, system } = ctx;
  const year = parseNumber(d.year);
  if (!d.make || !d.model || !year) throw new Error('Marca, modelo y año son obligatorios');

  const listPrice = parseNumber(d.list_price);
  const vehicle = {
    ...(await resolveMakeModel(client, d.make, d.model)),
    vin: normVin(d.vin) ?? undefined,
    stock_number: d.stock_number,
    year: Math.trunc(year),
    trim: d.trim,
    body_type: normEnum('body_type', d.body_type) ?? undefined,
    exterior_color: d.exterior_color,
    interior_color: d.interior_color,
    odometer: parseNumber(d.odometer) != null ? Math.round(parseNumber(d.odometer)) : undefined,
    odometer_unit: normEnum('odometer_unit', d.odometer_unit) ?? undefined,
    fuel_type: normEnum('fuel_type', d.fuel_type) ?? undefined,
    transmission: normEnum('transmission', d.transmission) ?? undefined,
    drivetrain: normEnum('drivetrain', d.drivetrain) ?? undefined,
    engine: d.engine,
    doors: parseNumber(d.doors) ?? undefined,
    seats: parseNumber(d.seats) ?? undefined,
    condition: normEnum('condition', d.condition) ?? undefined,
    status: normEnum('status', d.status) ?? (listPrice != null ? 'available' : 'incoming'),
    plate_number: d.plate_number,
    currency: d.currency ? String(d.currency).toUpperCase().slice(0, 3) : undefined,
    acquisition_cost: parseNumber(d.acquisition_cost) ?? undefined,
    acquired_at: parseDate(d.acquired_at) ?? undefined,
    list_price: listPrice ?? undefined,
    min_price: parseNumber(d.min_price) ?? undefined,
    lot_id: await lotIdFor(ctx, d.lot_code),
    description: d.description,
    features: d.features ? String(d.features).split(/[;|,]/).map((s) => s.trim()).filter(Boolean) : undefined,
  };
  if (vehicle.vin && !/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vehicle.vin)) {
    extras.vin_original = d.vin;
    vehicle.vin = undefined;
  }

  let id = await findRef(client, system, 'vehicle', d.external_id);
  if (!id && vehicle.vin) id = (await client.query('SELECT id FROM vehicles WHERE vin = $1', [vehicle.vin])).rows[0]?.id;
  if (!id && vehicle.stock_number) {
    id = (await client.query('SELECT id FROM vehicles WHERE stock_number = $1', [vehicle.stock_number])).rows[0]?.id;
  }

  let action;
  if (id) {
    const { rows: [cur] } = await client.query('SELECT attributes FROM vehicles WHERE id = $1', [id]);
    vehicle.attributes = { ...cur.attributes, ...extras };
    await updateById(client, 'vehicles', id, vehicle, VEHICLE_COLUMNS);
    action = 'updated';
  } else {
    vehicle.attributes = extras;
    id = (await insertRow(client, 'vehicles', vehicle, VEHICLE_COLUMNS)).id;
    action = 'inserted';
  }
  await saveRef(client, system, 'vehicle', d.external_id, id, raw);
  return action;
}

const CONTACT_COLUMNS = ['contact_type', 'first_name', 'last_name', 'company_name', 'email', 'phone', 'mobile',
  'tax_id', 'address_line', 'city', 'state', 'postal_code', 'source', 'marketing_opt_in', 'notes', 'attributes'];

async function importContact(ctx, d, extras, raw) {
  const { client, system } = ctx;
  let { first_name: first, last_name: last } = d;
  if (!first && d.full_name) {
    const parts = String(d.full_name).trim().split(/\s+/);
    first = parts.length > 2 ? parts.slice(0, -2).join(' ') : parts[0];
    last = parts.length > 2 ? parts.slice(-2).join(' ') : parts.slice(1).join(' ') || undefined;
  }
  const isCompany = !first && d.company_name;
  if (!first && !isCompany) throw new Error('El contacto necesita nombre o razón social');

  const contact = {
    contact_type: isCompany ? 'company' : 'person',
    first_name: first, last_name: last, company_name: d.company_name,
    email: d.email ? String(d.email).trim().toLowerCase() : undefined,
    phone: d.phone ? String(d.phone).replace(/[^\d+]/g, '') : undefined,
    mobile: d.mobile ? String(d.mobile).replace(/[^\d+]/g, '') : undefined,
    tax_id: d.tax_id ? String(d.tax_id).toUpperCase().trim() : undefined,
    address_line: d.address_line, city: d.city, state: d.state, postal_code: d.postal_code,
    source: d.source ?? `import:${system}`,
    marketing_opt_in: parseBool(d.marketing_opt_in) ?? undefined,
    notes: d.notes,
  };

  let id = await findRef(client, system, 'contact', d.external_id);
  if (!id && contact.email) id = (await client.query('SELECT id FROM contacts WHERE email = $1', [contact.email])).rows[0]?.id;
  if (!id && contact.phone) id = (await client.query('SELECT id FROM contacts WHERE phone = $1', [contact.phone])).rows[0]?.id;

  let action;
  if (id) {
    const { rows: [cur] } = await client.query('SELECT attributes FROM contacts WHERE id = $1', [id]);
    contact.attributes = { ...cur.attributes, ...extras };
    await updateById(client, 'contacts', id, contact, CONTACT_COLUMNS);
    action = 'updated';
  } else {
    contact.attributes = extras;
    id = (await insertRow(client, 'contacts', contact, CONTACT_COLUMNS)).id;
    action = 'inserted';
  }
  await saveRef(client, system, 'contact', d.external_id, id, raw);
  return action;
}

async function importListing(ctx, d, extras) {
  const price = parseNumber(d.price);
  if (!price) throw new Error('Precio inválido');
  if (!d.external_id) throw new Error('Falta el ID del anuncio');
  if (ctx.dryRun) return 'inserted';

  if (!ctx.source) {
    const code = `import_${normKey(ctx.system)}`;
    const { rows } = await query(
      `INSERT INTO data_sources (code, name, kind, provider, is_enabled) VALUES ($1, $2, 'file', 'manual', false)
       ON CONFLICT (code) DO UPDATE SET code = data_sources.code RETURNING *`,
      [code, `Archivo importado: ${ctx.system}`]);
    ctx.source = rows[0];
  }
  // upsertListing usa su propia conexión: el anuncio queda fuera de la transacción del lote
  const inserted = await upsertListing(ctx.source, {
    external_id: d.external_id, title: d.title, url: d.url, make: d.make, model: d.model,
    year: parseNumber(d.year), odometer: parseNumber(d.odometer), price,
    currency: d.currency?.toUpperCase(), location_city: d.location_city, location_state: d.location_state,
    raw: extras,
  });
  return inserted ? 'inserted' : 'updated';
}
