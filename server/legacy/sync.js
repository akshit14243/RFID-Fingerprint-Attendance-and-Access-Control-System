const { query, one } = require("../db");
const { findDevice, decideAndLog } = require("../decision");
const map = require("./mapping");

const ENABLED = String(process.env.LEGACY_SYNC_ENABLED || "false") === "true";
const URL_ = process.env.LEGACY_API_URL || "";
const TOKEN = process.env.LEGACY_API_TOKEN || "";
const INTERVAL = Number(process.env.LEGACY_SYNC_INTERVAL_SEC || 60) * 1000;

function pick(obj, path) {
  if (!path) return obj;
  return path.split(".").reduce((acc, k) => (acc ? acc[k] : undefined), obj);
}

async function fetchBatch(since) {
  const url = new URL(URL_);
  if (since) url.searchParams.set("since", new Date(since).toISOString());
  const res = await fetch(url, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`legacy API returned ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const records = pick(body, map.recordsPath);
  if (!Array.isArray(records)) throw new Error("legacy API: records path did not give an array");
  return records;
}

async function importRecord(rec) {
  const externalId = map.externalId(rec);

  const seen = await one("SELECT id FROM access_events WHERE external_id = $1", [externalId]);
  if (seen) return "duplicate";

  const deviceKey = map.readerToDeviceKey[map.readerId(rec)];
  if (!deviceKey) return "unmapped_reader";

  const device = await findDevice(deviceKey);
  if (!device) return "unknown_device";

  const out = await decideAndLog(
    device,
    {
      card_uid: map.cardUid(rec),
      fingerprint_slot: null,
      scanned_at: map.scannedAt(rec),
      device_event_id: `LEGACY-${externalId}`,
    },
    { source: "LEGACY", externalId },
  );
  return out.duplicate ? "duplicate" : "imported";
}

async function runOnce() {
  const state = await one("SELECT last_synced_at FROM legacy_sync_state WHERE id = 1");
  const records = await fetchBatch(state && state.last_synced_at);

  const counts = { imported: 0, duplicate: 0, unmapped_reader: 0, unknown_device: 0, failed: 0 };
  for (const rec of records) {
    try {
      counts[await importRecord(rec)]++;
    } catch (err) {
      counts.failed++;
      console.error("[legacy] record failed:", err.message);
    }
  }

  await query(
    "UPDATE legacy_sync_state SET last_synced_at = now(), last_error = NULL WHERE id = 1",
  );
  return { fetched: records.length, ...counts };
}

async function safeRunOnce() {
  try {
    const summary = await runOnce();
    console.log("[legacy] sync:", summary);
    return summary;
  } catch (err) {
    console.error("[legacy] sync failed:", err.message);
    await query("UPDATE legacy_sync_state SET last_error = $1 WHERE id = 1", [err.message]);
    return { error: err.message };
  }
}

function start() {
  if (!ENABLED) {
    console.log("[legacy] sync disabled (set LEGACY_SYNC_ENABLED=true to turn it on)");
    return;
  }
  if (!URL_) {
    console.warn("[legacy] sync enabled but LEGACY_API_URL is empty - not starting");
    return;
  }
  console.log(`[legacy] sync enabled, polling ${URL_} every ${INTERVAL / 1000}s`);
  safeRunOnce();
  setInterval(safeRunOnce, INTERVAL);
}

module.exports = { start, runOnce: safeRunOnce, ENABLED };
