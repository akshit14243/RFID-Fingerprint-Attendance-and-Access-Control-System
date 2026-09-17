# RFID + Fingerprint Access Control — database & backend

My part of the team project: the **PostgreSQL database** and the **Node.js API**
that the ESP32 readers talk to and the dashboard reads from. The hardware is
built by another team; the frontend by another teammate. Everything here runs
locally on my laptop and can be moved to a real server later without changing
any code — only the `.env`.

## How the pieces fit

```
ESP32 readers ──HTTP/JSON──►  API (Express, port 3000)  ──SQL──►  PostgreSQL
 (RFID + finger)              ▲                  │
                              │                  └── Server-Sent Events ──► dashboard (live)
 old RFID-only system ────────┘  (optional adapter, off by default)
```

Rules I am holding myself to:

1. **The server decides, not the reader.** A board can cache an allow-list to
   survive a Wi-Fi drop, but the record of truth is here.
2. **`access_events` is append-only.** A trigger blocks UPDATE and DELETE.
3. **Nothing is ever counted twice.** Every event carries a `device_event_id`
   that is unique per board, so a retry after a bad network is safe.
4. **Two timestamps.** `scanned_at` from the device, `received_at` from the
   server — the gap is how you spot clock drift and late offline replays.
5. **Occupancy is derived, never a stored flag.**

## Get it running

```bash
psql -U postgres -f db/01_schema.sql     # creates the database + tables
psql -U postgres -f db/02_seed.sql       # sample people, rooms, events

cd server && npm install && cp .env.example .env   # put your DB password in .env
npm start
```

The server prints the LAN URL to give the hardware team. Open that URL in a
browser (`http://<laptop-lan-ip>:3000/`) and the demo dashboard comes up — one
plain HTML file, no build step, no framework. Then, with no hardware at all:

```bash
node tools/simulate_device.cjs --loop 5      # live scans
node tools/simulate_device.cjs --offline 4   # Wi-Fi was down, then sync
node tools/simulate_device.cjs --replay      # same batch again: all duplicates
```

Leave the dashboard open while the simulator runs: scans appear in the live
feed the moment they are stored.

Dashboard login: `admin@example.com` / `admin123` (admin), `viewer@example.com`
/ `admin123` (read only).

## Where things are

| Path | What |
|---|---|
| `db/` | schema, seed and setup notes |
| `server/` | the API |
| `server/legacy/` | optional adapter for the existing RFID-only system, disabled by default |
| `web/index.html` | the demo dashboard — one static page, served by the API at `/` |
| `tools/simulate_device.cjs` | a fake ESP32 for testing |
| `API.md` | the contract for the hardware team and the frontend |

## The demo page

`web/index.html` is deliberately one file of plain HTML, CSS and JavaScript. It
exists to show the backend working end to end — log in, who is inside right
now, device health, the audit log with both timestamps, and live scans arriving
over Server-Sent Events. It is not the real frontend; my teammate is building
that in his own stack, and this page doubles as the worked example of every
call he needs (`fetch` with a Bearer token, and one `EventSource`).
