// app/web/src/components/autoBuy/KrakenCard.tsx
//
// Connect, verify and disconnect the node's Kraken API key (kraken-autobuy P4e,
// over the P4d routes). The server reads the key live and stores it only if its
// permissions are exactly the five K1 allows; then it looks the node's withdraw
// address up among the account's saved Kraken addresses. The node cannot add
// that address (it never holds "Add withdrawal addresses"), so the farm saves
// it in Kraken and presses Verify.
//
// Copy: reviewed and approved by Ethan at P6 (E4, D11; the setup guidance is
// copy under G4). The full setup guide is docs/AUTOBUY_OPERATOR_GUIDE.md's
// Kraken section; this card carries the short version with Kraken's own pages.

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

/**
 * The five permissions the key must have, and no others (ruling K1), as Kraken
 * names them. Kraken's developer docs say "Create & Modify Orders" and its key
 * page "Modify Orders", so the fifth names both (D-P6-8).
 */
export const KRAKEN_KEY_PERMISSIONS = [
  "Query Funds",
  "Withdraw Funds",
  "Query Open Orders & Trades",
  "Query Closed Orders & Trades",
  "Create & Modify Orders (called Modify Orders on some screens)",
];

/** Kraken's own pages behind each setup step (read 2026-11-24). */
const KRAKEN_HELP = {
  settingsLock: "https://support.kraken.com/articles/201396877-what-is-the-global-settings-lock-gsl-",
  apiKey: "https://support.kraken.com/articles/how-to-create-an-api-key-on-kraken-pro",
  address: "https://support.kraken.com/articles/360000672863-adding-and-confirming-a-new-cryptocurrency-withdrawal-address",
  recurringAch: "https://support.kraken.com/articles/recurring-ach-deposits",
};

function HelpLink({ href, children }: { href: string; children: string }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

export function addressStatusText(status: KrakenAddressStatus): string {
  switch (status) {
    case "matched": return "Your node's address is saved and verified on Kraken.";
    case "not_verified": return "Your node's address is saved on Kraken but not verified yet. Verify it in Kraken, then press Verify here.";
    case "not_found": return "Save your node's address (below) as a Bitcoin withdrawal address in Kraken, then press Verify here.";
    case "node_address_missing": return "Your node has no withdrawal address yet. Reload this page to create one.";
  }
}

/**
 * "Buys left" (P5, G11): from the API's funds, the same USD and the same next
 * buy the low-funds warning counts. Never computed here, so the two agree.
 */
export function fundsText(status: AutoBuyStatus): string {
  const f = status.funds;
  const snap = status.balance_snapshot;
  if (!snap) return "No balance read yet. Press Verify.";
  const asOf = `As of ${new Date(snap.read_at * 1000).toLocaleString()}${snap.stale ? " — may be out of date" : ""}.`;
  if (!f) return `$${snap.usd_available.toFixed(2)} USD available. Buys left can't be worked out without today's valuation. ${asOf}`;
  if (f.buys_covered === null) return `$${f.usd_available.toFixed(2)} USD available. The current zone buys nothing. ${asOf}`;
  return `About ${f.buys_covered} buy${f.buys_covered === 1 ? "" : "s"} left: $${f.usd_available.toFixed(2)} USD available, next buy $${f.next_buy_usd.toFixed(2)}. ${asOf}`;
}

export function minimumWarningText(w: KrakenMinimumWarning | null): string | null {
  if (!w || !w.below) return null;
  return `Your smallest buy ($${w.smallest_buy_usd.toFixed(2)}) is below Kraken's minimum (about $${w.minimum_usd.toFixed(2)} at today's price). Those buys will be skipped, not rounded up.`;
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
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Kraken</div>
      <div className="panel-body">
        {/* The order (ruling DOC2, P6 capture review): the address is saved in
            Kraken BEFORE the key is connected, so Connect finds it in one go.
            The five permissions sit inside the create-the-key step (S2), and
            that list is indented inside the card at every width (S3). */}
        <ol data-testid="kraken-setup-steps" style={{ marginTop: 0, marginBottom: 12, paddingLeft: 20 }}>
          <li>If Kraken's Global Settings Lock is on, unlock it first. <HelpLink href={KRAKEN_HELP.settingsLock}>About the lock</HelpLink></li>
          <li>
            Save your node's address (below) in Kraken: Withdraw → Bitcoin → Add new withdrawal address, with a
            unique label, and confirm it. <HelpLink href={KRAKEN_HELP.address}>Adding an address</HelpLink>
          </li>
          <li>
            In Kraken, go to Settings → API → Create API key, with exactly these permissions:
            <ul data-testid="kraken-permissions" style={{ marginTop: 4, marginBottom: 4, paddingLeft: 20 }}>
              {KRAKEN_KEY_PERMISSIONS.map((p) => <li key={p}>{p}</li>)}
            </ul>
            <span className="text-dim" style={{ fontSize: "0.8125rem" }}>
              Do not give it "Add withdrawal addresses" or "Update withdrawal addresses". A key with either is refused.
            </span>{" "}
            Don't add 2FA to the key, and leave Key Expiration and the nonce window unset. Restrict it to an IP
            address only if your node has a static IP.{" "}
            <HelpLink href={KRAKEN_HELP.apiKey}>Creating a key</HelpLink>
          </li>
          <li>Paste the API key and private key below and press Connect Kraken. BitCorn checks the key and finds your saved address.</li>
          <li>
            Set up one recurring ACH deposit in Kraken, covering a full interval of buys at your highest zone
            multiplier, plus a margin. Each deposit can be withdrawn seven days after it arrives.{" "}
            <HelpLink href={KRAKEN_HELP.recurringAch}>Recurring deposits</HelpLink>
          </li>
        </ol>
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
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Kraken</div>
      <div className="panel-body">
        <p style={{ marginTop: 0, marginBottom: 8 }}>
          Kraken key connected {new Date(creds.connected_at * 1000).toLocaleDateString()}.
        </p>
        <p data-testid="address-state" style={{ marginTop: 0, marginBottom: 12 }}>
          {creds.address_matched ? addressStatusText("matched") : addressStatusText("not_found")}
        </p>
        {!creds.address_matched && <NodeAddress address={status.config?.withdraw_address ?? ""} />}
        <p data-testid="kraken-funds" style={{ marginTop: 0, marginBottom: 12 }}>{fundsText(status)}</p>
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
