// app/web/src/components/autoBuy/ProviderChoice.tsx
//
// Which exchange this node's Auto-Buy uses (kraken-autobuy P4e; D2, rulings
// D-P4-2/-4/-7). Switching is refused by the server while any buy or sweep is
// still in progress (409 provider_switch_in_flight), and a switch pauses
// Auto-Buy so the farm re-enables it on the new exchange.
//
// ⚠ DRAFT COPY — every user-facing string in this file is a draft for Ethan's
// P6 copy review (E4, D11). Kept plain on purpose.

import { useState } from "react";
import { api, type AutoBuyProvider, type AutoBuyStatus } from "../../api/client";

interface Props {
  status: AutoBuyStatus;
  onRefresh: () => Promise<unknown>;
}

const LABEL: Record<AutoBuyProvider, string> = { coinbase: "Coinbase", kraken: "Kraken" };

export default function ProviderChoice({ status, onRefresh }: Props) {
  const current: AutoBuyProvider = status.config?.provider ?? "coinbase";
  const other: AutoBuyProvider = current === "coinbase" ? "kraken" : "coinbase";
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const doSwitch = async () => {
    setBusy(true); setMessage(null);
    try {
      await api.setAutoBuyProvider(other);
      setMessage({ kind: "success", text: `Switched to ${LABEL[other]}. Auto-Buy is paused until you enable it again.` });
      await onRefresh();
    } catch (err) {
      const e = err as { status?: number; body?: { error?: string; in_flight_runs?: number; in_flight_sweeps?: number } };
      if (e.status === 409 && e.body?.error === "provider_switch_in_flight") {
        setMessage({
          kind: "error",
          text: `You can't switch yet: ${e.body.in_flight_runs ?? 0} buy(s) and ${e.body.in_flight_sweeps ?? 0} withdrawal(s) are still in progress on ${LABEL[current]}. Try again once they finish.`,
        });
      } else {
        setMessage({ kind: "error", text: err instanceof Error ? err.message : "Switch failed." });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }} data-copy="draft">
      <div className="panel-header">Exchange</div>
      <div className="panel-body">
        <p style={{ marginTop: 0, marginBottom: 12 }}>
          Auto-Buy uses <strong data-testid="active-provider">{LABEL[current]}</strong>.
        </p>
        {message && (
          <div className="alert" role="status" style={{ background: message.kind === "success" ? "var(--green)" : "var(--red)", color: "var(--bg)", marginBottom: 12 }}>
            <div className="alert-body">{message.text}</div>
          </div>
        )}
        <button onClick={doSwitch} disabled={busy}>
          {busy ? "Switching…" : `Switch to ${LABEL[other]}`}
        </button>
        <p className="text-dim" style={{ marginBottom: 0, fontSize: "0.8125rem" }}>
          Switching pauses Auto-Buy. It is refused while a buy or withdrawal is in progress.
        </p>
      </div>
    </div>
  );
}
