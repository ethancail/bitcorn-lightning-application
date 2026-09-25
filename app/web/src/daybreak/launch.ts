// Whether the member nav shows the Daybreak entry. A build-time constant: it
// changes only with a release.
//
// ⚠ HIDDEN UNTIL LAUNCH. Merging to develop means the next release ships the
// screen to every member, and nothing can be published yet — so the entry is
// hidden while the /daybreak route stays registered and reachable directly.
// This is App.tsx's existing "hide the entry, keep the door" pattern (the
// Stablecoin entry in MemberSidebar's navItems, and its route comment in the
// member-shell Routes). Like that one, it is COSMETIC: it hides a link and
// gates nothing.
//
// ⚠ FLIP TO `true` ONLY WHEN ALL THREE HOLD:
//   1. the Worker is deployed with the Daybreak read route (GET /daybreak/edition)
//      and band stamping;
//   2. the power-law parameters (KV `daybreak_powerlaw_params_v1`) AND the bands
//      (KV `daybreak_powerlaw_bands_v1`) are seeded in production;
//   3. Kevin is able to publish an edition.
// Until then a member following the link would find "No edition yet".
export const SHOW_DAYBREAK_IN_MEMBER_NAV = false;
