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
// DownChar: Create multi-terminal sync jobs & commands
// ----------------------------------------------------
async function createDowncharSyncJobs(masterJobId) {
  if (!masterJobId) return [];

  const masterJob = await one(
    `SELECT j.*, p.employee_code, p.full_name, p.department
       FROM fingerprint_enrollment_jobs j
       JOIN people p ON p.id = j.person_id
      WHERE j.id = $1`,
    [masterJobId]
  );
  if (!masterJob || !masterJob.person_id) return [];

  // Find all other active devices in the facility
  const otherDevices = await query(
    `SELECT * FROM devices
      WHERE is_active = TRUE
        AND id != $1
      ORDER BY id ASC`,
    [masterJob.target_device_id || 0]
  );

  const createdJobs = [];

  for (const dev of otherDevices) {
    // Check if this device already has an active or completed downchar job for this person & slot
    const existing = await one(
      `SELECT id, status, step FROM fingerprint_enrollment_jobs
        WHERE person_id = $1
          AND target_device_id = $2
          AND fingerprint_id = $3
          AND status IN ('REQUESTED', 'RUNNING', 'COMPLETED')`,
      [masterJob.person_id, dev.id, masterJob.fingerprint_id]
    );

    if (existing) {
      createdJobs.push(existing);
      continue;
    }

    // Cancel any previous failed or stale commands/jobs for this device & person
    await query(
      `UPDATE fingerprint_enrollment_jobs
          SET status = 'CANCELLED', updated_at = now()
        WHERE person_id = $1 AND target_device_id = $2 AND status IN ('REQUESTED', 'RUNNING')`,
      [masterJob.person_id, dev.id]
    );

    await query(
      `UPDATE device_commands
          SET status = 'CANCELLED'
        WHERE user_id = $1 AND esp32_id = $2 AND status = 'PENDING'`,
      [masterJob.person_id, dev.device_key]
    );

    // Create downchar sub-job
    const subJob = await one(
      `INSERT INTO fingerprint_enrollment_jobs
         (person_id, target_device_id, fingerprint_id, card_uid, template_path, step, status)
       VALUES
         ($1, $2, $3, $4, $5, 'DOWNCHAR_PENDING', 'REQUESTED')
       RETURNING *`,
      [
        masterJob.person_id,
        dev.id,
        masterJob.fingerprint_id,
        masterJob.card_uid,
        masterJob.template_path,
      ]
    );

    // Create device command for this device (ENROLL_DOWNLOAD command for test_4.ino)
    await query(
      `INSERT INTO device_commands
         (job_id, esp32_id, command, user_id, fingerprint_id, status)
       VALUES
         ($1, $2, 'ENROLL_DOWNLOAD', $3, $4, 'PENDING')`,
      [subJob.id, dev.device_key, masterJob.person_id, masterJob.fingerprint_id]
    );

    createdJobs.push(subJob);
  }

  broadcast("device_sync_update", {
    master_job_id: masterJobId,
    person_id: masterJob.person_id,
    created_downchar_jobs: createdJobs.length,
  });

  return createdJobs;
}

