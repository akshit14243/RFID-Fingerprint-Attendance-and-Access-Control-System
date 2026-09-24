require("dotenv").config();
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { pool, query, one } = require("./db");
const { login, requireUser, requireAdmin } = require("./auth");
const deviceRoutes = require("./routes/device");
const readRoutes = require("./routes/reads");
const adminRoutes = require("./routes/admin");
const { router: streamRoutes } = require("./routes/stream");
const legacy = require("./legacy/sync");
const hardwareAdapter = require("./routes/hardware_adapter");
const enrollmentRoutes = require("./routes/enrollment");

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));
app.use(hardwareAdapter);
app.use(enrollmentRoutes);

app.use(express.static(path.join(__dirname, "..", "web")));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "bad_request" });
    const result = await login(email, password);
    if (!result) return res.status(401).json({ error: "invalid_credentials" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get("/api/auth/me", requireUser, (req, res) => res.json({ user: req.user }));

app.use("/api", deviceRoutes);
app.use("/api", streamRoutes);
app.use("/api", readRoutes);
app.use("/api", adminRoutes);

app.post("/api/legacy/sync-now", requireUser, requireAdmin, async (_req, res, next) => {
  try {
    res.json(await legacy.runOnce());
  } catch (err) {
    next(err);
  }
});

app.get("/api/legacy/status", requireUser, async (_req, res, next) => {
  try {
    const state = await one("SELECT * FROM legacy_sync_state WHERE id = 1");
    res.json({ enabled: legacy.ENABLED, ...state });
  } catch (err) {
    next(err);
  }
});

app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ status: "ok", database: "connected", server_time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: "error", database: "unreachable", message: err.message });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === "23505") return res.status(409).json({ error: "duplicate", detail: err.detail });
  if (err.code === "23503") return res.status(400).json({ error: "bad_reference", detail: err.detail });
  res.status(500).json({ error: "server_error", message: err.message });
});

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Access control API listening on port ${PORT}`);
  console.log(`Give the hardware team:  http://${lanAddress()}:${PORT}`);
  legacy.start();
});

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
