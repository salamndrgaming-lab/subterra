-- =====================================================================
-- Subterra — PostgreSQL + PostGIS schema
-- =====================================================================
-- Run with: psql $DATABASE_URL -f db/schema.sql
-- Requires PostgreSQL 15+, PostGIS 3.3+
-- All geometries use SRID 4326 (WGS84).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- ENUMS  (idempotent — safe to re-run)
-- ---------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE well_status AS ENUM (
    'active', 'inactive', 'plugged', 'permitted',
    'drilling', 'completed', 'abandoned', 'shut_in'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE well_type AS ENUM (
    'oil', 'gas', 'oil_gas', 'injection', 'disposal',
    'water', 'dry_hole', 'service', 'observation'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE claim_status AS ENUM (
    'active', 'closed', 'void', 'pending', 'relinquished', 'forfeited'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE claim_type AS ENUM (
    'lode', 'placer', 'mill_site', 'tunnel_site', 'sand_gravel'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE permit_status AS ENUM (
    'pending', 'approved', 'denied', 'expired', 'withdrawn', 'active'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alert_event_kind AS ENUM (
    'new_claim_filed', 'claim_dropped', 'permit_filed', 'permit_approved',
    'well_spudded', 'production_change', 'lease_filed', 'price_threshold'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'pro', 'free');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- USERS / AUTH
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           CITEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    display_name    TEXT,
    role            user_role NOT NULL DEFAULT 'free',
    is_verified     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    user_agent  TEXT,
    ip_address  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens (token_hash);

-- ---------------------------------------------------------------------
-- PROJECTS / WATCHLISTS / AOIs
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    color           TEXT DEFAULT '#f59e0b',
    is_archived     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects (user_id);

CREATE TABLE IF NOT EXISTS aois (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    notes       TEXT,
    geom        GEOMETRY(MULTIPOLYGON, 4326) NOT NULL,
    centroid    GEOMETRY(POINT, 4326),
    area_acres  NUMERIC(14, 4),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aois_geom ON aois USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_aois_project ON aois (project_id);
CREATE INDEX IF NOT EXISTS idx_aois_user ON aois (user_id);

CREATE TABLE IF NOT EXISTS watchlists (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlist_items (
    watchlist_id    UUID NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('parcel','well','claim','permit','aoi')),
    entity_id       UUID NOT NULL,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (watchlist_id, entity_type, entity_id)
);

-- ---------------------------------------------------------------------
-- PARCELS — surface ownership records
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS parcels (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parcel_number       TEXT,                       -- county APN
    state               CHAR(2) NOT NULL,
    county              TEXT NOT NULL,
    owner_name          TEXT,
    owner_address       TEXT,
    legal_description   TEXT,
    acreage             NUMERIC(14, 4),
    estimated_value     NUMERIC(14, 2),
    land_use            TEXT,                        -- residential, agricultural, mineral, etc
    surface_rights      BOOLEAN DEFAULT true,
    mineral_rights      BOOLEAN,                     -- nullable: unknown
    last_sale_date      DATE,
    last_sale_price     NUMERIC(14, 2),
    geom                GEOMETRY(MULTIPOLYGON, 4326) NOT NULL,
    centroid            GEOMETRY(POINT, 4326),
    source              TEXT,                        -- 'regrid', 'county_assessor', etc
    source_updated_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parcels_geom ON parcels USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_parcels_state_county ON parcels (state, county);
CREATE INDEX IF NOT EXISTS idx_parcels_owner ON parcels (owner_name);
CREATE INDEX IF NOT EXISTS idx_parcels_apn ON parcels (parcel_number);

-- ---------------------------------------------------------------------
-- WELLS — oil & gas
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wells (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    api_number          TEXT UNIQUE,                -- 14-digit API
    well_name           TEXT,
    operator            TEXT,
    operator_id         TEXT,
    state               CHAR(2) NOT NULL,
    county              TEXT,
    field_name          TEXT,
    basin               TEXT,                        -- 'Permian', 'Bakken', 'Eagle Ford', ...
    formation           TEXT,                        -- 'Wolfcamp', 'Bakken', 'Three Forks', ...
    well_type           well_type,
    status              well_status,
    spud_date           DATE,
    completion_date     DATE,
    plug_date           DATE,
    total_depth_ft      INTEGER,
    true_vertical_depth_ft INTEGER,
    lateral_length_ft   INTEGER,
    surface_lat         NUMERIC(10, 7),
    surface_lng         NUMERIC(10, 7),
    bottom_hole_lat     NUMERIC(10, 7),
    bottom_hole_lng     NUMERIC(10, 7),
    geom                GEOMETRY(POINT, 4326) NOT NULL,
    lateral_geom        GEOMETRY(LINESTRING, 4326),
    plss_township       TEXT,
    plss_range          TEXT,
    plss_section        INTEGER,
    source              TEXT,                        -- 'tx_rrc', 'ndic', 'cogcc', ...
    source_updated_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wells_geom ON wells USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_wells_lateral_geom ON wells USING GIST (lateral_geom);
CREATE INDEX IF NOT EXISTS idx_wells_state_county ON wells (state, county);
CREATE INDEX IF NOT EXISTS idx_wells_operator ON wells (operator);
CREATE INDEX IF NOT EXISTS idx_wells_status ON wells (status);
CREATE INDEX IF NOT EXISTS idx_wells_basin_formation ON wells (basin, formation);
CREATE INDEX IF NOT EXISTS idx_wells_spud_date ON wells (spud_date);

-- monthly production volumes
CREATE TABLE IF NOT EXISTS well_production (
    id              BIGSERIAL PRIMARY KEY,
    well_id         UUID NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
    report_month    DATE NOT NULL,                  -- first of month
    oil_bbl         NUMERIC(14, 2),
    gas_mcf         NUMERIC(14, 2),
    water_bbl       NUMERIC(14, 2),
    days_produced   INTEGER,
    source          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (well_id, report_month)
);

CREATE INDEX IF NOT EXISTS idx_well_production_well_month ON well_production (well_id, report_month DESC);

-- LAS file references and curve data
CREATE TABLE IF NOT EXISTS well_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    well_id         UUID NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
    log_type        TEXT,                            -- 'gamma_ray', 'resistivity', 'sonic', etc
    file_url        TEXT,                            -- s3/r2 path to LAS file
    file_size_bytes BIGINT,
    start_depth_ft  NUMERIC(10, 2),
    end_depth_ft    NUMERIC(10, 2),
    curves          JSONB,                           -- {"GR": [...], "RT": [...]}
    metadata        JSONB,
    uploaded_by     UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_well_logs_well ON well_logs (well_id);
CREATE INDEX IF NOT EXISTS idx_well_logs_curves_gin ON well_logs USING GIN (curves);

-- ---------------------------------------------------------------------
-- MINING CLAIMS — BLM MLRS data
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mining_claims (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    serial_number       TEXT UNIQUE NOT NULL,        -- BLM serial e.g. 'NMC-1234567'
    claim_name          TEXT,
    claim_type          claim_type,
    status              claim_status,
    owner_name          TEXT,
    owner_address       TEXT,
    co_owners           JSONB,
    commodity           TEXT,                        -- 'gold', 'silver', 'copper', 'lithium', ...
    state               CHAR(2) NOT NULL,
    county              TEXT,
    meridian            TEXT,
    plss_township       TEXT,
    plss_range          TEXT,
    plss_section        INTEGER,
    location_date       DATE,
    recordation_date    DATE,
    last_assessment_year INTEGER,
    acreage             NUMERIC(10, 4),
    geom                GEOMETRY(MULTIPOLYGON, 4326) NOT NULL,
    centroid            GEOMETRY(POINT, 4326),
    source              TEXT DEFAULT 'blm_mlrs',
    source_updated_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mining_claims_geom ON mining_claims USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_mining_claims_serial ON mining_claims (serial_number);
CREATE INDEX IF NOT EXISTS idx_mining_claims_state_county ON mining_claims (state, county);
CREATE INDEX IF NOT EXISTS idx_mining_claims_status ON mining_claims (status);
CREATE INDEX IF NOT EXISTS idx_mining_claims_commodity ON mining_claims (commodity);
CREATE INDEX IF NOT EXISTS idx_mining_claims_owner ON mining_claims (owner_name);

-- ---------------------------------------------------------------------
-- MINERAL OCCURRENCES — USGS MRDS
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mineral_occurrences (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mrds_id             TEXT UNIQUE,                 -- USGS dep_id
    site_name           TEXT,
    state               CHAR(2),
    county              TEXT,
    primary_commodity   TEXT,
    secondary_commodities TEXT[],
    deposit_type        TEXT,                        -- 'porphyry', 'epithermal', 'placer', 'VMS', ...
    development_status  TEXT,                        -- 'producer', 'past_producer', 'prospect', 'occurrence'
    discovery_year      INTEGER,
    last_production_year INTEGER,
    geom                GEOMETRY(POINT, 4326) NOT NULL,
    metadata            JSONB,
    source              TEXT DEFAULT 'usgs_mrds',
    source_updated_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mineral_occurrences_geom ON mineral_occurrences USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_mineral_occurrences_state ON mineral_occurrences (state);
CREATE INDEX IF NOT EXISTS idx_mineral_occurrences_commodity ON mineral_occurrences (primary_commodity);
CREATE INDEX IF NOT EXISTS idx_mineral_occurrences_status ON mineral_occurrences (development_status);

-- ---------------------------------------------------------------------
-- HISTORICAL MINES
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS historical_mines (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                TEXT NOT NULL,
    state               CHAR(2),
    county              TEXT,
    commodity           TEXT,
    operation_start     DATE,
    operation_end       DATE,
    peak_employment     INTEGER,
    estimated_production_value NUMERIC(14, 2),
    closure_reason      TEXT,
    geom                GEOMETRY(POINT, 4326) NOT NULL,
    metadata            JSONB,
    source              TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_historical_mines_geom ON historical_mines USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_historical_mines_state_county ON historical_mines (state, county);
CREATE INDEX IF NOT EXISTS idx_historical_mines_commodity ON historical_mines (commodity);

-- ---------------------------------------------------------------------
-- PERMITS — drilling, mining, NEPA
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS permits (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    permit_number       TEXT,
    permit_type         TEXT,                        -- 'drilling', 'mining_pod', 'NEPA_EA', 'NEPA_EIS'
    agency              TEXT,                        -- 'BLM', 'USFS', 'EPA', 'state'
    operator            TEXT,
    title               TEXT,
    description         TEXT,
    status              permit_status,
    application_date    DATE,
    decision_date       DATE,
    expiration_date     DATE,
    state               CHAR(2),
    county              TEXT,
    well_id             UUID REFERENCES wells(id) ON DELETE SET NULL,
    claim_id            UUID REFERENCES mining_claims(id) ON DELETE SET NULL,
    geom                GEOMETRY,                    -- can be point or polygon (mixed)
    metadata            JSONB,
    source              TEXT,
    source_updated_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permits_geom ON permits USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_permits_state_county ON permits (state, county);
CREATE INDEX IF NOT EXISTS idx_permits_status ON permits (status);
CREATE INDEX IF NOT EXISTS idx_permits_type ON permits (permit_type);
CREATE INDEX IF NOT EXISTS idx_permits_decision_date ON permits (decision_date);

-- ---------------------------------------------------------------------
-- LEASE BOUNDARIES — federal & state oil/gas/mineral leases
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lease_boundaries (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lease_number        TEXT UNIQUE,
    lessee              TEXT,
    lessor              TEXT,                        -- 'BLM', 'state', 'private'
    lease_type          TEXT,                        -- 'oil_gas', 'mineral', 'geothermal', 'coal'
    status              TEXT,
    effective_date      DATE,
    expiration_date     DATE,
    primary_term_years  INTEGER,
    royalty_rate        NUMERIC(6, 4),               -- e.g. 0.1875
    bonus_per_acre      NUMERIC(10, 2),
    rental_per_acre     NUMERIC(10, 2),
    acreage             NUMERIC(14, 4),
    state               CHAR(2),
    county              TEXT,
    geom                GEOMETRY(MULTIPOLYGON, 4326) NOT NULL,
    metadata            JSONB,
    source              TEXT,
    source_updated_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lease_boundaries_geom ON lease_boundaries USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_lease_boundaries_state ON lease_boundaries (state);
CREATE INDEX IF NOT EXISTS idx_lease_boundaries_status ON lease_boundaries (status);
CREATE INDEX IF NOT EXISTS idx_lease_boundaries_lessee ON lease_boundaries (lessee);

-- ---------------------------------------------------------------------
-- OPPORTUNITY SCORES — cached scoring output
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opportunity_scores (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type                 TEXT NOT NULL CHECK (entity_type IN ('parcel','claim','aoi','grid_cell')),
    entity_id                   UUID NOT NULL,
    commodity                   TEXT,
    score                       NUMERIC(5, 2) NOT NULL CHECK (score BETWEEN 0 AND 100),
    tags                        TEXT[] NOT NULL DEFAULT '{}',
    proximity_to_production     NUMERIC(5, 2),
    geology_similarity          NUMERIC(5, 2),
    infrastructure_score        NUMERIC(5, 2),
    claim_availability          NUMERIC(5, 2),
    commodity_price_index       NUMERIC(5, 2),
    permitting_complexity       NUMERIC(5, 2),
    breakdown                   JSONB,
    geom                        GEOMETRY(POINT, 4326),
    computed_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at                  TIMESTAMPTZ,
    UNIQUE (entity_type, entity_id, commodity)
);

CREATE INDEX IF NOT EXISTS idx_opportunity_scores_entity ON opportunity_scores (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_opportunity_scores_score ON opportunity_scores (score DESC);
CREATE INDEX IF NOT EXISTS idx_opportunity_scores_geom ON opportunity_scores USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_opportunity_scores_commodity ON opportunity_scores (commodity);

-- ---------------------------------------------------------------------
-- ALERTS — user-defined rules + triggered events
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS alerts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id          UUID REFERENCES projects(id) ON DELETE SET NULL,
    name                TEXT NOT NULL,
    event_kind          alert_event_kind NOT NULL,
    aoi_id              UUID REFERENCES aois(id) ON DELETE CASCADE,
    bbox                GEOMETRY(POLYGON, 4326),
    filters             JSONB NOT NULL DEFAULT '{}',  -- commodity, operator, status, etc
    delivery            TEXT[] NOT NULL DEFAULT '{email}',  -- 'email','sms','webhook','in_app'
    webhook_url         TEXT,
    is_enabled          BOOLEAN NOT NULL DEFAULT true,
    last_fired_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts (user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts (is_enabled) WHERE is_enabled = true;
CREATE INDEX IF NOT EXISTS idx_alerts_bbox ON alerts USING GIST (bbox);

CREATE TABLE IF NOT EXISTS alert_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_id        UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    event_kind      alert_event_kind NOT NULL,
    entity_type     TEXT,
    entity_id       UUID,
    payload         JSONB NOT NULL DEFAULT '{}',
    geom            GEOMETRY(POINT, 4326),
    fired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at    TIMESTAMPTZ,
    is_read         BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_alert_events_alert ON alert_events (alert_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_unread ON alert_events (alert_id) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_alert_events_geom ON alert_events USING GIST (geom);

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            'users','projects','aois','parcels','wells',
            'mining_claims','permits','alerts'
        ])
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I;', t);
        EXECUTE format(
            'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();', t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- centroid auto-population for polygon tables
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_centroid_from_geom()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.geom IS NOT NULL THEN
        NEW.centroid = ST_Centroid(NEW.geom);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_centroid_aois ON aois;
CREATE TRIGGER set_centroid_aois BEFORE INSERT OR UPDATE OF geom ON aois
    FOR EACH ROW EXECUTE FUNCTION set_centroid_from_geom();

DROP TRIGGER IF EXISTS set_centroid_parcels ON parcels;
CREATE TRIGGER set_centroid_parcels BEFORE INSERT OR UPDATE OF geom ON parcels
    FOR EACH ROW EXECUTE FUNCTION set_centroid_from_geom();

DROP TRIGGER IF EXISTS set_centroid_mining_claims ON mining_claims;
CREATE TRIGGER set_centroid_mining_claims BEFORE INSERT OR UPDATE OF geom ON mining_claims
    FOR EACH ROW EXECUTE FUNCTION set_centroid_from_geom();

