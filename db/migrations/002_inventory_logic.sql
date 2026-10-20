-- =====================================================================
-- Lógica de inventario en la base de datos
-- Las reglas críticas viven aquí (no sólo en el backend) para que se
-- cumplan sin importar quién escriba: API, migraciones o scripts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Máquina de estados de vehículos
--    - Valida transiciones contra vehicle_status_transitions.
--    - Fija listed_at / sold_at automáticamente.
--    - Se puede saltar en importaciones con:
--        SELECT set_config('app.skip_transition_check', 'on', true);
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vehicles_before_write() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF coalesce(current_setting('app.skip_transition_check', true), '') <> 'on'
       AND NOT EXISTS (SELECT 1 FROM vehicle_status_transitions
                       WHERE from_status = OLD.status AND to_status = NEW.status) THEN
      RAISE EXCEPTION 'Transición de estado no permitida: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status IN ('sold','delivered') AND NEW.status NOT IN ('sold','delivered') THEN
      NEW.sold_at := NULL;
    END IF;
  END IF;

  IF NEW.status = 'available' AND NEW.listed_at IS NULL THEN
    NEW.listed_at := now();
  END IF;
  IF NEW.status IN ('sold','delivered') AND NEW.sold_at IS NULL THEN
    NEW.sold_at := now();
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER vehicles_before_write
  BEFORE INSERT OR UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicles_before_write();

-- ---------------------------------------------------------------------
-- 2) Bitácora automática (vehicle_events)
--    El backend puede pasar usuario y nota con:
--      set_config('app.user_id', '<uuid>', true)
--      set_config('app.event_note', 'texto', true)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vehicles_audit() RETURNS trigger AS $$
DECLARE
  v_user uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_note text := NULLIF(current_setting('app.event_note', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO vehicle_events (vehicle_id, event_type, to_status, to_lot_id, new_price, user_id, notes)
    VALUES (NEW.id, 'created', NEW.status, NEW.lot_id, NEW.list_price, v_user, v_note);
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO vehicle_events (vehicle_id, event_type, from_status, to_status, user_id, notes)
    VALUES (NEW.id, 'status_change', OLD.status, NEW.status, v_user, v_note);
  END IF;
  IF NEW.lot_id IS DISTINCT FROM OLD.lot_id THEN
    INSERT INTO vehicle_events (vehicle_id, event_type, from_lot_id, to_lot_id, user_id, notes)
    VALUES (NEW.id, 'lot_transfer', OLD.lot_id, NEW.lot_id, v_user, v_note);
  END IF;
  IF NEW.list_price IS DISTINCT FROM OLD.list_price THEN
    INSERT INTO vehicle_events (vehicle_id, event_type, old_price, new_price, user_id, notes)
    VALUES (NEW.id, 'price_change', OLD.list_price, NEW.list_price, v_user, v_note);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER vehicles_audit
  AFTER INSERT OR UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicles_audit();

-- ---------------------------------------------------------------------
-- 3) Capacidad del lote: no permitir más unidades en stock que capacity
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vehicles_check_lot_capacity() RETURNS trigger AS $$
DECLARE
  v_capacity integer;
  v_count    integer;
BEGIN
  IF NEW.lot_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.lot_id IS NOT DISTINCT FROM OLD.lot_id THEN RETURN NEW; END IF;
  IF NOT (SELECT is_in_stock FROM vehicle_statuses WHERE code = NEW.status) THEN RETURN NEW; END IF;

  SELECT capacity INTO v_capacity FROM lots WHERE id = NEW.lot_id FOR UPDATE;
  IF v_capacity IS NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_count
  FROM vehicles v JOIN vehicle_statuses s ON s.code = v.status
  WHERE v.lot_id = NEW.lot_id AND s.is_in_stock AND v.id <> NEW.id;

  IF v_count >= v_capacity THEN
    RAISE EXCEPTION 'El lote está lleno (capacidad %)', v_capacity USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER vehicles_check_lot_capacity
  BEFORE INSERT OR UPDATE OF lot_id ON vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicles_check_lot_capacity();

-- ---------------------------------------------------------------------
-- 4) Historial de precios de anuncios de mercado
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION market_listings_price_snapshot() RETURNS trigger AS $$
BEGIN
  IF NEW.price IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.price IS DISTINCT FROM OLD.price) THEN
    INSERT INTO market_price_snapshots (listing_id, price) VALUES (NEW.id, NEW.price);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER market_listings_price_snapshot
  AFTER INSERT OR UPDATE OF price ON market_listings
  FOR EACH ROW EXECUTE FUNCTION market_listings_price_snapshot();

