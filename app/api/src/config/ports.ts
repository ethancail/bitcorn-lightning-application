import { isIP } from "net";

// API_LISTEN_HOST (dev-safety R2): the address the user API binds. Unset, no
// host is passed to listen(), today's bind; production sets no such variable,
// since cloudflared reaches the API over the Docker network. Set, it must be an
// IP address. Empty or anything else throws here, at boot, before anything
// listens: listen(port, "") would bind every interface, and a hostname that
// fails to resolve would surface as an unhandled 'error' on the server.
// The dev harness injects 127.0.0.1 for every slot (scripts/harness-slot.mjs).
export function resolveListenHost(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === "") throw new Error("API_LISTEN_HOST is set but empty; unset it for the default bind, or give an IP address");
  if (isIP(raw) === 0) throw new Error(`API_LISTEN_HOST must be an IP address (net.isIP), got ${JSON.stringify(raw)}`);
  return raw;
}

// Port configuration
// 3109 is reserved for any future authenticated, signed, replay-protected
// node-to-node coordination API. Currently unimplemented and not bound —
// under the member-driven role-based rebalancing model, no steady-state
// flow uses 3109. Never expose via Umbrel app-proxy.
export const PORTS = {
    // PORT env var lets local-dev instances bind 3102/3103 etc. without
    // colliding. Production on Umbrel doesn't set PORT and falls back to 3101.
    userApi: Number(process.env.PORT ?? "3101"),
    nodeApi: 3109, // reserved, never bound, never proxied
    listenHost: resolveListenHost(process.env.API_LISTEN_HOST),
  };
