// ProfilePanel (the public-alias panel) — copy pins. 1 and 2 were added when
// the member-name feature put BitcornNamePanel directly above it in Settings
// "Personal" (spec 2026-09-23-member-name-prompt §7.4); 3 by
// settings-name-clarity (Ethan, 2026-09-29).
//
// 1. The explanatory copy must not say "Your name is announced…". The panel
//    above now says the member's name for BitCorn is never published; the
//    same words here, meaning the ALIAS, read as a direct contradiction on
//    one screen. It says "Your alias" instead.
// 2. The alias input's placeholder must not contain "Ethan". The old
//    placeholder put an operator's personal name in the public repo — the
//    class migration 051's header says must not be committed.
// 3. The two Settings "Personal" panels no longer both read "Save": this one
//    is headed "Public alias" (was "Profile") and its button says "Save public
//    alias" — both PROPOSED, hardcoded below. Its placeholder is pinned
//    exactly because changing it was NOT approved; the name panel above was
//    told not to duplicate it.
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

describe("ProfilePanel copy — settings-name-clarity (PROPOSED)", () => {
  const HEADING = "Public alias"; // PROPOSED — settings-name-clarity, 2026-09-29
  const SAVE_ALIAS = "Save public alias"; // PROPOSED — settings-name-clarity, 2026-09-29

  it("the panel is headed 'Public alias', not 'Profile'", () => {
    const title = host.querySelector(".panel-title");
    expect(title, "panel title").toBeTruthy();
    const icon = title!.querySelector(".icon")?.textContent ?? "";
    expect((title!.textContent ?? "").slice(icon.length)).toBe(HEADING);
  });

  it("the save button says 'Save public alias', and no bare 'Save' button is left", () => {
    const labels = Array.from(host.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels.filter((l) => l === SAVE_ALIAS)).toHaveLength(1);
    expect(labels.filter((l) => l === "Save")).toHaveLength(0);
  });

  it("the alias placeholder is unchanged (changing it was not approved)", () => {
    const input = host.querySelector("input[type=text]") as HTMLInputElement;
    expect(input.placeholder).toBe('e.g. "Lazy Acres Farm"');
  });
});