-- ---------------------------------------------------------------------
-- 5) Vencimiento de apartados: devuelve el vehículo a "available"
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION expire_reservations() RETURNS integer AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('app.event_note', 'Apartado vencido automáticamente', true);
  WITH expired AS (
    UPDATE reservations SET status = 'expired'
    WHERE status = 'active' AND expires_at < now()
    RETURNING vehicle_id
  )
  UPDATE vehicles v SET status = 'available'
  FROM expired e
  WHERE v.id = e.vehicle_id AND v.status = 'reserved';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.event_note', '', true);
  RETURN n;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 6) Comparables de mercado para valuación
--    Ajusta el precio de cada anuncio a "nuestro" vehículo:
--      * ±6% por cada año de diferencia
--      * ±1% por cada 10,000 km de diferencia (tope ±15%)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION market_comparables(
  p_vehicle_id    uuid,
  p_year_window   integer DEFAULT 1,
  p_max_age_days  integer DEFAULT 120
) RETURNS TABLE (
  listing_id      uuid,
  source_code     text,
  title           text,
  url             text,
  year            smallint,
  odometer_km     integer,
  price           numeric,
  adjusted_price  numeric,
  last_seen_at    timestamptz
) AS $$
  WITH v AS (
    SELECT id, make_id, model_id, year, currency,
           CASE WHEN odometer_unit = 'mi' THEN odometer * 1.609344 ELSE odometer END AS km
    FROM vehicles WHERE id = p_vehicle_id
  ), l AS (
    SELECT ml.*,
           CASE WHEN ml.odometer_unit = 'mi' THEN ml.odometer * 1.609344 ELSE ml.odometer END AS km
    FROM market_listings ml
  )
  SELECT l.id, s.code, l.title, l.url, l.year, round(l.km)::integer, l.price,
         round(
           l.price
           * (1 + 0.06 * (v.year - l.year))
           * (1 + CASE WHEN v.km IS NULL OR l.km IS NULL THEN 0
                       ELSE greatest(least((l.km - v.km) / 10000.0 * 0.01, 0.15), -0.15) END)
         , 2),
         l.last_seen_at
  FROM v
  JOIN l ON l.make_id = v.make_id
        AND l.model_id = v.model_id
        AND l.year BETWEEN v.year - p_year_window AND v.year + p_year_window
        AND l.currency = v.currency
        AND l.price > 0
        AND l.is_active
        AND l.last_seen_at > now() - make_interval(days => p_max_age_days)
  JOIN data_sources s ON s.id = l.source_id;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- 7) Valuación por comparables: percentiles 25/50/75 del precio ajustado.
--    Si hay menos de 3 comparables con ±1 año, amplía la ventana a ±3.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION value_vehicle(p_vehicle_id uuid) RETURNS vehicle_valuations AS $$
DECLARE
  r vehicle_valuations;
  w integer;
  n integer := 0;
