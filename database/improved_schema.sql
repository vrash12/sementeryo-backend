-- ====================================================================
-- Cemetery GIS Schema (PostGIS) - improved_schema.sql
--  - All tables: id = BIGSERIAL (auto-increment PK)
--  - All tables: uid = CHAR(5) UNIQUE DEFAULT generate_uid()
--  - users: first_name, last_name, password_str, roles include super_admin
--  - seed only superadmin user
-- ====================================================================

-- ---------- Extensions ----------
CREATE EXTENSION IF NOT EXISTS postgis;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cemetery_user') THEN
    CREATE ROLE cemetery_user LOGIN PASSWORD 'cemetery123';
  END IF;
END$$;

-- make sure it can use the db and schema
GRANT CONNECT ON DATABASE cemetery_db TO cemetery_user;
GRANT USAGE ON SCHEMA public TO cemetery_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cemetery_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cemetery_user;


-- ---------- Drop existing objects (safe order) ----------
DO $$
BEGIN
  -- Functions
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_cemetery_bounds') THEN
    EXECUTE 'DROP FUNCTION IF EXISTS get_cemetery_bounds() CASCADE';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'find_nearest_plots') THEN
    EXECUTE 'DROP FUNCTION IF EXISTS find_nearest_plots(DECIMAL, DECIMAL, INTEGER) CASCADE';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'generate_plot_uuid') THEN
    EXECUTE 'DROP FUNCTION IF EXISTS generate_plot_uuid() CASCADE';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'generate_uid') THEN
    EXECUTE 'DROP FUNCTION IF EXISTS generate_uid() CASCADE';
  END IF;
END $$;

-- Tables (drop children first)
DROP TABLE IF EXISTS visit_logs CASCADE;
DROP TABLE IF EXISTS maintenance_requests CASCADE;
DROP TABLE IF EXISTS burial_schedules CASCADE;
DROP TABLE IF EXISTS qr_codes CASCADE;
DROP TABLE IF EXISTS graves CASCADE;
DROP TABLE IF EXISTS navigation_paths CASCADE;
DROP TABLE IF EXISTS cemetery_infrastructure CASCADE;
DROP TABLE IF EXISTS plots CASCADE;
DROP TABLE IF EXISTS road_plots CASCADE;
DROP TABLE IF EXISTS building_plots CASCADE;
DROP TABLE IF EXISTS cemetery_sections CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ====================================================================
-- Functions
-- ====================================================================

-- Generate 5-character random alphanumeric (A–Z, 0–9)
CREATE OR REPLACE FUNCTION generate_uid()
RETURNS CHAR(5) AS $$
DECLARE
    chars CONSTANT TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    outid TEXT := '';
BEGIN
    FOR i IN 1..5 LOOP
        outid := outid || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    END LOOP;
    RETURN outid::char(5);
END;
$$ LANGUAGE plpgsql;

-- ====================================================================
-- Core Tables (ALL: id BIGSERIAL PK, uid CHAR(5) UNIQUE DEFAULT generate_uid())
-- ====================================================================

