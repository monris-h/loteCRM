import pg from 'pg';
import { config } from './config.js';

// numeric -> number, bigint (count) -> number, date -> 'YYYY-MM-DD' (sin corrimiento de zona horaria)
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const query = (text, params) => pool.query(text, params);

/**
 * Ejecuta `fn(client)` dentro de una transacción.
 * `userId` y `note` quedan disponibles para los triggers de auditoría.
 */
export async function withTransaction(fn, { userId, note, skipTransitionCheck } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    if (note) await client.query("SELECT set_config('app.event_note', $1, true)", [note]);
    if (skipTransitionCheck) await client.query("SELECT set_config('app.skip_transition_check', 'on', true)");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Cambia la nota de auditoría dentro de una transacción ya abierta. */
export const setEventNote = (client, note) =>
  client.query("SELECT set_config('app.event_note', $1, true)", [note ?? '']);

/**
 * Construye un UPDATE parcial sólo con las columnas presentes en `data`
 * y permitidas en `allowed`.
 */
export async function updateById(client, table, id, data, allowed) {
  const cols = allowed.filter((c) => data[c] !== undefined);
  if (cols.length === 0) {
    const { rows } = await client.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return rows[0];
  }
  const sets = cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ');
  const { rows } = await client.query(
    `UPDATE ${table} SET ${sets} WHERE id = $1 RETURNING *`,
    [id, ...cols.map((c) => data[c])],
  );
  return rows[0];
}

/** INSERT con las columnas presentes en `data` y permitidas en `allowed`. */
export async function insertRow(client, table, data, allowed) {
  const cols = allowed.filter((c) => data[c] !== undefined);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql = cols.length
    ? `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`
    : `INSERT INTO ${table} DEFAULT VALUES RETURNING *`;
  const { rows } = await client.query(sql, cols.map((c) => data[c]));
  return rows[0];
}
