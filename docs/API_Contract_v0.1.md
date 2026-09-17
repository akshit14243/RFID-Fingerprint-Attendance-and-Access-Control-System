# API Contract v0.1 (draft)

RFID + Fingerprint Attendance System — contract between the ESP32 firmware and
the server. Marked v0.1 because I expect the hardware team to find things that
need changing once they are on real hardware. It gets frozen after that.

- Base URL during development: `http://<laptop-lan-ip>:3000` (for example `http://192.168.1.24:3000`)
- Content type: `application/json` for every request and response
- Time format: ISO 8601 UTC, e.g. `2026-09-01T09:30:44Z`
- Authentication: every device request carries `device_key`. Unknown or inactive key -> `401`.

---

## 1. POST /api/scan

The device sends one scan; the server decides and answers. The device does not
decide anything by itself — it only reports what it read and obeys the answer.

Request:

```json
{
  "device_key": "DEV-MAIN-8F2A41C7",
  "card_uid": "04A2B7C1",
  "fingerprint_slot": 1,
  "scanned_at": "2026-09-01T09:30:44Z",
  "device_event_id": "MAIN-0011"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `device_key` | string | yes | Issued by me, one per board |
| `card_uid` | string | yes | Uppercase hex, no separators |
| `fingerprint_slot` | integer | no | Omit or `null` when no finger was presented |
| `scanned_at` | string | yes | Device clock, UTC |
| `device_event_id` | string | yes | Unique per device, never reused. Used for idempotency |

Response `200`:

```json
{
  "allowed": true,
  "direction": "IN",
  "person_name": "Akshit Saini",
  "reason": "OK",
  "event_id": 1041
}
```

Denied example (still `200` — the request was valid, the person was not):

```json
{
  "allowed": false,
  "direction": "IN",
  "person_name": null,
  "reason": "FINGERPRINT_REQUIRED",
  "event_id": 1042
}
```

Reason codes: `OK`, `UNKNOWN_CARD`, `CREDENTIAL_EXPIRED`, `CREDENTIAL_REVOKED`,
`NO_ACCESS_RULE`, `FINGERPRINT_REQUIRED`, `FINGERPRINT_MISMATCH`,
`PERSON_INACTIVE`, `DEVICE_INACTIVE`.

Direction is decided by the server, not the device: if the person's last allowed
event in that room was `IN`, this one is `OUT`, otherwise `IN`.

Errors: `400` malformed body or missing field, `401` bad device key,
`500` server or database failure. On anything other than `200` the device should
buffer the event locally and retry through `/api/sync`.

---

## 2. POST /api/sync

Replay of events the device buffered while Wi-Fi was down. Up to 50 per call.

```json
{
  "device_key": "DEV-MAIN-8F2A41C7",
  "events": [
    { "card_uid": "04A2B7C1", "fingerprint_slot": 1, "scanned_at": "2026-09-01T09:31:00Z", "device_event_id": "MAIN-0012" },
    { "card_uid": "04B8D3E2", "fingerprint_slot": null, "scanned_at": "2026-09-01T09:33:10Z", "device_event_id": "MAIN-0013" }
  ]
}
```

Response `200`:

```json
{ "accepted": 2, "duplicates": 0, "rejected": 0, "results": [
  { "device_event_id": "MAIN-0012", "status": "accepted", "allowed": true,  "reason": "OK" },
  { "device_event_id": "MAIN-0013", "status": "accepted", "allowed": false, "reason": "NO_ACCESS_RULE" }
]}
```

Idempotent: an event whose `device_event_id` already exists for that device is
reported as `duplicate` and stored once. The device may safely retry the whole
batch after a timeout. Buffered events are logged but the door has already
closed on them — they count for attendance, not for opening anything.

---

## 3. POST /api/heartbeat

```json
{ "device_key": "DEV-LAB-5C9E30B4", "firmware_ver": "0.1.0", "uptime_s": 8123 }
```

Response `200`: `{ "server_time": "2026-09-01T09:35:02Z" }`

Updates `last_seen_at`. The device should also use `server_time` to correct its
own clock drift. Recommended interval: every 60 seconds.

---

## 4. Reads for the web dashboard (not for the device)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/occupancy` | Who is inside right now, per room |
| GET | `/api/events?from=&to=&person_id=&room_id=` | Filtered audit log |
| GET | `/api/people` | People and their credentials |
| POST | `/api/people` | Add a person |
| POST | `/api/credentials/:id/revoke` | Revoke a lost card |

---

## 5. Quick test for the hardware team

```bash
curl -X POST http://192.168.1.24:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"device_key":"DEV-MAIN-8F2A41C7","card_uid":"04A2B7C1","fingerprint_slot":1,"scanned_at":"2026-09-01T09:30:44Z","device_event_id":"TEST-0001"}'
```

Arduino side, same call:

```cpp
HTTPClient http;
http.begin("http://192.168.1.24:3000/api/scan");
http.addHeader("Content-Type", "application/json");
String body = "{\"device_key\":\"DEV-MAIN-8F2A41C7\",\"card_uid\":\"" + uid +
              "\",\"fingerprint_slot\":" + String(slot) +
              ",\"scanned_at\":\"" + isoTime + "\",\"device_event_id\":\"" + eventId + "\"}";
int code = http.POST(body);
String reply = http.getString();
http.end();
```

## 6. Open points to settle with the hardware team

1. Does the firmware keep its own event counter across reboots? `device_event_id` must never repeat.
2. Is the ESP32 clock set from NTP, or should it just send uptime and let the server timestamp?
3. How long can the offline buffer hold events before it starts overwriting?
4. Do they want the relay pulse duration returned in the scan response, or hard-coded in firmware?
