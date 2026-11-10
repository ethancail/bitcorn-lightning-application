-- Migration 074: member_transfer_settings — the member's automatic-transfer
-- settings, one row per node (drive-mode P3, spec §3.1; plan item 1).
--
-- Single row, id = 1 (the 027 pattern), but NOT seeded: a missing row, like a
-- NULL column (075–079), means "use the code default"
-- (transfers/transferSettings.ts TRANSFER_DEFAULTS). Only values the member
-- saves are stored, so unratified defaults are never frozen into a node.
--
-- No "enabled" column: that is P4's. Nothing reads this table to move money.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header). Each column
-- the settings need is its own migration, 075–079.

CREATE TABLE IF NOT EXISTS member_transfer_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at INTEGER NOT NULL DEFAULT 0
);
