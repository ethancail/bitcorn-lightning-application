// What a capital action looks like to the person about to take it, and what
// they have to type to proceed. Pure — no React, no fetch.
//
// Same shape as payModalMachine.ts / secureContext.ts / submitGuard.ts: the
// decision lives in a testable module and the component stays a renderer.
//
// ⚠ THIS IS NOT THE CONFIRMATION VALUE. The x-bitcorn-confirm header is derived
// from the serialized body inside apiFetch and nothing here touches it — see
// api/actionConfirmation.ts for why that has exactly one source. This module is
// only the human step: say what is about to happen, and make the operator type
// something that proves they read it.
//
// The two are deliberately independent. If this module were also the source of
// the hash, a copy change could alter a confirmation value, which is absurd but
// is exactly the coupling that "compute it in the form" produces.

export type Challenge =
  /** Type the amount in sats. Used wherever the action HAS an amount. */
  | { kind: "amount"; sats: number }
  /**
   * Type a short word. Used only where there is genuinely no amount — closing a
   * channel, approving a stored recommendation. Naming the fallback rather than
   * inventing a fake amount: a number the operator cannot check against
   * anything is worse than a word, because it looks like verification.
   */
  | { kind: "phrase"; text: string };

export interface ActionSummary {
  /** Imperative, specific. Becomes the modal heading. */
  title: string;
  /** Label → value rows. Amount and destination first where they exist. */
  rows: Array<{ label: string; value: string }>;
  /** One line on what cannot be undone, or undefined when nothing applies. */
  irreversible?: string;
  challenge: Challenge;
  /** Text on the go-ahead button. */
  confirmLabel: string;
}

export const fmtSats = (n: number): string =>
  Number.isFinite(n) ? `${Math.round(n).toLocaleString("en-US")} sats` : "—";

