// CORS: `Authorization` is deliberately absent from Allow-Headers below, and
// the gate's rejection responses (lib/jwt.ts) carry no CORS headers at all.
//
// Examined 2026-08-11 and left as-is, because neither is reachable. Every
// caller of this Worker runs server-side — the load-bearing property, and
// the only one the conclusion rests on. The set: the member node's API
// process (via `workerFetch`, plus direct-fetch sites that bypass it), CLI
// smoke tests, and repo tooling (scripts/state-snapshot.mjs reads
// /treasury-info on a full run). Those bypasses are neither uniformly
// documented nor all bootstrap — some sanctioned, like a bootstrap
// discovery that would be circular through the wrapper; some undocumented,
// on live request paths. Nothing in the web bundle holds this Worker's
// URL — no VITE_* var carries it — so no browser ever preflights here,
// and CORS headers only matter to a browser. Which sites, under which
// predicate, is answered by method rather than by a number in
// bitcorn-research/investigations/2026-08-12-worker-direct-fetch-
// predicates-and-cors-adjudication.md.
//
// THIS CHANGES the day anything calls this Worker from a browser. The named
// route to that today is hosted wallet registration on an HTTPS origin (a
// parked decision — bitcorn-research BACKLOG.md §1). If you are implementing
// that, you are crossing a line someone already examined: a request carrying
// `Authorization` is never a simple request, so the preflight must list it or
// the real request is never sent — and a 401 arriving without
// Access-Control-Allow-Origin is unreadable to the caller.
//
// The fix at that point: add "Authorization" here, and spread CORS_HEADERS
// into the rejection construction in lib/jwt.ts and the 404 catch-all in
// index.ts. Note that nothing would catch a regression afterward — no test
// asserts headers on a 401/403/404/503; today's assertions are status-and-body
// only.
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "X-Price-Source",
} as const;
