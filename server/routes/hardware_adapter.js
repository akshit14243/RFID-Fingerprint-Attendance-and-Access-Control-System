const express = require("express");
const { query, one } = require("../db");
const { broadcast } = require("../bus");
const { findCredential, findRule, nextDirection } = require("../decision");

const router = express.Router();

async function resolveDevice(esp32Id) {
  const idStr = String(esp32Id || "").trim();
  let dev = null;
  if (idStr) {
    dev = await one(
      `SELECT d.*, r.room_name, r.is_restricted
         FROM devices d JOIN rooms r ON r.id = d.room_id
        WHERE d.device_key = $1 OR d.device_label ILIKE '%' || $1 || '%'`,
      [idStr]
    );
    if (!dev) {
      try {
        dev = await one(
          `INSERT INTO devices (device_key, device_label, room_id, purpose, source, last_seen_at)
           VALUES ($1, $2, 1, 'ATTENDANCE', 'NATIVE', now())
           ON CONFLICT (device_key) DO UPDATE SET last_seen_at = now()
           RETURNING *`,
          [idStr, `Reader ${idStr}`]
        );
        if (dev) {
          const room = await one(`SELECT room_name, is_restricted FROM rooms WHERE id = $1`, [dev.room_id]);
          if (room) {
            dev.room_name = room.room_name;
            dev.is_restricted = room.is_restricted;
          }
        }
      } catch (e) {}
    }
  }
  if (!dev) {
    dev = await one(
      `SELECT d.*, r.room_name, r.is_restricted
         FROM devices d JOIN rooms r ON r.id = d.room_id
        WHERE d.id = 1`
    );
  }
  if (dev) {
    await query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [dev.id]);
  }
  return dev;
}

function cleanUid(raw) {
  return String(raw || "").toUpperCase().replace(/[^0-9A-F]/g, "");
}

function parseAccessTime(rawStr) {
  if (!rawStr) return new Date();
  // Match DD/MM/YYYY HH:MM:SS format from DS3231 RTC
  const match = String(rawStr).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (match) {
    const [, day, month, year, hour, minute, second] = match;
    const d = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    if (!isNaN(d.getTime())) return d;
  }
  const fallback = new Date(rawStr);
  return isNaN(fallback.getTime()) ? new Date() : fallback;
}

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

    // Check if there is an active enrollment job waiting for a card tap
    try {
      const pendingJob = await one(
        `SELECT id, person_id, fingerprint_id, updated_at FROM fingerprint_enrollment_jobs
          WHERE status IN ('REQUESTED', 'RUNNING') AND step = 'WAITING_CARD'
            AND (target_device_id = $1 OR target_device_id IS NULL)
          ORDER BY id DESC LIMIT 1`,
        [device.id]
      );
      if (pendingJob) {
        const ageSec = (Date.now() - new Date(pendingJob.updated_at).getTime()) / 1000;
        if (ageSec > 35) {
          await query(
            `UPDATE fingerprint_enrollment_jobs
                SET status = 'TIMEOUT', step = 'TIMEOUT',
                    error_message = 'Hardware card scan timed out.',
                    updated_at = now()
              WHERE id = $1`,
            [pendingJob.id]
          );
          broadcast("enrollment_update", {
            job_id: pendingJob.id,
            status: "TIMEOUT",
            step: "TIMEOUT",
            error_message: "Hardware card scan timed out."
          });
        } else {
          await query(
            `UPDATE fingerprint_enrollment_jobs
                SET card_uid = $1, step = 'CARD_TAPPED', status = 'RUNNING', updated_at = now()
              WHERE id = $2`,
            [nfcUid, pendingJob.id]
          );
          broadcast("enrollment_update", {
            job_id: pendingJob.id,
            person_id: pendingJob.person_id,
            card_uid: nfcUid,
            fingerprint_id: pendingJob.fingerprint_id,
            step: "CARD_TAPPED",
            status: "RUNNING"
          });
        }
      }

      // If there was an active fingerprint enrollment job on this terminal, but an NFC scan came through,
      // the hardware exited fingerprint enrollment and returned to standby door scanning!
      const pendingFpJob = await one(
        `SELECT id FROM fingerprint_enrollment_jobs
          WHERE status IN ('REQUESTED', 'RUNNING') AND step IN ('FINGER_1', 'FINGER_2')
            AND (target_device_id = $1 OR target_device_id IS NULL)
          ORDER BY id DESC LIMIT 1`,
        [device.id]
      );
      if (pendingFpJob) {
        await query(
          `UPDATE fingerprint_enrollment_jobs
              SET status = 'TIMEOUT', step = 'TIMEOUT',
                  error_message = 'Hardware exited fingerprint enrollment and returned to standby.',
                  updated_at = now()
            WHERE id = $1`,
          [pendingFpJob.id]
        );
        broadcast("enrollment_update", {
          job_id: pendingFpJob.id,
          status: "TIMEOUT",
          step: "TIMEOUT",
          error_message: "Hardware exited fingerprint enrollment and returned to standby."
        });
      }
    } catch (e) {
      console.warn("Enrollment auto-capture note:", e.message);
    }

    const cred = await findCredential(nfcUid);

    if (!cred || !cred.person_active || cred.is_revoked) {
      return res.json({
        success: true,
        authorized: false,
        message: !cred ? "Card not recognized" : (cred.is_revoked ? "Card revoked" : "Person inactive")
      });
    }

    if (cred.valid_until && new Date(cred.valid_until) < new Date()) {
      return res.json({
        success: true,
        authorized: false,
        message: "Card expired"
      });
    }

    const rule = await findRule(device.room_id, cred.person_id, cred.department);
    if (!rule) {
      return res.json({
        success: true,
        authorized: false,
        message: "No access rule for this door"
      });
    }

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

