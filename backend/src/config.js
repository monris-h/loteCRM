import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://lotes:lotes@localhost:5433/lotescrm',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  reservationDays: Number(process.env.RESERVATION_DAYS ?? 3),
  jobsEnabled: process.env.JOBS_ENABLED !== 'false',
  scraperUserAgent: process.env.SCRAPER_USER_AGENT ?? 'LotesCRM-bot/1.0',
};
