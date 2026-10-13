// V8: the four valuation controls the PR 1 re-screenshot still showed as
// native chrome (ValuationInput's Refresh now; DayForm's number input, Save
// and Delete) now carry the app's control classes — and a fifth, "Today",
// which PR 2's own before-capture showed grey in dark (.btn with no variant).
//
// This pins the classes only. The evidence that the residue existed, and is
// gone, is PR 2's before/after capture pair; a class check cannot see paint.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import { MemoryRouter } from "react-router-dom";

const stub = vi.hoisted(() => ({
  getValuationDay: vi.fn(async (date: string) => ({ date, metrics: { mvrv: { value: 1.234 } } })),
  getValuationInputs: vi.fn(() => new Promise<never>(() => {})),
  getValuationCalendar: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import ValuationInput from "./ValuationInput";

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: ["/valuation-input?view=day"] }, React.createElement(ValuationInput)),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const buttons = (label: string) =>
  [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);

describe("V8 valuation residue", () => {
  it("Today has a variant: a bare .btn sets no background, so the browser drew its grey", () => {
    const [b] = buttons("Today");
    expect(b).toBeTruthy();
    expect([...b.classList]).toEqual(expect.arrayContaining(["btn", "btn-outline"]));
  });

  it("Refresh now is a themed button", () => {
    const [b] = buttons("Refresh now");
    expect(b).toBeTruthy();
    expect(b.classList.contains("btn")).toBe(true);
  });

  it("every metric row's number input is a .form-input", () => {
    const inputs = [...host.querySelectorAll('input[type="number"]')];
    expect(inputs.length).toBe(9);
    for (const i of inputs) expect(i.classList.contains("form-input")).toBe(true);
  });

  it("every row's Save and Delete are themed buttons, Delete as .btn-danger", () => {
    const saves = buttons("Save");
    const deletes = buttons("Delete");
    expect(saves.length).toBe(9);
    expect(deletes.length).toBe(9);
    for (const b of saves) expect(b.classList.contains("btn")).toBe(true);
    for (const b of deletes) expect([...b.classList]).toEqual(expect.arrayContaining(["btn", "btn-danger"]));
  });

  it("Delete is still disabled where there is no entry, and enabled where there is one", () => {
    const deletes = buttons("Delete");
    expect(deletes.filter((b) => !b.disabled).length).toBe(1);
  });
});
