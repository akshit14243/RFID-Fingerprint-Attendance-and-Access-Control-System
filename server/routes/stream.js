const express = require("express");
const { addClient, broadcast, clientCount } = require("../bus");

const router = express.Router();

router.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(`event: connected\ndata: ${JSON.stringify({ server_time: new Date().toISOString() })}\n\n`);

  addClient(res);

  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => clearInterval(ping));
});

router.get("/stream/status", (_req, res) => res.json({ listeners: clientCount() }));

module.exports = { router, broadcast };
