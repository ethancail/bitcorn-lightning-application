// API server entry point
// TODO: Initialize Express/Fastify server and configure routes
import http from "http";
import { ENV } from "./config/env";
import { PORTS } from "./config/ports";

const server = http.createServer((req, res) => {
  // Dev-only CORS (removed when Umbrel proxy is enabled)
  if (ENV.isDev) {
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:3200");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORTS.userApi, () => {
  console.log(`[api] listening on port ${PORTS.userApi}`);
});
