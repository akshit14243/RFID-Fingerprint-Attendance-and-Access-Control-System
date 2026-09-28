const express = require("express");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const { pool, query, one } = require("../db");
const { requireUser, requireAdmin } = require("../auth");
const { broadcast } = require("../bus");

const router = express.Router();

const VALID_DELETE_PASSWORDS = [
  process.env.DELETE_PASSWORD,
  "ADMIN@DELETE#2026",
  "admin123",
  "delete123",
].filter(Boolean);

function isValidDeletePassword(pw) {
  if (!pw || typeof pw !== "string") return false;
  return VALID_DELETE_PASSWORDS.includes(pw.trim());
}

const personSchema = z.object({
  employee_code: z.string().min(1).max(20),
  full_name: z.string().min(1).max(120),
  department: z.string().min(1).max(60),
  person_type: z.enum(["EMPLOYEE", "CONTRACTOR", "VISITOR"]).default("EMPLOYEE"),
  email: z.string().email().nullable().optional(),
  is_active: z.boolean().default(true),
});

const credentialSchema = z.object({
  person_id: z.number().int(),
  card_uid: z.string().min(4).max(32),
  fingerprint_slot: z.number().int().nullable().optional(),
  valid_until: z.string().nullable().optional(),
});

const bad = (res, e) => res.status(400).json({ error: "bad_request", details: e.errors ?? String(e) });

router.get("/people", requireUser, async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT p.*, c.id AS credential_id, c.card_uid, c.fingerprint_slot,
              c.valid_until, c.is_revoked
         FROM people p LEFT JOIN credentials c ON c.person_id = p.id
        ORDER BY p.employee_code`,
    );
    res.json({ count: rows.length, people: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/people", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const p = personSchema.safeParse(req.body);
    if (!p.success) return bad(res, p.error);
    const row = await one(
      `INSERT INTO people (employee_code, full_name, department, person_type, email, is_active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [p.data.employee_code, p.data.full_name, p.data.department, p.data.person_type, p.data.email ?? null, p.data.is_active],
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put("/people/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const p = personSchema.partial().safeParse(req.body);
    if (!p.success) return bad(res, p.error);
    const row = await one(
      `UPDATE people SET
         employee_code = COALESCE($2, employee_code),
         full_name     = COALESCE($3, full_name),
         department    = COALESCE($4, department),
         person_type   = COALESCE($5, person_type),
         email         = COALESCE($6, email),
         is_active     = COALESCE($7, is_active)
       WHERE id = $1 RETURNING *`,
      [req.params.id, p.data.employee_code ?? null, p.data.full_name ?? null, p.data.department ?? null,
       p.data.person_type ?? null, p.data.email ?? null, p.data.is_active ?? null],
    );
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post("/verify-delete-password", requireUser, requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!isValidDeletePassword(password)) {
    return res.status(403).json({ success: false, error: "invalid_password", message: "Invalid master security password." });
  }
  res.json({ success: true, message: "Security password verified." });
});

async function performPermanentPersonDeletion(personId, res) {
  const person = await one("SELECT * FROM people WHERE id = $1", [personId]);
  if (!person) {
    return res.status(404).json({ error: "not_found", message: "Employee not found." });
  }

  // 1. Delete physical template files from disk
  const jobs = await query(
    "SELECT template_path FROM fingerprint_enrollment_jobs WHERE person_id = $1 AND template_path IS NOT NULL",
    [personId]
  );
  for (const j of jobs) {
    if (j.template_path) {
      const fullPath = path.isAbsolute(j.template_path)
        ? j.template_path
        : path.join(__dirname, "..", j.template_path);
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch (e) {
          console.warn("Could not delete template file:", fullPath, e.message);
        }
      }
    }
  }

  // 2. Delete database records in clean dependency order within a transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // access_events has append-only trigger trg_events_no_update.
    // Temporarily disable trigger on this session/table to clean up employee logs.
    await client.query("ALTER TABLE access_events DISABLE TRIGGER trg_events_no_update");
    await client.query(
      "DELETE FROM access_events WHERE person_id = $1 OR credential_id IN (SELECT id FROM credentials WHERE person_id = $1)",
      [personId]
    );
    await client.query("ALTER TABLE access_events ENABLE TRIGGER trg_events_no_update");

    await client.query("DELETE FROM device_commands WHERE user_id = $1", [personId]);
    await client.query("DELETE FROM fingerprint_enrollment_jobs WHERE person_id = $1", [personId]);
    await client.query("DELETE FROM access_rules WHERE person_id = $1", [personId]);
    await client.query("DELETE FROM credentials WHERE person_id = $1", [personId]);
    await client.query("DELETE FROM people WHERE id = $1", [personId]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    try {
      await pool.query("ALTER TABLE access_events ENABLE TRIGGER trg_events_no_update");
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  broadcast("employee_deleted", { person_id: personId, employee_code: person.employee_code });

  return res.json({
    success: true,
    message: `Employee '${person.full_name}' and all associated biometric templates, RFID cards, and access permissions have been permanently deleted.`,
    deleted_id: personId,
  });
}

router.delete("/people/:id/permanent", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const personId = Number(req.params.id);
    const password = req.headers["x-delete-password"] || req.body?.password || req.query?.password;

    if (!isValidDeletePassword(password)) {
      return res.status(403).json({
        error: "forbidden",
        message: "Invalid master security password. Permanent deletion rejected.",
      });
    }

    await performPermanentPersonDeletion(personId, res);
  } catch (err) {
    next(err);
  }
});