// ----------------------------------------------------
// 1. API: Start Enrollment Wizard Job
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

    // Create master job
    const job = await one(
      `INSERT INTO fingerprint_enrollment_jobs
         (person_id, target_device_id, fingerprint_id, step, status)
       VALUES
         ($1, $2, $3, 'WAITING_CARD', 'REQUESTED')
       RETURNING *`,
      [person.id, targetDeviceId, nextSlot]
    );

    // Create device command: ENROLL_UPLOAD aligns directly with test_4.ino firmware
    await query(
      `INSERT INTO device_commands
         (job_id, esp32_id, command, user_id, fingerprint_id, status)
       VALUES
         ($1, $2, 'ENROLL_UPLOAD', $3, $4, 'PENDING')`,
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

    // Auto-expire stale master jobs: if active job has had no update for > 35 seconds
    // (excluding downchar pending jobs which wait for remote devices to poll)
    if (["REQUESTED", "RUNNING"].includes(job.status) && !String(job.step).startsWith("DOWNCHAR")) {
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

  // If completed or syncing, commit credentials & access rules
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

    // Automatically trigger DownChar sync job creation for other devices
    try {
      await createDowncharSyncJobs(jobId);
    } catch (e) {
      console.error("DownChar sync creation failed in advanceEnrollmentStep:", e);
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

const handleStepAdvance = async (req, res, next) => {
  try {
    const { job_id, step, card_uid, error_message } = req.body || {};
    const jid = Number(job_id || req.params.id || 0);
    if (!jid || !step) {
      return res.status(400).json({ error: "bad_request", message: "job_id and step are required" });
    }
    const result = await advanceEnrollmentStep(jid, step, card_uid, error_message);
    if (!result) return res.status(404).json({ error: "not_found", message: "Job not found" });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

router.post("/api/enrollment/step", handleStepAdvance);
router.post("/api/fingerprint/enrollment/step", handleStepAdvance);
router.post("/api/fingerprint/enrollment/:id/step", handleStepAdvance);

// ----------------------------------------------------
// 4. API: Hardware NFC Card Registration (test_4.ino: sendNFCToServer)
// ----------------------------------------------------
const handleNfcEnrollment = async (req, res, next) => {
  try {
    const jobId = Number(req.params.id || req.params.jobId || req.body?.job_id || 0);
    const { device_key, nfc_uid } = req.body || {};

    if (!jobId) {
      return res.status(400).json({ success: false, message: "Missing job_id" });
    }

    const cleanCard = cleanUid(nfc_uid);
    if (!cleanCard) {
      return res.status(400).json({ success: false, message: "Invalid nfc_uid" });
    }

    const job = await one("SELECT * FROM fingerprint_enrollment_jobs WHERE id = $1", [jobId]);
    if (!job) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    const updated = await one(
      `UPDATE fingerprint_enrollment_jobs
          SET card_uid = $1, step = 'CARD_TAPPED', status = 'RUNNING', updated_at = now()
        WHERE id = $2
        RETURNING *`,
      [cleanCard, jobId]
    );

    broadcast("enrollment_update", {
      job_id: updated.id,
      person_id: updated.person_id,
      card_uid: updated.card_uid,
      fingerprint_id: updated.fingerprint_id,
      step: "CARD_TAPPED",
      status: "RUNNING",
    });

    res.json({
      success: true,
      message: "NFC card registered successfully",
      job_id: jobId,
      fingerprint_id: updated.fingerprint_id,
    });
  } catch (err) {
    next(err);
  }
};

router.post("/api/fingerprint/enrollment/:id/nfc", handleNfcEnrollment);
router.post("/api/enrollment/:id/nfc", handleNfcEnrollment);

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
// 6. Hardware Command Polling (test_4.ino: checkServerCommand)
// ----------------------------------------------------
const handleDeviceCommand = async (req, res, next) => {
  try {
    const esp32Key = String(
      req.params.deviceKey || req.params.esp32_id || req.query.esp32_id || req.query.device_key || ""
    ).trim();

    if (!esp32Key) {
      return res.json({ success: true, command_available: false, command: "NORMAL" });
    }

    // Keep device last_seen_at fresh!
    await query(
      "UPDATE devices SET last_seen_at = now() WHERE device_key = $1 OR device_label ILIKE '%' || $1 || '%'",
      [esp32Key]
    );

    // Auto-expire stale commands/jobs (> 60s without update, except downchar jobs waiting for poll)
    await query(
      `UPDATE fingerprint_enrollment_jobs
          SET status = 'TIMEOUT', step = 'TIMEOUT',
              error_message = 'Enrollment command timed out.',
              updated_at = now()
        WHERE status IN ('REQUESTED', 'RUNNING')
          AND updated_at < now() - interval '60 seconds'
          AND step NOT LIKE 'DOWNCHAR%'`
    );

    // Find pending command for this device
    const cmd = await one(
      `SELECT c.*, j.person_id, j.fingerprint_id, j.status AS job_status
         FROM device_commands c
         JOIN fingerprint_enrollment_jobs j ON j.id = c.job_id
        WHERE (c.esp32_id = $1 OR (c.esp32_id = 'ESP32_01' AND $1 = 'ESP32_01'))
          AND c.status = 'PENDING'
          AND j.status IN ('REQUESTED', 'RUNNING')
        ORDER BY c.command_id ASC
        LIMIT 1`,
      [esp32Key]
    );

    if (!cmd) {
      return res.json({
        success: true,
        command_available: false,
        command: "NORMAL",
      });
    }

    // Normalize command name for test_4.ino
    let commandName = cmd.command;
    if (commandName === "ENTER_ENROLLMENT") {
      commandName = "ENROLL_UPLOAD";
    }

    res.json({
      success: true,
      command_available: true,
      command_id: cmd.command_id,
      job_id: cmd.job_id,
      esp32_id: cmd.esp32_id,
      user_id: cmd.user_id || cmd.person_id,
      person_id: cmd.user_id || cmd.person_id,
      fingerprint_id: cmd.fingerprint_id,
      command: commandName,
      created_at: cmd.created_at,
    });
  } catch (err) {
    next(err);
  }
};

router.get("/api/device/:deviceKey/command", handleDeviceCommand);
router.get("/api/device/:esp32_id/command", handleDeviceCommand);
router.get("/access_control/get_command.php", handleDeviceCommand);

// ----------------------------------------------------
// 7. Hardware Template Upload (test_4.ino: uploadTemplateToServer)
// ----------------------------------------------------
const handleTemplateUpload = async (req, res, next) => {
  try {
    const jobId = Number(
      req.headers["x-job-id"] || req.query.job_id || req.params.id || req.body?.job_id || 0
    );
    const personId = Number(req.headers["x-person-id"] || req.query.person_id || 0);
    const fpId = Number(req.headers["x-fingerprint-id"] || req.query.fingerprint_id || 0);
    const deviceKey = String(req.headers["x-device-key"] || req.query.device_key || "").trim();

    const raw = req.body;
    if (!raw || raw.length === 0) {
      return res.status(400).json({ success: false, message: "Empty template payload" });
    }

    if (!jobId) {
      return res.status(400).json({ success: false, message: "Missing job_id or X-Job-ID header" });
    }

    const fileName = `job_${jobId}.bin`;
    const filePath = path.join(TEMPLATES_DIR, fileName);
    fs.writeFileSync(filePath, raw);

    const relPath = `templates/${fileName}`;

    await query(
      `UPDATE fingerprint_enrollment_jobs
          SET template_path = $1, step = 'FINGER_2', updated_at = now()
        WHERE id = $2`,
      [relPath, jobId]
    );

    // Automatically create DownChar sync jobs for all other active terminals in the facility
    try {
      await createDowncharSyncJobs(jobId);
    } catch (syncErr) {
      console.error("Downchar sync generation error on upload:", syncErr);
    }

    broadcast("enrollment_update", {
      job_id: jobId,
      step: "FINGER_2",
      status: "RUNNING",
      template_uploaded: true,
      template_size: raw.length,
    });

    res.json({
      success: true,
      message: "Template uploaded and sync jobs provisioned",
      job_id: jobId,
      template_size: raw.length,
      template_path: relPath,
    });
  } catch (err) {
    next(err);
  }
};

router.post(
  "/api/fingerprint/template/upload",
  express.raw({ type: "*/*", limit: "2mb" }),
  handleTemplateUpload
);
router.post(
  "/access_control/upload_template.php",
  express.raw({ type: "*/*", limit: "2mb" }),
  handleTemplateUpload
);

// ----------------------------------------------------
// 8. Hardware Template Download (test_4.ino: downloadTemplateFromServer)
// ----------------------------------------------------
const handleTemplateDownload = async (req, res, next) => {
  try {
    const jobId = Number(req.params.id || req.params.jobId || req.query.job_id || 0);
    if (!jobId) return res.status(400).send("Invalid job_id");

    const job = await one("SELECT * FROM fingerprint_enrollment_jobs WHERE id = $1", [jobId]);
    if (!job) return res.status(404).send("Job not found");

    let templateRelPath = job.template_path;
    if (!templateRelPath) {
      // If this is a downchar subjob, check for master template from person_id
      const masterJob = await one(
        `SELECT template_path FROM fingerprint_enrollment_jobs
          WHERE person_id = $1 AND template_path IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
        [job.person_id]
      );
      if (masterJob) templateRelPath = masterJob.template_path;
    }

    if (!templateRelPath) {
      const defaultPath = path.join(TEMPLATES_DIR, `job_${jobId}.bin`);
      if (fs.existsSync(defaultPath)) templateRelPath = `templates/job_${jobId}.bin`;
    }

    if (!templateRelPath) {
      return res.status(404).send("Template not found");
    }

    const fullPath = path.isAbsolute(templateRelPath)
      ? templateRelPath
      : path.join(__dirname, "..", templateRelPath);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).send("Template file missing on disk");
    }

    // Mark job as in-progress downloading/downchar syncing
    await query(
      "UPDATE fingerprint_enrollment_jobs SET step = 'DOWNCHAR_SYNCING', status = 'RUNNING', updated_at = now() WHERE id = $1",
      [jobId]
    );
    broadcast("enrollment_update", { job_id: jobId, step: "DOWNCHAR_SYNCING", status: "RUNNING" });

    const data = fs.readFileSync(fullPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", data.length);
    res.send(data);
  } catch (err) {
    next(err);
  }
};

router.get("/api/fingerprint/template/:id", handleTemplateDownload);
router.get("/api/fingerprint/template/download/:id", handleTemplateDownload);
router.get("/access_control/download_template.php", handleTemplateDownload);

// ----------------------------------------------------
// 9. Hardware Enrollment Complete / Fail Reporting
// (test_4.ino: markJobComplete and markJobFailed)
// ----------------------------------------------------
async function handleEnrollmentReport(req, res, next) {
  try {
    const data = req.body || {};
    const jobId = Number(req.params.id || req.params.jobId || data.job_id || req.query.job_id || 0);
    const esp32Id = data.device_key || data.esp32_id || req.query.esp32_id || "";
    const cardUid = data.card_uid || req.query.card_uid || null;

    const isFailRoute = req.path.endsWith("/fail") || req.url.includes("/fail");
    const isTimeout =
      String(data.status || data.step || data.message || data.reason || "").toUpperCase().includes("TIMEOUT") ||
      String(req.query.status || req.query.step || req.query.message || "").toUpperCase().includes("TIMEOUT");

    const isSuccess = !isFailRoute && !isTimeout && (data.success === undefined ? true : Boolean(data.success));

    if (!jobId) {
      return res.status(400).json({ success: false, message: "Missing required job_id" });
    }

    if (!isSuccess || isTimeout) {
      const finalStep = isTimeout ? "TIMEOUT" : "FAILED";
      const errMsg =
        data.reason ||
        data.message ||
        (isTimeout ? "Hardware enrollment timed out. Terminal returned to standby state." : "Hardware enrollment reported failure");
      await advanceEnrollmentStep(jobId, finalStep, null, errMsg);
      await query("UPDATE device_commands SET status = $1, completed_at = now() WHERE job_id = $2", [finalStep, jobId]);
      return res.json({ success: true, message: `Enrollment marked as ${finalStep}`, job_id: jobId, status: finalStep });
    }

    // Success path
    const result = await advanceEnrollmentStep(jobId, "COMPLETED", cardUid);
    await query("UPDATE device_commands SET status = 'COMPLETED', completed_at = now() WHERE job_id = $1", [jobId]);

    // Ensure DownChar sync jobs are ready for all active terminals
    try {
      await createDowncharSyncJobs(jobId);
    } catch (e) {
      console.error("DownChar sync creation failed in handleEnrollmentReport:", e);
    }

    res.json({
      success: true,
      message: "Enrollment completed successfully",
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

router.post("/api/fingerprint/enrollment/:id/complete", handleEnrollmentReport);
router.post("/api/fingerprint/enrollment/:id/fail", handleEnrollmentReport);
router.post("/api/fingerprint/enrollment/complete", handleEnrollmentReport);
router.post("/api/fingerprint/enrollment/fail", handleEnrollmentReport);
router.post("/api/enrollment/:id/complete", handleEnrollmentReport);
router.post("/api/enrollment/:id/fail", handleEnrollmentReport);
router.post("/api/enrollment/complete", handleEnrollmentReport);
router.post("/api/enrollment/fail", handleEnrollmentReport);
router.post("/api/enrollment/timeout", handleEnrollmentReport);
router.post("/access_control/test_enrollment.php", handleEnrollmentReport);
router.post("/access_control/access_control_test/test_enrollment.php", handleEnrollmentReport);
router.post("/access_control/update_transfer_status.php", handleEnrollmentReport);

// ----------------------------------------------------
// 10. Step 5 Multi-Device DownChar Sync Status & Trigger
// ----------------------------------------------------
router.get("/api/enrollment/:id/sync-devices", async (req, res, next) => {
  try {
    const masterJobId = Number(req.params.id);
    const masterJob = await one(
      `SELECT j.*, p.employee_code, p.full_name, p.department
         FROM fingerprint_enrollment_jobs j
         JOIN people p ON p.id = j.person_id
        WHERE j.id = $1`,
      [masterJobId]
    );
    if (!masterJob) return res.status(404).json({ error: "not_found", message: "Job not found" });

    // Fetch all active devices
    const allDevices = await query(
      `SELECT d.*, (d.last_seen_at IS NOT NULL AND d.last_seen_at > now() - interval '5 minutes') AS is_online
         FROM devices d
        WHERE d.is_active = TRUE
        ORDER BY (d.id = $1) DESC, d.id ASC`,
      [masterJob.target_device_id || 0]
    );

    // Fetch all downchar sub-jobs for this person & fingerprint_id
    const downcharJobs = await query(
      `SELECT j.*, c.command_id, c.status AS command_status, c.command
         FROM fingerprint_enrollment_jobs j
         LEFT JOIN device_commands c ON c.job_id = j.id
        WHERE j.person_id = $1 AND j.fingerprint_id = $2`,
      [masterJob.person_id, masterJob.fingerprint_id]
    );

    const downcharByDevId = {};
    for (const dj of downcharJobs) {
      if (dj.target_device_id) {
        downcharByDevId[dj.target_device_id] = dj;
      }
    }

    const deviceList = allDevices.map((dev) => {
      const isMaster = (dev.id === masterJob.target_device_id);
      if (isMaster) {
        const isMasterDone =
          masterJob.status === "COMPLETED" ||
          masterJob.step === "COMPLETED" ||
          masterJob.step === "SYNCING" ||
          masterJob.step === "FINGER_2";
        return {
          device_id: dev.id,
          device_key: dev.device_key,
          device_label: dev.device_label,
          is_online: dev.is_online,
          is_master: true,
          role: "Source Terminal",
          sync_status: isMasterDone ? "COMPLETED" : masterJob.status,
          step: masterJob.step,
          status_text: isMasterDone ? "Biometrics Uploaded & Saved" : "In Progress",
        };
      }

      const dj = downcharByDevId[dev.id];
      let syncStatus = "PENDING";
      let statusText = "Queued (Waiting for poll)";

      if (dj) {
        if (dj.status === "COMPLETED" || dj.step === "COMPLETED") {
          syncStatus = "COMPLETED";
          statusText = "Synced (DownChar stored)";
        } else if (dj.status === "FAILED" || dj.step === "FAILED") {
          syncStatus = "FAILED";
          statusText = `Failed: ${dj.error_message || "Transfer error"}`;
        } else if (dj.status === "RUNNING" || dj.step === "DOWNCHAR_SYNCING") {
          syncStatus = "RUNNING";
          statusText = "Transferring DownChar to sensor...";
        } else {
          syncStatus = "QUEUED";
          statusText = dev.is_online ? "Queued (Ready to DownChar)" : "Queued (Offline - syncs when booted)";
        }
      } else {
        syncStatus = "QUEUED";
        statusText = "Queuing sync...";
      }

      return {
        device_id: dev.id,
        device_key: dev.device_key,
        device_label: dev.device_label,
        is_online: dev.is_online,
        is_master: false,
        role: "Target Terminal",
        sync_status: syncStatus,
        sub_job_id: dj?.id || null,
        status_text: statusText,
      };
    });

    const totalCount = deviceList.length;
    const completedCount = deviceList.filter((d) => d.sync_status === "COMPLETED").length;

    res.json({
      success: true,
      master_job_id: masterJobId,
      person_id: masterJob.person_id,
      fingerprint_id: masterJob.fingerprint_id,
      total_devices: totalCount,
      completed_devices: completedCount,
      all_synced: (completedCount === totalCount),
      devices: deviceList,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/api/enrollment/:id/sync-devices", async (req, res, next) => {
  try {
    const masterJobId = Number(req.params.id);
    const created = await createDowncharSyncJobs(masterJobId);
    res.json({ success: true, count: created.length });
  } catch (err) {
    next(err);
  }
});

// Backward compatibility poll handler
router.get("/access_control/test_enrollment.php", handleDeviceCommand);
router.get("/access_control/access_control_test/test_enrollment.php", handleDeviceCommand);
router.get("/api/fingerprint-enrollment", handleDeviceCommand);

module.exports = router;
