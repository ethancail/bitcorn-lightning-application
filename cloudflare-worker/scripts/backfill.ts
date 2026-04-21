// One-off backfill script — called on first deploy to seed KV with historical
// valuation data before the daily cron takes over.
//
// Usage (after `wrangler deploy` has shipped the Worker code):
//
//   # Start a local dev instance with production KV bindings wired through:
//   npx wrangler dev --test-scheduled --remote
//
//   # In another terminal, trigger the scheduled handler manually:
//   curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
//
// The scheduled handler is the same code that runs daily on cron; running it
// manually once is sufficient to populate the three KV keys:
//   - valuation_current_v1
//   - valuation_history_v1
//   - valuation_inputs_v1
//
// Verify with:
//   curl https://bitcorn-onramp.<you>.workers.dev/valuation/current
//
// This file exists as living documentation; it is not imported by any code.

export {};
