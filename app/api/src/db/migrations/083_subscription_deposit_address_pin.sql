-- Migration 083: the member's pinned subscription deposit address.
--
-- Source of truth: bitcorn-research specs/2026-11-10-treasury-price-trust-
-- spec.md §6 (decision D4: "pinning is what holds against a compromised
-- treasury"). Member-side: a member node pins the deposit address its
-- treasury states on the first VERIFIED status, and refuses to pay any other
-- address until the change is acknowledged on the node itself (a host-run
-- command, never an HTTP route — spec §6.4).
--
-- APPEND-ONLY. The current pin is the newest row (highest id) for the member.
-- Rows are never updated or deleted, so the history of which address was
-- pinned, when and how, survives.
--
-- source:
--   first_sight  — the first verified, applicable status, no local history
--   marker_seed  — the newest subscription_send_marker row's address (the
--                  address this node last paid), seeded at first sight
--   acknowledged — appended by the host command after a verified status
--                  stated exactly that address
--
-- Timestamps are epoch SECONDS, as subscription_send_marker.

CREATE TABLE IF NOT EXISTS subscription_deposit_address_pin (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_pubkey   TEXT    NOT NULL,
  deposit_address TEXT    NOT NULL,
  source          TEXT    NOT NULL CHECK (source IN ('first_sight','marker_seed','acknowledged')),
  pinned_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_deposit_address_pin_member
  ON subscription_deposit_address_pin(member_pubkey, id);
