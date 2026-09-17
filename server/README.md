# API server (runs on my laptop)

Express + PostgreSQL. No cloud, no hosting. The ESP32 boards reach it over the
LAN; the dashboard reaches it from the browser.

## Run it

```bash
cd server
npm install
cp .env.example .env      # put your PostgreSQL password in it
npm start
```

It prints the exact URL to hand to the hardware team, e.g.
`http://192.168.1.24:3000`. Check it: `curl http://127.0.0.1:3000/api/health`.

Opening that same URL in a browser serves the demo dashboard
(`../web/index.html`) — login, occupancy, devices, audit log and the live feed.

If the boards cannot reach it, it is almost always the laptop firewall blocking
port 3000.

## Test without hardware

```bash
node ../tools/simulate_device.cjs                       # one scan
node ../tools/simulate_device.cjs --loop 5              # five random scans
node ../tools/simulate_device.cjs --offline 4           # buffer while "Wi-Fi is down", then sync
node ../tools/simulate_device.cjs --replay              # re-send the same batch: all duplicates
node ../tools/simulate_device.cjs --card 0499FF01       # unknown card, denied
node ../tools/simulate_device.cjs --device DEV-SRV-2B7D91A6 --no-finger   # restricted door without a finger
```

## Files

| File | What it does |
|---|---|
| `index.js` | wiring: middleware, routes, error handler |
| `db.js` | PostgreSQL pool |
| `auth.js` | login, token, admin check |
| `decision.js` | the one access decision, in one place |
| `bus.js` | keeps the live-stream listeners |
| `routes/device.js` | scan, sync, heartbeat, config — the boards |
| `routes/reads.js` | occupancy, events, attendance, device status |
| `routes/admin.js` | people, cards, rooms, devices, rules |
| `routes/stream.js` | `GET /api/stream`, the real-time feed |
| `../web/index.html` | the static demo dashboard the server hands out at `/` |
| `legacy/mapping.js` | the only file to edit when the old system's field names arrive |
| `legacy/sync.js` | optional timer that imports from the old RFID-only system |

Endpoints are documented in `../API.md`.

## Login

Seeded users (password `admin123`):

- `admin@example.com` — can change things
- `viewer@example.com` — read only

Change a password: `node tools/hash_password.js newpassword` and paste the hash
into the `users` table.
