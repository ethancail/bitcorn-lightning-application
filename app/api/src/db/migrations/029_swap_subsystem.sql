-- Migration 029: Loop-based swap subsystem
-- Four tables: swap_requests, swap_executions, swap_events, liquidity_actions

CREATE TABLE IF NOT EXISTS swap_requests (
  id                   TEXT PRIMARY KEY,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  node_pubkey          TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK(role IN ('member', 'treasury')),
  swap_type            TEXT NOT NULL CHECK(swap_type IN ('loop_in', 'loop_out')),
  direction            TEXT NOT NULL CHECK(direction IN ('lightning_to_chain', 'chain_to_lightning')),
  status               TEXT NOT NULL,
  amount_sat           INTEGER NOT NULL,
  max_fee_sat          INTEGER,
  quoted_fee_sat       INTEGER,
  actual_fee_sat       INTEGER,
  destination_address  TEXT,
  channel_id           TEXT,
  quote_expires_at     INTEGER,
  failure_reason       TEXT,
  notes                TEXT
);

CREATE INDEX IF NOT EXISTS idx_swap_requests_pubkey ON swap_requests(node_pubkey);
CREATE INDEX IF NOT EXISTS idx_swap_requests_status ON swap_requests(status);
CREATE INDEX IF NOT EXISTS idx_swap_requests_created ON swap_requests(created_at DESC);

CREATE TABLE IF NOT EXISTS swap_executions (
  id                     TEXT PRIMARY KEY,
  swap_request_id        TEXT NOT NULL,
  provider               TEXT NOT NULL,
  provider_swap_id       TEXT,
  invoice                TEXT,
  prepay_invoice         TEXT,
  payment_hash           TEXT,
  prepay_payment_hash    TEXT,
  htlc_address           TEXT,
  onchain_txid           TEXT,
  sweep_txid             TEXT,
  timeout_block_height   INTEGER,
  status                 TEXT NOT NULL,
  raw_provider_status    TEXT,
  started_at             INTEGER NOT NULL,
  completed_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_swap_exec_request ON swap_executions(swap_request_id);
CREATE INDEX IF NOT EXISTS idx_swap_exec_provider_id ON swap_executions(provider_swap_id);
CREATE INDEX IF NOT EXISTS idx_swap_exec_status ON swap_executions(status);

CREATE TABLE IF NOT EXISTS swap_events (
  id                   TEXT PRIMARY KEY,
  swap_request_id      TEXT NOT NULL,
  swap_execution_id    TEXT,
  event_type           TEXT NOT NULL,
  event_json           TEXT NOT NULL,
  created_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_swap_events_request ON swap_events(swap_request_id);
CREATE INDEX IF NOT EXISTS idx_swap_events_created ON swap_events(created_at DESC);

CREATE TABLE IF NOT EXISTS liquidity_actions (
  id                       TEXT PRIMARY KEY,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  node_pubkey              TEXT NOT NULL,
  channel_id               TEXT,
  actor_role               TEXT NOT NULL CHECK(actor_role IN ('member', 'treasury')),
  action_type              TEXT NOT NULL CHECK(action_type IN (
    'loop_in', 'loop_out', 'rebalance', 'open_channel', 'wait', 'manual_review'
  )),
  reason_code              TEXT NOT NULL,
  recommended_amount_sat   INTEGER,
  priority                 TEXT NOT NULL CHECK(priority IN ('low', 'medium', 'high', 'critical')),
  status                   TEXT NOT NULL CHECK(status IN (
    'recommended', 'approved', 'rejected', 'executing', 'completed', 'failed'
  )),
  approved_by              TEXT,
  linked_swap_request_id   TEXT,
  expires_at               INTEGER
);

CREATE INDEX IF NOT EXISTS idx_liq_actions_pubkey ON liquidity_actions(node_pubkey);
CREATE INDEX IF NOT EXISTS idx_liq_actions_status ON liquidity_actions(status);
CREATE INDEX IF NOT EXISTS idx_liq_actions_swap ON liquidity_actions(linked_swap_request_id);