BEGIN
  FOREACH w IN ARRAY ARRAY[1, 3] LOOP
    SELECT count(*) INTO n FROM market_comparables(p_vehicle_id, w);
    EXIT WHEN n >= 3;
  END LOOP;
  IF n = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO vehicle_valuations (vehicle_id, method, currency, value_low, value_mid, value_high, sample_size, details)
  SELECT p_vehicle_id, 'market_comparables', v.currency,
         round((percentile_cont(0.25) WITHIN GROUP (ORDER BY c.adjusted_price))::numeric, -2),
         round((percentile_cont(0.50) WITHIN GROUP (ORDER BY c.adjusted_price))::numeric, -2),
         round((percentile_cont(0.75) WITHIN GROUP (ORDER BY c.adjusted_price))::numeric, -2),
         count(*),
         jsonb_build_object(
           'year_window', w,
           'sources', jsonb_agg(DISTINCT c.source_code),
           'raw_median', percentile_cont(0.5) WITHIN GROUP (ORDER BY c.price))
  FROM market_comparables(p_vehicle_id, w) c
  CROSS JOIN (SELECT currency FROM vehicles WHERE id = p_vehicle_id) v
  GROUP BY v.currency
  RETURNING * INTO r;
  RETURN r;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 8) Vistas de inventario
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_inventory AS
SELECT
  v.*,
  mk.name::text                                  AS make,
  md.name::text                                  AS model,
  l.code                                         AS lot_code,
  l.name                                         AS lot_name,
  st.label                                       AS status_label,
  st.is_in_stock,
  (v.owner_partner_id IS NULL)                   AS is_own,
  p.code                                         AS owner_partner_code,
  p.name                                         AS owner_partner_name,
  coalesce(c.total, 0)                           AS extra_costs,
  coalesce(v.acquisition_cost, 0) + coalesce(c.total, 0) AS total_cost,
  v.list_price - (coalesce(v.acquisition_cost, 0) + coalesce(c.total, 0)) AS expected_margin,
  (CASE WHEN v.sold_at IS NOT NULL THEN v.sold_at::date ELSE current_date END)
    - coalesce(v.acquired_at, v.created_at::date) AS days_in_stock,
  val.value_mid                                  AS market_value,
  val.valued_at                                  AS market_valued_at,
  img.url                                        AS primary_image_url
FROM vehicles v
JOIN makes mk            ON mk.id = v.make_id
JOIN models md           ON md.id = v.model_id
JOIN vehicle_statuses st ON st.code = v.status
LEFT JOIN lots l         ON l.id = v.lot_id
LEFT JOIN partners p     ON p.id = v.owner_partner_id
LEFT JOIN (SELECT vehicle_id, sum(amount) AS total FROM vehicle_costs GROUP BY vehicle_id) c
       ON c.vehicle_id = v.id
LEFT JOIN LATERAL (
  SELECT value_mid, valued_at FROM vehicle_valuations vv
  WHERE vv.vehicle_id = v.id ORDER BY valued_at DESC LIMIT 1
) val ON true
LEFT JOIN LATERAL (
  SELECT url FROM vehicle_media vm
  WHERE vm.vehicle_id = v.id AND vm.media_type = 'image'
  ORDER BY vm.is_primary DESC, vm.position LIMIT 1
) img ON true;

-- ---------------------------------------------------------------------
-- 9) Inventario público para socios: SÓLO estas columnas se exponen por API
--    (nunca costo, precio mínimo ni datos internos)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public_availability(p_status text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status
    WHEN 'available' THEN 'available'
    WHEN 'reserved'  THEN 'reserved'
    WHEN 'sold'      THEN 'sold'
    WHEN 'delivered' THEN 'sold'
    ELSE 'unavailable'
  END
$$;

CREATE OR REPLACE VIEW v_public_inventory AS
SELECT
  v.id, v.stock_number, v.vin, mk.name::text AS make, md.name::text AS model, v.year, v.trim,
  v.body_type, v.exterior_color, v.odometer, v.transmission, v.fuel_type, v.condition,
  v.list_price, public_availability(v.status) AS availability,
  l.city AS location_city, l.state AS location_state,
  coalesce((SELECT jsonb_agg(m.url ORDER BY m.is_primary DESC, m.position)
            FROM vehicle_media m WHERE m.vehicle_id = v.id AND m.media_type = 'image'), '[]'::jsonb) AS photos,
  v.owner_partner_id, v.syndicate, v.updated_at
FROM vehicles v
JOIN makes mk ON mk.id = v.make_id
JOIN models md ON md.id = v.model_id
LEFT JOIN lots l ON l.id = v.lot_id;

-- Antigüedad del inventario propio en rangos (sólo unidades en stock)
CREATE OR REPLACE VIEW v_inventory_aging AS
SELECT
  CASE
    WHEN days_in_stock <= 30 THEN '0-30'
    WHEN days_in_stock <= 60 THEN '31-60'
    WHEN days_in_stock <= 90 THEN '61-90'
    ELSE '90+'
  END AS bucket,
  count(*)               AS units,
  sum(total_cost)        AS total_cost,
  sum(list_price)        AS list_value
FROM v_inventory
WHERE is_in_stock AND is_own
GROUP BY 1;
