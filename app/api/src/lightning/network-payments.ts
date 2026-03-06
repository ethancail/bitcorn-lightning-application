import { db } from "../db";
import { decodePaymentRequest } from "ln-service";
import { createLndInvoice } from "./lnd";
import { payInvoice } from "./pay";
import { insertOutboundPayment } from "./persist-payments";
import { assertRateLimit } from "../utils/rate-limit";

// ─── Exchange rate ───────────────────────────────────────────────────────────

export async function getBtcExchangeRate(): Promise<{ usd: number; source: string }> {
  const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  if (!res.ok) throw new Error(`Coinbase API error: ${res.status}`);
  const data = (await res.json()) as { data: { amount: string } };
  return { usd: parseFloat(data.data.amount), source: "coinbase" };
}

function satsToUsd(sats: number, rateUsd: number): number {
  return Math.round(((sats / 100_000_000) * rateUsd) * 100) / 100;
}

async function fetchRateSafe(): Promise<{ usd: number } | null> {
  try {
    return await getBtcExchangeRate();
  } catch {
    return null;
  }
}

// ─── Invoice creation (Request Payment) ──────────────────────────────────────

export interface InvoiceResult {
  payment_hash: string;
  payment_request: string;
  amount_sats: number;
  amount_usd: number | null;
  exchange_rate_usd: number | null;
}

export async function createPaymentInvoice(
  amountSats: number,
  memo?: string
): Promise<InvoiceResult> {
  if (amountSats <= 0) throw new Error("Amount must be positive");

  const invoice = await createLndInvoice(amountSats, memo);
  const rate = await fetchRateSafe();

  const exchangeRate = rate?.usd ?? null;
  const amountUsd = exchangeRate ? satsToUsd(amountSats, exchangeRate) : null;

  db.prepare(`
    INSERT INTO network_payments
    (payment_hash, direction, status, amount_sats, exchange_rate_usd, amount_usd, memo, payment_request, created_at)
    VALUES (?, 'receive', 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    invoice.id,
    amountSats,
    exchangeRate,
    amountUsd,
    memo ?? null,
    invoice.request,
    Date.now()
  );

  return {
    payment_hash: invoice.id,
    payment_request: invoice.request,
    amount_sats: amountSats,
    amount_usd: amountUsd,
    exchange_rate_usd: exchangeRate,
  };
}

// ─── Invoice decoding (preview before pay) ───────────────────────────────────

export interface DecodedInvoice {
  id: string;
  destination: string;
  tokens: number;
  description: string | null;
  expires_at: string | null;
}

export function decodeInvoice(paymentRequest: string): DecodedInvoice {
  const decoded = decodePaymentRequest({ request: paymentRequest });
  return {
    id: decoded.id,
    destination: decoded.destination,
    tokens: decoded.tokens,
    description: decoded.description ?? null,
    expires_at: decoded.expires_at ?? null,
  };
}

// ─── Pay invoice (Pay Invoice flow) ──────────────────────────────────────────

export interface PaymentResult {
  ok: boolean;
  payment_hash: string;
  amount_sats: number;
  fee_sats: number;
  amount_usd: number | null;
  destination: string;
  memo: string | null;
  error?: string;
}

export async function payNetworkInvoice(
  paymentRequest: string
): Promise<PaymentResult> {
  const decoded = decodePaymentRequest({ request: paymentRequest });
  const { id: paymentHash, destination, tokens, description } = decoded;

  assertRateLimit(tokens);

  const rate = await fetchRateSafe();
  const exchangeRate = rate?.usd ?? null;
  const amountUsd = exchangeRate ? satsToUsd(tokens, exchangeRate) : null;

  // Record pending payment
  db.prepare(`
    INSERT INTO network_payments
    (payment_hash, direction, status, amount_sats, exchange_rate_usd, amount_usd, memo, counterparty_pubkey, payment_request, created_at)
    VALUES (?, 'send', 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    paymentHash,
    tokens,
    exchangeRate,
    amountUsd,
    description ?? null,
    destination,
    paymentRequest,
    Date.now()
  );

  try {
    const result = await payInvoice(paymentRequest);

    // Update to succeeded
    db.prepare(`
      UPDATE network_payments
      SET status = 'succeeded', fee_sats = ?, settled_at = ?
      WHERE payment_hash = ? AND direction = 'send'
    `).run(result.fee, Date.now(), paymentHash);

    // Also record in payments_outbound for compatibility
    insertOutboundPayment({
      payment_hash: result.id,
      payment_request: paymentRequest,
      destination,
      tokens: result.tokens,
      fee: result.fee,
      status: "succeeded",
    });

    return {
      ok: true,
      payment_hash: result.id,
      amount_sats: result.tokens,
      fee_sats: result.fee,
      amount_usd: amountUsd,
      destination,
      memo: description ?? null,
    };
  } catch (err: any) {
    // Update to failed
    db.prepare(`
      UPDATE network_payments
      SET status = 'failed'
      WHERE payment_hash = ? AND direction = 'send'
    `).run(paymentHash);

    // Also record failed in payments_outbound
    insertOutboundPayment({
      payment_hash: paymentHash,
      payment_request: paymentRequest,
      destination,
      tokens,
      fee: 0,
      status: "failed",
    });

    return {
      ok: false,
      payment_hash: paymentHash,
      amount_sats: tokens,
      fee_sats: 0,
      amount_usd: amountUsd,
      destination,
      memo: description ?? null,
      error: err.message || String(err),
    };
  }
}

// ─── Payment history ─────────────────────────────────────────────────────────

export interface NetworkPayment {
  id: number;
  payment_hash: string;
  direction: "send" | "receive";
  status: "pending" | "succeeded" | "failed" | "expired";
  amount_sats: number;
  fee_sats: number;
  exchange_rate_usd: number | null;
  amount_usd: number | null;
  memo: string | null;
  counterparty_pubkey: string | null;
  payment_request: string | null;
  created_at: number;
  settled_at: number | null;
}

export function getNetworkPayments(options?: {
  direction?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): NetworkPayment[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (options?.direction) {
    conditions.push("direction = ?");
    params.push(options.direction);
  }
  if (options?.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  return db.prepare(`
    SELECT * FROM network_payments
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as NetworkPayment[];
}

// ─── Settlement sync ─────────────────────────────────────────────────────────

export function syncNetworkInvoiceSettlements(): { updated: number } {
  // Find pending receive payments whose payment_hash now appears in payments_inbound
  const pending = db.prepare(`
    SELECT np.id, np.payment_hash
    FROM network_payments np
    WHERE np.direction = 'receive' AND np.status = 'pending'
  `).all() as Array<{ id: number; payment_hash: string }>;

  let updated = 0;
  const now = Date.now();

  for (const p of pending) {
    const settled = db.prepare(`
      SELECT settled_at FROM payments_inbound WHERE payment_hash = ?
    `).get(p.payment_hash) as { settled_at: number } | undefined;

    if (settled) {
      db.prepare(`
        UPDATE network_payments SET status = 'succeeded', settled_at = ? WHERE id = ?
      `).run(settled.settled_at || now, p.id);
      updated++;
    }
  }

  return { updated };
}
