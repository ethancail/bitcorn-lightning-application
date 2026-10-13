// D3 on the treasury's Liquidity page (PR3-1, PR3-7): the critical tier keeps
// its place and turns amber; amber colours bars and rings only. A warning
// tier's number stays in --text, with its word beside the bar.

import { describe, it, expect, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import LiquidityLaneRow from "./LiquidityLaneRow";
import LiquidityKpiBanner from "./LiquidityKpiBanner";
import { HEALTH_COLOR, HEALTH_TEXT_COLOR, healthWord, type HealthTier, type LiquidityPeer } from "./types";

const TIERS: HealthTier[] = ["critical", "heavy", "healthy", "neutral"];

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function render(el: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  return host;
}

const peer = (role: LiquidityPeer["role"], tier: HealthTier, rolePct: number): LiquidityPeer => ({
  pubkey: "02" + "b".repeat(64), name: "Peer", role, capacity: 2_000_000,
  memberLocal: 0, memberRemote: 0, channelCount: 1, rolePct, healthTier: tier,
});

const style = (el: Element) => el.getAttribute("style") ?? "";

describe("the tier colours", () => {
  it("no tier is red; critical and heavy are amber on the bar", () => {
    for (const t of TIERS) expect(HEALTH_COLOR[t]).not.toMatch(/red/);
    expect(HEALTH_COLOR.critical).toBe("var(--amber)");
    expect(HEALTH_COLOR.heavy).toBe("var(--amber)");
  });
  it("PR3-7: no text colour is amber or red", () => {
    for (const t of TIERS) expect(HEALTH_TEXT_COLOR[t]).not.toMatch(/amber|red/);
  });
  it("the warning tiers have a word; the others none", () => {
    expect(healthWord("merchant", "critical")).toBe("Low");
    expect(healthWord("farmer", "heavy")).toBe("Getting full");
    expect(healthWord("merchant", "healthy")).toBeNull();
    expect(healthWord("external", "neutral")).toBeNull();
  });
});

describe("the lane row", () => {
  it("a critical merchant → amber bar, the % chip in --text, \"Low\" beside the bar", async () => {
    const el = await render(React.createElement(LiquidityLaneRow, { peer: peer("merchant", "critical", 0.1), isSelected: false, pulseKey: 0 }));
    expect(style(el.querySelector('[data-testid="capacity-bar"]')!)).toContain("var(--amber)");
    const texts = [...el.querySelectorAll('[data-testid="capacity-text"]')];
    expect(texts.map((t) => t.textContent)).toEqual(["Low", "10%"]);
    expect(texts.map(style).join("|")).not.toMatch(/amber|red/);
  });

  it("PERMITTING: a healthy farmer → green bar and chip, no word", async () => {
    const el = await render(React.createElement(LiquidityLaneRow, { peer: peer("farmer", "healthy", 0.6), isSelected: false, pulseKey: 0 }));
    expect(style(el.querySelector('[data-testid="capacity-bar"]')!)).toContain("var(--green)");
    const texts = [...el.querySelectorAll('[data-testid="capacity-text"]')];
    expect(texts.map((t) => t.textContent)).toEqual(["60%"]);
    expect(style(texts[0])).toContain("color: var(--green)");
  });
});

describe("the KPI banner", () => {
  it("a critical tier's count is --text, not red", async () => {
    const el = await render(React.createElement(LiquidityKpiBanner, {
      kpis: {
        totalDeployed: 4_000_000, peerCount: 2,
        merchantsHealthy: 0, merchantsTotal: 1, merchantsTier: "critical",
        farmersHealthy: 1, farmersTotal: 1, farmersTier: "healthy",
      } as any,
    }));
    const [merchants, farmers] = [...el.querySelectorAll('[data-testid="capacity-text"]')];
    expect(style(merchants)).toContain("color: var(--text)");
    expect(style(farmers)).toContain("color: var(--green)");
  });
});
