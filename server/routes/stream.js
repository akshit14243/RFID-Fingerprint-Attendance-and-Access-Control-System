// Real-time feed for the dashboard, using Server-Sent Events.
// The frontend needs three lines and no library:
//
//   const es = new EventSource("http://<lan-ip>:3000/api/stream");
//   es.addEventListener("access_event", e => console.log(JSON.parse(e.data)));
//
// Works the same in plain JavaScript and in React (open it in a useEffect).

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

  // A comment line every 25 s so proxies and phones do not drop the socket.
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => clearInterval(ping));
});

router.get("/stream/status", (_req, res) => res.json({ listeners: clientCount() }));

module.exports = { router, broadcast };
