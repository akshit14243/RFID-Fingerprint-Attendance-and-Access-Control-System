# Database setup (PostgreSQL, local)

## 1. Install

- Windows / macOS: the installer from https://www.postgresql.org/download/
  (it includes pgAdmin, which is the GUI I use to look at the tables)
- Linux: `sudo apt install postgresql`

Remember the password you set for the `postgres` user.

## 2. Create everything

From the project root:

```bash
psql -U postgres -f db/01_schema.sql
psql -U postgres -f db/02_seed.sql
```

`01_schema.sql` drops and recreates the `access_control` database, so running
it again gives a clean slate. `02_seed.sql` fills it with 8 people, 4 rooms,
4 devices, the access rules and two days of events.

In pgAdmin: right-click the server → Query Tool → open the file → run.

## 3. Check it worked

```bash
psql -U postgres -d access_control -c "SELECT * FROM v_occupancy;"
psql -U postgres -d access_control -c "SELECT full_name, direction, decision, scanned_at FROM access_events e JOIN people p ON p.id=e.person_id ORDER BY scanned_at DESC LIMIT 5;"
```

## 4. The tables

| Table | Holds |
|---|---|
| `people` | the identity: name, employee code, department |
| `credentials` | a card and/or fingerprint slot belonging to a person, with expiry and revoke |
| `rooms` | each area, and whether it is restricted |
| `devices` | one row per reader: its key, room, purpose (DOOR / ATTENDANCE), source (NATIVE / LEGACY) |
| `access_rules` | who may enter which room, and whether a fingerprint is required |
| `access_events` | append-only log of every tap: person, room, IN/OUT, allowed/denied, reason, both timestamps |
| `users` | dashboard logins with an admin/viewer role |
| `legacy_sync_state` | when we last pulled from the old RFID-only system |
| `v_occupancy` (view) | who is inside right now |
| `v_attendance_days` (view) | first in, last out, hours per person per day |

Three design points worth defending:

1. **`access_events` is append-only** — a database trigger raises an exception
   on UPDATE or DELETE. An audit log you can edit is not an audit log.
2. **Occupancy is a view, not a flag.** A stored `is_inside` boolean goes wrong
   the first time an event is missed; a view recomputed from the log cannot.
3. **`scanned_at` and `received_at` are both stored.** The gap between them is
   exactly how you see clock drift and events that arrived late after an
   offline period.

## 5. Diagram for the report

pgAdmin → right-click the `access_control` database → *ERD For Database*.
That gives the entity-relationship diagram straight from the real schema.
