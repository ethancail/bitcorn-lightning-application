import { useEffect, useState, useCallback, useRef } from "react";
// QR code generation disabled — payments should route through the BitCorn app, not external wallets
// import QRCode from "qrcode";
import {
  api,
  type NetworkPayment,
  type InvoiceResult,
  type DecodedInvoice,
  type PaymentResult,
  type Contact,
  resolveContactName,
  fmtSats,
} from "../api/client";

type Tab = "request" | "pay";

/** Copy text to clipboard with HTTP fallback (navigator.clipboard requires HTTPS). */
function copyToClipboard(text: string): void {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

export default function Payments({ title }: { title: string }) {
  const [tab, setTab] = useState<Tab>("request");
  const [payments, setPayments] = useState<NetworkPayment[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [rate, setRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPayment, setSelectedPayment] = useState<NetworkPayment | null>(null);

  const loadPayments = useCallback(async () => {
    try {
      const data = await api.getNetworkPayments({ limit: 50 });
      setPayments(data);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    Promise.all([
      api.getContacts().then(setContacts).catch(() => {}),
      api.getExchangeRate().then((r) => setRate(r.usd)).catch(() => {}),
      api.syncSettlements().catch(() => {}),
      loadPayments(),
    ]).finally(() => setLoading(false));

    const rateInterval = setInterval(() => {
      api.getExchangeRate().then((r) => setRate(r.usd)).catch(() => {});
    }, 60_000);
    return () => clearInterval(rateInterval);
  }, [loadPayments]);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>{title}</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Request and send Lightning payments
        </p>
      </div>

      {selectedPayment ? (
        <div className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-body">
            <PaymentDetail
              payment={selectedPayment}
              contacts={contacts}
              rate={rate}
              onClose={() => setSelectedPayment(null)}
              onDeleted={() => { setSelectedPayment(null); loadPayments(); }}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="payment-tabs">
            <button
              className={`payment-tab ${tab === "request" ? "active" : ""}`}
              onClick={() => setTab("request")}
            >
              Request Payment
            </button>
            <button
              className={`payment-tab ${tab === "pay" ? "active" : ""}`}
              onClick={() => setTab("pay")}
            >
              Pay Invoice
            </button>
          </div>

          <div className="panel" style={{ marginBottom: 24 }}>
            <div className="panel-body">
              {tab === "request" ? (
                <RequestPaymentForm rate={rate} onCreated={loadPayments} />
              ) : (
                <PayInvoiceForm rate={rate} contacts={contacts} onPaid={loadPayments} />
              )}
            </div>
          </div>
        </>
      )}

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">Payment History</span>
        </div>
        <div className="panel-body" style={{ padding: 0 }}>
          {loading ? (
            <div className="loading-shimmer" style={{ height: 120 }} />
          ) : payments.length === 0 ? (
            <div className="empty-state" style={{ padding: "40px 20px" }}>
              No payments yet. Create an invoice or pay one to get started.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Direction</th>
                    <th>Status</th>
                    <th>Amount</th>
                    <th>Fee</th>
                    <th>Counterparty</th>
                    <th>Memo</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <PaymentRow
                      key={p.id}
                      payment={p}
                      contacts={contacts}
                      selected={selectedPayment?.id === p.id}
                      onSelect={() => setSelectedPayment(p)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Request Payment Form ────────────────────────────────────────────────────

function RequestPaymentForm({
  rate,
  onCreated,
}: {
  rate: number | null;
  onCreated: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [creating, setCreating] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceResult | null>(null);
  // const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Receive capacity from treasury channel
  const [channelLocal, setChannelLocal] = useState<number | null>(null);
  const [channelRemote, setChannelRemote] = useState<number | null>(null);
  const [channelCapacity, setChannelCapacity] = useState<number | null>(null);

  useEffect(() => {
    api.getMemberStats()
      .then((s) => {
        if (s.treasury_channel) {
          setChannelLocal(s.treasury_channel.local_sats);
          setChannelRemote(s.treasury_channel.remote_sats);
          setChannelCapacity(s.treasury_channel.capacity_sats);
        }
      })
      .catch(() => {});
  }, []);

  const sats = Number(amount) || 0;
  const usdPreview =
    rate && sats > 0
      ? `$${((sats / 100_000_000) * rate).toFixed(2)}`
      : null;

  // Channel state percentages
  const currentLocalPct =
    channelLocal != null && channelCapacity != null && channelCapacity > 0
      ? Math.round((channelLocal / channelCapacity) * 100)
      : null;
  const projectedLocalPct =
    channelLocal != null && channelCapacity != null && channelCapacity > 0 && sats > 0
      ? Math.min(100, Math.round(((channelLocal + sats) / channelCapacity) * 100))
      : null;

  // Two-tier capacity thresholds
  // Soft cap (85% of remote): routing fees + HTLC constraints may cause failures
  // Hard cap (100% of remote): physically impossible, payment will fail
  const softCap = channelRemote != null ? Math.floor(channelRemote * 0.85) : null;
  const hardCap = channelRemote;
  const maxInvoice = softCap; // display value for the "Max Invoice" card
  const isOverSoft = softCap != null && sats > softCap;
  const isOverHard = hardCap != null && sats > hardCap;

  const handleCreate = async () => {
    if (sats <= 0) return;
    setCreating(true);
    setError("");
    try {
      const result = await api.createNetworkInvoice({
        amount_sats: sats,
        memo: memo.trim() || undefined,
      });
      setInvoice(result);
      // QR code disabled — payments should route through the BitCorn app
      // const dataUrl = await QRCode.toDataURL(result.payment_request.toUpperCase(), {
      //   width: 280, margin: 2, color: { dark: "#000000", light: "#ffffff" },
      // });
      // setQrDataUrl(dataUrl);
      onCreated();
    } catch (err: any) {
      setError(err.message || "Failed to create invoice");
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = () => {
    if (!invoice) return;
    copyToClipboard(invoice.payment_request);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    setInvoice(null);
    // setQrDataUrl("");
    setAmount("");
    setMemo("");
    setCopied(false);
  };

  if (invoice) {
    return (
      <div className="invoice-display">
        <div style={{ textAlign: "center" }}>
          {/* QR code disabled — payments should route through the BitCorn app
          {qrDataUrl && (
            <img src={qrDataUrl} alt="Invoice QR code" className="invoice-qr" />
          )}
          */}
          <div style={{ margin: "16px 0 8px", fontSize: "1.25rem", fontWeight: 600 }}>
            {fmtSats(sats)}
            {invoice.amount_usd != null && (
              <span className="text-dim" style={{ fontSize: "0.875rem", marginLeft: 8 }}>
                (${invoice.amount_usd.toFixed(2)} USD)
              </span>
            )}
          </div>
          {memo && (
            <div className="text-dim" style={{ fontSize: "0.875rem", marginBottom: 12 }}>
              {memo}
            </div>
          )}
        </div>
        <div className="bolt11-text">{invoice.payment_request}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={handleCopy} style={{ flex: 1 }}>
            {copied ? "Copied!" : "Copy Invoice"}
          </button>
          <button className="btn btn-outline" onClick={handleReset}>
            New Invoice
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Channel state bar */}
      {currentLocalPct != null && (
        <div style={{
          background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8,
          padding: "10px 14px", marginBottom: 10,
        }}>
          <div style={{ fontSize: "0.625rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 4 }}>
            Current channel
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 8, background: "var(--bg)", borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
              <div style={{ width: `${Math.min(currentLocalPct, 100)}%`, height: "100%", background: "var(--amber)" }} />
            </div>
            <span style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-2)" }}>
              {currentLocalPct}% local
            </span>
          </div>
        </div>
      )}

      {/* Receive capacity card (green-tinted) */}
      {channelRemote != null && (
        <div style={{
          border: "1px solid color-mix(in srgb, var(--green) 30%, transparent)",
          background: "color-mix(in srgb, var(--green) 8%, var(--bg-2))",
          borderRadius: 8, padding: 10, marginBottom: 12,
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
        }}>
          <div>
            <div style={{ fontSize: "0.625rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)" }}>
              Receive capacity
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: "1.125rem", fontWeight: 600, color: "var(--green)", lineHeight: 1.2 }}>
              {channelRemote.toLocaleString()}
              <span style={{ fontSize: "0.75rem", color: "var(--text-3)", fontWeight: 400, marginLeft: 4 }}>sats</span>
            </div>
          </div>
          {maxInvoice != null && maxInvoice > 0 && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "0.625rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)" }}>
                Max invoice
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem", color: "var(--text-2)" }}>
                {maxInvoice.toLocaleString()} sats
              </div>
            </div>
          )}
        </div>
      )}

      {/* Zero receive capacity — empty state */}
      {channelRemote != null && channelRemote === 0 && (
        <div className="alert critical" style={{ marginBottom: 12 }}>
          No receive capacity. Your channel is fully on your side — Cash Out some Lightning balance to on-chain to restore inbound.
        </div>
      )}

      <label className="form-label">Amount</label>
      <div style={{ position: "relative", marginBottom: 6 }}>
        <input
          type="text"
          inputMode="numeric"
          className="form-input"
          placeholder="e.g. 10,000"
          value={sats > 0 ? sats.toLocaleString() : amount}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, "");
            setAmount(raw);
          }}
          style={{ paddingRight: usdPreview ? 90 : 42 }}
        />
        <span style={{
          position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
          fontSize: "0.75rem", color: "var(--text-3)", fontFamily: "var(--mono)", pointerEvents: "none",
          display: "flex", gap: 6, alignItems: "center",
        }}>
          {usdPreview && <span>{usdPreview}</span>}
          <span>sats</span>
        </span>
      </div>

      {/* Two-tier capacity warnings */}
      {isOverHard && (
        <div className="alert critical" style={{ marginBottom: 10, fontSize: "0.75rem" }}>
          Amount exceeds receive capacity ({hardCap?.toLocaleString()} sats). Payment cannot succeed.
        </div>
      )}
      {!isOverHard && isOverSoft && (
        <div className="alert warning" style={{ marginBottom: 10, fontSize: "0.75rem" }}>
          Amount is near receive capacity limit. Payment may fail due to routing fees or HTLC constraints. Consider requesting a smaller amount.
        </div>
      )}

      {/* Projected channel state */}
      {projectedLocalPct != null && !isOverHard && (
        <div style={{
          background: "var(--bg-2)", borderLeft: "2px solid var(--green)",
          padding: 8, fontSize: "0.65rem", color: "var(--text-2)", marginBottom: 12,
        }}>
          After receive: <strong style={{ color: "var(--green)" }}>
            {currentLocalPct}% → {projectedLocalPct}% local
          </strong>
        </div>
      )}

      <label className="form-label">Memo (optional)</label>
      <input
        type="text"
        className="form-input"
        placeholder="What's this payment for?"
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        maxLength={200}
        style={{ marginBottom: 16 }}
      />

      {error && (
        <div className="alert warning" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <button
        className="btn btn-primary"
        onClick={handleCreate}
        disabled={sats <= 0 || creating || isOverHard}
      >
        {creating ? "Creating..." : "Create Invoice"}
      </button>
    </div>
  );
}

// ─── Pay Invoice Form ────────────────────────────────────────────────────────

function PayInvoiceForm({
  rate,
  contacts,
  onPaid,
}: {
  rate: number | null;
  contacts: Contact[];
  onPaid: () => void;
}) {
  const [bolt11, setBolt11] = useState("");
  const [decoded, setDecoded] = useState<DecodedInvoice | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [error, setError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Send capacity from treasury channel (= member's local balance)
  const [channelLocal, setChannelLocal] = useState<number | null>(null);
  const [channelCapacity, setChannelCapacity] = useState<number | null>(null);

  useEffect(() => {
    api.getMemberStats()
      .then((s) => {
        if (s.treasury_channel) {
          setChannelLocal(s.treasury_channel.local_sats);
          setChannelCapacity(s.treasury_channel.capacity_sats);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const trimmed = bolt11.trim();
    if (!trimmed || trimmed.length < 20) {
      setDecoded(null);
      setError("");
      return;
    }
    setDecoding(true);
    setError("");

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const d = await api.decodeInvoice(trimmed);
        setDecoded(d);
      } catch (err: any) {
        setDecoded(null);
        setError(err.message || "Invalid invoice");
      } finally {
        setDecoding(false);
      }
    }, 300);
  }, [bolt11]);

  const handlePay = async () => {
    if (!decoded) return;
    setPaying(true);
    setError("");
    setResult(null);
    try {
      const res = await api.payNetworkInvoice(bolt11.trim());
      setResult(res);
      if (res.ok) onPaid();
    } catch (err: any) {
      setError(err.message || "Payment failed");
    } finally {
      setPaying(false);
    }
  };

  const handleReset = () => {
    setBolt11("");
    setDecoded(null);
    setResult(null);
    setError("");
  };

  if (result) {
    return (
      <div className={`payment-result ${result.ok ? "success" : "failed"}`}>
        <div style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: 8 }}>
          {result.ok ? "Payment Sent!" : "Payment Failed"}
        </div>
        {result.ok ? (
          <>
            <div>
              <strong>Amount:</strong> {fmtSats(result.amount_sats)}
              {result.amount_usd != null && (
                <span className="text-dim"> (${result.amount_usd.toFixed(2)})</span>
              )}
            </div>
            <div>
              <strong>Fee:</strong> {fmtSats(result.fee_sats)}
            </div>
            <div>
              <strong>To:</strong> {resolveContactName(result.destination, contacts)}
            </div>
            {result.memo && (
              <div>
                <strong>Memo:</strong> {result.memo}
              </div>
            )}
            <div className="text-dim" style={{ fontSize: "0.75rem", marginTop: 8, wordBreak: "break-all" }}>
              Hash: {result.payment_hash}
            </div>
          </>
        ) : (
          <div className="text-dim">{result.error}</div>
        )}
        <button className="btn btn-outline" onClick={handleReset} style={{ marginTop: 16 }}>
          {result.ok ? "New Payment" : "Try Again"}
        </button>
      </div>
    );
  }

  const usdPreview =
    rate && decoded && decoded.tokens
      ? `$${((decoded.tokens / 100_000_000) * rate).toFixed(2)}`
      : null;

  // Channel state percentages
  const currentLocalPct =
    channelLocal != null && channelCapacity != null && channelCapacity > 0
      ? Math.round((channelLocal / channelCapacity) * 100)
      : null;
  const decodedAmount = decoded?.tokens ?? 0;
  const projectedLocalPct =
    channelLocal != null && channelCapacity != null && channelCapacity > 0 && decodedAmount > 0
      ? Math.max(0, Math.round(((channelLocal - decodedAmount) / channelCapacity) * 100))
      : null;

  // Two-tier send capacity thresholds (mirrors Request Payment's receive check)
  // Soft cap (85% of local): routing fees + HTLC constraints may cause failures
  // Hard cap (100% of local): physically impossible, payment will fail
  const softCap = channelLocal != null ? Math.floor(channelLocal * 0.85) : null;
  const hardCap = channelLocal;
  const maxSendable = softCap;
  const isOverSoft = softCap != null && decodedAmount > softCap;
  const isOverHard = hardCap != null && decodedAmount > hardCap;

  return (
    <div>
      {/* Channel state bar */}
      {currentLocalPct != null && (
        <div style={{
          background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8,
          padding: "10px 14px", marginBottom: 10,
        }}>
          <div style={{ fontSize: "0.625rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 4 }}>
            Current channel
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 8, background: "var(--bg)", borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
              <div style={{ width: `${Math.min(currentLocalPct, 100)}%`, height: "100%", background: "var(--amber)" }} />
            </div>
            <span style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-2)" }}>
              {currentLocalPct}% local
            </span>
          </div>
        </div>
      )}

      {/* Send capacity card (amber-tinted) */}
      {channelLocal != null && (
        <div style={{
          border: "1px solid color-mix(in srgb, var(--amber) 30%, transparent)",
          background: "color-mix(in srgb, var(--amber) 8%, var(--bg-2))",
          borderRadius: 8, padding: 10, marginBottom: 12,
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
        }}>
          <div>
            <div style={{ fontSize: "0.625rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)" }}>
              Send capacity
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: "1.125rem", fontWeight: 600, color: "var(--amber)", lineHeight: 1.2 }}>
              {channelLocal.toLocaleString()}
              <span style={{ fontSize: "0.75rem", color: "var(--text-3)", fontWeight: 400, marginLeft: 4 }}>sats</span>
            </div>
          </div>
          {maxSendable != null && maxSendable > 0 && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "0.625rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)" }}>
                Max send
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem", color: "var(--text-2)" }}>
                {maxSendable.toLocaleString()} sats
              </div>
            </div>
          )}
        </div>
      )}

      {/* Zero send capacity — empty state */}
      {channelLocal != null && channelLocal === 0 && (
        <div className="alert critical" style={{ marginBottom: 12 }}>
          No send capacity. Your channel is fully on the treasury's side — Refill your channel to restore outbound.
        </div>
      )}

      <label className="form-label">Paste BOLT11 Invoice</label>
      <textarea
        className="form-input"
        rows={4}
        placeholder="lnbc..."
        value={bolt11}
        onChange={(e) => setBolt11(e.target.value)}
        style={{ fontFamily: "var(--mono)", fontSize: "0.8rem", resize: "vertical", marginBottom: 12 }}
      />

      {decoding && <div className="text-dim" style={{ marginBottom: 12 }}>Decoding...</div>}

      {decoded && (
        <div className="payment-preview">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span>Amount</span>
            <span style={{ fontWeight: 600 }}>
              {fmtSats(decoded.tokens)}
              {usdPreview && <span className="text-dim" style={{ marginLeft: 6 }}>{usdPreview}</span>}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span>To</span>
            <span className="td-mono" style={{ fontSize: "0.8rem" }}>
              {resolveContactName(decoded.destination, contacts)}
            </span>
          </div>
          {decoded.description && (
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span>Memo</span>
              <span>{decoded.description}</span>
            </div>
          )}
          {decoded.expires_at && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Expires</span>
              <span className="text-dim">{new Date(decoded.expires_at).toLocaleString()}</span>
            </div>
          )}
        </div>
      )}

      {/* Two-tier capacity warnings (after decode) */}
      {decoded && isOverHard && (
        <div className="alert critical" style={{ marginBottom: 10, fontSize: "0.75rem" }}>
          Amount exceeds send capacity ({hardCap?.toLocaleString()} sats). Payment cannot succeed — Refill your channel first.
        </div>
      )}
      {decoded && !isOverHard && isOverSoft && (
        <div className="alert warning" style={{ marginBottom: 10, fontSize: "0.75rem" }}>
          Amount is near send capacity limit. Payment may fail due to routing fees or HTLC constraints.
        </div>
      )}

      {/* Projected channel state (after decode) */}
      {decoded && projectedLocalPct != null && !isOverHard && (
        <div style={{
          background: "var(--bg-2)", borderLeft: "2px solid var(--amber)",
          padding: 8, fontSize: "0.65rem", color: "var(--text-2)", marginBottom: 12,
        }}>
          After send: <strong style={{ color: "var(--amber)" }}>
            {currentLocalPct}% → {projectedLocalPct}% local
          </strong>
        </div>
      )}

      {error && (
        <div className="alert warning" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <button
        className="btn btn-primary"
        onClick={handlePay}
        disabled={!decoded || paying || isOverHard}
      >
        {paying ? "Paying..." : "Confirm & Pay"}
      </button>
    </div>
  );
}

// ─── Payment Detail ──────────────────────────────────────────────────────────

function PaymentDetail({
  payment: p,
  contacts,
  rate,
  onClose,
  onDeleted,
}: {
  payment: NetworkPayment;
  contacts: Contact[];
  rate: number | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleCopy = () => {
    if (!p.payment_request) return;
    copyToClipboard(p.payment_request);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deletePayment(p.id);
      onDeleted();
    } catch (e: any) {
      setDeleteError(e.message ?? "Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  const canDelete = p.status !== "succeeded";

  const dirLabel = p.direction === "send" ? "Sent" : "Received";
  const statusBadge: Record<string, { label: string; cls: string }> = {
    pending: { label: "Pending", cls: "badge-amber" },
    succeeded: { label: "Success", cls: "badge-green" },
    failed: { label: "Failed", cls: "badge-red" },
    expired: { label: "Expired", cls: "badge-muted" },
  };
  const sBadge = statusBadge[p.status] || { label: p.status, cls: "badge-muted" };

  return (
    <div className="invoice-display" style={{ position: "relative" }}>
      {/* X close button — top right */}
      <button
        onClick={onClose}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          background: "none",
          border: "none",
          color: "var(--text-3)",
          fontSize: "1.25rem",
          cursor: "pointer",
          padding: "4px 8px",
          lineHeight: 1,
        }}
        title="Close"
      >
        ✕
      </button>

      <div style={{ textAlign: "center", margin: "16px 0 8px", fontSize: "1.25rem", fontWeight: 600 }}>
        {fmtSats(p.amount_sats)}
        {p.amount_usd != null && (
          <span className="text-dim" style={{ fontSize: "0.875rem", marginLeft: 8 }}>
            (${p.amount_usd.toFixed(2)} USD)
          </span>
        )}
      </div>

      <div className="payment-preview" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Direction</span>
          <span>{dirLabel}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Status</span>
          <span className={sBadge.cls}>{sBadge.label}</span>
        </div>
        {p.fee_sats > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span>Fee</span>
            <span>{fmtSats(p.fee_sats)}</span>
          </div>
        )}
        {p.counterparty_pubkey && (
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span>{p.direction === "send" ? "To" : "From"}</span>
            <span className="td-mono" style={{ fontSize: "0.8rem" }}>
              {resolveContactName(p.counterparty_pubkey, contacts)}
            </span>
          </div>
        )}
        {p.memo && (
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span>Memo</span>
            <span>{p.memo}</span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span>Date</span>
          <span className="text-dim">{new Date(p.created_at).toLocaleString()}</span>
        </div>
        {p.settled_at && (
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Settled</span>
            <span className="text-dim">{new Date(p.settled_at).toLocaleString()}</span>
          </div>
        )}
      </div>

      <div className="text-dim" style={{ fontSize: "0.75rem", wordBreak: "break-all", marginBottom: 12 }}>
        Hash: {p.payment_hash}
      </div>

      {/* BOLT11 string + copy for received invoices */}
      {p.payment_request && p.direction === "receive" && (
        <>
          <div className="bolt11-text">{p.payment_request}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={handleCopy} style={{ flex: 1 }}>
              {copied ? "Copied!" : "Copy Invoice"}
            </button>
            {canDelete && (
              <button className="btn btn-danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete"}
              </button>
            )}
          </div>
        </>
      )}

      {/* Delete button for failed/pending sent payments */}
      {p.direction === "send" && canDelete && (
        <button className="btn btn-danger" onClick={handleDelete} disabled={deleting} style={{ marginTop: 4 }}>
          {deleting ? "Deleting..." : "Delete"}
        </button>
      )}

      {deleteError && (
        <div style={{ color: "var(--red)", fontSize: "0.8125rem", marginTop: 8 }}>{deleteError}</div>
      )}
    </div>
  );
}

// ─── Payment Row ─────────────────────────────────────────────────────────────

function PaymentRow({
  payment: p,
  contacts,
  selected,
  onSelect,
}: {
  payment: NetworkPayment;
  contacts: Contact[];
  selected: boolean;
  onSelect: () => void;
}) {
  const dirBadge =
    p.direction === "send"
      ? { label: "Sent", cls: "badge-red" }
      : { label: "Received", cls: "badge-green" };

  const statusBadge: Record<string, { label: string; cls: string }> = {
    pending: { label: "Pending", cls: "badge-amber" },
    succeeded: { label: "Success", cls: "badge-green" },
    failed: { label: "Failed", cls: "badge-red" },
    expired: { label: "Expired", cls: "badge-muted" },
  };
  const sBadge = statusBadge[p.status] || { label: p.status, cls: "badge-muted" };

  return (
    <tr
      onClick={onSelect}
      className={selected ? "row-selected" : ""}
      style={{ cursor: "pointer" }}
    >
      <td><span className={dirBadge.cls}>{dirBadge.label}</span></td>
      <td><span className={sBadge.cls}>{sBadge.label}</span></td>
      <td className="td-num">
        {fmtSats(p.amount_sats)}
        {p.amount_usd != null && (
          <div className="text-dim" style={{ fontSize: "0.75rem" }}>
            ${p.amount_usd.toFixed(2)}
          </div>
        )}
      </td>
      <td className="td-num">{p.fee_sats > 0 ? fmtSats(p.fee_sats) : "\u2014"}</td>
      <td className="td-mono" style={{ fontSize: "0.8rem" }}>
        {p.counterparty_pubkey
          ? resolveContactName(p.counterparty_pubkey, contacts)
          : "\u2014"}
      </td>
      <td>{p.memo || "\u2014"}</td>
      <td className="text-dim" style={{ whiteSpace: "nowrap" }}>
        {new Date(p.created_at).toLocaleDateString()}
      </td>
    </tr>
  );
}
