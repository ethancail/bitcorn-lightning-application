// app/web/src/components/autoBuy/KrakenCard.tsx
//
// Connect, verify and disconnect the node's Kraken API key (kraken-autobuy P4e,
// over the P4d routes). The server reads the key live and stores it only if its
// permissions are exactly the five K1 allows; then it looks the node's withdraw
// address up among the account's saved Kraken addresses. The node cannot add
// that address (it never holds "Add withdrawal addresses"), so the farm saves
// it in Kraken and presses Verify.
//
// ⚠ DRAFT COPY — every user-facing string in this file is a draft for Ethan's
// P6 copy review (E4, D11; the setup guidance is copy under G4). Kept plain.

import { useState } from "react";
import {
  api,
  type AutoBuyStatus,
  type KrakenAddressStatus,
  type KrakenMinimumWarning,
} from "../../api/client";

interface Props {
  status: AutoBuyStatus;
  onRefresh: () => Promise<unknown>;
}

type Note = { kind: "success" | "error" | "info"; text: string } | null;

/** The five permissions the key must have, and no others (ruling K1), as Kraken's key page names them. */
export const KRAKEN_KEY_PERMISSIONS = [
  "Query Funds",
  "Withdraw Funds",
  "Query Open Orders & Trades",
  "Query Closed Orders & Trades",
  "Create & Modify Orders",
];

export function addressStatusText(status: KrakenAddressStatus): string {
  switch (status) {
    case "matched": return "Your node's address is saved and verified on Kraken.";
    case "not_verified": return "Your node's address is saved on Kraken but not verified yet. Verify it in Kraken, then press Verify here.";
    case "not_found": return "Save your node's address (below) as a Bitcoin withdrawal address in Kraken, then press Verify here.";
    case "node_address_missing": return "Your node has no withdrawal address yet. Reload this page to create one.";
  }
}

export function minimumWarningText(w: KrakenMinimumWarning | null): string | null {
  if (!w || !w.below) return null;
  return `Your smallest buy ($${w.smallest_buy_usd.toFixed(2)}) is below Kraken's minimum (about $${w.minimum_usd.toFixed(2)} at today's price). Buys that small will be skipped, not rounded up.`;
}

/** A refusal from the server → plain text (the structured body, never a parsed message). */
export function krakenErrorText(err: unknown): string {
  const e = err as { body?: { error?: string; extra?: string[]; missing?: string[]; detail?: string } };
  const b = e?.body;
  switch (b?.error) {
    case "key_permissions_too_broad":
      return `This key has permissions it must not have: ${(b.extra ?? []).join(", ")}. Create a key with only the five permissions listed.`;
    case "key_permissions_missing":
      return `This key is missing: ${(b.missing ?? []).join(", ")}. Create a key with all five permissions listed.`;
    case "ambiguous_withdraw_method":
      return "Your node's address is saved under more than one Kraken withdrawal method. Keep it under one Bitcoin method only, then try again.";
    case "verification_failed":
      return `Kraken did not accept this key${b.detail ? ` (${b.detail})` : ""}.`;
    case "invalid_kraken_key_format":
      return "That doesn't look like a Kraken API key and private key. Copy both again from Kraken.";
    default:
      return err instanceof Error ? err.message : "Something went wrong.";
  }
}

export default function KrakenCard({ status, onRefresh }: Props) {
  return status.kraken_credentials
    ? <ConnectedState status={status} onRefresh={onRefresh} />
    : <DisconnectedState status={status} onRefresh={onRefresh} />;
}

function NodeAddress({ address }: { address: string }) {
  return (
    <p style={{ marginTop: 0, marginBottom: 12, fontSize: "0.8125rem" }}>
      Your node's withdrawal address:{" "}
      <code className="ident" data-testid="node-address" style={{ wordBreak: "break-all" }}>{address || "—"}</code>
    </p>
  );
}

function NoteBox({ note }: { note: Note }) {
  if (!note) return null;
  const bg = note.kind === "success" ? "var(--green)" : note.kind === "error" ? "var(--red)" : "var(--amber)";
  return (
    <div className="alert" role="status" style={{ background: bg, color: "var(--bg)", marginBottom: 12 }}>
      <div className="alert-body">{note.text}</div>
    </div>
  );
}

