// API server entry point
// TODO: Initialize Express/Fastify server and configure routes
import http from "http";
import { PORTS } from "./config/ports";

const server = http.createServer((req, res) => {
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