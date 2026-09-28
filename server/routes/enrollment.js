const express = require("express");
const fs = require("fs");
const path = require("path");
const { query, one } = require("../db");
const { broadcast } = require("../bus");

const router = express.Router();

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
if (!fs.existsSync(TEMPLATES_DIR)) {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
}

function cleanUid(raw) {
  return String(raw || "").toUpperCase().replace(/[^0-9A-F]/g, "");
}

// Helper: allocate next free fingerprint slot (1..1000)
async function getNextFingerprintSlot() {
  const used = await query(`
    SELECT DISTINCT slot FROM (
      SELECT fingerprint_slot AS slot FROM credentials WHERE fingerprint_slot IS NOT NULL AND fingerprint_slot > 0
      UNION
      SELECT fingerprint_id AS slot FROM fingerprint_enrollment_jobs WHERE status IN ('REQUESTED', 'RUNNING') AND fingerprint_id > 0
    ) s ORDER BY slot ASC
  `);
  const usedSet = new Set(used.map((r) => r.slot));
  for (let i = 1; i <= 1000; i++) {
    if (!usedSet.has(i)) return i;
  }
  return 1;
}

// ----------------------------------------------------
// 1. API: Start Enrollment Wizard Job (supports all endpoint aliases)
// ----------------------------------------------------
const handleStartEnrollment = async (req, res, next) => {
  try {
    const { code, name, dept, type, email, device_id, person_id, employee_code, full_name, department, target_device_id } = req.body || {};

    const empCode = (code || employee_code || "").trim();
    const empName = (name || full_name || "").trim();
    const empDept = (dept || department || "Engineering").trim();
    const targetDevId = Number(device_id || target_device_id) || null;

    let person = null;
    if (person_id) {
      person = await one("SELECT * FROM people WHERE id = $1", [person_id]);
    } else {
      if (!empCode || !empName) {
        return res.status(400).json({ error: "bad_request", message: "Employee code and name are required" });
      }
      person = await one(
        `INSERT INTO people (employee_code, full_name, department, person_type, email, is_active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (employee_code) DO UPDATE
           SET full_name = EXCLUDED.full_name,
               department = EXCLUDED.department,
               person_type = EXCLUDED.person_type,
               email = COALESCE(EXCLUDED.email, people.email)
         RETURNING *`,
        [empCode, empName, empDept, type || "EMPLOYEE", email ? email.trim() : null]
      );
    }

    if (!person) {
      return res.status(500).json({ error: "server_error", message: "Failed to create or find employee" });
    }

    // Resolve target device
    let targetDeviceId = targetDevId;
    if (!targetDeviceId) {
      const defDev = await one(
        "SELECT id FROM devices WHERE is_active = TRUE ORDER BY (device_key ILIKE '%ESP32%' OR device_label ILIKE '%HR%') DESC, (last_seen_at IS NOT NULL) DESC, last_seen_at DESC, id ASC LIMIT 1"
      );
      if (defDev) targetDeviceId = defDev.id;
    }

    const dev = targetDeviceId
      ? await one(
          `SELECT *, (last_seen_at IS NOT NULL AND last_seen_at > now() - interval '5 minutes') AS is_online
             FROM devices WHERE id = $1`,
          [targetDeviceId]
        )
      : null;

    if (!dev) {
      return res.status(400).json({ error: "unknown_device", message: "Target HR device not found" });
    }

    if (!dev.is_online) {
      return res.status(400).json({
        error: "device_offline",
        message: `Device '${dev.device_label || dev.device_key}' is offline. Please power on the HR reader and ensure Wi-Fi connection.`,
      });
    }

    const esp32Key = dev.device_key || "ESP32_01";

    // Allocate next fingerprint slot
    const nextSlot = await getNextFingerprintSlot();

    // Cancel existing pending jobs and commands for this person/device
    await query(
      `UPDATE fingerprint_enrollment_jobs
          SET status = 'CANCELLED', updated_at = now()
        WHERE status IN ('REQUESTED', 'RUNNING')
          AND (person_id = $1 OR target_device_id = $2)`,
      [person.id, targetDeviceId]
    );
    await query(
      `UPDATE device_commands
          SET status = 'CANCELLED'
        WHERE status = 'PENDING'
          AND (user_id = $1 OR esp32_id = $2)`,
      [person.id, esp32Key]
    );

    // Create job
    const job = await one(
      `INSERT INTO fingerprint_enrollment_jobs
         (person_id, target_device_id, fingerprint_id, step, status)
       VALUES
         ($1, $2, $3, 'WAITING_CARD', 'REQUESTED')
       RETURNING *`,
      [person.id, targetDeviceId, nextSlot]
    );

    // Create device command
    await query(
      `INSERT INTO device_commands
         (job_id, esp32_id, command, user_id, fingerprint_id, status)
       VALUES
         ($1, $2, 'ENTER_ENROLLMENT', $3, $4, 'PENDING')`,
      [job.id, esp32Key, person.id, nextSlot]
    );

    const payload = {
      job_id: job.id,
      person_id: person.id,
      employee_code: person.employee_code,
      full_name: person.full_name,
      department: person.department,
      fingerprint_id: nextSlot,
      device_id: targetDeviceId,
      device_key: esp32Key,
      step: "WAITING_CARD",
      status: "REQUESTED",
    };

    broadcast("enrollment_update", payload);

    res.json({
      success: true,
      ...payload,
    });
  } catch (err) {
    next(err);
  }
};

