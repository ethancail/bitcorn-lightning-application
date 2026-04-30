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
  };