DROP DATABASE IF EXISTS access_control;
CREATE DATABASE access_control;
\connect access_control

CREATE TYPE direction_t   AS ENUM ('IN', 'OUT');
CREATE TYPE decision_t    AS ENUM ('ALLOWED', 'DENIED');
CREATE TYPE source_t      AS ENUM ('NATIVE', 'LEGACY');
CREATE TYPE purpose_t     AS ENUM ('DOOR', 'ATTENDANCE');
CREATE TYPE role_t        AS ENUM ('admin', 'viewer');

CREATE TABLE people (
  id            SERIAL PRIMARY KEY,
  employee_code TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  department    TEXT NOT NULL,
  person_type   TEXT NOT NULL DEFAULT 'EMPLOYEE',
  email         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credentials (
  id               SERIAL PRIMARY KEY,
  person_id        INT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  card_uid         TEXT NOT NULL UNIQUE,
  fingerprint_slot INT,
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until      TIMESTAMPTZ,
  is_revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_credentials_person ON credentials(person_id);

CREATE TABLE rooms (
  id            SERIAL PRIMARY KEY,
  room_name     TEXT NOT NULL UNIQUE,
  is_restricted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE devices (
  id            SERIAL PRIMARY KEY,
  device_key    TEXT NOT NULL UNIQUE,
  device_label  TEXT NOT NULL,
  room_id       INT NOT NULL REFERENCES rooms(id),
  purpose       purpose_t NOT NULL DEFAULT 'DOOR',
  source        source_t  NOT NULL DEFAULT 'NATIVE',
  firmware_ver  TEXT,
  last_seen_at  TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE access_rules (
  id                   SERIAL PRIMARY KEY,
  room_id              INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  person_id            INT REFERENCES people(id) ON DELETE CASCADE,
  department           TEXT,
  fingerprint_required BOOLEAN NOT NULL DEFAULT FALSE,
  valid_until          TIMESTAMPTZ,
  CHECK (person_id IS NOT NULL OR department IS NOT NULL)
);
CREATE INDEX idx_rules_room ON access_rules(room_id);

CREATE TABLE access_events (
  id               BIGSERIAL PRIMARY KEY,
  device_id        INT NOT NULL REFERENCES devices(id),
  room_id          INT NOT NULL REFERENCES rooms(id),
  person_id        INT REFERENCES people(id),
  credential_id    INT REFERENCES credentials(id),
  card_uid         TEXT NOT NULL,
  direction        direction_t NOT NULL,
  decision         decision_t  NOT NULL,
  reason_code      TEXT NOT NULL,
  fingerprint_used BOOLEAN NOT NULL DEFAULT FALSE,
  scanned_at       TIMESTAMPTZ NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source           source_t NOT NULL DEFAULT 'NATIVE',
  device_event_id  TEXT NOT NULL,
  external_id      TEXT
);
CREATE UNIQUE INDEX uq_event_device ON access_events(device_id, device_event_id);
CREATE UNIQUE INDEX uq_event_external ON access_events(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_events_time   ON access_events(scanned_at DESC);
CREATE INDEX idx_events_person ON access_events(person_id, scanned_at DESC);
CREATE INDEX idx_events_room   ON access_events(room_id, scanned_at DESC);

CREATE OR REPLACE FUNCTION block_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'access_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_events_no_update BEFORE UPDATE OR DELETE ON access_events
  FOR EACH ROW EXECUTE FUNCTION block_event_mutation();

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          role_t NOT NULL DEFAULT 'viewer',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE legacy_sync_state (
  id             INT PRIMARY KEY DEFAULT 1,
  last_synced_at TIMESTAMPTZ,
  last_cursor    TEXT,
  last_error     TEXT,
  CHECK (id = 1)
);
INSERT INTO legacy_sync_state (id) VALUES (1);

CREATE VIEW v_occupancy AS
SELECT p.id AS person_id, p.full_name, p.employee_code, p.department,
       r.id AS room_id, r.room_name, e.scanned_at AS since
FROM (
  SELECT DISTINCT ON (person_id, room_id) *
  FROM access_events
  WHERE decision = 'ALLOWED' AND person_id IS NOT NULL
  ORDER BY person_id, room_id, scanned_at DESC, id DESC
) e
JOIN people p ON p.id = e.person_id
JOIN rooms  r ON r.id = e.room_id
WHERE e.direction = 'IN';

CREATE VIEW v_attendance_days AS
SELECT p.id AS person_id, p.full_name, p.employee_code, p.department,
       (e.scanned_at AT TIME ZONE 'UTC')::date AS work_date,
       MIN(e.scanned_at) FILTER (WHERE e.direction = 'IN')  AS first_in,
       MAX(e.scanned_at) FILTER (WHERE e.direction = 'OUT') AS last_out,
       NULLIF(GREATEST(ROUND(EXTRACT(EPOCH FROM (
         MAX(e.scanned_at) FILTER (WHERE e.direction = 'OUT') -
         MIN(e.scanned_at) FILTER (WHERE e.direction = 'IN')
       )) / 3600.0, 2), 0), 0) AS hours
FROM access_events e
JOIN people p ON p.id = e.person_id
JOIN devices d ON d.id = e.device_id
WHERE e.decision = 'ALLOWED' AND d.purpose = 'ATTENDANCE'
GROUP BY p.id, p.full_name, p.employee_code, p.department, work_date;
