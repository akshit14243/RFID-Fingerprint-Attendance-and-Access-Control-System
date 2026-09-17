# Integration note for the hardware team

Short version of what you need from the server side. Full detail is in
`API_Contract_v0.1.md`.

## 1. Where the server is

While we are developing, the server runs on my laptop:

```
http://<my-laptop-lan-ip>:3000
```

I will send the current IP on the group before each session — it changes when
the router hands out a new lease. Both boards and my laptop must be on the same
Wi-Fi. `localhost` from the ESP32 means the ESP32 itself, so it must be the IP.

If you cannot reach it: my firewall may be blocking port 3000, ping me and I
will allow it.

## 2. Your device keys

| Board | device_key | Door |
|---|---|---|
| Board 1 | `DEV-MAIN-8F2A41C7` | Main Entrance |
| Board 2 | `DEV-LAB-5C9E30B4` | Hardware Lab |

Send it with every request. Unknown key gets a `401`.

## 3. What to send on a scan

```json
POST /api/scan
{
  "device_key": "DEV-MAIN-8F2A41C7",
  "card_uid": "04A2B7C1",
  "fingerprint_slot": 1,
  "scanned_at": "2026-09-01T09:30:44Z",
  "device_event_id": "MAIN-0011"
}
```

- `card_uid`: uppercase hex, no colons or spaces.
- `fingerprint_slot`: the R307S template ID that matched, or `null` if no finger was read.
- `device_event_id`: must be unique per board and must survive a reboot. This is what stops a duplicate when you retry.

You get back:

```json
{ "allowed": true, "direction": "IN", "person_name": "Akshit Saini", "reason": "OK" }
```

Fire the relay only when `allowed` is `true`. Show the reason on the buzzer/LED
however you like — `FINGERPRINT_REQUIRED` should probably prompt for the finger
rather than just beeping a refusal.

## 4. When Wi-Fi is down

Buffer locally, then send up to 50 at a time to `POST /api/sync` with the same
fields. Re-sending the same batch is safe: anything already stored comes back as
`duplicate` and is not counted twice.

## 5. Heartbeat

`POST /api/heartbeat` every 60 s with `device_key` and `firmware_ver`. The reply
carries `server_time`, which you can use to correct clock drift.

## 6. Test it in two minutes

```bash
curl -X POST http://<my-ip>:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"device_key":"DEV-MAIN-8F2A41C7","card_uid":"04A2B7C1","fingerprint_slot":1,"scanned_at":"2026-09-01T09:30:44Z","device_event_id":"TEST-0001"}'
```

Use a fresh `device_event_id` each time or you will get `duplicate` back, which
is the system working correctly.

## 7. Things I need from you

1. Confirm the event counter survives a reboot.
2. Tell me whether you will set the clock from NTP or rely on my `server_time`.
3. Tell me how many events your offline buffer can hold.
4. Send me the real card UIDs once you can read them, so I can register them against people.
