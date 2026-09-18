\connect access_control

CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO departments (name)
VALUES ('Engineering'), ('Operations'), ('Finance'), ('HR'), ('Sales')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  shift_name TEXT NOT NULL UNIQUE,
  start_time TIME NOT NULL DEFAULT '09:30',
  end_time TIME NOT NULL DEFAULT '18:30',
  grace_minutes INT NOT NULL DEFAULT 15,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO shifts (shift_name, start_time, end_time, grace_minutes, is_default)
VALUES ('General Shift', '09:30', '18:30', 15, TRUE)
ON CONFLICT (shift_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY,
  holiday_date DATE NOT NULL UNIQUE,
  holiday_name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO holidays (holiday_date, holiday_name, description)
VALUES 
  ('2026-10-02', 'Gandhi Jayanti', 'National Holiday'),
  ('2026-11-08', 'Diwali', 'Festival of Lights'),
  ('2026-01-26', 'Republic Day', 'National Holiday')
ON CONFLICT (holiday_date) DO NOTHING;
