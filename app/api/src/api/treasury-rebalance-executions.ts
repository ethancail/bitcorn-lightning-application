import { db } from "../db";

export type RebalanceExecutionStatus =
  | "requested"
  | "submitted"
  | "succeeded"
  | "failed";

export type RebalanceExecution = {
  id: number;
  type: string;
  tokens: number;
  outgoing_channel: string;
  incoming_channel: string;
  max_fee_sats: number;
  status: RebalanceExecutionStatus;
  payment_hash: string | null;
  fee_paid_sats: number | null;
  error: string | null;
  created_at: number;
};

export function createRebalanceExecution(params: {
  type: string;
  tokens: number;
  outgoing_channel: string;
  incoming_channel: string;
  max_fee_sats: number;
}): number {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO treasury_rebalance_executions
       (type, tokens, outgoing_channel, incoming_channel, max_fee_sats, status, payment_hash, fee_paid_sats, error, created_at)
       VALUES (?, ?, ?, ?, ?, 'requested', NULL, NULL, NULL, ?)`
    )
    .run(
      params.type,
      params.tokens,
      params.outgoing_channel,
      params.incoming_channel,
      params.max_fee_sats,
      now
    );
  return Number(result.lastInsertRowid);
}

export function updateRebalanceExecution(
  id: number,
  status: RebalanceExecutionStatus,
  paymentHash?: string | null,
  feePaidSats?: number | null,
  error?: string | null
): void {
  db.prepare(
    `UPDATE treasury_rebalance_executions
     SET status = ?, payment_hash = ?, fee_paid_sats = ?, error = ?
     WHERE id = ?`
  ).run(
    status,
    paymentHash ?? null,
    feePaidSats ?? null,
    error ?? null,
    id
  );
}

export function getRebalanceExecutions(limit: number = 50): RebalanceExecution[] {
  return db
    .prepare(
      `SELECT id, type, tokens, outgoing_channel, incoming_channel, max_fee_sats,
              status, payment_hash, fee_paid_sats, error, created_at
       FROM treasury_rebalance_executions
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as RebalanceExecution[];
}