router.post("/api/enrollment/start", handleStartEnrollment);
router.post("/api/fingerprint/enrollment/create", handleStartEnrollment);
router.post("/api/fingerprint-enrollment", handleStartEnrollment);
router.post("/api/fingerprint/enrollment", handleStartEnrollment);

// ----------------------------------------------------
// 2. API: Get Enrollment Job Status
// ----------------------------------------------------
const handleEnrollmentStatus = async (req, res, next) => {
  try {
    const jobId = Number(req.params.id || req.params.jobId);
    if (!jobId) return res.status(400).json({ error: "bad_request" });

    let job = await one(
      `SELECT j.*,
              p.employee_code, p.full_name, p.department, p.person_type, p.email,
              d.device_key, d.device_label
         FROM fingerprint_enrollment_jobs j
         JOIN people p ON p.id = j.person_id
         LEFT JOIN devices d ON d.id = j.target_device_id
        WHERE j.id = $1`,
      [jobId]
    );

    if (!job) {
      return res.status(404).json({ error: "not_found", message: "Job not found" });
    }

    // Auto-expire stale jobs: if active job has had no update for > 35 seconds
    if (["REQUESTED", "RUNNING"].includes(job.status)) {
      const updatedAt = new Date(job.updated_at).getTime();
      const now = Date.now();
      if (now - updatedAt > 35000) {
        await query(
          `UPDATE fingerprint_enrollment_jobs
              SET status = 'TIMEOUT', step = 'TIMEOUT',
                  error_message = 'Hardware enrollment timed out. Terminal returned to standby state.',
                  updated_at = now()
            WHERE id = $1`,
          [jobId]
        );
        await query(
          `UPDATE device_commands
              SET status = 'TIMEOUT'
            WHERE job_id = $1 AND status = 'PENDING'`,
          [jobId]
        );
        job.status = "TIMEOUT";
        job.step = "TIMEOUT";
        job.error_message = "Hardware enrollment timed out. Terminal returned to standby state.";
        broadcast("enrollment_update", {
          job_id: job.id,
          status: "TIMEOUT",
          step: "TIMEOUT",
          error_message: job.error_message,
        });
      }
    }

    res.json({ success: true, job, ...job });
  } catch (err) {
    next(err);
  }
};

router.get("/api/enrollment/status/:id", handleEnrollmentStatus);
router.get("/api/fingerprint/enrollment/:id", handleEnrollmentStatus);
router.get("/api/fingerprint-enrollment/:id", handleEnrollmentStatus);