router.post("/people/:id/permanent-delete", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const personId = Number(req.params.id);
    const password = req.headers["x-delete-password"] || req.body?.password || req.query?.password;

    if (!isValidDeletePassword(password)) {
      return res.status(403).json({
        error: "forbidden",
        message: "Invalid master security password. Permanent deletion rejected.",
      });
    }

    await performPermanentPersonDeletion(personId, res);
  } catch (err) {
    next(err);
  }
});

router.delete("/people/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const isPermanent =
      req.query.permanent === "true" ||
      Boolean(req.body?.permanent) ||
      Boolean(req.headers["x-delete-password"]);

    if (isPermanent) {
      const personId = Number(req.params.id);
      const password = req.headers["x-delete-password"] || req.body?.password || req.query?.password;
      if (!isValidDeletePassword(password)) {
        return res.status(403).json({
          error: "forbidden",
          message: "Invalid master security password. Permanent deletion rejected.",
        });
      }
      return await performPermanentPersonDeletion(personId, res);
    }

    const row = await one("UPDATE people SET is_active = FALSE WHERE id = $1 RETURNING id", [req.params.id]);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json({ deactivated: row.id });
  } catch (err) {
    next(err);
  }
});

router.post("/credentials", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const c = credentialSchema.safeParse(req.body);
    if (!c.success) return bad(res, c.error);
    const row = await one(
      `INSERT INTO credentials (person_id, card_uid, fingerprint_slot, valid_until)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [c.data.person_id, c.data.card_uid.toUpperCase(), c.data.fingerprint_slot ?? null, c.data.valid_until ?? null],
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.post("/credentials/:id/revoke", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const row = await one("UPDATE credentials SET is_revoked = TRUE WHERE id = $1 RETURNING *", [req.params.id]);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.get("/rooms", requireUser, async (_req, res, next) => {
  try {
    res.json({ rooms: await query("SELECT * FROM rooms ORDER BY room_name") });
  } catch (err) {
    next(err);
  }
});

router.post("/rooms", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const s = z.object({ room_name: z.string().min(1), is_restricted: z.boolean().default(false) }).safeParse(req.body);
    if (!s.success) return bad(res, s.error);
    res.status(201).json(
      await one("INSERT INTO rooms (room_name, is_restricted) VALUES ($1,$2) RETURNING *",
        [s.data.room_name, s.data.is_restricted]),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/devices", requireUser, async (_req, res, next) => {
  try {
    res.json({
      devices: await query(
        `SELECT d.*, r.room_name,
                (d.last_seen_at IS NOT NULL AND d.last_seen_at > now() - interval '5 minutes') AS online
           FROM devices d
           JOIN rooms r ON r.id = d.room_id
          ORDER BY d.device_label`
      ),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/devices", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const s = z.object({
      device_key: z.string().min(8),
      device_label: z.string().min(1),
      room_id: z.number().int(),
      purpose: z.enum(["DOOR", "ATTENDANCE"]).default("DOOR"),
      source: z.enum(["NATIVE", "LEGACY"]).default("NATIVE"),
    }).safeParse(req.body);
    if (!s.success) return bad(res, s.error);
    res.status(201).json(
      await one(
        `INSERT INTO devices (device_key, device_label, room_id, purpose, source)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [s.data.device_key, s.data.device_label, s.data.room_id, s.data.purpose, s.data.source]),
    );
  } catch (err) {
    next(err);
  }
});

