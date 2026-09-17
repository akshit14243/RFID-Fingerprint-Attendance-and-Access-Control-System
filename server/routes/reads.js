// Everything the dashboard reads. All of these need a login (any role).

const express = require("express");
const { query } = require("../db");
const { requireUser } = require("../auth");

const router = express.Router();

// Every route here needs a login. Added per route (not with router.use) so
// that unrelated /api paths mounted alongside are not affected.

// Who is inside right now, per room. This is the fire-drill muster list.
router.get("/occupancy", requireUser, async (_req, res, next) => {
  try {
    const rows = await query("SELECT * FROM v_occupancy ORDER BY room_name, full_name");
    res.json({ count: rows.length, people: rows });
  } catch (err) {
    next(err);
  }
});

// Event history with filters. Every row carries full date and time.
router.get("/events", requireUser, async (req, res, next) => {
  try {
    const { from, to, room_id, person_id, decision, direction } = req.query;
    const limit = Math.min(Number(req.query.limit || 100), 1000);

    const where = [];
    const params = [];
    const add = (sql, value) => {
      if (value === undefined || value === "") return;
      params.push(value);
      where.push(sql.replace("$?", `$${params.length}`));
    };

    add("e.scanned_at >= $?", from);
    add("e.scanned_at <= $?", to);
    add("e.room_id = $?", room_id ? Number(room_id) : undefined);
    add("e.person_id = $?", person_id ? Number(person_id) : undefined);
    add("e.decision = $?", decision);
    add("e.direction = $?", direction);

    params.push(limit);
    const rows = await query(
      `SELECT e.id, e.scanned_at, e.received_at, e.direction, e.decision, e.reason_code,
              e.card_uid, e.fingerprint_used, e.source,
              p.full_name, p.employee_code, p.department,
              r.room_name, d.device_label,
              (e.received_at - e.scanned_at) > interval '1 minute' AS arrived_late
         FROM access_events e
         LEFT JOIN people p ON p.id = e.person_id
         JOIN rooms   r ON r.id = e.room_id
         JOIN devices d ON d.id = e.device_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY e.scanned_at DESC, e.id DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ count: rows.length, events: rows });
  } catch (err) {
    next(err);
  }
});

// First in / last out / hours, per person, for one day (default today).
router.get("/attendance", requireUser, async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const rows = await query(
      "SELECT * FROM v_attendance_days WHERE work_date = $1 ORDER BY full_name",
      [date],
    );
    res.json({ date, count: rows.length, attendance: rows });
  } catch (err) {
    next(err);
  }
});

// Device health - which board last spoke to us and when.
router.get("/devices/status", requireUser, async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT d.id, d.device_label, d.device_key, d.purpose, d.source, d.firmware_ver,
              d.last_seen_at, r.room_name,
              (d.last_seen_at IS NOT NULL AND d.last_seen_at > now() - interval '3 minutes') AS online
         FROM devices d JOIN rooms r ON r.id = d.room_id
        ORDER BY r.room_name`,
    );
    res.json({ count: rows.length, devices: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
