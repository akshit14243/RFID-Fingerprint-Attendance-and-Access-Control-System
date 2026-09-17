# API — one page for the hardware team and the frontend

Base URL while we develop: `http://<my-laptop-lan-ip>:3000`
(both the boards and the dashboard must be on the same Wi-Fi; `localhost` from
an ESP32 means the ESP32 itself, so it must be the IP).

Everything is JSON. Times are ISO-8601 UTC (`2026-09-03T09:30:44Z`).

---

## A. Endpoints for the ESP32 boards (no login, `device_key` instead)

### `POST /api/scan` — one live tap

```json
{
  "device_key": "DEV-MAIN-8F2A41C7",
  "card_uid": "04A2B7C1",
  "fingerprint_slot": 1,
  "scanned_at": "2026-09-03T09:30:44Z",
  "device_event_id": "MAIN-00012"
}
```

`fingerprint_slot` is the R307S template id that matched, or `null` if no
finger was read. `device_event_id` must be unique per board and must survive a
reboot — this is what makes a retry safe.

Reply:

```json
{ "allowed": true, "direction": "IN", "person_name": "Akshit Saini", "reason": "OK", "event_id": 812, "duplicate": false }
```

Open the relay only when `allowed` is `true`. Direction is decided by the
server from the person's previous event in that room, so the board does not
have to track it.

Reason codes: `OK`, `UNKNOWN_CARD`, `CREDENTIAL_REVOKED`, `CREDENTIAL_EXPIRED`,
`CREDENTIAL_NOT_YET_VALID`, `PERSON_INACTIVE`, `NO_ACCESS_RULE`,
`FINGERPRINT_REQUIRED`, `FINGERPRINT_MISMATCH`, `DEVICE_INACTIVE`.

Status codes: `200` decided, `400` bad body, `401` unknown device key.

### `POST /api/sync` — the offline buffer

```json
{ "device_key": "DEV-MAIN-8F2A41C7", "events": [ { "card_uid": "...", "fingerprint_slot": 1, "scanned_at": "...", "device_event_id": "..." } ] }
```

Up to 100 per batch. Reply:

```json
{ "accepted": 3, "duplicates": 1, "rejected": 0,
  "stored": ["MAIN-00013","MAIN-00014","MAIN-00015","MAIN-00016"],
  "results": [ { "device_event_id": "MAIN-00013", "status": "accepted", "allowed": true, "reason": "OK" } ] }
```

Delete from your own buffer only the ids listed in `stored`. Re-sending the
same batch is safe — already-stored rows come back as `duplicate` and are not
counted twice.

### `POST /api/heartbeat` — every 60 s

`{ "device_key": "...", "firmware_ver": "0.1.0" }` → `{ "server_time": "..." }`
Use `server_time` to correct your clock drift.

### `GET /api/device/config?device_key=...`

Returns the board's room, purpose (`DOOR` or `ATTENDANCE`), heartbeat interval
and an `allow_list` of `{ card_uid, fingerprint_slot, fingerprint_required }`.
Cache it — that is what lets the board still decide correctly while Wi-Fi is
down.

---

## B. Endpoints for the dashboard (login required)

### `POST /api/auth/login`

`{ "email": "admin@example.com", "password": "admin123" }` →
`{ "token": "...", "user": { "id": 1, "email": "...", "role": "admin" } }`

Send it back on every other call: `Authorization: Bearer <token>`.
`viewer` can read everything; only `admin` can create, edit or delete.

### Reads

| Method | Path | Returns |
|---|---|---|
| GET | `/api/occupancy` | who is inside right now, per room |
| GET | `/api/events?from=&to=&room_id=&person_id=&decision=&direction=&limit=` | event history; each row has name, room, direction, decision, reason, `scanned_at`, `received_at`, `arrived_late` |
| GET | `/api/attendance?date=YYYY-MM-DD` | first in, last out, hours per person |
| GET | `/api/devices/status` | each board, `last_seen_at`, `online` |
| GET | `/api/legacy/status` | is the old-system sync on, when it last ran |

### Writes (admin only)

`POST/PUT/DELETE /api/people`, `POST /api/credentials`,
`POST /api/credentials/:id/revoke`, `POST /api/rooms`, `POST /api/devices`,
`POST/DELETE /api/rules`, `POST /api/legacy/sync-now`.

### Live updates — `GET /api/stream`

Server-Sent Events. Works identically in vanilla JS and React:

```js
const es = new EventSource("http://<lan-ip>:3000/api/stream");
es.addEventListener("access_event", (e) => {
  const ev = JSON.parse(e.data);   // person_name, room_name, direction, decision, reason_code, scanned_at
});
es.addEventListener("occupancy_changed", () => refreshOccupancy());
```

In React put that in a `useEffect` and call `es.close()` in the cleanup. The
browser reconnects on its own if the server restarts.

---

## C. Errors

Same shape everywhere:

```json
{ "error": "bad_request", "details": [ ... ] }
```

`400` invalid body · `401` no/!valid token or unknown device key · `403` needs
admin · `404` not found · `409` duplicate · `500` server error.
