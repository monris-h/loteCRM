-- =====================================================================
-- LotesCRM - Schema base
-- Diseño "genérico": nombres de campos estándar de la industria automotriz
-- (VIN, stock number, odometer, trim, body type...), catálogos como tablas
-- (no ENUMs de Postgres) y columnas `attributes jsonb` + tabla
-- `external_refs` para que la migración desde otros sistemas no pierda datos.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Organización: usuarios (vendedores) y lotes (sucursales)
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text NOT NULL,
  email       citext NOT NULL UNIQUE,
  phone       text,
  role        text NOT NULL DEFAULT 'sales' CHECK (role IN ('admin','manager','sales','staff')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  address_line  text,
  city          text,
  state         text,
  postal_code   text,
  country       char(2) NOT NULL DEFAULT 'MX',
  phone         text,
  capacity      integer CHECK (capacity IS NULL OR capacity >= 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Socios: otros lotes / agencias que se conectan por API con una llave.
-- Pueden vender nuestro inventario y publicar aquí el suyo y sus ventas.
-- ---------------------------------------------------------------------
CREATE TABLE partners (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{2,30}$'),
  name                   text NOT NULL,
  contact_name           text,
  contact_email          citext,
  contact_phone          text,
  can_sell_inventory     boolean NOT NULL DEFAULT true,   -- ver y vender nuestro inventario compartido
  can_publish_inventory  boolean NOT NULL DEFAULT true,   -- publicar aquí SU inventario y SUS ventas
  commission_pct         numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct BETWEEN 0 AND 100),
  api_key_prefix         text UNIQUE,                     -- primeros caracteres, para identificar la llave
  api_key_hash           text,                            -- SHA-256 de la llave (nunca la llave en claro)
  last_api_call_at       timestamptz,
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Catálogo de marcas / modelos
-- ---------------------------------------------------------------------
CREATE TABLE makes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           citext NOT NULL UNIQUE,
  external_code  text,              -- p.ej. Make_ID de NHTSA vPIC
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE models (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  make_id        uuid NOT NULL REFERENCES makes(id) ON DELETE CASCADE,
  name           citext NOT NULL,
  external_code  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (make_id, name),
  UNIQUE (id, make_id)             -- permite FK compuesta (modelo debe pertenecer a la marca)
);

-- ---------------------------------------------------------------------
-- Estados de inventario y transiciones permitidas (máquina de estados
-- dirigida por datos: se puede ajustar sin tocar código).
-- ---------------------------------------------------------------------
CREATE TABLE vehicle_statuses (
  code         text PRIMARY KEY,
  label        text NOT NULL,
  is_in_stock  boolean NOT NULL,     -- cuenta como inventario propio
  is_sellable  boolean NOT NULL,     -- se puede vender/apartar directamente
  sort_order   smallint NOT NULL
);

INSERT INTO vehicle_statuses (code, label, is_in_stock, is_sellable, sort_order) VALUES
  ('incoming',       'En tránsito',     true,  false, 1),
  ('reconditioning', 'En preparación',  true,  false, 2),
  ('available',      'Disponible',      true,  true,  3),
  ('on_hold',        'En pausa',        true,  false, 4),
  ('reserved',       'Apartado',        true,  false, 5),
  ('sold',           'Vendido',         false, false, 6),
  ('delivered',      'Entregado',       false, false, 7),
  ('archived',       'Baja',            false, false, 8);

CREATE TABLE vehicle_status_transitions (
  from_status  text NOT NULL REFERENCES vehicle_statuses(code),
  to_status    text NOT NULL REFERENCES vehicle_statuses(code),
  PRIMARY KEY (from_status, to_status),
  CHECK (from_status <> to_status)
);

INSERT INTO vehicle_status_transitions (from_status, to_status) VALUES
  ('incoming','reconditioning'), ('incoming','available'), ('incoming','archived'),
  ('reconditioning','available'), ('reconditioning','archived'),
  ('available','reserved'), ('available','on_hold'), ('available','reconditioning'),
  ('available','sold'), ('available','archived'),
  ('on_hold','available'), ('on_hold','archived'),
  ('reserved','available'), ('reserved','sold'),
  ('sold','delivered'), ('sold','available'),
  ('archived','available');

-- ---------------------------------------------------------------------
-- Vehículos (inventario)
-- ---------------------------------------------------------------------
CREATE SEQUENCE vehicle_stock_seq START 1000;

CREATE TABLE vehicles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_number        text NOT NULL UNIQUE DEFAULT ('STK-' || nextval('vehicle_stock_seq')),
  vin                 text UNIQUE CHECK (vin IS NULL OR vin ~ '^[A-HJ-NPR-Z0-9]{11,17}$'),
  plate_number        text,
  lot_id              uuid REFERENCES lots(id) ON DELETE SET NULL,
  -- NULL = inventario propio; con valor = vehículo de un socio reflejado aquí
  owner_partner_id    uuid REFERENCES partners(id) ON DELETE RESTRICT,
  -- compartir (sindicar) este vehículo propio con los socios
  syndicate           boolean NOT NULL DEFAULT true,

  make_id             uuid NOT NULL REFERENCES makes(id),
  model_id            uuid NOT NULL,
  year                smallint NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  trim                text,
  body_type           text CHECK (body_type IN ('sedan','suv','pickup','hatchback','coupe','convertible',
                                                'van','minivan','wagon','truck','motorcycle','other')),
  exterior_color      text,
  interior_color      text,
  odometer            integer CHECK (odometer IS NULL OR odometer >= 0),
  odometer_unit       text NOT NULL DEFAULT 'km' CHECK (odometer_unit IN ('km','mi')),
  fuel_type           text CHECK (fuel_type IN ('gasoline','diesel','hybrid','plug_in_hybrid',
                                                'electric','lpg','cng','other')),
  transmission        text CHECK (transmission IN ('manual','automatic','cvt','dct','other')),
  drivetrain          text CHECK (drivetrain IN ('fwd','rwd','awd','4wd','other')),
  engine              text,
  cylinders           smallint CHECK (cylinders IS NULL OR cylinders BETWEEN 0 AND 16),
  displacement_l      numeric(4,2),
  doors               smallint CHECK (doors IS NULL OR doors BETWEEN 0 AND 6),
  seats               smallint CHECK (seats IS NULL OR seats BETWEEN 0 AND 60),
  condition           text NOT NULL DEFAULT 'used' CHECK (condition IN ('new','used','certified')),
  title_status        text NOT NULL DEFAULT 'clean' CHECK (title_status IN ('clean','salvage','rebuilt','lien','unknown')),
  owners_count        smallint CHECK (owners_count IS NULL OR owners_count >= 0),

  status              text NOT NULL DEFAULT 'incoming' REFERENCES vehicle_statuses(code),
  currency            char(3) NOT NULL DEFAULT 'MXN',
  acquisition_cost    numeric(14,2) CHECK (acquisition_cost IS NULL OR acquisition_cost >= 0),
  acquisition_source  text CHECK (acquisition_source IN ('purchase','trade_in','auction','consignment','other')),
  acquired_at         date,
  list_price          numeric(14,2) CHECK (list_price IS NULL OR list_price >= 0),
  min_price           numeric(14,2) CHECK (min_price IS NULL OR min_price >= 0),
  listed_at           timestamptz,     -- primera vez que pasó a "available"
  sold_at             timestamptz,

  description         text,
  features            text[] NOT NULL DEFAULT '{}',
  attributes          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- campos extra de otros sistemas
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (model_id, make_id) REFERENCES models(id, make_id),
  CHECK (min_price IS NULL OR list_price IS NULL OR min_price <= list_price)
);

CREATE INDEX vehicles_status_idx      ON vehicles (status);
CREATE INDEX vehicles_lot_idx         ON vehicles (lot_id);
CREATE INDEX vehicles_make_model_idx  ON vehicles (make_id, model_id, year);
CREATE INDEX vehicles_owner_idx       ON vehicles (owner_partner_id) WHERE owner_partner_id IS NOT NULL;
CREATE INDEX vehicles_updated_idx     ON vehicles (updated_at);

CREATE TABLE vehicle_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  url         text NOT NULL,
  media_type  text NOT NULL DEFAULT 'image' CHECK (media_type IN ('image','video','document')),
  caption     text,
  position    smallint NOT NULL DEFAULT 0,
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_media_vehicle_idx ON vehicle_media (vehicle_id, position);
CREATE UNIQUE INDEX vehicle_media_one_primary ON vehicle_media (vehicle_id) WHERE is_primary;

-- Costos posteriores a la compra (reacondicionamiento, traslado, trámites...)
CREATE TABLE vehicle_costs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  category     text NOT NULL CHECK (category IN ('reconditioning','transport','fees','parts','labor',
                                                 'detailing','inspection','other')),
  description  text,
  vendor       text,
  amount       numeric(14,2) NOT NULL CHECK (amount >= 0),
  incurred_at  date NOT NULL DEFAULT current_date,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_costs_vehicle_idx ON vehicle_costs (vehicle_id);

-- Bitácora de inventario (la llenan triggers automáticamente)
CREATE TABLE vehicle_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  event_type   text NOT NULL CHECK (event_type IN ('created','status_change','lot_transfer','price_change')),
  from_status  text,
  to_status    text,
  from_lot_id  uuid,
  to_lot_id    uuid,
  old_price    numeric(14,2),
  new_price    numeric(14,2),
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_events_vehicle_idx ON vehicle_events (vehicle_id, created_at DESC);

-- ---------------------------------------------------------------------
-- CRM: contactos, prospectos (leads) y actividades
-- ---------------------------------------------------------------------
CREATE TABLE contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_type       text NOT NULL DEFAULT 'person' CHECK (contact_type IN ('person','company')),
  first_name         text,
  last_name          text,
  company_name       text,
  email              citext,
  phone              text,
  mobile             text,
  tax_id             text,             -- RFC / NIT / RUT según país
  address_line       text,
  city               text,
  state              text,
  postal_code        text,
  country            char(2) NOT NULL DEFAULT 'MX',
  preferred_contact  text CHECK (preferred_contact IN ('phone','email','whatsapp','sms')),
  source             text,
  marketing_opt_in   boolean NOT NULL DEFAULT false,
  owner_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  notes              text,
  attributes         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((contact_type = 'person'  AND first_name   IS NOT NULL) OR
         (contact_type = 'company' AND company_name IS NOT NULL))
);
CREATE INDEX contacts_email_idx ON contacts (email);
CREATE INDEX contacts_phone_idx ON contacts (phone);