router.get("/access_control/log_access.php", async (req, res, next) => {
  try {
    const userId = Number(req.query.user_id) || null;
    const doorId = Number(req.query.door_id) || 1;
    const rawNfc = req.query.nfc_uid;
    const fpId = Number(req.query.fingerprint_id) || 0;
    const result = String(req.query.result || "").toUpperCase();
    const reason = String(req.query.reason || "OK");
    const rawAccessTime = req.query.access_time;
    const esp32Id = req.query.esp32_id;

    const nfcUid = cleanUid(rawNfc);
    const decision = (result === "GRANTED" || result === "ALLOWED") ? "ALLOWED" : "DENIED";

    const dev = await resolveDevice(esp32Id || `DOOR_${doorId}`);
    const deviceId = dev ? dev.id : 1;

    let credId = null;
    let personId = userId;
    if (nfcUid) {
      const cred = await one(
        `SELECT id, person_id FROM credentials
          WHERE UPPER(REPLACE(card_uid, ':', '')) = $1 OR UPPER(card_uid) = $2`,
        [nfcUid, String(rawNfc || "").toUpperCase()]
      );
      if (cred) {
        credId = cred.id;
        if (!personId) personId = cred.person_id;
      }
    }
    // Also resolve by fingerprint slot if personId is still not identified!
    if (!personId && fpId > 0) {
      const cred = await one(`SELECT id, person_id FROM credentials WHERE fingerprint_slot = $1`, [fpId]);
      if (cred) {
        credId = cred.id;
        personId = cred.person_id;
      }
    }

    const direction = personId ? await nextDirection(personId, doorId) : "IN";
    const now = new Date();
    const scannedAt = parseAccessTime(rawAccessTime);
    const eventIdStr = `ESP32-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random()*1000)}`;

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
        nfcUid || (fpId > 0 ? `FP-SLOT-${fpId}` : "--"),
        direction,
        decision,
        reason,
        fpId > 0,
        scannedAt,
        now,
        eventIdStr
      ]
    );

    let personName = "";
    let employeeCode = "";
    let department = "";
    if (personId) {
      const p = await one(`SELECT full_name, employee_code, department FROM people WHERE id = $1`, [personId]);
      if (p) {
        personName = p.full_name;
        employeeCode = p.employee_code;
        department = p.department;
      }
    }
    if (!personName) {
      personName = decision === "ALLOWED" ? (employeeCode ? `Employee ${employeeCode}` : "Authorized Personnel") : "Unregistered User";
    }
    const r = await one(`SELECT room_name FROM rooms WHERE id = $1`, [doorId]);
    const roomName = r ? r.room_name : (dev ? dev.room_name : "Door");

    broadcast("access_event", {
      event_id: event.id,
      id: event.id,
      device_key: dev ? dev.device_key : "ESP32_01",
      device_label: dev ? dev.device_label : "Main Entrance",
      person_id: personId,
      full_name: personName,
      person_name: personName,
      employee_code: employeeCode,
      department: department,
      card_uid: nfcUid || (fpId > 0 ? `FP-SLOT-${fpId}` : "--"),
      room_name: roomName,
      direction: direction,
      decision: decision,
      result: decision === "ALLOWED" ? "GRANTED" : "DENIED",
      reason_code: reason,
      reason: reason,
      scanned_at: scannedAt.toISOString(),
      access_time: scannedAt.toISOString(),
      fingerprint_used: fpId > 0
    });

    broadcast("occupancy_changed", { room_id: doorId });

    // If hardware logged a normal door access event, any active enrollment job on this terminal has timed out / reverted
    try {
      const activeEnrollJob = await one(
        `SELECT id FROM fingerprint_enrollment_jobs
          WHERE status IN ('REQUESTED', 'RUNNING')
            AND (target_device_id = $1 OR target_device_id IS NULL)
            AND updated_at < now() - interval '5 seconds'
          ORDER BY id DESC LIMIT 1`,
        [deviceId]
      );
      if (activeEnrollJob) {
        await query(
          `UPDATE fingerprint_enrollment_jobs
              SET status = 'TIMEOUT', step = 'TIMEOUT',
                  error_message = 'Hardware resumed normal door access control.',
                  updated_at = now()
            WHERE id = $1`,
          [activeEnrollJob.id]
        );
        await query(
          `UPDATE device_commands
              SET status = 'TIMEOUT'
            WHERE job_id = $1 AND status = 'PENDING'`,
          [activeEnrollJob.id]
        );
        broadcast("enrollment_update", {
          job_id: activeEnrollJob.id,
          status: "TIMEOUT",
          step: "TIMEOUT",
          error_message: "Hardware resumed normal door access control."
        });
      }
    } catch (e) {
      console.warn("Log access enrollment sync note:", e.message);
    }

    res.json({ success: true, event_id: event.id });
  } catch (err) {
    next(err);
  }
});

router.get("/access_control/sync.php", async (req, res, next) => {
  try {
    const esp32Id = req.query.esp32_id;
    const device = await resolveDevice(esp32Id);
    const roomId = device ? device.room_id : 1;

    const rows = await query(
      `SELECT p.id AS user_id, p.employee_code, p.full_name, c.card_uid, c.fingerprint_slot, p.is_active
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
      user_id: r.user_id,
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
