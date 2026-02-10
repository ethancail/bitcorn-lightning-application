// API server entry point
// TODO: Initialize Express/Fastify server and configure routes
import http from "http";

const PORT = 3101;

const server = http.createServer((req, res) => {
  // --- Minimal CORS (Week 1 only) ---
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:3200");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  // ---------------------------------

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[api] listening on port ${PORT}`);
});
