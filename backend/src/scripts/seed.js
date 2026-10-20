// Registra las fuentes de datos (APIs y scraping) y ejecuta la ingesta inicial.
// No crea datos de negocio: lotes, usuarios, vehículos, clientes y ventas se capturan
// en la aplicación, se importan desde otro sistema o llegan por la API de socios.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../db.js';
import { runAllEnabled } from './ingest.js';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/seeds/sources.sql');

async function main() {
  await query(await fs.readFile(file, 'utf8'));
  console.log('✓ Fuentes de datos registradas');
  if (!process.argv.includes('--no-ingest')) await runAllEnabled();
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
