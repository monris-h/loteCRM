import { app } from './app.js';
import { config } from './config.js';
import { withTransaction } from './db.js';
import { expireReservations } from './services/inventory.js';

app.listen(config.port, () => {
  console.log(`LotesCRM API escuchando en http://localhost:${config.port}`);
  console.log(`API de socios en http://localhost:${config.port}/partner/v1`);
});

// Tarea periódica: vencer apartados cada 5 minutos
if (config.jobsEnabled) {
  const tick = async () => {
    try {
      const n = await withTransaction((c) => expireReservations(c));
      if (n > 0) console.log(`[jobs] ${n} apartado(s) vencido(s)`);
    } catch (err) {
      console.error('[jobs] error al vencer apartados:', err.message);
    }
  };
  setTimeout(tick, 5_000);
  setInterval(tick, 5 * 60_000);
}
