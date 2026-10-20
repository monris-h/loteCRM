// NHTSA vPIC (https://vpic.nhtsa.dot.gov/api/) - API pública y gratuita, sin token.
// - decodeVin(): llena la ficha del vehículo a partir del VIN.
// - run(): sincroniza el catálogo de modelos por marca y año.
import { pool } from '../../db.js';
import { resolveMakeModel } from '../../services/catalog.js';
import { normEnum, parseNumber } from '../../services/normalize.js';

const BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`NHTSA respondió ${res.status}`);
  return res.json();
}

const val = (v) => (v == null || v === '' || v === 'Not Applicable' ? null : v);

/** Devuelve campos en formato del schema de vehicles (o lanza si el VIN no se reconoce). */
export async function decodeVin(vin) {
  const data = await getJson(`${BASE}/DecodeVinValues/${encodeURIComponent(vin)}?format=json`);
  const r = data.Results?.[0] ?? {};
  if (!val(r.Make)) {
    throw new Error(r.ErrorText ? `VIN no reconocido: ${r.ErrorText}` : 'VIN no reconocido');
  }
  const fuel = [r.FuelTypePrimary, r.FuelTypeSecondary].filter(val).join(' ');
  return {
    vin,
    make: val(r.Make),
    model: val(r.Model),
    year: parseNumber(r.ModelYear),
    trim: val(r.Trim) ?? val(r.Series),
    body_type: val(r.BodyClass) ? normEnum('body_type', r.BodyClass) : null,
    fuel_type: /electric/i.test(fuel) && /gasoline/i.test(fuel)
      ? 'hybrid'
      : (val(r.FuelTypePrimary) ? normEnum('fuel_type', r.FuelTypePrimary) : null),
    transmission: val(r.TransmissionStyle) ? normEnum('transmission', r.TransmissionStyle) : null,
    drivetrain: val(r.DriveType) ? normEnum('drivetrain', r.DriveType) : null,
    engine: [val(r.DisplacementL) && `${Number(r.DisplacementL).toFixed(1)}L`, val(r.EngineConfiguration), val(r.EngineModel)]
      .filter(Boolean).join(' ') || null,
    cylinders: parseNumber(r.EngineCylinders),
    displacement_l: parseNumber(r.DisplacementL) ? Number(Number(r.DisplacementL).toFixed(2)) : null,
    doors: parseNumber(r.Doors),
    seats: parseNumber(r.Seats),
    attributes: {
      vpic: {
        manufacturer: val(r.Manufacturer),
        plant_country: val(r.PlantCountry),
        vehicle_type: val(r.VehicleType),
        error_code: val(r.ErrorCode),
      },
    },
  };
}

// Este proveedor alimenta el catálogo, no anuncios de mercado
export const producesListings = false;

/** config: { years: [2023, 2024], makes: ["TOYOTA", "NISSAN"] } */
export async function run(ctx) {
  const years = ctx.config.years ?? [new Date().getFullYear()];
  const makes = ctx.config.makes ?? [];
  if (makes.length === 0) throw new Error('Configura "makes" con la lista de marcas a sincronizar');

  const client = await pool.connect();
  try {
    for (const make of makes) {
      for (const year of years) {
        const base = `${BASE}/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}`;
        const cars = await getJson(`${base}/vehicletype/car?format=json`);
        const trucks = await getJson(`${base}/vehicletype/truck?format=json`);
        // la API busca por coincidencia parcial ("FORD" también trae "Stanford Customs"): sólo la marca exacta
        const models = [...(cars.Results ?? []), ...(trucks.Results ?? [])]
          .filter((m) => String(m.Make_Name).trim().toUpperCase() === make.toUpperCase());
        let created = 0;
        for (const m of models) {
          if ((await resolveMakeModel(client, m.Make_Name, m.Model_Name)).created) created += 1;
        }
        ctx.stats.items_found += models.length;
        ctx.stats.items_inserted += created;
        ctx.stats.items_updated += models.length - created;
        ctx.log(`${make} ${year}: ${models.length} modelos (${created} nuevos)`);
      }
    }
  } finally {
    client.release();
  }
}
