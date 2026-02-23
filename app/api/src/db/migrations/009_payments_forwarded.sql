CREATE TABLE IF NOT EXISTS payments_forwarded (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incoming_channel TEXT NOT NULL,
  outgoing_channel TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(incoming_channel, outgoing_channel, created_at)
);

CREATE INDEX IF NOT EXISTS idx_forwarded_created ON payments_forwarded(created_at);
CREATE INDEX IF NOT EXISTS idx_forwarded_incoming ON payments_forwarded(incoming_channel);
CREATE INDEX IF NOT EXISTS idx_forwarded_outgoing ON payments_forwarded(outgoing_channel);
