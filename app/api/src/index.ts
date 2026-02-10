// API server entry point
import http from "http";
import { PORTS } from "./config/ports";
import { initDb, getDb } from "./db";
import { isLndAvailable, getLndInfo } from "./lightning/lnd";

// Initialize database deterministically at startup
initDb();

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    try {
      const db = getDb();
      db.prepare("SELECT 1").get();

      // Check LND availability (non-blocking - don't fail health if LND is missing)
      const lndStatus = isLndAvailable() ? "ok" : "unavailable";

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", db: "ok", lnd: lndStatus }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", db: "error", lnd: "unavailable" }));
    }
    return;
  }

  if (req.url === "/lnd/info" && req.method === "GET") {
    try {
      const info = await getLndInfo();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(info));
    } catch (err) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "LND unavailable",
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORTS.userApi, () => {
  console.log(`[api] listening on port ${PORTS.userApi}`);
});