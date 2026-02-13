import http from "http";
import { PORTS } from "./config/ports";
import { initDb, db } from "./db";
import { runMigrations } from "./db/migrate";
import { persistNodeInfo } from "./lightning/persist";
import { syncLndState } from "./lightning/sync";
import { payInvoice } from "./lightning/pay";
import { assertActiveMember } from "./utils/membership";
import { assertRateLimit } from "./utils/rate-limit";
import { insertOutboundPayment } from "./lightning/persist-payments";
import { decodePaymentRequest } from "ln-service";
import { getChannels, getPeers, getNodeInfo } from "./api/read";
import { getTreasuryMetrics } from "./api/treasury";

initDb();
runMigrations();

persistNodeInfo().catch(err => {
  console.warn("[lnd] unable to persist node info:", err.message);
});

(async () => {
  try {
    await syncLndState();
    console.log("[lnd] initial sync complete");
  } catch (err: any) {
    console.warn("[lnd] initial sync failed:", err.message);
  }

  setInterval(() => {
    syncLndState().catch(err =>
      console.warn("[lnd] periodic sync failed:", err.message)
    );
  }, 15000);
})();

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

  if (req.method === "GET" && req.url === "/api/treasury/metrics") {
    try {
      const data = getTreasuryMetrics();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "failed_to_fetch_metrics" }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/pay") {
    try {
      let body = "";

      req.on("data", chunk => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const { payment_request } = JSON.parse(body);

          if (!payment_request) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "missing_payment_request" }));
            return;
          }

          const node = getNodeInfo();
          if (!node) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: "node_info_unavailable" }));
            return;
          }

          // Decode payment request first (needed for rate limiting and logging)
          let decodedRequest: { id: string; destination: string; tokens: number } | null = null;
          try {
            decodedRequest = decodePaymentRequest({ request: payment_request });
          } catch (decodeErr) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_payment_request" }));
            return;
          }

          if (!decodedRequest) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "failed_to_decode_payment_request" }));
            return;
          }

          try {
            console.log("Node membership:", node?.membership_status);

            assertActiveMember(node.membership_status);
            assertRateLimit(decodedRequest.tokens);

            console.log("Membership passed");
            console.log("Rate limit passed");

            const result = await payInvoice(payment_request);

            console.log("Payment result:", result);

            // Persist successful payment
            insertOutboundPayment({
              payment_hash: result.id,
              payment_request,
              destination: decodedRequest.destination,
              tokens: result.tokens,
              fee: result.fee,
              status: "succeeded",
            });

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error("PAY ERROR:", err);

            // Persist failed payment (includes rate-limited payments)
            insertOutboundPayment({
              payment_hash: decodedRequest.id,
              payment_request,
              destination: decodedRequest.destination,
              tokens: decodedRequest.tokens,
              fee: 0,
              status: "failed",
            });

            // Check if it's a rate limit error (429) or other error (403)
            const isRateLimitError = String(err).includes("Rate limit exceeded");
            const statusCode = isRateLimitError ? 429 : 403;
            
            res.writeHead(statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          }
        } catch (err: any) {
          console.error("PAY ERROR (outer):", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err?.message ?? "payment_failed" }));
        }
      });
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "payment_failed" }));
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
