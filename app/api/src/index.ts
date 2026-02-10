// API server entry point
// TODO: Initialize Express/Fastify server and configure routes
import http from "http";

const PORT = 3101;

const server = http.createServer((req, res) => {
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
