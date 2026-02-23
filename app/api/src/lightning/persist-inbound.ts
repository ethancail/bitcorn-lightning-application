import { db } from "../db";
import { getLndInvoices, isLndAvailable } from "./lnd";

export async function syncInboundPayments(): Promise<void> {
  if (!isLndAvailable()) return;

  const { invoices } = await getLndInvoices();

  // Filter for confirmed invoices only
  const confirmedInvoices = invoices.filter(
    invoice => invoice.is_confirmed === true && invoice.received && invoice.confirmed_at
  );

  for (const invoice of confirmedInvoices) {
    // Convert confirmed_at timestamp to milliseconds if it's a string
    const settledAt = invoice.confirmed_at
      ? new Date(invoice.confirmed_at).getTime()
      : Date.now();

    try {
      db.prepare(`
        INSERT OR IGNORE INTO payments_inbound
        (payment_hash, tokens, settled_at)
        VALUES (?, ?, ?)
      `).run(
        invoice.id,
        invoice.received ?? 0,
        settledAt
      );
    } catch (err) {
      // Ignore duplicate errors (handled by UNIQUE constraint)
      // Log other errors for debugging
      console.error(`[inbound] Failed to insert payment ${invoice.id}:`, err);
    }
  }
}
