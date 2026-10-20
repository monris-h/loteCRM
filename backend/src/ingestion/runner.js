// Orquestador de ingesta: ejecuta un proveedor, registra la corrida en
// ingestion_runs, hace upsert de anuncios y revalúa el inventario.
import { pool, query } from '../db.js';
import { HttpError, notFound } from '../http.js';
import { matchMakeModel, resolveMakeModel } from '../services/catalog.js';
import { revalueInventory } from '../services/inventory.js';
import { cleanName } from '../services/normalize.js';
import * as nhtsa from './providers/nhtsa.js';
import * as genericHtml from './providers/genericHtml.js';
import * as externalApi from './providers/externalApi.js';

// nhtsa_vpic: API pública gratuita (catálogo y VIN) · generic_html: scraper de agencias/concesionarias
// external_api: endpoint JSON de otro sistema, con mapeo automático de campos
export const PROVIDERS = {
  nhtsa_vpic: nhtsa,
  generic_html: genericHtml,
  external_api: externalApi,
};

const running = new Set();

/** Lanza la corrida en segundo plano y devuelve el registro de la corrida. */
export async function startRun(sourceId) {
  const { source, run } = await prepare(sourceId);
  execute(source, run).catch((err) => console.error('[ingesta]', err));
  return run;
}

/** Ejecuta la corrida y espera a que termine (scripts / tests). */
export async function runSourceNow(sourceId) {
  const { source, run } = await prepare(sourceId);
  return execute(source, run);
}

async function prepare(sourceId) {
  const { rows } = await query('SELECT * FROM data_sources WHERE id = $1', [sourceId]);
  const source = rows[0];
  if (!source) throw notFound('Fuente de datos');
  if (!source.is_enabled) throw new HttpError(409, 'La fuente está deshabilitada');
  if (!PROVIDERS[source.provider]) throw new HttpError(400, `Proveedor desconocido: ${source.provider}`);
  if (running.has(source.id)) throw new HttpError(409, 'Ya hay una corrida en curso para esta fuente');
  running.add(source.id);
  const { rows: [run] } = await query('INSERT INTO ingestion_runs (source_id) VALUES ($1) RETURNING *', [source.id]);
  return { source, run };
}

async function execute(source, run) {
  const stats = { items_found: 0, items_inserted: 0, items_updated: 0, items_failed: 0 };
  const log = [];
  const ctx = {
    source,
    config: source.config ?? {},
    log: (message, level = 'info') => {
      log.push({ at: new Date().toISOString(), level, message });
      if (log.length > 500) log.shift();
    },
    stats,
    saveListing: async (listing) => {
      stats.items_found += 1;
      try {
        const inserted = await upsertListing(source, listing);
        stats[inserted ? 'items_inserted' : 'items_updated'] += 1;
      } catch (err) {
        stats.items_failed += 1;
        ctx.log(`Anuncio ${listing.external_id ?? '?'}: ${err.message}`, 'error');
      }
    },
  };

  let status = 'success';
  let errorMessage = null;
  try {
    await PROVIDERS[source.provider].run(ctx);
    if (stats.items_failed > 0) status = 'partial';

    if (stats.items_found > 0 && PROVIDERS[source.provider].producesListings !== false) {
      await query(
        `UPDATE market_listings SET is_active = false
         WHERE source_id = $1 AND is_active AND last_seen_at < now() - interval '30 days'`, [source.id]);
      const client = await pool.connect();
      try {
        const r = await revalueInventory(client);
        ctx.log(`Revaluación: ${r.valued}/${r.total} vehículos con comparables`);
      } finally {
        client.release();
      }
    }
  } catch (err) {
    status = 'failed';
    errorMessage = err.message;
    ctx.log(err.message, 'error');
  } finally {
    running.delete(source.id);
  }

  const { rows: [done] } = await query(
    `UPDATE ingestion_runs SET status = $2, finished_at = now(), items_found = $3, items_inserted = $4,
       items_updated = $5, items_failed = $6, error_message = $7, log = $8
     WHERE id = $1 RETURNING *`,
    [run.id, status, stats.items_found, stats.items_inserted, stats.items_updated, stats.items_failed,
      errorMessage, JSON.stringify(log)]);
  await query('UPDATE data_sources SET last_run_at = now() WHERE id = $1', [source.id]);
  return done;
}

/**
 * Inserta o actualiza un anuncio. Formato esperado (todos opcionales salvo external_id):
 * { external_id, url, title, make, model, year, trim, odometer, odometer_unit, price, currency,
 *   condition, location_city, location_state, seller_type, seller_name, exterior_color,
 *   transmission, fuel_type, drivetrain, doors, raw }
 * Devuelve true si fue inserción, false si fue actualización.
 */
export async function upsertListing(source, l) {
  if (!l.external_id) throw new Error('Falta external_id');
  let ids = null;
  if (l.make && l.model) {
    const client = await pool.connect();
    try {
      ids = await resolveMakeModel(client, l.make, l.model);
    } finally {
      client.release();
    }
  } else {
    ids = await matchMakeModel(`${l.make ?? ''} ${l.model ?? ''} ${l.title ?? ''}`);
  }

  const { rows } = await query(
    `INSERT INTO market_listings (source_id, external_id, url, title, make_id, model_id, make_raw, model_raw,
        year, trim, odometer, odometer_unit, price, currency, condition, location_city, location_state,
        seller_type, seller_name, exterior_color, transmission, fuel_type, drivetrain, doors, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12,'km'),$13,coalesce($14,'MXN'),$15,$16,$17,
             $18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (source_id, external_id) DO UPDATE SET
       url = EXCLUDED.url, title = EXCLUDED.title,
       make_id = coalesce(EXCLUDED.make_id, market_listings.make_id),
       model_id = coalesce(EXCLUDED.model_id, market_listings.model_id),
       year = coalesce(EXCLUDED.year, market_listings.year),
       trim = coalesce(EXCLUDED.trim, market_listings.trim),
       odometer = coalesce(EXCLUDED.odometer, market_listings.odometer),
       price = EXCLUDED.price, currency = EXCLUDED.currency,
       location_city = EXCLUDED.location_city, location_state = EXCLUDED.location_state,
       seller_name = coalesce(EXCLUDED.seller_name, market_listings.seller_name),
       exterior_color = coalesce(EXCLUDED.exterior_color, market_listings.exterior_color),
       transmission = coalesce(EXCLUDED.transmission, market_listings.transmission),
       fuel_type = coalesce(EXCLUDED.fuel_type, market_listings.fuel_type),
       drivetrain = coalesce(EXCLUDED.drivetrain, market_listings.drivetrain),
       doors = coalesce(EXCLUDED.doors, market_listings.doors),
       raw = EXCLUDED.raw, is_active = true, last_seen_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [source.id, String(l.external_id), l.url ?? null, l.title ?? null, ids?.make_id ?? null, ids?.model_id ?? null,
      cleanName(l.make) ?? ids?.make ?? null, cleanName(l.model) ?? ids?.model ?? null, l.year ?? null,
      l.trim ?? null, l.odometer != null ? Math.round(l.odometer) : null, l.odometer_unit ?? null,
      l.price ?? null, l.currency ?? null, l.condition ?? null, l.location_city ?? null,
      l.location_state ?? null, l.seller_type ?? null, l.seller_name ?? null, l.exterior_color ?? null,
      l.transmission ?? null, l.fuel_type ?? null, l.drivetrain ?? null, l.doors ?? null,
      JSON.stringify(l.raw ?? {})]);
  return rows[0].inserted;
}
