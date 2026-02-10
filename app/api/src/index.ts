// API server entry point
import http from "http";
import { PORTS } from "./config/ports";
import { initDb, getDb } from "./db";

// Initialize database deterministically at startup
initDb();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    try {
      const db = getDb();
      db.prepare("SELECT 1").get();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", db: "ok" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", db: "error" }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORTS.userApi, () => {
  console.log(`[api] listening on port ${PORTS.userApi}`);
});