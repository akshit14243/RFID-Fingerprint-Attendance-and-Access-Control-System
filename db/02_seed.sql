\connect access_control

TRUNCATE access_events RESTART IDENTITY CASCADE;
ALTER TABLE access_events DISABLE TRIGGER trg_events_no_update;
TRUNCATE access_rules, credentials, devices, rooms, people, users RESTART IDENTITY CASCADE;

INSERT INTO people (employee_code, full_name, department, person_type, email) VALUES
 ('EMP001', 'Akshit Saini',     'Engineering', 'EMPLOYEE',   'akshit@example.com'),
 ('EMP002', 'Priya Nair',       'Engineering', 'EMPLOYEE',   'priya@example.com'),
 ('EMP003', 'Rahul Verma',      'Operations',  'EMPLOYEE',   'rahul@example.com'),
 ('EMP004', 'Sneha Kulkarni',   'Finance',     'EMPLOYEE',   'sneha@example.com'),
 ('EMP005', 'Imran Sheikh',     'Security',    'EMPLOYEE',   'imran@example.com'),
 ('EMP006', 'Meera Joshi',      'Engineering', 'EMPLOYEE',   'meera@example.com'),
 ('CON001', 'Vikas Rathore',    'Facilities',  'CONTRACTOR', NULL),
 ('VIS001', 'Anita Desai',      'Visitor',     'VISITOR',    NULL);

INSERT INTO credentials (person_id, card_uid, fingerprint_slot, valid_until, is_revoked) VALUES
 (1, '04A2B7C1', 1,  NULL, FALSE),
 (2, '04B3C8D2', 2,  NULL, FALSE),
 (3, '04C4D9E3', 3,  NULL, TRUE),
 (4, '04D5EAF4', 4,  NULL, FALSE),
 (5, '04E6FB05', 5,  NULL, FALSE),
 (6, '04F70C16', 6,  NULL, FALSE),
 (7, '0508 1D27', NULL, now() + interval '30 days', FALSE),
 (8, '0509 2E38', NULL, now() - interval '1 day',  FALSE);

UPDATE credentials SET card_uid = REPLACE(card_uid, ' ', '');

INSERT INTO rooms (room_name, is_restricted) VALUES
 ('Main Entrance', FALSE),
 ('Hardware Lab',  FALSE),
 ('Server Room',   TRUE),
 ('Finance Office',TRUE);

INSERT INTO devices (device_key, device_label, room_id, purpose, source, firmware_ver) VALUES
 ('DEV-MAIN-8F2A41C7', 'Main entrance reader', 1, 'ATTENDANCE', 'NATIVE', '0.1.0'),
 ('DEV-LAB-5C9E30B4',  'Hardware lab reader',  2, 'DOOR',       'NATIVE', '0.1.0'),
 ('DEV-SRV-2B7D91A6',  'Server room reader',   3, 'DOOR',       'NATIVE', '0.1.0'),
 ('DEV-LEGACY-FIN-01', 'Old finance reader',   4, 'DOOR',       'LEGACY', NULL);

INSERT INTO access_rules (room_id, department, fingerprint_required) VALUES
 (1, 'Engineering', FALSE), (1, 'Operations', FALSE), (1, 'Finance', FALSE),
 (1, 'Security',    FALSE), (1, 'Facilities', FALSE), (1, 'Visitor',  FALSE);

INSERT INTO access_rules (room_id, department, fingerprint_required) VALUES
 (2, 'Engineering', FALSE);

INSERT INTO access_rules (room_id, person_id, fingerprint_required) VALUES
 (3, 1, TRUE), (3, 5, TRUE);

INSERT INTO access_rules (room_id, department, fingerprint_required) VALUES
 (4, 'Finance', TRUE);

INSERT INTO users (email, password_hash, role) VALUES
 ('admin@example.com',  '$2b$10$HiKk3F7RBZGqovbsRjS5D.ZcF0dwW1BfeqULsqlHdJ42L2KOVn53K', 'admin'),
 ('viewer@example.com', '$2b$10$HiKk3F7RBZGqovbsRjS5D.ZcF0dwW1BfeqULsqlHdJ42L2KOVn53K', 'viewer');

INSERT INTO access_events
 (device_id, room_id, person_id, credential_id, card_uid, direction, decision,
  reason_code, fingerprint_used, scanned_at, received_at, source, device_event_id)
VALUES
 (1,1,1,1,'04A2B7C1','IN', 'ALLOWED','OK',              TRUE,  now()-interval '1 day 9 hours',  now()-interval '1 day 9 hours',  'NATIVE','MAIN-0001'),
 (1,1,2,2,'04B3C8D2','IN', 'ALLOWED','OK',              TRUE,  now()-interval '1 day 8 hours',  now()-interval '1 day 8 hours',  'NATIVE','MAIN-0002'),
 (2,2,1,1,'04A2B7C1','IN', 'ALLOWED','OK',              FALSE, now()-interval '1 day 7 hours',  now()-interval '1 day 7 hours',  'NATIVE','LAB-0001'),
 (2,2,1,1,'04A2B7C1','OUT','ALLOWED','OK',              FALSE, now()-interval '1 day 6 hours',  now()-interval '1 day 6 hours',  'NATIVE','LAB-0002'),
 (3,3,4,4,'04D5EAF4','IN', 'DENIED', 'NO_ACCESS_RULE',  TRUE,  now()-interval '1 day 5 hours',  now()-interval '1 day 5 hours',  'NATIVE','SRV-0001'),
 (1,1,1,1,'04A2B7C1','OUT','ALLOWED','OK',              TRUE,  now()-interval '1 day 1 hour',   now()-interval '1 day 1 hour',   'NATIVE','MAIN-0003'),
 (1,1,2,2,'04B3C8D2','OUT','ALLOWED','OK',              TRUE,  now()-interval '1 day',          now()-interval '1 day',          'NATIVE','MAIN-0004'),
 (1,1,1,1,'04A2B7C1','IN', 'ALLOWED','OK',              TRUE,  now()-interval '4 hours',        now()-interval '4 hours',        'NATIVE','MAIN-0005'),
 (1,1,5,5,'04E6FB05','IN', 'ALLOWED','OK',              TRUE,  now()-interval '3 hours',        now()-interval '3 hours',        'NATIVE','MAIN-0006'),
 (3,3,1,1,'04A2B7C1','IN', 'ALLOWED','OK',              TRUE,  now()-interval '2 hours',        now()-interval '2 hours',        'NATIVE','SRV-0002'),
 (2,2,3,3,'04C4D9E3','IN', 'DENIED', 'CREDENTIAL_REVOKED',FALSE,now()-interval '90 minutes',    now()-interval '90 minutes',     'NATIVE','LAB-0003'),
 (2,2,NULL,NULL,'0499FF01','IN','DENIED','UNKNOWN_CARD',FALSE, now()-interval '60 minutes',     now()-interval '60 minutes',     'NATIVE','LAB-0004'),
 (2,2,6,6,'04F70C16','IN','ALLOWED','OK',               FALSE, now()-interval '80 minutes',     now()-interval '40 minutes',     'NATIVE','LAB-0005');

ALTER TABLE access_events ENABLE TRIGGER trg_events_no_update;

SELECT 'people' AS table, count(*) FROM people
UNION ALL SELECT 'credentials', count(*) FROM credentials
UNION ALL SELECT 'rooms', count(*) FROM rooms
UNION ALL SELECT 'devices', count(*) FROM devices
UNION ALL SELECT 'access_rules', count(*) FROM access_rules
UNION ALL SELECT 'access_events', count(*) FROM access_events;
