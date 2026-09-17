const express = require("express");
const { z } = require("zod");
const { query, one } = require("../db");
const { requireUser, requireAdmin } = require("../auth");

const router = express.Router();

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

router.delete("/people/:id", requireUser, requireAdmin, async (req, res, next) => {
  try {
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
        "SELECT d.*, r.room_name FROM devices d JOIN rooms r ON r.id = d.room_id ORDER BY d.device_label"),
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

router.get("/rules", requireUser, async (_req, res, next) => {
  try {
    res.json({
      rules: await query(
        `SELECT ar.*, r.room_name, p.full_name
           FROM access_rules ar
           JOIN rooms r ON r.id = ar.room_id
           LEFT JOIN people p ON p.id = ar.person_id
          ORDER BY r.room_name`),
    });
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

module.exports = router;
