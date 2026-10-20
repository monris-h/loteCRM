-- Fuentes de datos reales (no inserta datos de negocio). Idempotente.

INSERT INTO data_sources (code, name, kind, provider, is_enabled, config) VALUES
(
  'nhtsa_vpic',
  'NHTSA vPIC · catálogo de marcas y modelos (API pública gratuita)',
  'api', 'nhtsa_vpic', true,
  '{
     "years": [2023, 2024, 2025],
     "makes": ["NISSAN", "CHEVROLET", "VOLKSWAGEN", "TOYOTA", "HONDA", "MAZDA", "KIA", "FORD", "HYUNDAI"]
   }'
),
(
  'concesionarias_mx',
  'Autos de concesionarias · Guadalajara, Monterrey, Puebla y Querétaro (seminuevos.com)',
  'scraper', 'generic_html', true,
  '{
     "mode": "css",
     "start_urls": [
       "https://www.seminuevos.com/carros/autos-de-concesionaria-usados-guadalajara?page={page}",
       "https://www.seminuevos.com/carros/autos-de-concesionaria-usados-monterrey?page={page}",
       "https://www.seminuevos.com/carros/autos-de-concesionaria-usados-puebla?page={page}",
       "https://www.seminuevos.com/carros/autos-de-concesionaria-usados-queretaro?page={page}"
     ],
     "max_pages": 1,
     "item_selector": "div.group.block:has(a[href^=\"/vehicle/\"])",
     "fields": {
       "external_id":  { "selector": "a[href^=\"/vehicle/\"]", "attr": "href", "regex": "/(\\d+)$" },
       "url":          { "selector": "a[href^=\"/vehicle/\"]", "attr": "href" },
       "make":         { "selector": "h3", "regex": "^(.+?)\\s+·" },
       "model":        { "selector": "h3", "regex": "·\\s+(.+)$" },
       "year":         { "selector": "p.text-sm" },
       "odometer":     { "selector": "p.text-xs span span" },
       "price":        { "selector": "span.text-lg" },
       "location":     { "selector": "span.truncate" }
     },
     "detail": {
       "max_items": 140,
       "first_line": { "field": "trim", "selector": "h2:contains(\"Acerca de este vehículo\") + p" },
       "labels": {
         "trim":           ["Versión"],
         "exterior_color": ["Color", "Color exterior"],
         "transmission":   ["Transmisión"],
         "fuel_type":      ["Combustible", "Combustible o energía"],
         "drivetrain":     ["Tracción"],
         "doors":          ["Puertas"]
       }
     },
     "delay_ms": 2500,
     "currency": "MXN",
     "seller_type": "dealer",
     "respect_robots": true
   }'
),
(
  'sitio_agencia',
  'Sitio web de una agencia (plantilla: datos estructurados schema.org)',
  'scraper', 'generic_html', false,
  '{
     "mode": "jsonld",
     "start_urls": ["https://www.tu-agencia.mx/seminuevos?page={page}"],
     "max_pages": 3,
     "delay_ms": 3000,
     "currency": "MXN",
     "respect_robots": true
   }'
)
ON CONFLICT (code) DO NOTHING;
