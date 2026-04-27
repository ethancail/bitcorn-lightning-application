// Port configuration
// 3109 is reserved for any future authenticated, signed, replay-protected
// node-to-node coordination API. Currently unimplemented and not bound —
// under the member-driven role-based rebalancing model, no steady-state
// flow uses 3109. Never expose via Umbrel app-proxy.
export const PORTS = {
    userApi: 3101,
    nodeApi: 3109, // reserved, never bound, never proxied
  };