// ----------------------------------------------------
// 3. API: Advance Step / Complete Job
// ----------------------------------------------------
async function advanceEnrollmentStep(jobId, step, cardUid = null, errorMsg = null) {
  const job = await one(
    `SELECT j.*, p.employee_code, p.full_name, p.department, d.device_key
       FROM fingerprint_enrollment_jobs j
       JOIN people p ON p.id = j.person_id
       LEFT JOIN devices d ON d.id = j.target_device_id
      WHERE j.id = $1`,
    [jobId]
  );
  if (!job) return null;

  const validCard = cardUid ? cleanUid(cardUid) : job.card_uid;
  let status = job.status;

  if (step === "FAILED" || step === "TIMEOUT") {
    status = step === "TIMEOUT" ? "TIMEOUT" : "FAILED";
  } else if (step === "COMPLETED") {
    status = "COMPLETED";
  } else {
    status = "RUNNING";
  }

  if (["FAILED", "TIMEOUT", "CANCELLED"].includes(status)) {
    await query("UPDATE device_commands SET status = $1 WHERE job_id = $2 AND status = 'PENDING'", [status, jobId]);
  }

  // If completed, commit to database credentials & access rules
  if (step === "COMPLETED" || step === "SYNCING") {
    if (validCard) {
      const existingCred = await one("SELECT id FROM credentials WHERE person_id = $1", [job.person_id]);
      if (existingCred) {
        await query(
          `UPDATE credentials
              SET card_uid = $1, fingerprint_slot = $2, is_revoked = FALSE, valid_until = NULL
            WHERE id = $3`,
          [validCard, job.fingerprint_id, existingCred.id]
        );
      } else {
        await query(
          `INSERT INTO credentials (person_id, card_uid, fingerprint_slot, is_revoked, valid_from)
           VALUES ($1, $2, $3, FALSE, now())
           ON CONFLICT (card_uid) DO UPDATE
             SET person_id = EXCLUDED.person_id,
                 fingerprint_slot = EXCLUDED.fingerprint_slot,
                 is_revoked = FALSE`,
          [job.person_id, validCard, job.fingerprint_id]
        );
      }

      // Ensure at least one access rule exists
      const rule = await one(
        `SELECT id FROM access_rules WHERE person_id = $1 OR (person_id IS NULL AND department = $2)`,
        [job.person_id, job.department]
      );
      if (!rule) {
        await query(
          `INSERT INTO access_rules (room_id, person_id, department, fingerprint_required)
           VALUES (1, $1, $2, FALSE)`,
          [job.person_id, job.department]
        );
      }
    }
  }

  const updated = await one(
    `UPDATE fingerprint_enrollment_jobs
        SET step = $1,
            status = $2,
            card_uid = COALESCE($3, card_uid),
            error_message = $4,
            updated_at = now()
      WHERE id = $5
      RETURNING *`,
    [step, status, validCard, errorMsg, jobId]
  );

  const payload = {
    job_id: updated.id,
    person_id: job.person_id,
    employee_code: job.employee_code,
    full_name: job.full_name,
    department: job.department,
    card_uid: updated.card_uid,
    fingerprint_id: updated.fingerprint_id,
    step: updated.step,
    status: updated.status,
    error_message: updated.error_message,
  };

  broadcast("enrollment_update", payload);
  return payload;
}

