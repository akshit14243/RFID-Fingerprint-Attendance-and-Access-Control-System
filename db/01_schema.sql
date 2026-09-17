-- ===========================================================================
-- RFID + Fingerprint Access Control / Attendance
-- Schema for PostgreSQL 14+          run:  psql -U postgres -f db/01_schema.sql
-- ===========================================================================
-- Everything is UTC (timestamptz). The frontend formats for display.
-- access_events is APPEND ONLY: no UPDATE, no DELETE, ever. That is what makes
-- it an audit trail instead of just a table.
-- ===========================================================================

DROP DATABASE IF EXISTS access_control;
CREATE DATABASE access_control;
\connect access_control

-- --- enums -----------------------------------------------------------------
CREATE TYPE direction_t   AS ENUM ('IN', 'OUT');
CREATE TYPE decision_t    AS ENUM ('ALLOWED', 'DENIED');
CREATE TYPE source_t      AS ENUM ('NATIVE', 'LEGACY');   -- new ESP32 vs the old RFID-only system
CREATE TYPE purpose_t     AS ENUM ('DOOR', 'ATTENDANCE'); -- a plain door vs a shift check-in point
CREATE TYPE role_t        AS ENUM ('admin', 'viewer');

-- --- 1. people -------------------------------------------------------------
-- The person is the identity. A card is not a person; that distinction is the
-- whole reason this table exists separately from credentials.
CREATE TABLE people (
  id            SERIAL PRIMARY KEY,
  employee_code TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  department    TEXT NOT NULL,
  person_type   TEXT NOT NULL DEFAULT 'EMPLOYEE',  -- EMPLOYEE | CONTRACTOR | VISITOR
  email         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- 2. credentials --------------------------------------------------------
-- A card and/or a fingerprint slot belonging to a person. Lost card => set
-- is_revoked, we never delete the person or their history.
CREATE TABLE credentials (
  id               SERIAL PRIMARY KEY,
  person_id        INT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  card_uid         TEXT NOT NULL UNIQUE,        -- uppercase hex from the PN532
  fingerprint_slot INT,                         -- R307S template id, NULL if not enrolled
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until      TIMESTAMPTZ,                 -- NULL = no expiry
  is_revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_credentials_person ON credentials(person_id);

-- --- 3. rooms --------------------------------------------------------------
CREATE TABLE rooms (
  id            SERIAL PRIMARY KEY,
  room_name     TEXT NOT NULL UNIQUE,
  is_restricted BOOLEAN NOT NULL DEFAULT FALSE
);

-- --- 4. devices ------------------------------------------------------------
-- One row per ESP32 board (and per legacy reader, so old data has a home too).
CREATE TABLE devices (
  id            SERIAL PRIMARY KEY,
  device_key    TEXT NOT NULL UNIQUE,   -- the board's shared secret, sent on every request
  device_label  TEXT NOT NULL,
  room_id       INT NOT NULL REFERENCES rooms(id),
  purpose       purpose_t NOT NULL DEFAULT 'DOOR',
  source        source_t  NOT NULL DEFAULT 'NATIVE',
  firmware_ver  TEXT,
  last_seen_at  TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

-- --- 5. access_rules -------------------------------------------------------
-- "Every card opens every door" is the complaint. This table is the fix.
-- A rule targets ONE person, or a whole department (person_id NULL).
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

-- --- 6. access_events ------------------------------------------------------
-- The heart of the system. Every tap ends up here, allowed or denied.
CREATE TABLE access_events (
  id               BIGSERIAL PRIMARY KEY,
  device_id        INT NOT NULL REFERENCES devices(id),
  room_id          INT NOT NULL REFERENCES rooms(id),
  person_id        INT REFERENCES people(id),        -- NULL for an unknown card
  credential_id    INT REFERENCES credentials(id),
  card_uid         TEXT NOT NULL,
  direction        direction_t NOT NULL,
  decision         decision_t  NOT NULL,
  reason_code      TEXT NOT NULL,                    -- OK, UNKNOWN_CARD, NO_ACCESS_RULE, ...
  fingerprint_used BOOLEAN NOT NULL DEFAULT FALSE,
  scanned_at       TIMESTAMPTZ NOT NULL,             -- the device clock
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),-- our clock; the gap shows drift / offline replay
  source           source_t NOT NULL DEFAULT 'NATIVE',
  device_event_id  TEXT NOT NULL,                    -- the board's own counter, survives reboot
  external_id      TEXT                              -- the legacy system's record id, if imported
);
-- This one index is what makes a retried offline batch harmless.
CREATE UNIQUE INDEX uq_event_device ON access_events(device_id, device_event_id);
CREATE UNIQUE INDEX uq_event_external ON access_events(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_events_time   ON access_events(scanned_at DESC);
CREATE INDEX idx_events_person ON access_events(person_id, scanned_at DESC);
CREATE INDEX idx_events_room   ON access_events(room_id, scanned_at DESC);

-- Enforce append-only at the database level, not just by good intentions.
CREATE OR REPLACE FUNCTION block_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'access_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_events_no_update BEFORE UPDATE OR DELETE ON access_events
  FOR EACH ROW EXECUTE FUNCTION block_event_mutation();

-- --- 7. users (dashboard login) -------------------------------------------
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          role_t NOT NULL DEFAULT 'viewer',   -- role lives here, checked server side only
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- 8. sync bookkeeping for the legacy system -----------------------------
CREATE TABLE legacy_sync_state (
  id             INT PRIMARY KEY DEFAULT 1,
  last_synced_at TIMESTAMPTZ,
  last_cursor    TEXT,
  last_error     TEXT,
  CHECK (id = 1)
);
INSERT INTO legacy_sync_state (id) VALUES (1);

-- --- 9. occupancy view -----------------------------------------------------
-- Who is inside right now. Derived from the last ALLOWED event per person per
-- room. Never a stored "is_inside" flag, because that goes stale the moment a
-- single event is missed.
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

-- --- 10. attendance view ---------------------------------------------------
-- First IN and last OUT per person per day, at ATTENDANCE devices.
CREATE VIEW v_attendance_days AS
SELECT p.id AS person_id, p.full_name, p.employee_code, p.department,
       (e.scanned_at AT TIME ZONE 'UTC')::date AS work_date,
       MIN(e.scanned_at) FILTER (WHERE e.direction = 'IN')  AS first_in,
       MAX(e.scanned_at) FILTER (WHERE e.direction = 'OUT') AS last_out,
       -- NULL when the day is incomplete (no OUT yet) or the timestamps are
       -- out of order after a late offline replay. The dashboard shows a dash
       -- rather than a nonsense negative number.
       NULLIF(GREATEST(ROUND(EXTRACT(EPOCH FROM (
         MAX(e.scanned_at) FILTER (WHERE e.direction = 'OUT') -
         MIN(e.scanned_at) FILTER (WHERE e.direction = 'IN')
       )) / 3600.0, 2), 0), 0) AS hours
FROM access_events e
JOIN people p ON p.id = e.person_id
JOIN devices d ON d.id = e.device_id
WHERE e.decision = 'ALLOWED' AND d.purpose = 'ATTENDANCE'
GROUP BY p.id, p.full_name, p.employee_code, p.department, work_date;
