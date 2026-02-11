import http from "http";
import { PORTS } from "./config/ports";
import { initDb, db } from "./db";
import { runMigrations } from "./db/migrate";
import { persistNodeInfo } from "./lightning/persist";
import { syncLndState } from "./lightning/sync";
import { getChannels, getPeers, getNodeInfo } from "./api/read";

initDb();
runMigrations();

persistNodeInfo().catch(err => {
  console.warn("[lnd] unable to persist node info:", err.message);
});

const server = http.createServer(async (req, res) => {
  // ✅ CORS HEADERS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  
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
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/node") {
    try {
      const data = getNodeInfo();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data ?? {}));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "failed_to_fetch_node" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/peers") {
    try {
      const data = getPeers();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "failed_to_fetch_peers" }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/channels") {
    try {
      const data = getChannels();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "failed_to_fetch_channels" }));
    }
    return;
  }

  // ✅ 404 MUST BE LAST
  res.writeHead(404);
  res.end();
});


server.listen(PORTS.userApi, () => {
  console.log(`[api] listening on port ${PORTS.userApi}`);
});
