// Ejecuta todas las fuentes habilitadas, una tras otra (o sólo las indicadas por código).
// Uso: node src/scripts/ingest.js [codigo1 codigo2 ...]
import { fileURLToPath } from 'node:url';
import { pool, query } from '../db.js';
import { runSourceNow } from '../ingestion/runner.js';

export async function runAllEnabled(codes = []) {
  const { rows } = await query(
    `SELECT id, code, name FROM data_sources
     WHERE is_enabled AND kind <> 'file' AND (cardinality($1::text[]) = 0 OR code = ANY($1))
     ORDER BY CASE provider WHEN 'nhtsa_vpic' THEN 0 ELSE 1 END, code`, [codes]);
  for (const s of rows) {
    const started = Date.now();
    process.stdout.write(`→ ${s.name}… `);
    const run = await runSourceNow(s.id);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`${run.status} en ${secs}s · ${run.items_found} encontrados, ${run.items_inserted} nuevos, ${run.items_updated} actualizados, ${run.items_failed} con error${run.error_message ? ` · ${run.error_message}` : ''}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAllEnabled(process.argv.slice(2))
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => pool.end());
}
