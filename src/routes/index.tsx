import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Attendance System — Database & API Contract (US_2003)" },
      {
        name: "description",
        content:
          "Database design and draft API contract for the RFID and fingerprint attendance system: tables, access decision logic, and the endpoints the ESP32 devices call.",
      },
      { property: "og:title", content: "Attendance System — Database & API Contract" },
      {
        property: "og:description",
        content:
          "MySQL schema, access decision logic and the v0.1 API contract for the RFID + fingerprint attendance project.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const tables: Array<{ name: string; holds: string; why: string }> = [
  {
    name: "people",
    holds: "employee code, name, department, type, active flag",
    why: "The card is not the person. This table is the identity.",
  },
  {
    name: "credentials",
    holds: "card UID, fingerprint slot, valid_from / valid_until, revoked",
    why: "Credential lifecycle. A lost card is revoked without deleting the person.",
  },
  {
    name: "rooms",
    holds: "room code, name, restricted flag",
    why: "Answers 'which room did they enter'.",
  },
  {
    name: "devices",
    holds: "device key, label, room, firmware version, last seen",
    why: "One ESP32 per door. Identifies who is reporting.",
  },
  {
    name: "access_rules",
    holds: "room + person or department, fingerprint_required, expiry",
    why: "Fixes 'every card opens every door'.",
  },
  {
    name: "access_events",
    holds: "person, device, room, direction, decision, reason, both timestamps",
    why: "Append-only audit log. The heart of the system.",
  },
  {
    name: "v_occupancy",
    holds: "view: last allowed event per person per room where direction = IN",
    why: "Live who's-inside and the fire drill muster list, derived not stored.",
  },
  {
    name: "users",
    holds: "dashboard login, role admin or viewer",
    why: "Web users, separate from the people who tap cards.",
  },
];

const endpoints: Array<{ method: string; path: string; purpose: string }> = [
  { method: "POST", path: "/api/scan", purpose: "One scan in, allow/deny + direction out" },
  { method: "POST", path: "/api/sync", purpose: "Replay of events buffered while Wi-Fi was down" },
  { method: "POST", path: "/api/heartbeat", purpose: "Device liveness, updates last_seen" },
  { method: "GET", path: "/api/occupancy", purpose: "Who is inside right now" },
  { method: "GET", path: "/api/events", purpose: "Filtered audit log" },
  { method: "GET", path: "/api/people", purpose: "People and their credentials" },
];

const reasons = [
  "OK",
  "UNKNOWN_CARD",
  "CREDENTIAL_EXPIRED",
  "CREDENTIAL_REVOKED",
  "NO_ACCESS_RULE",
  "FINGERPRINT_REQUIRED",
  "FINGERPRINT_MISMATCH",
  "PERSON_INACTIVE",
  "DEVICE_INACTIVE",
];

function Index() {
  return (
    <main className="min-h-screen bg-background px-6 py-12 text-foreground">
      <div className="mx-auto max-w-4xl space-y-12">
        <header className="space-y-3 border-b border-border pb-8">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            US_2003 · Web side
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            RFID + Fingerprint Attendance — Database and API Contract
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            The hardware team owns the ESP32. This side owns the database, the access decision and
            the endpoints the readers call. Schema runs locally in MySQL Workbench; the API server
            runs on my laptop and the devices reach it over the LAN.
          </p>
        </header>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">The tables and why each exists</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Table</th>
                  <th className="px-4 py-3 font-medium">Holds</th>
                  <th className="px-4 py-3 font-medium">Why it exists</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((t) => (
                  <tr key={t.name} className="border-t border-border align-top">
                    <td className="px-4 py-3 font-mono text-xs">{t.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{t.holds}</td>
                    <td className="px-4 py-3">{t.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">The access decision, in order</h2>
          <ol className="space-y-2 text-sm leading-relaxed">
            {[
              "Is the device key known and active?",
              "Does the card UID match a credential?",
              "Is that credential revoked or past its valid_until?",
              "Is the person still active?",
              "Is there an access rule for this person or department in this room?",
              "If the rule demands a fingerprint, was one presented, and does the slot match the card's owner?",
              "Direction: last allowed event in this room was IN, so this one is OUT, otherwise IN.",
              "Write the event — allowed or denied — with a reason code, and answer the device.",
            ].map((step, i) => (
              <li key={step} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2 pt-2">
            {reasons.map((r) => (
              <span
                key={r}
                className="rounded border border-border px-2 py-1 font-mono text-xs text-muted-foreground"
              >
                {r}
              </span>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">API contract v0.1 (draft)</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Method</th>
                  <th className="px-4 py-3 font-medium">Path</th>
                  <th className="px-4 py-3 font-medium">Purpose</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((e) => (
                  <tr key={e.path} className="border-t border-border">
                    <td className="px-4 py-3 font-mono text-xs">{e.method}</td>
                    <td className="px-4 py-3 font-mono text-xs">{e.path}</td>
                    <td className="px-4 py-3 text-muted-foreground">{e.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 text-xs leading-relaxed">
            {`POST /api/scan
{
  "device_key": "DEV-MAIN-8F2A41C7",
  "card_uid": "04A2B7C1",
  "fingerprint_slot": 1,
  "scanned_at": "2026-09-01T09:30:44Z",
  "device_event_id": "MAIN-0011"
}
-->
{ "allowed": true, "direction": "IN", "person_name": "Akshit Saini", "reason": "OK" }`}
          </pre>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">How the hardware team connects</h2>
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
            <li>
              Both the laptop and the ESP32 sit on the same Wi-Fi. The server listens on port 3000.
            </li>
            <li>
              They post to <code className="font-mono text-xs">http://&lt;laptop-lan-ip&gt;:3000/api/scan</code>{" "}
              — not localhost, that would be the board itself.
            </li>
            <li>Each board gets its own device_key from the devices table.</li>
            <li>
              Until the board is ready, <code className="font-mono text-xs">tools/simulate_device.js</code>{" "}
              plays the device so the server can be built and tested on its own.
            </li>
          </ol>
        </section>

        <footer className="border-t border-border pt-6 text-xs text-muted-foreground">
          Schema: <code className="font-mono">db/01_schema.sql</code> · Seed:{" "}
          <code className="font-mono">db/02_seed.sql</code> · Server:{" "}
          <code className="font-mono">server/</code> · Contract:{" "}
          <code className="font-mono">docs/API_Contract_v0.1.md</code>
        </footer>
      </div>
    </main>
  );
}
