import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { query } from './db.js';
import { errorHandler } from './http.js';
import catalog from './routes/catalog.js';
import connectors from './routes/connectors.js';
import crm from './routes/crm.js';
import dashboard from './routes/dashboard.js';
import ingestion from './routes/ingestion.js';
import partnerApi from './routes/partnerApi.js';
import partners from './routes/partners.js';
import sales from './routes/sales.js';
import vehicles from './routes/vehicles.js';

export const app = express();

app.use(cors({ origin: config.corsOrigin.split(',') }));
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', async (req, res) => {
  await query('SELECT 1');
  res.json({ ok: true });
});

app.use('/api/catalog', catalog);
app.use('/api/vehicles', vehicles);
app.use('/api', crm);
app.use('/api', sales);
app.use('/api/dashboard', dashboard);
app.use('/api/ingestion', ingestion);
app.use('/api/partners', partners);
app.use('/api/connectors', connectors);

// API pública para sistemas externos (autenticada con llave de socio)
app.use('/partner/v1', partnerApi);

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use(errorHandler);