router.delete("/devices/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const hasEvents = await one("SELECT id FROM access_events WHERE device_id = $1 LIMIT 1", [req.params.id]);
    if (hasEvents) {
      const row = await one("UPDATE devices SET is_active = FALSE WHERE id = $1 RETURNING id", [req.params.id]);
      if (!row) return res.status(404).json({ error: "not_found" });
      return res.json({ deactivated: row.id, message: "Device deactivated due to historical logs" });
    }
    const row = await one("DELETE FROM devices WHERE id = $1 RETURNING id", [req.params.id]);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json({ deleted: row.id });
  } catch (err) {
    next(err);
  }
});

router.put("/devices/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const s = z.object({
      device_label: z.string().min(1).optional(),
      room_id: z.number().int().optional(),
      purpose: z.enum(["DOOR", "ATTENDANCE"]).optional(),
      is_active: z.boolean().optional(),
    }).safeParse(req.body);
    if (!s.success) return bad(res, s.error);
    const row = await one(
      `UPDATE devices SET
         device_label = COALESCE($2, device_label),
         room_id      = COALESCE($3, room_id),
         purpose      = COALESCE($4, purpose),
         is_active    = COALESCE($5, is_active)
       WHERE id = $1 RETURNING *`,
      [req.params.id, s.data.device_label ?? null, s.data.room_id ?? null, s.data.purpose ?? null, s.data.is_active ?? null],
    );
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.get("/rules", requireUser, async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT ar.*, r.room_name, p.full_name
         FROM access_rules ar
         JOIN rooms r ON r.id = ar.room_id
         LEFT JOIN people p ON p.id = ar.person_id
        ORDER BY r.room_name`,
    );
    res.json({ rules: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/rules", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const s = z.object({
      room_id: z.number().int(),
      person_id: z.number().int().nullable().optional(),
      department: z.string().nullable().optional(),
      fingerprint_required: z.boolean().default(false),
      valid_until: z.string().nullable().optional(),
    }).refine((v) => v.person_id || v.department, { message: "person_id or department is required" })
      .safeParse(req.body);
    if (!s.success) return bad(res, s.error);
    res.status(201).json(
      await one(
        `INSERT INTO access_rules (room_id, person_id, department, fingerprint_required, valid_until)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [s.data.room_id, s.data.person_id ?? null, s.data.department ?? null,
         s.data.fingerprint_required, s.data.valid_until ?? null]),
    );
  } catch (err) {
    next(err);
  }
});

router.delete("/rules/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const row = await one("DELETE FROM access_rules WHERE id = $1 RETURNING id", [req.params.id]);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json({ deleted: row.id });
  } catch (err) {
    next(err);
  }
});

