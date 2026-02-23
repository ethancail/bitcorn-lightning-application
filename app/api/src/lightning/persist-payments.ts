import { db } from "../db";

export interface OutboundPayment {
  payment_hash: string;
  payment_request: string;
  destination?: string | null;
  tokens: number;
  fee: number;
  status: "succeeded" | "failed";
}

export function insertOutboundPayment(payment: OutboundPayment) {
  const now = Date.now();

  db.prepare(`
    INSERT INTO payments_outbound
    (payment_hash, payment_request, destination, tokens, fee, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    payment.payment_hash,
    payment.payment_request,
    payment.destination ?? null,
    payment.tokens,
    payment.fee,
    payment.status,
    now
  );
}
