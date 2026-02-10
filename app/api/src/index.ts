import http from "http";
import { PORTS } from "./config/ports";
import { initDb, db } from "./db";
import { runMigrations } from "./db/migrate";
import "./db/migrate";
import { persistNodeInfo } from "./lightning/persist";
import { syncLndState } from "./lightning/sync";

initDb();
runMigrations();

persistNodeInfo().catch(err => {
  console.warn("[lnd] unable to persist node info:", err.message);
});

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    try {
      db.prepare("SELECT 1").get();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", db: "ok" }));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", db: "error" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/lnd/sync") {
    try {
      const result = await syncLndState();

      if (!result.ok) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error" }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});


server.listen(PORTS.userApi, () => {
  console.log(`[api] listening on port ${PORTS.userApi}`);
});
