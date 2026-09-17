// THE ACCESS DECISION.
// One scan in, one answer out: allowed or denied, which direction, and why.
// Every door in the building goes through this function - normal doors,
// restricted doors and the shift check-in point. The difference between them
// is data (fingerprint_required on the rule), not code.
//
// The order of the checks matters: cheapest and most definite first, so the
// reason code we return is the real reason and not a side effect.

const { query, one } = require("./db");
const { broadcast } = require("./bus");

async function findDevice(deviceKey) {
  return one(
    `SELECT d.*, r.room_name, r.is_restricted
       FROM devices d JOIN rooms r ON r.id = d.room_id
      WHERE d.device_key = $1`,
    [deviceKey],
  );
}

async function findCredential(cardUid) {
  return one(
    `SELECT c.*, p.full_name, p.employee_code, p.department, p.is_active AS person_active
       FROM credentials c JOIN people p ON p.id = c.person_id
      WHERE c.card_uid = $1`,
    [cardUid],
  );
}

// A rule naming the person beats a rule naming their department.
async function findRule(roomId, personId, department) {
  return one(
    `SELECT * FROM access_rules
      WHERE room_id = $1
        AND (person_id = $2 OR department = $3)
        AND (valid_until IS NULL OR valid_until > now())
      ORDER BY (person_id IS NULL)
      LIMIT 1`,
    [roomId, personId, department],
  );
}

// IN or OUT is not sent by the board; we work it out from the last allowed
// event for that person in that room. First ever scan = IN.
async function nextDirection(personId, roomId) {
  const last = await one(
    `SELECT direction FROM access_events
      WHERE person_id = $1 AND room_id = $2 AND decision = 'ALLOWED'
      ORDER BY scanned_at DESC, id DESC LIMIT 1`,
    [personId, roomId],
  );
  return last && last.direction === "IN" ? "OUT" : "IN";
}

function evaluate(device, cred, rule, fingerprintSlot) {
  if (!device.is_active) return "DEVICE_INACTIVE";
  if (!cred) return "UNKNOWN_CARD";
  if (cred.is_revoked) return "CREDENTIAL_REVOKED";
  if (cred.valid_until && new Date(cred.valid_until) < new Date()) return "CREDENTIAL_EXPIRED";
  if (cred.valid_from && new Date(cred.valid_from) > new Date()) return "CREDENTIAL_NOT_YET_VALID";
  if (!cred.person_active) return "PERSON_INACTIVE";
  if (!rule) return "NO_ACCESS_RULE";
  if (rule.fingerprint_required) {
    if (fingerprintSlot === null || fingerprintSlot === undefined) return "FINGERPRINT_REQUIRED";
    if (Number(fingerprintSlot) !== Number(cred.fingerprint_slot)) return "FINGERPRINT_MISMATCH";
  }
  return "OK";
}

/**
 * Decide one scan and store it.
 * scan: { card_uid, fingerprint_slot, scanned_at, device_event_id }
 * returns { allowed, direction, person_name, reason, event_id, duplicate }
 */
async function decideAndLog(device, scan, opts = {}) {
  const cardUid = String(scan.card_uid).toUpperCase().replace(/[^0-9A-F]/g, "");
  const fp = scan.fingerprint_slot ?? null;

  const cred = await findCredential(cardUid);
  const rule = cred
    ? await findRule(device.room_id, cred.person_id, cred.department)
    : null;

  const reason = evaluate(device, cred, rule, fp);
  const allowed = reason === "OK";

  // Unknown cards are logged as an IN attempt so they show up in the denied report.
  const direction = cred ? await nextDirection(cred.person_id, device.room_id) : "IN";
  const scannedAt = validDate(scan.scanned_at);

  const insert = `
    INSERT INTO access_events
      (device_id, room_id, person_id, credential_id, card_uid, direction, decision,
       reason_code, fingerprint_used, scanned_at, source, device_event_id, external_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (device_id, device_event_id) DO NOTHING
    RETURNING id, received_at`;

  const rows = await query(insert, [
    device.id,
    device.room_id,
    cred ? cred.person_id : null,
    cred ? cred.id : null,
    cardUid,
    direction,
    allowed ? "ALLOWED" : "DENIED",
    opts.reasonOverride || reason,
    fp !== null,
    scannedAt,
    opts.source || "NATIVE",
    scan.device_event_id,
    opts.externalId || null,
  ]);

  // Nothing returned = this device_event_id was already stored. A retry of
  // something we already handled, not an error. Report the stored answer.
  if (rows.length === 0) {
    const prev = await one(
      `SELECT id, decision, direction, reason_code FROM access_events
        WHERE device_id = $1 AND device_event_id = $2`,
      [device.id, scan.device_event_id],
    );
    return {
      allowed: prev ? prev.decision === "ALLOWED" : false,
      direction: prev ? prev.direction : direction,
      person_name: cred ? cred.full_name : null,
      reason: prev ? prev.reason_code : reason,
      event_id: prev ? prev.id : null,
      duplicate: true,
    };
  }

  const result = {
    allowed,
    direction,
    person_name: cred ? cred.full_name : null,
    reason,
    event_id: rows[0].id,
    duplicate: false,
  };

  // Push it to every dashboard that is watching.
  broadcast("access_event", {
    id: rows[0].id,
    person_name: result.person_name,
    employee_code: cred ? cred.employee_code : null,
    card_uid: cardUid,
    room_name: device.room_name,
    device_label: device.device_label,
    direction,
    decision: allowed ? "ALLOWED" : "DENIED",
    reason_code: reason,
    fingerprint_used: fp !== null,
    scanned_at: scannedAt,
    received_at: rows[0].received_at,
    late: new Date(rows[0].received_at) - new Date(scannedAt) > 60000,
  });
  if (allowed) broadcast("occupancy_changed", { room_name: device.room_name, direction });

  return result;
}

function validDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  return isNaN(d.getTime()) ? new Date() : d;
}

module.exports = { findDevice, findCredential, findRule, nextDirection, decideAndLog };
