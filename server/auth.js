const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { one } = require("./db");

const SECRET = process.env.AUTH_SECRET || "change-this-in-your-env-file";
const TTL_HOURS = 12;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  if (payload.exp < Date.now()) return null;
  return payload;
}

async function login(email, password) {
  const user = await one("SELECT id, email, password_hash, role FROM users WHERE email = $1", [email]);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  const token = sign({ uid: user.id, exp: Date.now() + TTL_HOURS * 3600 * 1000 });
  return { token, user: { id: user.id, email: user.email, role: user.role } };
}

async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const payload = verify(header.replace(/^Bearer\s+/i, ""));
    if (!payload) return res.status(401).json({ error: "unauthorized" });
    const user = await one("SELECT id, email, role FROM users WHERE id = $1", [payload.uid]);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden", message: "admin role required" });
  }
  next();
}

module.exports = { login, requireUser, requireAdmin, sign, verify };