CREATE TABLE leads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  vehicle_id        uuid REFERENCES vehicles(id) ON DELETE SET NULL,  -- vehículo de interés
  assigned_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','contacted','qualified','test_drive','negotiation','won','lost')),
  source            text NOT NULL DEFAULT 'walk_in'
                    CHECK (source IN ('walk_in','website','phone','referral','marketplace','social','other')),
  budget_min        numeric(14,2),
  budget_max        numeric(14,2),
  desired_make      text,
  desired_model     text,
  desired_year_min  smallint,
  desired_year_max  smallint,
  lost_reason       text,
  notes             text,
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_status_idx  ON leads (status);
CREATE INDEX leads_contact_idx ON leads (contact_id);

CREATE TABLE activities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        uuid REFERENCES leads(id) ON DELETE CASCADE,
  contact_id     uuid REFERENCES contacts(id) ON DELETE CASCADE,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  activity_type  text NOT NULL CHECK (activity_type IN ('call','email','whatsapp','meeting','test_drive','note','task')),
  subject        text NOT NULL,
  notes          text,
  due_at         timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (lead_id IS NOT NULL OR contact_id IS NOT NULL)
);
CREATE INDEX activities_lead_idx ON activities (lead_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Apartados (reservas) y ventas
-- ---------------------------------------------------------------------
CREATE TABLE reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','expired','cancelled')),
  deposit_amount  numeric(14,2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  currency        char(3) NOT NULL DEFAULT 'MXN',
  reserved_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > reserved_at)
);
-- Regla de inventario: un vehículo sólo puede tener UN apartado activo
CREATE UNIQUE INDEX reservations_one_active ON reservations (vehicle_id) WHERE status = 'active';