/** Middle-truncate a long identifier so both ends stay checkable. */
export function truncId(s: string, keep = 8): string {
  if (!s) return "—";
  return s.length <= keep * 2 + 1 ? s : `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The typed challenge
// ─────────────────────────────────────────────────────────────────────────────

/** What the operator must type, as they must type it. */
export function challengeTarget(c: Challenge): string {
  return c.kind === "amount" ? String(Math.round(c.sats)) : c.text;
}

/**
 * Does what they typed match?
 *
 * Amounts: digit-compared after stripping separators and whitespace, so
 * "1,000,000", "1 000 000" and "1000000" all pass. The operator is being asked
 * to demonstrate they read the number, not to guess a format.
 *
 * ⚠ EMPTY NEVER MATCHES, on either side. `"" === ""` passing is the same bug
 * shape as sync.ts:15 and the server's confirmation comparison; it is guarded
 * here too because this is a second place the pattern could appear.
 */
export function challengeSatisfied(c: Challenge, typed: string): boolean {
  const target = challengeTarget(c);
  if (!target) return false;
  if (c.kind === "amount") {
    const norm = (s: string) => s.replace(/[\s,_']/g, "");
    const t = norm(typed);
    if (t === "") return false;
    if (!/^\d+$/.test(t)) return false;
    return t === norm(target);
  }
  const t = typed.trim();
  if (t === "") return false;
  // Case-insensitive: the word is a speed bump, not a password.
  return t.toLowerCase() === target.toLowerCase();
}

/** Prompt above the input. */
export function challengePrompt(c: Challenge): string {
  return c.kind === "amount"
    ? `Type the amount to confirm: ${Math.round(c.sats).toLocaleString("en-US")}`
    : `Type ${c.text} to confirm`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-action summaries.
//
// Copy rules, argued and worth keeping:
//   · No "ask your node operator" anywhere. On a member node the farmer IS the
//     operator, so that phrasing routes them back to themselves. Same rule as
//     stablecoin/secureContext.ts.
//   · Name what is irreversible, once, plainly. Channel opens and on-chain
//     sends cost fees that do not come back; Lightning payments cannot be
//     recalled.
//   · Amount and destination lead, because those are what a mis-click gets
//     wrong.
// ─────────────────────────────────────────────────────────────────────────────

export function summarizeOpenMemberChannel(p: {
  capacitySats: number;
  partnerSocket?: string;
  hubLabel?: string;
}): ActionSummary {
  return {
    title: "Open a channel to the hub",
    rows: [
      { label: "Capacity", value: fmtSats(p.capacitySats) },
      { label: "Peer", value: p.hubLabel ?? "Bitcorn treasury hub" },
      ...(p.partnerSocket ? [{ label: "Address", value: p.partnerSocket }] : []),
    ],
    irreversible:
      "Funding a channel is an on-chain transaction. The mining fee is spent whether or not you close the channel later.",
    challenge: { kind: "amount", sats: p.capacitySats },
    confirmLabel: "Open channel",
  };
}

export function summarizeTreasuryOpenChannel(p: {
  peerPubkey: string;
  capacitySats: number;
  peerAlias?: string;
}): ActionSummary {
  return {
    title: "Open a treasury channel",
    rows: [
      { label: "Capacity", value: fmtSats(p.capacitySats) },
      { label: "Peer", value: p.peerAlias ? `${p.peerAlias} (${truncId(p.peerPubkey)})` : truncId(p.peerPubkey) },
    ],
    irreversible: "On-chain funding transaction. The mining fee is not recoverable.",
    challenge: { kind: "amount", sats: p.capacitySats },
    confirmLabel: "Open channel",
  };
}

export function summarizeCloseChannel(p: {
  channelId: string;
  isForceClose?: boolean;
  capacitySats?: number;
  peerAlias?: string;
}): ActionSummary {
  const force = p.isForceClose === true;
  return {
    title: force ? "Force-close this channel" : "Close this channel",
    rows: [
      { label: "Channel", value: truncId(p.channelId) },
      ...(p.peerAlias ? [{ label: "Peer", value: p.peerAlias }] : []),
      ...(p.capacitySats !== undefined ? [{ label: "Capacity", value: fmtSats(p.capacitySats) }] : []),
      { label: "Type", value: force ? "Force close" : "Cooperative close" },
    ],
    irreversible: force
      ? "A force close pays on-chain fees now and locks your balance behind a timelock — typically days before the funds are spendable."
      : "Closing settles the channel on-chain and pays a mining fee. Reopening later costs another one.",
    // No amount leaves the node here, so an amount challenge would be a number
    // with nothing to check it against. The word states which act is happening.
    challenge: { kind: "phrase", text: force ? "FORCE" : "CLOSE" },
    confirmLabel: force ? "Force close" : "Close channel",
  };
}

export function summarizePayInvoice(p: {
  amountSats: number;
  destination?: string;
  memo?: string;
}): ActionSummary {
  return {
    title: "Send this payment",
    rows: [
      { label: "Amount", value: fmtSats(p.amountSats) },
      ...(p.destination ? [{ label: "To", value: truncId(p.destination) }] : []),
      ...(p.memo ? [{ label: "Memo", value: p.memo }] : []),
    ],
    irreversible: "A Lightning payment cannot be recalled once it settles.",
    challenge: { kind: "amount", sats: p.amountSats },
    confirmLabel: "Send payment",
  };
}

export function summarizeLoopOut(p: {
  amountSats: number;
  destinationAddress: string;
  feeSats?: number;
}): ActionSummary {
  return {
    title: "Move funds on-chain",
    rows: [
      { label: "Amount", value: fmtSats(p.amountSats) },
      { label: "To address", value: truncId(p.destinationAddress, 10) },
      ...(p.feeSats !== undefined ? [{ label: "Estimated fee", value: fmtSats(p.feeSats) }] : []),
    ],
    irreversible:
      "The address above is where the coins land. A wrong address cannot be reversed by anyone.",
    challenge: { kind: "amount", sats: p.amountSats },
    confirmLabel: "Withdraw",
  };
}

export function summarizeLoopIn(p: { amountSats: number; feeSats?: number }): ActionSummary {
  return {
    title: "Refill this channel",
    rows: [
      { label: "Amount", value: fmtSats(p.amountSats) },
      ...(p.feeSats !== undefined ? [{ label: "Estimated fee", value: fmtSats(p.feeSats) }] : []),
    ],
    irreversible: "The swap fee is spent even if the swap does not complete.",
    challenge: { kind: "amount", sats: p.amountSats },
    confirmLabel: "Refill",
  };
}

export function summarizeApproveLiquidity(p: {
  recommendationId: string;
  amountSats?: number;
  peerAlias?: string;
}): ActionSummary {
  return {
    title: "Approve this liquidity action",
    rows: [
      ...(p.amountSats !== undefined ? [{ label: "Amount", value: fmtSats(p.amountSats) }] : []),
      ...(p.peerAlias ? [{ label: "Peer", value: p.peerAlias }] : []),
      { label: "Recommendation", value: truncId(p.recommendationId) },
    ],
    irreversible: "Approving moves funds. The routing fee is spent on completion.",
    challenge:
      p.amountSats !== undefined
        ? { kind: "amount", sats: p.amountSats }
        : { kind: "phrase", text: "APPROVE" },
    confirmLabel: "Approve",
  };
}