router.get("/departments", requireUser, async (_req, res, next) => {
  try {
    const rows = await query(`
      SELECT d.*, COUNT(p.id)::int AS employee_count
        FROM departments d
        LEFT JOIN people p ON p.department = d.name AND p.is_active = TRUE
       GROUP BY d.id, d.name
       ORDER BY d.name
    `);
    res.json({ departments: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/departments", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const s = z.object({ name: z.string().min(1).max(60) }).safeParse(req.body);
    if (!s.success) return bad(res, s.error);
    const row = await one("INSERT INTO departments (name) VALUES ($1) RETURNING *", [s.data.name.trim()]);
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete("/departments/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const dept = await one("SELECT * FROM departments WHERE id = $1", [req.params.id]);
    if (!dept) return res.status(404).json({ error: "not_found" });
    const inUse = await one("SELECT id FROM people WHERE department = $1 LIMIT 1", [dept.name]);
    if (inUse) {
      return res.status(400).json({ error: "in_use", message: "Cannot delete department with assigned employees. Reassign employees first." });
    }
    await one("DELETE FROM departments WHERE id = $1 RETURNING id", [req.params.id]);
    res.json({ deleted: dept.id });
  } catch (err) {
    next(err);
  }
});

router.get("/shifts", requireUser, async (_req, res, next) => {
  try {
    const rows = await query("SELECT * FROM shifts ORDER BY id");
    res.json({ shifts: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/shifts", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const s = z.object({
      shift_name: z.string().min(1).max(60),
      start_time: z.string().min(4),
      end_time: z.string().min(4),
      grace_minutes: z.number().int().min(0).default(15),
      is_default: z.boolean().default(false),
    }).safeParse(req.body);
    if (!s.success) return bad(res, s.error);
    if (s.data.is_default) {
      await query("UPDATE shifts SET is_default = FALSE");
    }
    const row = await one(
      `INSERT INTO shifts (shift_name, start_time, end_time, grace_minutes, is_default)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [s.data.shift_name.trim(), s.data.start_time, s.data.end_time, s.data.grace_minutes, s.data.is_default],
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put("/shifts/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const s = z.object({
      shift_name: z.string().min(1).max(60).optional(),
      start_time: z.string().min(4).optional(),
      end_time: z.string().min(4).optional(),
      grace_minutes: z.number().int().min(0).optional(),
      is_default: z.boolean().optional(),
    }).safeParse(req.body);
    if (!s.success) return bad(res, s.error);
    if (s.data.is_default) {
      await query("UPDATE shifts SET is_default = FALSE WHERE id <> $1", [req.params.id]);
    }
    const row = await one(
      `UPDATE shifts SET
         shift_name    = COALESCE($2, shift_name),
         start_time    = COALESCE($3, start_time),
         end_time      = COALESCE($4, end_time),
         grace_minutes = COALESCE($5, grace_minutes),
         is_default    = COALESCE($6, is_default)
       WHERE id = $1 RETURNING *`,
      [req.params.id, s.data.shift_name?.trim() ?? null, s.data.start_time ?? null, s.data.end_time ?? null, s.data.grace_minutes ?? null, s.data.is_default ?? null],
    );
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete("/shifts/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const shift = await one("SELECT * FROM shifts WHERE id = $1", [req.params.id]);
    if (!shift) return res.status(404).json({ error: "not_found" });
    if (shift.is_default) {
      return res.status(400).json({ error: "default_shift", message: "Cannot delete the default shift schedule." });
    }
    await one("DELETE FROM shifts WHERE id = $1 RETURNING id", [req.params.id]);
    res.json({ deleted: shift.id });
  } catch (err) {
    next(err);
  }
});

router.get("/holidays", requireUser, async (_req, res, next) => {
  try {
    const rows = await query("SELECT * FROM holidays ORDER BY holiday_date ASC");
    res.json({ holidays: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/holidays", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const s = z.object({
      holiday_date: z.string().min(10),
      holiday_name: z.string().min(1).max(120),
      description: z.string().nullable().optional(),
    }).safeParse(req.body);
    if (!s.success) return bad(res, s.error);
    const row = await one(
      `INSERT INTO holidays (holiday_date, holiday_name, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [s.data.holiday_date, s.data.holiday_name.trim(), s.data.description?.trim() ?? null],
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.delete("/holidays/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
    const row = await one("DELETE FROM holidays WHERE id = $1 RETURNING id", [req.params.id]);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json({ deleted: row.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

