const express = require("express");
const { query, one } = require("../db");
const { requireUser } = require("../auth");

const router = express.Router();

router.get("/occupancy", requireUser, async (_req, res, next) => {
  try {
    const rows = await query("SELECT * FROM v_occupancy ORDER BY room_name, full_name");
    res.json({ count: rows.length, people: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/events", requireUser, async (req, res, next) => {
  try {
    const { from, to, room_id, person_id, decision, direction } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 30, 200));
    const offset = (page - 1) * limit;

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

    const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

    const stats = await one(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE e.decision = 'ALLOWED')::int AS granted,
              COUNT(*) FILTER (WHERE e.decision != 'ALLOWED')::int AS denied
         FROM access_events e
        ${whereClause}`,
      params
    );

    const total = stats ? stats.total : 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const queryParams = [...params, limit, offset];
    const rows = await query(
      `SELECT e.id, e.scanned_at, e.received_at, e.direction, e.decision, e.reason_code,
              e.card_uid, e.fingerprint_used, e.source,
              COALESCE(p.full_name, cp.full_name) AS full_name,
              COALESCE(p.employee_code, cp.employee_code) AS employee_code,
              COALESCE(p.department, cp.department) AS department,
              r.room_name, d.device_label,
              (e.received_at - e.scanned_at) > interval '1 minute' AS arrived_late
         FROM access_events e
         LEFT JOIN people p ON p.id = e.person_id
         LEFT JOIN credentials c ON (c.id = e.credential_id OR (e.card_uid IS NOT NULL AND UPPER(REPLACE(c.card_uid, ':', '')) = UPPER(REPLACE(e.card_uid, ':', ''))))
         LEFT JOIN people cp ON cp.id = c.person_id
         JOIN rooms   r ON r.id = e.room_id
         JOIN devices d ON d.id = e.device_id
        ${whereClause}
        ORDER BY e.scanned_at DESC, e.id DESC
        LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
      queryParams,
    );
    res.json({
      count: rows.length,
      total,
      page,
      limit,
      total_pages: totalPages,
      granted_count: stats ? stats.granted : 0,
      denied_count: stats ? stats.denied : 0,
      events: rows,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/attendance", requireUser, async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const rows = await query(
      `SELECT p.id AS person_id, p.full_name, p.employee_code, p.department,
              $1::date AS work_date,
              v.first_in, v.last_out, v.hours
         FROM people p
         LEFT JOIN v_attendance_days v ON v.person_id = p.id AND v.work_date = $1::date
        WHERE p.is_active = TRUE
        ORDER BY p.full_name`,
      [date],
    );
    res.json({ date, count: rows.length, attendance: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/devices/status", requireUser, async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT d.id, d.device_label, d.device_key, d.purpose, d.source, d.firmware_ver,
              d.last_seen_at, r.room_name,
              (d.last_seen_at IS NOT NULL AND d.last_seen_at > now() - interval '5 minutes') AS online
         FROM devices d JOIN rooms r ON r.id = d.room_id
        ORDER BY r.room_name`,
    );
    res.json({ count: rows.length, devices: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
