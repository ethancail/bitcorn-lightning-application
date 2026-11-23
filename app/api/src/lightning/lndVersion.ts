// node-version-alert: tell a node whose LND is older than Bitcorn needs that its
// Lightning Node app is out of date.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// Umbrel's Lightning Node app shipped Tor 0.4.7.8 until umbrel-apps 9f636edd
// (2026-07-10), whose message says that Tor "can no longer reliably bootstrap".
// The same commit moved Bitcoin Node and Electrs to the new Tor. Nodes that have
// not updated should be told so, in plain words. Rulings R1–R6, bitcorn-research
// decisions/2026-11-20-node-version-alert-signal-minimum-and-surfaces.md.
//
// ─── WHAT IS CHECKED, AND ITS KNOWN COST ────────────────────────────────────
//
// LND's own version (R1), from the read the sync loop already makes every 15 s
// (lightning/sync.ts). It is a partial signal: 0.21.1-beta-patch.1 changed the
// app's Tor and kept LND at v0.21.1-beta, so a patched node still reports
// 0.21.1 and is warned. R2 accepts that cost: following the warning only
// updates the node.
//
// ─── HELD IN MEMORY, NEVER PERSISTED (R6) ───────────────────────────────────
//
// No migration, and persistNodeInfo is untouched. Until the first successful
// read the value is null and both surfaces say nothing. A failed read leaves the
// last good value in place (Ethan, 2026-11-20, Phase 1 item 5).

import type { TreasuryAlert } from "../api/treasury-alerts";

export type LndVersionTuple = readonly [number, number, number];

/**
 * Below this LND version, both surfaces fire (R2). ⚠ ONE CONSTANT, fixed in
 * code: not "always the latest", which would nag at every Umbrel release.
 */
export const LND_MIN_VERSION: LndVersionTuple = [0, 21, 2];

/**
 * LND reports e.g. "0.20.0-beta commit=v0.20.0-beta". Only the leading
 * major.minor.patch is read; anything without one is unparseable (null).
 */
export function parseLndVersion(raw: string | null | undefined): LndVersionTuple | null {
  if (typeof raw !== "string") return null;
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whole-tuple comparison: the first differing part decides. */
export function isBelowMinimum(v: LndVersionTuple, min: LndVersionTuple = LND_MIN_VERSION): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] < min[i];
  }
  return false;
}

// ─── The in-memory value ────────────────────────────────────────────────────

let lastVersion: string | null = null;

/**
 * Called by the sync loop with each successful read. A read that carries no
 * version string leaves the last good one in place, as a failed read does.
 */
export function recordLndVersion(raw: string | null | undefined): void {
  if (typeof raw === "string" && raw.length > 0) lastVersion = raw;
}

/** The latest version LND reported, or null before the first read. */
export function getLndVersion(): string | null {
  return lastVersion;
}

export function resetLndVersionForTests(): void {
  lastVersion = null;
}

// ─── The two surfaces ───────────────────────────────────────────────────────

/**
 * The member line (R4; wording ruled by Ethan, 2026-11-20). One line, no
 * heading, no version number. ⚠ COPY CONSTRAINTS, pinned in lndVersion.test.ts:
 * no "operator", "channel", "treasury" or "hub", and never "Bitcorn".
 */
export const NODE_UPDATE_NOTICE_TEXT =
  "Your Lightning Node app is out of date, and part of it has stopped working. " +
  "Update it in your Umbrel's App Store, and update Bitcoin Node and Electrs too if you have them.";

/**
 * The member notice for /api/member/stats: the sentence, or null when there is
 * nothing to say (version current, unknown, or unparseable).
 */
export function nodeUpdateNoticeText(raw: string | null): string | null {
  const v = parseLndVersion(raw);
  if (!v || !isBelowMinimum(v)) return null;
  return NODE_UPDATE_NOTICE_TEXT;
}

/**
 * The treasury alert (R5): `warning`, because the dashboard drops `info`
 * (Dashboard.tsx:107-111). Heading set here, where it is created (SH1).
 */
export function lndVersionAlert(raw: string | null, nowMs: number): TreasuryAlert | null {
  const v = parseLndVersion(raw);
  if (!v || !isBelowMinimum(v)) return null;
  const minimum = LND_MIN_VERSION.join(".");
  return {
    type: "LND_VERSION_OUTDATED",
    heading: "Lightning Node app is out of date",
    severity: "warning",
    message:
      `This node runs LND ${v.join(".")}; BitCorn needs ${minimum} or later. ` +
      "Update Lightning Node, Bitcoin Node and Electrs in the Umbrel App Store.",
    data: { version: raw, minimum },
    at: nowMs,
  };
}
