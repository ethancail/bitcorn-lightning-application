// Z2 identifier guards (UI redesign PR 4). Identifiers — node IDs, pubkeys,
// txids, addresses, invoices, hashes — render in --font-id; everything else in
// the UI font.
//
// 1. Every <code> carries a class. A classless <code> gets the browser's own
//    monospace (DejaVu Sans Mono on Linux), not IBM Plex Mono, and a number in
//    one is monospace where Z2 wants the UI font — the font round's §7.1
//    defect. With a class, each <code> states which it is: `ident`, or a named
//    rule. Scanned statically over app/web/src (tests excluded); the scanner
//    skips {…} so an attribute holding ">" cannot end the tag early.
// 2. ActionConfirmModal sets the identifier rows of a summary (`ident: true`)
//    in .ident, and only those.
//
// Harness for (2): react-dom/client createRoot inside act(), no Testing Library.

import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React, { useEffect } from "react";
import ActionConfirmModal, { useActionConfirm } from "./components/actionConfirm/ActionConfirmModal";
import {
  summarizeCloseChannel, summarizeLoopOut, summarizeApproveLiquidity, summarizeOpenMemberChannel,
  summarizePayInvoice, summarizeTreasuryOpenChannel, type ActionSummary,
} from "./components/actionConfirm/confirmAction";

const SRC = __dirname;

function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** Each `<code …>` opening tag in `src` with no className, as "line: tag". */
export function classlessCode(src: string): string[] {
  const found: string[] = [];
  const re = /<code\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + 5;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice(m.index, i + 1);
    if (!/\bclassName=/.test(tag)) found.push(`${src.slice(0, m.index).split("\n").length}: ${tag.replace(/\s+/g, " ")}`);
  }
  return found;
}

describe("Z2: every <code> carries a class", () => {
  it("anti-vacuity: the scanner flags a classless <code>, with or without other attributes", () => {
    expect(classlessCode("a <code>{x}</code> b")).toHaveLength(1);
    expect(classlessCode('<code title={a > b ? "x" : "y"}>{x}</code>')).toHaveLength(1);
    expect(classlessCode('<code style={{ fontFamily: "var(--font-id)" }}>K</code>')).toHaveLength(1);
    expect(classlessCode('<code className="ident">{x}</code><code\n  className="sub-pubkey"\n  title={t}>')).toEqual([]);
  });

  it("anti-vacuity: the scan reaches files that hold <code> tags", () => {
    const withCode = sourceFiles().filter((f) => readFileSync(f, "utf8").includes("<code"));
    expect(withCode.length).toBeGreaterThanOrEqual(10);
  });

  it("no source file has a classless <code>", () => {
    const offenders = sourceFiles().flatMap((f) =>
      classlessCode(readFileSync(f, "utf8")).map((o) => `${relative(SRC, f)}:${o}`));
    expect(offenders).toEqual([]);
  });
});

// ── (2) ActionConfirmModal ──────────────────────────────────────────────────

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

function Harness({ summary }: { summary: ActionSummary }) {
  const c = useActionConfirm();
  useEffect(() => { c.open(summary); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return React.createElement(ActionConfirmModal, { controller: c, onConfirm: async () => undefined });
}

async function rowsOf(summary: ActionSummary) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(Harness, { summary })); });
  return [...host.querySelectorAll("dt")].map((dt) => ({
    label: dt.textContent,
    ident: (dt.nextElementSibling as HTMLElement | null)?.classList.contains("ident") ?? false,
  }));
}

const PK = "02" + "ab".repeat(32);

describe("Z2: the confirm modal sets identifier rows in .ident, and only those", () => {
  const CASES: Array<[string, ActionSummary, string[]]> = [
    ["open member channel", summarizeOpenMemberChannel({ capacitySats: 1_000_000, partnerSocket: "203.0.113.5:9735" }), ["Address"]],
    ["open treasury channel", summarizeTreasuryOpenChannel({ peerPubkey: PK, capacitySats: 1_000_000, peerAlias: "M1" }), ["Peer"]],
    ["close channel", summarizeCloseChannel({ channelId: "123456789012345678", peerAlias: "M1", capacitySats: 1_000_000 }), ["Channel"]],
    ["payment", summarizePayInvoice({ amountSats: 1_000, destination: PK, memo: "m" }), ["To"]],
    ["loop out", summarizeLoopOut({ amountSats: 300_000, destinationAddress: "bcrt1q" + "x".repeat(38), feeSats: 500 }), ["To address"]],
    ["liquidity approval", summarizeApproveLiquidity({ recommendationId: "rec-" + "9".repeat(20), amountSats: 1_000, peerAlias: "M1" }), ["Recommendation"]],
  ];
  for (const [name, summary, idents] of CASES) {
    it(name, async () => {
      const rows = await rowsOf(summary);
      expect(rows.length).toBeGreaterThan(idents.length); // a non-identifier row is present too
      expect(rows.filter((r) => r.ident).map((r) => r.label)).toEqual(idents);
    });
  }
});
