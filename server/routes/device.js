// Everything the ESP32 boards call: scan, sync, heartbeat, config.
// Each request carries device_key; an unknown key gets 401 and nothing else.

const express = require("express");
const { z } = require("zod");
const { query, one } = require("../db");
const { findDevice, decideAndLog } = require("../decision");

const router = express.Router();

const scanSchema = z.object({
  device_key: z.string().min(4),
  card_uid: z.string().min(4).max(32),
  fingerprint_slot: z.number().int().nonnegative().nullable().optional(),
  scanned_at: z.string().optional(),
  device_event_id: z.string().min(1).max(64),
});

const syncSchema = z.object({
  device_key: z.string().min(4),
  events: z.array(scanSchema.omit({ device_key: true })).max(100),
});

function badRequest(res, err) {
  return res.status(400).json({ error: "bad_request", details: err.errors ?? String(err) });
}

// --- 1. one live scan ------------------------------------------------------
router.post("/scan", async (req, res, next) => {
  try {
    const parsed = scanSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);

    const device = await findDevice(parsed.data.device_key);
    if (!device) return res.status(401).json({ error: "unknown_device" });

    const out = await decideAndLog(device, parsed.data);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// --- 2. offline buffer replay ---------------------------------------------
// The board sends what it stored while Wi-Fi was down. Re-sending the same
// batch is safe: anything already stored comes back as "duplicate".
router.post("/sync", async (req, res, next) => {
  try {
    const parsed = syncSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);

    const device = await findDevice(parsed.data.device_key);
    if (!device) return res.status(401).json({ error: "unknown_device" });

    const results = [];
    let accepted = 0;
    let duplicates = 0;

    for (const ev of parsed.data.events) {
      const out = await decideAndLog(device, ev);
      out.duplicate ? duplicates++ : accepted++;
      results.push({
        device_event_id: ev.device_event_id,
        status: out.duplicate ? "duplicate" : "accepted",
        allowed: out.allowed,
        reason: out.reason,
      });
    }

    // stored[] is what the board is allowed to delete from its own buffer.
    res.json({
      accepted,
      duplicates,
      rejected: 0,
      stored: results.map((r) => r.device_event_id),
      results,
    });
  } catch (err) {
    next(err);
  }
});

// --- 3. heartbeat ----------------------------------------------------------
router.post("/heartbeat", async (req, res, next) => {
  try {
    const { device_key, firmware_ver } = req.body || {};
    if (!device_key) return res.status(400).json({ error: "bad_request", message: "device_key required" });

    const device = await findDevice(device_key);
    if (!device) return res.status(401).json({ error: "unknown_device" });

    await query(
      "UPDATE devices SET last_seen_at = now(), firmware_ver = COALESCE($1, firmware_ver) WHERE id = $2",
      [firmware_ver ?? null, device.id],
    );
    // server_time lets the board correct its own clock drift.
    res.json({ server_time: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// --- 4. device config ------------------------------------------------------
// The board pulls this on boot and every few minutes. It caches the allow-list
// so it can still decide correctly while the Wi-Fi is down.
router.get("/device/config", async (req, res, next) => {
  try {
    const device = await findDevice(String(req.query.device_key || ""));
    if (!device) return res.status(401).json({ error: "unknown_device" });

    const allowed = await query(
      `SELECT c.card_uid, c.fingerprint_slot, r.fingerprint_required
         FROM access_rules r
         JOIN people p  ON (r.person_id = p.id OR (r.person_id IS NULL AND r.department = p.department))
         JOIN credentials c ON c.person_id = p.id
        WHERE r.room_id = $1
          AND p.is_active AND NOT c.is_revoked
          AND (c.valid_until IS NULL OR c.valid_until > now())
          AND (r.valid_until IS NULL OR r.valid_until > now())`,
      [device.room_id],
    );

    res.json({
      device_label: device.device_label,
      room_name: device.room_name,
      purpose: device.purpose,
      server_time: new Date().toISOString(),
      heartbeat_sec: 60,
      max_batch: 100,
      allow_list: allowed,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
