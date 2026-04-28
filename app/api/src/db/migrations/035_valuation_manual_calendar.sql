-- 035_valuation_manual_calendar.sql — adds entry_date + uniqueness for the
-- calendar-input feature. Without this, the API has to scan submitted_at to
-- find "the most recent entry for date D" which is O(N) per metric.
--
-- entry_date is the canonical "what date does this value represent" column;
-- submitted_at remains "when did the operator type it in" for audit. For
-- legacy rows (before this migration), entry_date is backfilled from the
-- UTC date of submitted_at — accurate for any row submitted same-day.

ALTER TABLE valuation_manual_inputs
  ADD COLUMN entry_date TEXT;

UPDATE valuation_manual_inputs
  SET entry_date = strftime('%Y-%m-%d', submitted_at, 'unixepoch')
  WHERE entry_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_valuation_manual_inputs_entry_date
  ON valuation_manual_inputs (entry_date);

CREATE INDEX IF NOT EXISTS idx_valuation_manual_inputs_metric_date
  ON valuation_manual_inputs (metric_key, entry_date);