router.post("/api/enrollment/step", async (req, res, next) => {
  try {
    const { job_id, step, card_uid, error_message } = req.body || {};
    if (!job_id || !step) {
      return res.status(400).json({ error: "bad_request", message: "job_id and step are required" });
    }
    const result = await advanceEnrollmentStep(Number(job_id), step, card_uid, error_message);
    if (!result) return res.status(404).json({ error: "not_found", message: "Job not found" });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});


// ----------------------------------------------------
// 5. API: Cancel enrollment
// ----------------------------------------------------
router.post("/api/enrollment/cancel", async (req, res, next) => {
  try {
    const { job_id } = req.body || {};
    const jid = Number(job_id);
    if (!jid) return res.status(400).json({ error: "bad_request" });

    await query("UPDATE fingerprint_enrollment_jobs SET status = 'CANCELLED', updated_at = now() WHERE id = $1", [jid]);
    await query("UPDATE device_commands SET status = 'CANCELLED' WHERE job_id = $1", [jid]);
    broadcast("enrollment_update", { job_id: jid, status: "CANCELLED" });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// 6. Hardware Compatibility: Poll Pending Enrollment
// (Handles /access_control/test_enrollment.php and /api/fingerprint-enrollment)
// ----------------------------------------------------
async function handleEnrollmentPoll(req, res, next) {
  try {
    const esp32Id = String(req.query.esp32_id || req.query.device_key || "").trim();

    // Auto-expire stale pending jobs (> 35s) so hardware never picks up dead sessions
    await query(
      `UPDATE fingerprint_enrollment_jobs
          SET status = 'TIMEOUT', step = 'TIMEOUT',
              error_message = 'Hardware enrollment timed out.',
              updated_at = now()
        WHERE status IN ('REQUESTED', 'RUNNING')
          AND updated_at < now() - interval '35 seconds'`
    );

    let targetDev = null;
    if (esp32Id) {
      targetDev = await one(
        "SELECT * FROM devices WHERE device_key = $1 OR device_label ILIKE '%' || $1 || '%'",
        [esp32Id]
      );
    }

    const whereDev = targetDev
      ? `AND (j.target_device_id = ${targetDev.id} OR j.target_device_id IS NULL OR j.target_device_id = 1)`
      : "";

    const job = await one(
      `SELECT j.*,
              p.employee_code, p.full_name,
              d.device_key, d.device_label
         FROM fingerprint_enrollment_jobs j
         JOIN people p ON p.id = j.person_id
         LEFT JOIN devices d ON d.id = j.target_device_id
        WHERE j.status IN ('REQUESTED', 'RUNNING')
          ${whereDev}
        ORDER BY j.id ASC
        LIMIT 1`
    );

    if (!job) {
      return res.json({
        success: true,
        enrollment_available: false,
        message: "No enrollment job available",
      });
    }

    res.json({
      success: true,
      enrollment_available: true,
      job_id: job.id,
      source_esp32: esp32Id || job.device_key || "ESP32_01",
      target_esp32: esp32Id || job.device_key || "ESP32_01",
      user_id: job.person_id,
      employee_id: job.employee_code,
      full_name: job.full_name,
      fingerprint_id: job.fingerprint_id,
      card_uid: job.card_uid,
      step: job.step,
      status: job.status,
    });
  } catch (err) {
    next(err);
  }
}

router.get("/access_control/test_enrollment.php", handleEnrollmentPoll);
router.get("/access_control/access_control_test/test_enrollment.php", handleEnrollmentPoll);
router.get("/api/fingerprint-enrollment", handleEnrollmentPoll);

// ----------------------------------------------------
// 7. Hardware Compatibility: Report Enrollment Result / Progress
// (POST /access_control/test_enrollment.php)
// ----------------------------------------------------
async function handleEnrollmentReport(req, res, next) {
  try {
    const data = req.body || {};
    const jobId = Number(data.job_id || req.query.job_id || 0);
    const esp32Id = data.esp32_id || req.query.esp32_id || "";
    const cardUid = data.card_uid || req.query.card_uid || null;
    const fpId = Number(data.fingerprint_id || req.query.fingerprint_id || 0);
    const step = data.step || (data.success ? "COMPLETED" : "FAILED");
    const isSuccess = data.success === undefined ? true : Boolean(data.success);
    const isTimeout =
      String(data.status || data.step || data.message || "").toUpperCase().includes("TIMEOUT") ||
      String(req.query.status || req.query.step || req.query.message || "").toUpperCase().includes("TIMEOUT");

    if (!jobId) {
      return res.status(400).json({ success: false, message: "Missing required job_id" });
    }

    if (!isSuccess || isTimeout) {
      const finalStep = isTimeout ? "TIMEOUT" : "FAILED";
      const errMsg = data.message || (isTimeout ? "Hardware enrollment timed out. Terminal returned to standby state." : "Hardware enrollment reported failure");
      await advanceEnrollmentStep(jobId, finalStep, null, errMsg);
      return res.json({ success: true, message: `Enrollment marked as ${finalStep}`, job_id: jobId, status: finalStep });
    }

    const result = await advanceEnrollmentStep(jobId, step, cardUid);
    res.json({
      success: true,
      message: "Enrollment updated successfully",
      job_id: jobId,
      user_id: result.person_id,
      esp32_id: esp32Id,
      card_uid: result.card_uid,
      fingerprint_id: result.fingerprint_id,
      step: result.step,
      status: result.status,
    });
  } catch (err) {
    next(err);
  }
}

router.post("/access_control/test_enrollment.php", handleEnrollmentReport);
router.post("/access_control/access_control_test/test_enrollment.php", handleEnrollmentReport);
router.post("/api/enrollment/complete", handleEnrollmentReport);
router.post("/api/enrollment/fail", handleEnrollmentReport);
router.post("/api/enrollment/timeout", handleEnrollmentReport);
router.post("/api/fingerprint/enrollment/:id/complete", handleEnrollmentReport);
router.post("/api/fingerprint/enrollment/complete", handleEnrollmentReport);
router.post("/api/fingerprint-enrollment/complete", handleEnrollmentReport);

// ----------------------------------------------------
// 8. Hardware Compatibility: Template Upload & Download
// ----------------------------------------------------
router.post(
  "/access_control/upload_template.php",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req, res, next) => {
    try {
      const jobId = Number(req.query.job_id || 0);
      if (!jobId) return res.status(400).json({ success: false, message: "Invalid job_id" });

      const raw = req.body;
      if (!raw || raw.length === 0) {
        return res.status(400).json({ success: false, message: "Empty template payload" });
      }

      const filePath = path.join(TEMPLATES_DIR, `job_${jobId}.bin`);
      fs.writeFileSync(filePath, raw);

      const relPath = `templates/job_${jobId}.bin`;
      await query(
        "UPDATE fingerprint_enrollment_jobs SET template_path = $1, step = 'FINGER_2', updated_at = now() WHERE id = $2",
        [relPath, jobId]
      );

      broadcast("enrollment_update", { job_id: jobId, step: "FINGER_2", template_uploaded: true });

      res.json({
        success: true,
        message: "Template uploaded",
        job_id: jobId,
        template_size: raw.length,
        template_path: relPath,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get("/access_control/download_template.php", async (req, res, next) => {
  try {
    const jobId = Number(req.query.job_id || 0);
    if (!jobId) return res.status(400).send("Invalid job_id");

    const job = await one("SELECT template_path FROM fingerprint_enrollment_jobs WHERE id = $1", [jobId]);
    if (!job || !job.template_path) return res.status(404).send("Template not uploaded");

    const fullPath = path.join(__dirname, "..", job.template_path);
    if (!fs.existsSync(fullPath)) return res.status(404).send("Template file not found");

    const data = fs.readFileSync(fullPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", data.length);
    res.send(data);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// 9. Hardware Compatibility: Update Transfer Status & Commands
// ----------------------------------------------------
router.post("/access_control/update_transfer_status.php", async (req, res, next) => {
  try {
    const { job_id, status, message } = req.body || {};
    const jid = Number(job_id);
    if (!jid) return res.status(400).json({ success: false, message: "Missing job_id" });

    if (status === "TRANSFER_SUCCESS") {
      await advanceEnrollmentStep(jid, "COMPLETED");
    }

    res.json({ success: true, job_id: jid, status, message: message || "OK" });
  } catch (err) {
    next(err);
  }
});

router.get("/access_control/get_command.php", async (req, res, next) => {
  try {
    const esp32Id = String(req.query.esp32_id || "").trim();
    if (!esp32Id) return res.json({ success: false, message: "esp32_id required" });

    const cmd = await one(
      `SELECT * FROM device_commands
        WHERE (esp32_id = $1 OR esp32_id = 'ESP32_01') AND status = 'PENDING'
        ORDER BY command_id ASC LIMIT 1`,
      [esp32Id]
    );

    if (!cmd) {
      return res.json({ success: true, command_available: false, message: "No pending command" });
    }

    res.json({
      success: true,
      command_available: true,
      command_id: cmd.command_id,
      job_id: cmd.job_id,
      esp32_id: cmd.esp32_id,
      command: cmd.command,
      user_id: cmd.user_id,
      fingerprint_id: cmd.fingerprint_id,
      status: cmd.status,
      created_at: cmd.created_at,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
