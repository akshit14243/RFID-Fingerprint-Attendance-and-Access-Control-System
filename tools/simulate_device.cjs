#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

const BASE = opt("--url", "http://127.0.0.1:3000");
const DEVICE = opt("--device", "DEV-MAIN-8F2A41C7");
const BUFFER_FILE = path.join(__dirname, ".sim_buffer.json");

const CARDS = ["04A2B7C1", "04B3C8D2", "04C4D9E3", "04D5EAF4", "04E6FB05", "04F70C16"];
const SLOTS = { "04A2B7C1": 1, "04B3C8D2": 2, "04C4D9E3": 3, "04D5EAF4": 4, "04E6FB05": 5, "04F70C16": 6 };

const counterFile = path.join(__dirname, ".sim_counter");
function nextEventId() {
  const n = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0) + 1;
  fs.writeFileSync(counterFile, String(n));
  return `${DEVICE.split("-")[1]}-SIM-${String(n).padStart(5, "0")}`;
}

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

function makeScan(cardOverride, withFinger = true, when = new Date()) {
  const card = cardOverride || CARDS[Math.floor(Math.random() * CARDS.length)];
  return {
    card_uid: card,
    fingerprint_slot: withFinger ? (SLOTS[card] ?? null) : null,
    scanned_at: when.toISOString(),
    device_event_id: nextEventId(),
  };
}

function show(label, r) {
  const b = r.body;
  const line = typeof b === "object" && b.reason
    ? `${b.allowed ? "ALLOWED" : "DENIED "} ${b.direction}  ${b.person_name || "(unknown card)"}  reason=${b.reason}${b.duplicate ? "  [duplicate]" : ""}`
    : JSON.stringify(b);
  console.log(`${label} [${r.status}] ${line}`);
}

async function scanOnce() {
  const scan = makeScan(opt("--card", null), !has("--no-finger"));
  show("scan   ", await post("/api/scan", { device_key: DEVICE, ...scan }));
}

async function loop(n) {
  for (let i = 0; i < n; i++) {
    await scanOnce();
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function offline(n) {
  const events = [];
  for (let i = n; i > 0; i--) {
    events.push(makeScan(null, true, new Date(Date.now() - i * 5 * 60 * 1000)));
  }
  fs.writeFileSync(BUFFER_FILE, JSON.stringify(events, null, 2));
  console.log(`buffered ${n} events while "offline" (saved to ${path.basename(BUFFER_FILE)})`);

  const r = await post("/api/sync", { device_key: DEVICE, events });
  console.log(`sync    [${r.status}] accepted=${r.body.accepted} duplicates=${r.body.duplicates}`);
  for (const x of r.body.results || []) console.log(`   ${x.device_event_id}  ${x.status}  ${x.reason}`);
  console.log("The board deletes only the ids listed in stored[].");
}

async function replay() {
  if (!fs.existsSync(BUFFER_FILE)) return console.log("no buffer to replay - run --offline first");
  const events = JSON.parse(fs.readFileSync(BUFFER_FILE, "utf8"));
  const r = await post("/api/sync", { device_key: DEVICE, events });
  console.log(`replay  [${r.status}] accepted=${r.body.accepted} duplicates=${r.body.duplicates}`);
  console.log(r.body.accepted === 0 ? "Correct: nothing was double counted." : "PROBLEM: something was inserted twice.");
}

async function heartbeat() {
  const r = await post("/api/heartbeat", { device_key: DEVICE, firmware_ver: "0.1.0-sim" });
  console.log(`heart   [${r.status}]`, r.body);
}

async function config() {
  const res = await fetch(`${BASE}/api/device/config?device_key=${encodeURIComponent(DEVICE)}`);
  console.log(`config  [${res.status}]`, JSON.stringify(await res.json(), null, 2));
}

(async () => {
  try {
    if (has("--offline")) return await offline(Number(opt("--offline", 3)));
    if (has("--replay")) return await replay();
    if (has("--heartbeat")) return await heartbeat();
    if (has("--config")) return await config();
    if (has("--loop")) return await loop(Number(opt("--loop", 5)));
    await scanOnce();
  } catch (err) {
    console.error("Could not reach the server:", err.message);
    console.error(`Is it running?  ${BASE}/api/health`);
    process.exit(1);
  }
})();