CREATE SEQUENCE sale_number_seq START 1;

CREATE TABLE sales (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_number            text NOT NULL UNIQUE DEFAULT ('VTA-' || lpad(nextval('sale_number_seq')::text, 6, '0')),
  vehicle_id             uuid NOT NULL REFERENCES vehicles(id),
  contact_id             uuid REFERENCES contacts(id),
  lead_id                uuid REFERENCES leads(id) ON DELETE SET NULL,
  reservation_id         uuid REFERENCES reservations(id) ON DELETE SET NULL,
  salesperson_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  -- quién vendió qué:
  --   direct            vehículo propio vendido por nosotros
  --   partner_sold_ours vehículo propio vendido por un socio (le pagamos comisión)
  --   we_sold_partner   vehículo de un socio vendido por nosotros (nos paga comisión)
  --   partner_own       vehículo de un socio vendido por él mismo (sólo se refleja)
  sale_type              text NOT NULL DEFAULT 'direct'
                         CHECK (sale_type IN ('direct','partner_sold_ours','we_sold_partner','partner_own')),
  selling_partner_id     uuid REFERENCES partners(id) ON DELETE SET NULL,
  partner_reference      text,            -- id de la venta en el sistema del socio
  buyer_name             text,            -- comprador cuando el socio no comparte el contacto
  commission_amount      numeric(14,2) CHECK (commission_amount IS NULL OR commission_amount >= 0),
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
  sale_date              date NOT NULL DEFAULT current_date,
  currency               char(3) NOT NULL DEFAULT 'MXN',
  sale_price             numeric(14,2) NOT NULL CHECK (sale_price >= 0),
  discount_amount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  fees_amount            numeric(14,2) NOT NULL DEFAULT 0 CHECK (fees_amount >= 0),
  tax_amount             numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount           numeric(14,2) GENERATED ALWAYS AS (sale_price - discount_amount + fees_amount + tax_amount) STORED,
  cost_at_sale           numeric(14,2),   -- foto del costo total al momento de la venta
  gross_profit           numeric(14,2) GENERATED ALWAYS AS (
                           CASE sale_type
                             WHEN 'we_sold_partner' THEN commission_amount
                             WHEN 'partner_own'     THEN NULL
                             ELSE sale_price - discount_amount - cost_at_sale - coalesce(commission_amount, 0)
                           END) STORED,
  down_payment           numeric(14,2) NOT NULL DEFAULT 0 CHECK (down_payment >= 0),
  payment_method         text NOT NULL DEFAULT 'cash'
                         CHECK (payment_method IN ('cash','financing','transfer','card','mixed','other')),
  financing_institution  text,
  financing_term_months  smallint,
  financing_rate         numeric(6,3),
  trade_in_vehicle_id    uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  trade_in_value         numeric(14,2),
  delivered_at           timestamptz,
  cancelled_at           timestamptz,
  cancel_reason          text,
  notes                  text,
  attributes             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_amount <= sale_price),
  CHECK (trade_in_vehicle_id IS NULL OR trade_in_vehicle_id <> vehicle_id),
  CHECK (contact_id IS NOT NULL OR selling_partner_id IS NOT NULL),
  CHECK ((sale_type IN ('partner_sold_ours','partner_own')) = (selling_partner_id IS NOT NULL))
);
-- Regla de inventario: un vehículo no puede tener dos ventas vigentes (ni entre sistemas)
CREATE UNIQUE INDEX sales_one_active_per_vehicle ON sales (vehicle_id) WHERE status <> 'cancelled';
-- Idempotencia: la misma venta del socio no se registra dos veces
CREATE UNIQUE INDEX sales_partner_reference ON sales (selling_partner_id, partner_reference)
  WHERE partner_reference IS NOT NULL;