function DisconnectedState({ status, onRefresh }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true); setNote(null); setWarning(null);
    try {
      const r = await api.saveKrakenCredentials({ api_key: apiKey.trim(), api_secret: secret.trim() });
      setApiKey(""); setSecret("");
      setNote({ kind: r.address_status === "matched" ? "success" : "info", text: `Connected. ${addressStatusText(r.address_status)}` });
      setWarning(minimumWarningText(r.minimum_warning));
      await onRefresh();
    } catch (err) {
      setNote({ kind: "error", text: krakenErrorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }} data-copy="draft">
      <div className="panel-header">Kraken</div>
      <div className="panel-body">
        <p style={{ marginTop: 0, marginBottom: 8 }}>
          Create an API key in Kraken with exactly these permissions:
        </p>
        <ul data-testid="kraken-permissions" style={{ marginTop: 0, marginBottom: 8 }}>
          {KRAKEN_KEY_PERMISSIONS.map((p) => <li key={p}>{p}</li>)}
        </ul>
        <p className="text-dim" style={{ marginTop: 0, marginBottom: 12, fontSize: "0.8125rem" }}>
          Do not give it "Add withdrawal addresses" or "Update withdrawal addresses". A key with either is refused.
        </p>
        <NodeAddress address={status.config?.withdraw_address ?? ""} />
        <label style={{ display: "block", marginBottom: 8 }}>
          API key
          <input aria-label="Kraken API key" type="text" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label style={{ display: "block", marginBottom: 12 }}>
          Private key
          <input aria-label="Kraken private key" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} style={{ width: "100%" }} />
        </label>
        <NoteBox note={note} />
        {warning && <NoteBox note={{ kind: "info", text: warning }} />}
        <button onClick={connect} disabled={busy || !apiKey.trim() || !secret.trim()}>
          {busy ? "Connecting…" : "Connect Kraken"}
        </button>
      </div>
    </div>
  );
}

function ConnectedState({ status, onRefresh }: Props) {
  const creds = status.kraken_credentials!;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [balances, setBalances] = useState<{ usd: number; usdc: number; btc: number } | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const verify = async () => {
    setBusy(true); setNote(null); setWarning(null);
    try {
      const r = await api.verifyKrakenCredentials();
      setBalances(r.balances);
      setNote({ kind: r.address_status === "matched" ? "success" : "info", text: `Key checked. ${addressStatusText(r.address_status)}` });
      setWarning(minimumWarningText(r.minimum_warning));
      await onRefresh();
    } catch (err) {
      setNote({ kind: "error", text: krakenErrorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true); setNote(null);
    try {
      await api.deleteKrakenCredentials();
      setConfirmingDisconnect(false);
      await onRefresh();
    } catch (err) {
      setNote({ kind: "error", text: krakenErrorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }} data-copy="draft">
      <div className="panel-header">Kraken</div>
      <div className="panel-body">
        <p style={{ marginTop: 0, marginBottom: 8 }}>
          Kraken key connected {new Date(creds.connected_at * 1000).toLocaleDateString()}.
        </p>
        <p data-testid="address-state" style={{ marginTop: 0, marginBottom: 12 }}>
          {creds.address_matched ? addressStatusText("matched") : addressStatusText("not_found")}
        </p>
        {!creds.address_matched && <NodeAddress address={status.config?.withdraw_address ?? ""} />}
        <NoteBox note={note} />
        {warning && <NoteBox note={{ kind: "info", text: warning }} />}
        {balances && (
          <p data-testid="kraken-balances" style={{ marginTop: 0, marginBottom: 12, fontFamily: "var(--mono)" }}>
            USD ${balances.usd.toFixed(2)} · USDC ${balances.usdc.toFixed(2)} · BTC {balances.btc.toFixed(8)}
          </p>
        )}
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={verify} disabled={busy}>{busy ? "Checking…" : "Verify"}</button>
          {confirmingDisconnect ? (
            <>
              <button onClick={disconnect} disabled={busy}>Confirm disconnect</button>
              <button onClick={() => setConfirmingDisconnect(false)} disabled={busy}>Keep key</button>
            </>
          ) : (
            <button onClick={() => setConfirmingDisconnect(true)} disabled={busy}>Disconnect</button>
          )}
        </div>
      </div>
    </div>
  );
}
