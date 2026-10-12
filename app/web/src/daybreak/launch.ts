// Whether the member nav shows the Daybreak entry. A build-time constant: it
// changes only with a release.
//
// The entry was HIDDEN UNTIL LAUNCH, while the /daybreak route stayed
// registered and reachable directly — App.tsx's existing "hide the entry, keep
// the door" pattern (the Stablecoin entry in MemberSidebar's navItems, and its
// route comment in the member-shell Routes). Like that one, it is COSMETIC: it
// shows or hides a link and gates nothing.
//
// The launch conditions were:
//   1. the Worker is deployed with the Daybreak read route (GET /daybreak/edition)
//      and band stamping;
//   2. the power-law parameters (KV `daybreak_powerlaw_params_v1`) AND the bands
//      (KV `daybreak_powerlaw_bands_v1`) are seeded in production;
//   3. Kevin is able to publish an edition.
// LAUNCHED 2026-10-12: all three are met — the Worker is deployed with the read
// route and band stamping, both KV keys are seeded, and Kevin can publish. The
// flag now stays on.
export const SHOW_DAYBREAK_IN_MEMBER_NAV = true;