CREATE INDEX sales_date_idx ON sales (sale_date);

CREATE TABLE sale_payments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id    uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  method     text NOT NULL CHECK (method IN ('cash','transfer','card','check','financing','other')),
  reference  text,
  paid_at    timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Ingesta de datos de mercado (scraping + APIs)
-- ---------------------------------------------------------------------
CREATE TABLE data_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('api','scraper','file','manual')),
  provider     text NOT NULL,           -- implementación en backend: nhtsa_vpic, mercadolibre, generic_html, demo...
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled   boolean NOT NULL DEFAULT true,
  last_run_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingestion_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','failed')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  items_found     integer NOT NULL DEFAULT 0,
  items_inserted  integer NOT NULL DEFAULT 0,
  items_updated   integer NOT NULL DEFAULT 0,
  items_failed    integer NOT NULL DEFAULT 0,
  error_message   text,
  log             jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX ingestion_runs_source_idx ON ingestion_runs (source_id, started_at DESC);

-- Anuncios de mercado (comparables) obtenidos de APIs o scraping
CREATE TABLE market_listings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  external_id     text NOT NULL,
  url             text,
  title           text,
  make_id         uuid REFERENCES makes(id),
  model_id        uuid REFERENCES models(id),
  make_raw        text,
  model_raw       text,
  year            smallint,
  trim            text,
  odometer        integer,
  odometer_unit   text NOT NULL DEFAULT 'km' CHECK (odometer_unit IN ('km','mi')),
  price           numeric(14,2),
  currency        char(3) NOT NULL DEFAULT 'MXN',
  condition       text,
  location_city   text,
  location_state  text,
  seller_type     text,
  seller_name     text,                 -- agencia / concesionaria que lo anuncia
  exterior_color  text,
  transmission    text,
  fuel_type       text,
  drivetrain      text,
  doors           smallint,
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  vehicle_id      uuid REFERENCES vehicles(id) ON DELETE SET NULL,  -- si ya se agregó al inventario
  is_active       boolean NOT NULL DEFAULT true,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);
