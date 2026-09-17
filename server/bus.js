// The live-update bus. Every dashboard that opens GET /api/stream registers
// here; when a scan is stored we push it to all of them.
// Deliberately tiny: no websocket library, no rooms, no reconnect logic on our
// side (the browser's EventSource reconnects by itself).

const clients = new Set();

function addClient(res) {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

function broadcast(event, payload) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

function clientCount() {
  return clients.size;
}

module.exports = { addClient, broadcast, clientCount };
