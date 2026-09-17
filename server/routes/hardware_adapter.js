const express = require("express");
const { query, one } = require("../db");
const { broadcast } = require("../bus");
const { findCredential, findRule, nextDirection } = require("../decision");

const router = express.Router();

// Helper to find device by key or alias (like "ESP32_01" -> "DEV-MAIN-8F2A41C7")
async function resolveDevice(esp32Id) {
  const idStr = String(esp32Id || "").trim();
  let dev = await one(
    `SELECT d.*, r.room_name, r.is_restricted
       FROM devices d JOIN rooms r ON r.id = d.room_id
      WHERE d.device_key = $1 OR d.device_label ILIKE '%' || $1 || '%'`,
    [idStr]
  );
  if (!dev) {
    // Fallback: if ESP32_01, map to room 1 (Main Entrance)
    dev = await one(
      `SELECT d.*, r.room_name, r.is_restricted
         FROM devices d JOIN rooms r ON r.id = d.room_id
        WHERE d.id = 1`
    );
  }
  return dev;
}

// Normalize NFC UID (handles "C6:10:00:02" -> "C6100002" or raw hex)
function cleanUid(raw) {
  return String(raw || "").toUpperCase().replace(/[^0-9A-F]/g, "");
}

// ============================================================================
// 1. GET /access_control/authenticate.php
// Params: nfc_uid, esp32_id
// ============================================================================
router.get("/access_control/authenticate.php", async (req, res, next) => {
  try {
    const rawUid = req.query.nfc_uid;
    const esp32Id = req.query.esp32_id;

    if (!rawUid) {
      return res.json({ success: false, message: "Missing nfc_uid parameter" });
    }

    const nfcUid = cleanUid(rawUid);
    const device = await resolveDevice(esp32Id);

    if (!device) {
      return res.json({ success: false, message: "Unknown or inactive device" });
    }

    // Look up credential
    const cred = await findCredential(nfcUid);

    if (!cred || !cred.person_active || cred.is_revoked) {
      return res.json({
        success: true,
        authorized: false,
        message: !cred ? "Card not recognized" : (cred.is_revoked ? "Card revoked" : "Person inactive")
      });
    }

    // Check expiration
    if (cred.valid_until && new Date(cred.valid_until) < new Date()) {
      return res.json({
        success: true,
        authorized: false,
        message: "Card expired"
      });
    }

    // Check access rule for this room
    const rule = await findRule(device.room_id, cred.person_id, cred.department);
    if (!rule) {
      return res.json({
        success: true,
        authorized: false,
        message: "No access rule for this door"
      });
    }

    // Success response matching esp32_test2.ino expected fields
    return res.json({
      success: true,
      authorized: true,
      message: "OK",
      user_id: cred.person_id,
      employee_id: cred.employee_code,
      name: cred.full_name,
      fingerprint_id: cred.fingerprint_slot != null ? cred.fingerprint_slot : 0,
      door_id: device.room_id,
      door_name: device.room_name
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 2. GET /access_control/log_access.php
// Params: user_id, door_id, nfc_uid, fingerprint_id, result, reason
// ============================================================================
router.get("/access_control/log_access.php", async (req, res, next) => {
  try {
    const userId = Number(req.query.user_id) || null;
    const doorId = Number(req.query.door_id) || 1;
    const rawNfc = req.query.nfc_uid;
    const fpId = Number(req.query.fingerprint_id);
    const result = String(req.query.result || "").toUpperCase(); // "GRANTED" or "DENIED"
    const reason = String(req.query.reason || "OK");

    const nfcUid = cleanUid(rawNfc);
    const decision = result === "GRANTED" ? "ALLOWED" : "DENIED";

    // Lookup device for this room
    const dev = await one(`SELECT id FROM devices WHERE room_id = $1 LIMIT 1`, [doorId]);
    const deviceId = dev ? dev.id : 1;

    // Lookup credential if possible
    let credId = null;
    let personId = userId;
    if (nfcUid) {
      const cred = await one(`SELECT id, person_id FROM credentials WHERE card_uid = $1`, [nfcUid]);
      if (cred) {
        credId = cred.id;
        if (!personId) personId = cred.person_id;
      }
    }

    const direction = personId ? await nextDirection(personId, doorId) : "IN";
    const now = new Date();
    const eventIdStr = `ESP32-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random()*1000)}`;

    // Insert access event
    const event = await one(
      `INSERT INTO access_events
         (device_id, room_id, person_id, credential_id, card_uid, direction,
          decision, reason_code, fingerprint_used, scanned_at, received_at,
          source, device_event_id)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'NATIVE', $12)
       RETURNING *`,
      [
        deviceId,
        doorId,
        personId,
        credId,
        nfcUid || "UNKNOWN",
        direction,
        decision,
        reason,
        fpId > 0,
        now,
        now,
        eventIdStr
      ]
    );

    // Broadcast via SSE to live dashboard
    let personName = "Unknown";
    let roomName = "";
    if (personId) {
      const p = await one(`SELECT full_name FROM people WHERE id = $1`, [personId]);
      if (p) personName = p.full_name;
    }
    const r = await one(`SELECT room_name FROM rooms WHERE id = $1`, [doorId]);
    if (r) roomName = r.room_name;

    broadcast("access_event", {
      event_id: event.id,
      device_key: "ESP32_01",
      person_name: personName,
      room_name: roomName,
      direction: direction,
      decision: decision,
      reason_code: reason,
      scanned_at: now.toISOString(),
      fingerprint_used: fpId > 0
    });

    broadcast("occupancy_changed", { room_id: doorId });

    // Response matching esp32_test2.ino
    res.json({ success: true, event_id: event.id });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 3. GET /access_control/sync.php
// Params: esp32_id
// ============================================================================
router.get("/access_control/sync.php", async (req, res, next) => {
  try {
    const esp32Id = req.query.esp32_id;
    const device = await resolveDevice(esp32Id);
    const roomId = device ? device.room_id : 1;

    // Get all valid employees with access to this room
    const rows = await query(
      `SELECT p.employee_code, p.full_name, c.card_uid, c.fingerprint_slot, p.is_active
         FROM access_rules r
         JOIN people p ON (r.person_id = p.id OR (r.person_id IS NULL AND r.department = p.department))
         JOIN credentials c ON c.person_id = p.id
        WHERE r.room_id = $1
          AND p.is_active = TRUE
          AND c.is_revoked = FALSE
          AND (c.valid_until IS NULL OR c.valid_until > now())
          AND (r.valid_until IS NULL OR r.valid_until > now())`,
      [roomId]
    );

    const employees = rows.map((r) => ({
      employee_id: r.employee_code,
      name: r.full_name,
      nfc_uid: r.card_uid,
      fingerprint_id: r.fingerprint_slot != null ? r.fingerprint_slot : 0,
      door_id: roomId,
      allowed: 1,
      status: r.is_active ? "active" : "inactive"
    }));

    res.json({
      success: true,
      employee_count: employees.length,
      employees: employees
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