CREATE INDEX market_listings_lookup_idx ON market_listings (make_id, model_id, year) WHERE is_active;

-- Historial de precios de cada anuncio (para ver tendencias de mercado)
CREATE TABLE market_price_snapshots (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id   uuid NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  price        numeric(14,2) NOT NULL,
  observed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_price_snapshots_listing_idx ON market_price_snapshots (listing_id, observed_at);

CREATE TABLE vehicle_valuations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  method       text NOT NULL CHECK (method IN ('market_comparables','api','manual')),
  source_id    uuid REFERENCES data_sources(id) ON DELETE SET NULL,
  currency     char(3) NOT NULL DEFAULT 'MXN',
  value_low    numeric(14,2),
  value_mid    numeric(14,2),
  value_high   numeric(14,2),
  sample_size  integer,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  valued_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_valuations_vehicle_idx ON vehicle_valuations (vehicle_id, valued_at DESC);

-- ---------------------------------------------------------------------
-- Migración / integración con otros sistemas
-- ---------------------------------------------------------------------
-- Mapea el ID de un registro en el sistema origen -> ID local. Permite
-- re-importar (upsert) sin duplicar y rastrear de dónde vino cada dato.
CREATE TABLE external_refs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  system       text NOT NULL,          -- nombre del sistema origen (p.ej. "dealer_legacy", "excel_2023")
  entity_type  text NOT NULL CHECK (entity_type IN ('vehicle','contact','lead','sale','reservation','lot','user','market_listing')),
  external_id  text NOT NULL,
  entity_id    uuid NOT NULL,
  raw          jsonb,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (system, entity_type, external_id)
);
CREATE INDEX external_refs_entity_idx ON external_refs (entity_type, entity_id);

CREATE TABLE import_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL,
  system       text NOT NULL,
  file_name    text,
  mapping      jsonb NOT NULL DEFAULT '{}'::jsonb,
  dry_run      boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','failed')),
  total_rows   integer NOT NULL DEFAULT 0,
  inserted     integer NOT NULL DEFAULT 0,
  updated      integer NOT NULL DEFAULT 0,
  failed       integer NOT NULL DEFAULT 0,
  errors       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

-- ---------------------------------------------------------------------
-- Triggers de updated_at
-- ---------------------------------------------------------------------
CREATE TRIGGER users_updated_at        BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER partners_updated_at     BEFORE UPDATE ON partners     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER lots_updated_at         BEFORE UPDATE ON lots         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER contacts_updated_at     BEFORE UPDATE ON contacts     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER leads_updated_at        BEFORE UPDATE ON leads        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER reservations_updated_at BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sales_updated_at        BEFORE UPDATE ON sales        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER data_sources_updated_at BEFORE UPDATE ON data_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();