-- Users
CREATE TABLE users (
    id             BIGSERIAL PRIMARY KEY,
    uid            CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    username       VARCHAR(50)  UNIQUE NOT NULL,
    email          VARCHAR(100) UNIQUE NOT NULL,
    password_hash  VARCHAR(255) NOT NULL,
    password_str   VARCHAR(255),            -- for dev/demo use only
    role           VARCHAR(20)  NOT NULL DEFAULT 'visitor'
                   CHECK (role IN ('super_admin','admin','staff','visitor')),
    first_name     VARCHAR(60)  NOT NULL,
    last_name      VARCHAR(60)  NOT NULL,
    phone          VARCHAR(20),
    address        TEXT,
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Cemetery sections/areas
CREATE TABLE cemetery_sections (
    id           BIGSERIAL PRIMARY KEY,
    uid          CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    section_name VARCHAR(50) NOT NULL,
    section_type VARCHAR(30) CHECK (section_type IN ('lawn_lots_2_5','double_lawn_lots_5_0','memorial_court_10_5','regular')),
    description  TEXT,
    boundary     GEOMETRY(POLYGON, 4326),
    area_sqm     DECIMAL(10,2),
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Plots
CREATE TABLE plots (
    id            BIGSERIAL PRIMARY KEY,
    uid           CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    plot_code     VARCHAR(20) UNIQUE NOT NULL,
    section_id    BIGINT REFERENCES cemetery_sections(id) ON DELETE SET NULL,
    section_name  VARCHAR(10),
    row_num       INTEGER,
    col_num       INTEGER,
    plot_type     VARCHAR(50) DEFAULT 'standard',
    size_sqm      DECIMAL(8,2),
    status        VARCHAR(20) NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','reserved','occupied','maintenance')),
    coordinates   GEOMETRY(POINT, 4326) NOT NULL,
    plot_boundary GEOMETRY(POLYGON, 4326),
    price         DECIMAL(10,2),
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE road_plots (
    id            BIGSERIAL PRIMARY KEY,
    uid           CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    plot_code     VARCHAR(20) UNIQUE NOT NULL,
    section_id    BIGINT REFERENCES cemetery_sections(id) ON DELETE SET NULL,
    section_name  VARCHAR(10),
    row_num       INTEGER,
    col_num       INTEGER,
    plot_type     VARCHAR(50) DEFAULT 'standard',
    size_sqm      DECIMAL(8,2),
    status        VARCHAR(20) NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','reserved','occupied','maintenance')),
    coordinates   GEOMETRY(POINT, 4326) NOT NULL,
    plot_boundary GEOMETRY(POLYGON, 4326),
    price         DECIMAL(10,2),
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE building_plots (
    id            BIGSERIAL PRIMARY KEY,
    uid           CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    plot_code     VARCHAR(20) UNIQUE NOT NULL,
    section_id    BIGINT REFERENCES cemetery_sections(id) ON DELETE SET NULL,
    section_name  VARCHAR(10),
    row_num       INTEGER,
    col_num       INTEGER,
    plot_type     VARCHAR(50) DEFAULT 'standard',
    size_sqm      DECIMAL(8,2),
    status        VARCHAR(20) NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','reserved','occupied','maintenance')),
    coordinates   GEOMETRY(POINT, 4326) NOT NULL,
    plot_boundary GEOMETRY(POLYGON, 4326),
    price         DECIMAL(10,2),
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Cemetery infrastructure (buildings, roads, facilities)
CREATE TABLE cemetery_infrastructure (
    id            BIGSERIAL PRIMARY KEY,
    uid           CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    name          VARCHAR(100) NOT NULL,
    type          VARCHAR(50)  NOT NULL CHECK (type IN ('entrance','office','chapel','toilet','road','path','parking','garden')),
    description   TEXT,
    coordinates   GEOMETRY(POINT, 4326),
    geometry      GEOMETRY(GEOMETRY, 4326),
    width_meters  DECIMAL(8,2),
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Graves
CREATE TABLE graves (
    id              BIGSERIAL PRIMARY KEY,
    uid             CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    plot_id         BIGINT REFERENCES plots(id) ON DELETE CASCADE,
    deceased_name   VARCHAR(100) NOT NULL,
    birth_date      DATE,
    death_date      DATE NOT NULL,
    burial_date     DATE,
    qr_token        VARCHAR(255) UNIQUE,
    epitaph         TEXT,
    family_contact  BIGINT,
    headstone_type  VARCHAR(50),
    memorial_text   TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Burial schedules
CREATE TABLE burial_schedules (
    id                   BIGSERIAL PRIMARY KEY,
    uid                  CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    plot_id              BIGINT REFERENCES plots(id) ON DELETE SET NULL,
    requester_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    deceased_name        VARCHAR(100) NOT NULL,
    scheduled_date       DATE NOT NULL,
    scheduled_time       TIME,
    status               VARCHAR(20) NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','completed','cancelled')),
    burial_type          VARCHAR(30) NOT NULL DEFAULT 'burial'
                         CHECK (burial_type IN ('burial','cremation')),
    special_requirements TEXT,
    approved_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
    notes                TEXT,
    created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Visit logs
CREATE TABLE visit_logs (
    id                       BIGSERIAL PRIMARY KEY,
    uid                      CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    user_id                  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    grave_id                 BIGINT REFERENCES graves(id) ON DELETE SET NULL,
    entry_coordinates        GEOMETRY(POINT, 4326),
    destination_coordinates  GEOMETRY(POINT, 4326),
    visit_path               GEOMETRY(LINESTRING, 4326),
    visit_timestamp          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    duration_minutes         INTEGER,
    device_info              JSONB
);

-- Maintenance requests
CREATE TABLE maintenance_requests (
    id                  BIGSERIAL PRIMARY KEY,
    uid                 CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    plot_id             BIGINT REFERENCES plots(id) ON DELETE SET NULL,
    grave_id            BIGINT REFERENCES graves(id) ON DELETE SET NULL,
    infrastructure_id   BIGINT REFERENCES cemetery_infrastructure(id) ON DELETE SET NULL,
    requester_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    assigned_staff_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    request_type        VARCHAR(50) NOT NULL,
    category            VARCHAR(30) CHECK (category IN ('grave_maintenance','infrastructure','landscaping','security')),
    description         TEXT NOT NULL,
    priority            VARCHAR(20) NOT NULL DEFAULT 'medium'
                        CHECK (priority IN ('low','medium','high','urgent')),
    status              VARCHAR(20) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','assigned','in_progress','completed','closed')),
    estimated_cost      DECIMAL(10,2),
    actual_cost         DECIMAL(10,2),
    photos              JSONB,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at        TIMESTAMP
);

-- QR codes (polymorphic entity_id; keep as INT without FK)
CREATE TABLE qr_codes (
    id            BIGSERIAL PRIMARY KEY,
    uid           CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    qr_token      VARCHAR(255) UNIQUE NOT NULL,
    entity_type   VARCHAR(20) CHECK (entity_type IN ('grave','entrance','facility')),
    entity_id     BIGINT, -- references graves.id or cemetery_infrastructure.id depending on entity_type
    coordinates   GEOMETRY(POINT, 4326),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    scan_count    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_scanned  TIMESTAMP
);

-- Navigation paths (for A*)
CREATE TABLE navigation_paths (
    id               BIGSERIAL PRIMARY KEY,
    uid              CHAR(5) UNIQUE NOT NULL DEFAULT generate_uid(),
    path_name        VARCHAR(100),
    path_type        VARCHAR(30) CHECK (path_type IN ('walkway','road','stairs','accessible_path')),
    geometry         GEOMETRY(LINESTRING, 4326) NOT NULL,
    width_meters     DECIMAL(5,2),
    surface_type     VARCHAR(30),
    is_accessible    BOOLEAN NOT NULL DEFAULT TRUE,
    difficulty_level INTEGER NOT NULL DEFAULT 1 CHECK (difficulty_level BETWEEN 1 AND 5),
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ====================================================================
-- Indexes
-- ====================================================================

-- Spatial indexes
CREATE INDEX idx_plots_coordinates                ON plots                  USING GIST (coordinates);
CREATE INDEX idx_plots_boundary                   ON plots                  USING GIST (plot_boundary);
CREATE INDEX idx_infrastructure_coordinates       ON cemetery_infrastructure USING GIST (coordinates);
CREATE INDEX idx_infrastructure_geometry          ON cemetery_infrastructure USING GIST (geometry);
CREATE INDEX idx_cemetery_sections_boundary       ON cemetery_sections      USING GIST (boundary);
CREATE INDEX idx_visit_logs_entry_coords          ON visit_logs             USING GIST (entry_coordinates);
CREATE INDEX idx_visit_logs_dest_coords           ON visit_logs             USING GIST (destination_coordinates);
CREATE INDEX idx_navigation_paths_geometry        ON navigation_paths       USING GIST (geometry);
CREATE INDEX idx_qr_codes_coordinates             ON qr_codes               USING GIST (coordinates);

-- Regular indexes
CREATE INDEX idx_plots_status                     ON plots (status);
CREATE INDEX idx_plots_section                    ON plots (section_id);
CREATE INDEX idx_graves_plot_id                   ON graves (plot_id);
CREATE INDEX idx_graves_qr_token                  ON graves (qr_token);
CREATE INDEX idx_maintenance_requests_status      ON maintenance_requests (status);
CREATE INDEX idx_maintenance_requests_priority    ON maintenance_requests (priority);
CREATE INDEX idx_users_role                       ON users (role);
CREATE INDEX idx_burial_schedules_date            ON burial_schedules (scheduled_date);
CREATE INDEX idx_qr_codes_token                   ON qr_codes (qr_token);

-- ====================================================================
-- Seed Data
-- ====================================================================

-- Super Admin (only)
INSERT INTO users (
  username, email, first_name, last_name, role, password_str, password_hash, is_active
) VALUES (
  'superadmin',
  'superadmin@cemeteryadmin.com',
  'Super',
  'Admin',
  'super_admin',
  'cemeterygroup1',
  '305d977bca42d9eb7ff8997828af9d35fbe224a18282647e1350636d86a14699',
  TRUE
);

-- Cemetery sections
INSERT INTO cemetery_sections (section_name, section_type, description, area_sqm) VALUES
('Lawn Lots A',       'lawn_lots_2_5',      'Standard 2.5 sqm lawn burial plots', 2.5),
('Double Lawn Lots B','double_lawn_lots_5_0','Double sized 5.0 sqm lawn plots',   5.0),
('Memorial Court C',  'memorial_court_10_5','Premium 10.5 sqm memorial court plots', 10.5);

-- Infrastructure (KML-derived)
INSERT INTO cemetery_infrastructure (name, type, coordinates, description) VALUES
('Main Entrance',      'entrance', ST_SetSRID(ST_MakePoint(120.5548296893815, 15.4943438269666), 4326), 'Main cemetery entrance gate'),
('Cemetery Office',    'office',   ST_SetSRID(ST_MakePoint(120.5549719481618, 15.49424438067306), 4326), 'Administrative office'),
('Chapel',             'chapel',   ST_SetSRID(ST_MakePoint(120.5546903788043, 15.49455599991288), 4326), 'Chapel for services'),
('Toilet Facility',    'toilet',   ST_SetSRID(ST_MakePoint(120.5549418472478, 15.49544832231259), 4326), 'Public restroom facility'),
('8 Meter Wide Road',  'road',     ST_SetSRID(ST_MakePoint(120.5557733931444, 15.49505949006052), 4326), 'Main access road'),
('Existing Main Road', 'road',     ST_SetSRID(ST_MakePoint(120.5552282664661, 15.4946523810428), 4326), 'Primary cemetery road');

-- Plots (KML-derived) — now referencing plots.id (auto)
INSERT INTO plots (plot_code, section_name, coordinates, status, size_sqm) VALUES
('PLOT_01','A1',ST_SetSRID(ST_MakePoint(120.5544734769128,15.49498982826807),4326),'available',2.5),
('PLOT_02','A1',ST_SetSRID(ST_MakePoint(120.5545061907757,15.49502043676235),4326),'available',2.5),
('PLOT_03','A1',ST_SetSRID(ST_MakePoint(120.5545535433884,15.49506469910858),4326),'available',2.5),
('PLOT_04','A1',ST_SetSRID(ST_MakePoint(120.5545873145398,15.49510077990216),4326),'available',2.5),
('PLOT_05','A1',ST_SetSRID(ST_MakePoint(120.5546213848528,15.49513078525863),4326),'available',2.5),
('PLOT_06','A1',ST_SetSRID(ST_MakePoint(120.5546569444614,15.49516364923329),4326),'available',2.5),
('PLOT_07','A1',ST_SetSRID(ST_MakePoint(120.5546973030675,15.49520040162916),4326),'available',2.5),
('PLOT_08','A1',ST_SetSRID(ST_MakePoint(120.5547330322458,15.49523345534344),4326),'available',2.5),
('PLOT_09','A1',ST_SetSRID(ST_MakePoint(120.5547614086875,15.4952559414855),4326),'available',2.5),

('PLOT_1B','B1',ST_SetSRID(ST_MakePoint(120.5546567155955,15.49490152752566),4326),'available',2.5),
('PLOT_2B','B1',ST_SetSRID(ST_MakePoint(120.5547082992836,15.49495232593415),4326),'available',2.5),
('PLOT_7B','B1',ST_SetSRID(ST_MakePoint(120.5548655590982,15.49512134464808),4326),'available',2.5),
('PLOT_8B','B1',ST_SetSRID(ST_MakePoint(120.5548961824474,15.49515525414155),4326),'available',2.5),

('P_13','A2',ST_SetSRID(ST_MakePoint(120.5546132473435,15.49495076357173),4326),'available',2.5),
('P_14','A2',ST_SetSRID(ST_MakePoint(120.5546505388219,15.49499360891238),4326),'available',2.5),
('P_15','A2',ST_SetSRID(ST_MakePoint(120.5546839593874,15.49503383867387),4326),'available',2.5),
('P_16','A2',ST_SetSRID(ST_MakePoint(120.5547140845465,15.49506416903846),4326),'available',2.5),
('P_17','A2',ST_SetSRID(ST_MakePoint(120.5547442738449,15.49509975360539),4326),'available',2.5),
('P_18','A2',ST_SetSRID(ST_MakePoint(120.5547740232747,15.49513357866755),4326),'available',2.5),
('P_19','A2',ST_SetSRID(ST_MakePoint(120.5548093435372,15.49516546766719),4326),'available',2.5),
('P_20','A2',ST_SetSRID(ST_MakePoint(120.554835223375,15.49519281733158),4326),'available',2.5),
('P_21','A2',ST_SetSRID(ST_MakePoint(120.5548661561339,15.49521496382369),4326),'available',2.5),
('P_22','A2',ST_SetSRID(ST_MakePoint(120.5548914827332,15.495245281586),4326),'available',2.5),
('P_23','A2',ST_SetSRID(ST_MakePoint(120.5549222719584,15.49527568654798),4326),'available',2.5),
('P_24','A2',ST_SetSRID(ST_MakePoint(120.5549512826742,15.49530537321276),4326),'available',2.5),
('P_25','A2',ST_SetSRID(ST_MakePoint(120.5551034140508,15.49535187289317),4326),'available',2.5),

('PLOT_3C','C1',ST_SetSRID(ST_MakePoint(120.554741561886,15.49499308021153),4326),'available',2.5),
('PLOT_4C','C1',ST_SetSRID(ST_MakePoint(120.5547719156183,15.49502882615115),4326),'available',2.5),
('PLOT_5C','C1',ST_SetSRID(ST_MakePoint(120.5548013711458,15.49505902939111),4326),'available',2.5),
('PLOT_6C','C1',ST_SetSRID(ST_MakePoint(120.5548330086766,15.4950946637584),4326),'available',2.5),
('PLOT_9C','C1',ST_SetSRID(ST_MakePoint(120.5549192454036,15.49517758050694),4326),'available',2.5),
('PLOT_10C','C1',ST_SetSRID(ST_MakePoint(120.5549469280719,15.49520487957005),4326),'available',2.5),
('PLOT_11C','C1',ST_SetSRID(ST_MakePoint(120.554983496266,15.4952350194149),4326),'available',2.5),
('PLOT_12C','C1',ST_SetSRID(ST_MakePoint(120.555011206756,15.49526665382431),4326),'available',2.5),

('P_46','A3',ST_SetSRID(ST_MakePoint(120.555057686182,15.49539154022303),4326),'available',5.0),

('UP_01','D1',ST_SetSRID(ST_MakePoint(120.5551816862994,15.49543046006881),4326),'available',2.5),
('UP_02','D1',ST_SetSRID(ST_MakePoint(120.5552209882477,15.49547724603648),4326),'available',2.5),
('UP_03','D1',ST_SetSRID(ST_MakePoint(120.5552677716454,15.49551961126822),4326),'available',2.5),
('UP_04','D1',ST_SetSRID(ST_MakePoint(120.555304944136,15.49555625434965),4326),'available',2.5),
('UP_05','D1',ST_SetSRID(ST_MakePoint(120.5553438219862,15.49559456350777),4326),'available',2.5),
('UP_06','D1',ST_SetSRID(ST_MakePoint(120.5553848094954,15.4956317552095),4326),'available',2.5),
('UP_07','D1',ST_SetSRID(ST_MakePoint(120.5554328274953,15.49567865379713),4326),'available',2.5),
('UP_08','D1',ST_SetSRID(ST_MakePoint(120.5554783868702,15.49572266281451),4326),'available',2.5),
('UP_09','D1',ST_SetSRID(ST_MakePoint(120.5555248210755,15.49576811841605),4326),'available',2.5),
('UP_10','D1',ST_SetSRID(ST_MakePoint(120.5555676287376,15.49580999730775),4326),'available',2.5),
('UP_11','D1',ST_SetSRID(ST_MakePoint(120.5551218414925,15.49546973206433),4326),'available',2.5),
('UP_12','D1',ST_SetSRID(ST_MakePoint(120.5551626147033,15.49551764245546),4326),'available',2.5),
('UP_13','D1',ST_SetSRID(ST_MakePoint(120.5552116462865,15.49556575340961),4326),'available',2.5),
('UP_14','D1',ST_SetSRID(ST_MakePoint(120.5552609291678,15.49560888816875),4326),'available',2.5),
('UP_15','D1',ST_SetSRID(ST_MakePoint(120.5552955550309,15.49563650670098),4326),'available',2.5),
('UP_16','D1',ST_SetSRID(ST_MakePoint(120.5553281527178,15.49567307264895),4326),'available',2.5),
('UP_17','D1',ST_SetSRID(ST_MakePoint(120.5553700495005,15.49571931081474),4326),'available',2.5),
('UP_18','D1',ST_SetSRID(ST_MakePoint(120.5554233275095,15.49577040085125),4326),'available',2.5),
('UP_19','D1',ST_SetSRID(ST_MakePoint(120.5554610126793,15.4958082836083),4326),'available',2.5),
('UP_20','D1',ST_SetSRID(ST_MakePoint(120.5555047774469,15.49584917345475),4326),'available',2.5),

('LAWN_25_A','LAWN',ST_SetSRID(ST_MakePoint(120.5551017681103,15.49494130433183),4326),'available',2.5),
('LAWN_25_B','LAWN',ST_SetSRID(ST_MakePoint(120.5549057302741,15.49478340782611),4326),'available',2.5),
('LAWN_25_C','LAWN',ST_SetSRID(ST_MakePoint(120.5553358054178,15.49450047312827),4326),'available',2.5),
('DOUBLE_LAWN_50','DOUBLE',ST_SetSRID(ST_MakePoint(120.5555014453171,15.49423440190427),4326),'available',5.0),
('MEMORIAL_105','MEMORIAL',ST_SetSRID(ST_MakePoint(120.5559134063363,15.49479393020988),4326),'available',10.5);

-- Entrance QR (entity_id points to infrastructure.id)
INSERT INTO qr_codes (qr_token, entity_type, entity_id, coordinates)
VALUES (
  'ENTRANCE_MAIN_2025',
  'entrance',
  (SELECT id FROM cemetery_infrastructure WHERE name = 'Main Entrance'),
  ST_SetSRID(ST_MakePoint(120.5548296893815, 15.4943438269666), 4326)
);

-- ====================================================================
-- Spatial Helper Functions
-- ====================================================================

-- Find nearest plots within radius (meters)
CREATE OR REPLACE FUNCTION find_nearest_plots(
  user_lat DECIMAL,
  user_lng DECIMAL,
  radius_meters INTEGER DEFAULT 100
)
RETURNS TABLE(plot_id BIGINT, plot_code VARCHAR, distance_meters DECIMAL)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id AS plot_id,
         p.plot_code,
         ST_Distance(
           ST_Transform(p.coordinates, 3857),
           ST_Transform(ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326), 3857)
         ) AS distance_meters
  FROM plots p
  WHERE ST_DWithin(
           ST_Transform(p.coordinates, 3857),
           ST_Transform(ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326), 3857),
           radius_meters
        )
  ORDER BY distance_meters;
END;
$$;

-- Cemetery bounds for map init (safe extent materialization)
CREATE OR REPLACE FUNCTION get_cemetery_bounds()
RETURNS TABLE(
  min_lat double precision,
  min_lng double precision,
  max_lat double precision,
  max_lng double precision
)
LANGUAGE sql
AS $$
  SELECT
    ST_YMin(ext) AS min_lat,
    ST_XMin(ext) AS min_lng,
    ST_YMax(ext) AS max_lat,
    ST_XMax(ext) AS max_lng
  FROM (
    SELECT ST_Extent(p.coordinates)::box2d AS ext
    FROM plots p
  ) s;
$$;

BEGIN;

-- 0) Ensure every table has an updated_at column
ALTER TABLE users                   ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cemetery_sections       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE plots                   ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cemetery_infrastructure ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE graves                  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE burial_schedules        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE visit_logs              ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE maintenance_requests    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE qr_codes                ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE navigation_paths        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 1) One generic trigger function for all tables
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2) Drop old triggers if any (idempotent), then create new ones
DROP TRIGGER IF EXISTS trg_users_updated_at                   ON users;
DROP TRIGGER IF EXISTS trg_cemetery_sections_updated_at       ON cemetery_sections;
DROP TRIGGER IF EXISTS trg_plots_updated_at                   ON plots;
DROP TRIGGER IF EXISTS trg_cemetery_infrastructure_updated_at ON cemetery_infrastructure;
DROP TRIGGER IF EXISTS trg_graves_updated_at                  ON graves;
DROP TRIGGER IF EXISTS trg_burial_schedules_updated_at        ON burial_schedules;
DROP TRIGGER IF EXISTS trg_visit_logs_updated_at              ON visit_logs;
DROP TRIGGER IF EXISTS trg_maintenance_requests_updated_at    ON maintenance_requests;
DROP TRIGGER IF EXISTS trg_qr_codes_updated_at                ON qr_codes;
DROP TRIGGER IF EXISTS trg_navigation_paths_updated_at        ON navigation_paths;

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_cemetery_sections_updated_at
BEFORE UPDATE ON cemetery_sections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_plots_updated_at
BEFORE UPDATE ON plots
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_cemetery_infrastructure_updated_at
BEFORE UPDATE ON cemetery_infrastructure
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_graves_updated_at
BEFORE UPDATE ON graves
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_burial_schedules_updated_at
BEFORE UPDATE ON burial_schedules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_visit_logs_updated_at
BEFORE UPDATE ON visit_logs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_maintenance_requests_updated_at
BEFORE UPDATE ON maintenance_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_qr_codes_updated_at
BEFORE UPDATE ON qr_codes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_navigation_paths_updated_at
BEFORE UPDATE ON navigation_paths
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;

