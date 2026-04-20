-- 033_valuation_manual_inputs.sql — local audit cache for the 8 manually-entered
-- Glassnode-sourced valuation metrics. Full history lives on the Cloudflare
-- Worker's KV (key: valuation_manual_v1); this table exists to power the
-- "last entered at <when>, value: <x>" display in the /valuation-input UI
-- and to drive the staleness alert (VALUATION_MANUAL_STALE). One row per
-- (metric, submission) — every daily submission inserts 8 rows atomically.
--
-- Numbered 033 because slots 028–032 are already taken on main/develop by
-- unrelated migrations (advisor_min_channel_capacity, swap_subsystem, etc.).

CREATE TABLE IF NOT EXISTS valuation_manual_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_key TEXT NOT NULL,                    -- mvrv | puell | sopr | reserve_risk | nvt | hash_ribbons | difficulty_ribbon | hodl_waves
  value REAL NOT NULL,
  submitted_at INTEGER NOT NULL,               -- unix seconds (sourced from the submission's submitted_at)
  created_at INTEGER NOT NULL,                 -- unix seconds; when this row was inserted locally
  worker_sync_status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | failed
  worker_sync_error TEXT,                      -- populated when worker_sync_status = 'failed'
  worker_sync_at INTEGER                       -- unix seconds; when the Worker confirmed receipt (204)
);

CREATE INDEX IF NOT EXISTS idx_valuation_manual_inputs_metric_key
  ON valuation_manual_inputs (metric_key, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_valuation_manual_inputs_sync_status
  ON valuation_manual_inputs (worker_sync_status);
