// ProfilePanel (the public-alias panel) — two copy pins, added when the
// member-name feature put BitcornNamePanel directly above it in Settings
// "Personal" (spec 2026-09-23-member-name-prompt §7.4).
//
// 1. The explanatory copy must not say "Your name is announced…". The panel
//    above now says the member's name for BitCorn is never published; the
//    same words here, meaning the ALIAS, read as a direct contradiction on
//    one screen. It says "Your alias" instead.
// 2. The alias input's placeholder must not contain "Ethan". The old
//    placeholder put an operator's personal name in the public repo — the
//    class migration 051's header says must not be committed.
//
// ⚠ Each forbidding assertion is paired with a positive in the SAME render
// (the sentence is there; the placeholder is there), so neither can pass
// against a panel that simply failed to render that text.
//
// Harness: react-dom/client createRoot inside act(), no Testing Library — the
// repo's established approach (vitest.config.ts header).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

const stub = vi.hoisted(() => ({
  getProfileAlias: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import ProfilePanel from "./ProfilePanel";

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  stub.getProfileAlias.mockResolvedValue({
    alias: null,
    alias_set_at: null,
    alias_applied_at: null,
    pubkey: "03" + "a".repeat(64),
    default_alias: "03aaaaaaaaaaaaaaaaaa",
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(ProfilePanel)); });
  for (let i = 0; i < 3; i++) {
    await act(async () => { await Promise.resolve(); });
  }
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("ProfilePanel copy", () => {
  it("the announcement sentence is present (paired positive)", () => {
    expect(host.textContent).toContain("is announced to the public Lightning network");
  });

  it("the announcement sentence does not say 'Your name is' — it is the alias", () => {
    expect(host.textContent).not.toContain("Your name is");
  });

  it("the alias input has a placeholder (paired positive)", () => {
    const input = host.querySelector("input[type=text]") as HTMLInputElement | null;
    expect(input, "alias input").toBeTruthy();
    expect(input!.placeholder.length).toBeGreaterThan(0);
  });

  it("the alias placeholder does not contain an operator's personal name ('Ethan')", () => {
    const input = host.querySelector("input[type=text]") as HTMLInputElement;
    expect(input.placeholder).not.toContain("Ethan");
  });
});
