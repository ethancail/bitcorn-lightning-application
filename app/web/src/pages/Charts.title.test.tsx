// Kevin's chart name (2026-10-21): the corn chart's panel title reads
// "Corn-Bitcoin Price (Bushels/Bitcoin)" — bushels per BTC, matching the axis.
import { afterEach, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.mock("../components/PowerLawChart", () => ({ default: () => null }));
vi.mock("../components/MovingAveragesChart", () => ({ default: () => null }));
vi.mock("../components/CornBitcoinChart", () => ({ default: () => null }));
vi.mock("../components/CornMovingAveragesChart", () => ({ default: () => null }));
vi.mock("../components/CommodityPricesPanel", () => ({ default: () => null }));

import Charts from "./Charts";

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; vi.unstubAllGlobals(); });

it("the corn chart is titled Corn-Bitcoin Price (Bushels/Bitcoin), not Ratio", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // Coinbase spot/historic never settle
  const host = document.createElement("div");
  act(() => { root = createRoot(host); root.render(<Charts />); });
  const titles = [...host.querySelectorAll(".panel-title")].map((t) => t.textContent ?? "");
  expect(titles).toContain("🌽Corn-Bitcoin Price (Bushels/Bitcoin)");
  expect(titles.some((t) => t.includes("Corn-Bitcoin Ratio"))).toBe(false);
});
