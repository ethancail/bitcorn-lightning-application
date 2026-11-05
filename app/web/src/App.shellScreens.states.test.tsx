// member-first-run-ui separation slice — done-when (1), the root loading
// splash and ApiUnreachableScreen.
//
// WHAT THIS PROVES: both full-screen states render the same DOM (text and every
// attribute) and "Try again" makes the same call, before and after the two
// move out of App.tsx into components/shell/.
//
// HOW: the "before" is the .snap file this test wrote against the pre-move
// code (commit A); the move (commit B) must leave it byte-identical and these
// tests green under CI=1. Rendering goes through the real App, which reaches
// both screens on either side of the move, so this file needs no edit between
// A and B.
//
// Harness: App.declaredRole.test.tsx's (the REAL App; RailScope mocked by the
// existing pass-through pattern).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

vi.hoisted(() => {
  localStorage.setItem("bitcorn_theme", "dark");
});

const never = () => new Promise<never>(() => {});

const stub = vi.hoisted(() => ({
  getNode: vi.fn(),
}));

vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

vi.mock("./stablecoin/RailScope", () => ({
  RailScope: ({ children }: { children: React.ReactNode }) => children,
}));

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function serialize(node: Node, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent === "" ? [] : [`${pad}${JSON.stringify(node.textContent)}`];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const attrs = [...el.attributes].map((a) => `${a.name}=${JSON.stringify(a.value)}`).sort();
  if (el instanceof HTMLButtonElement) attrs.push(`prop:disabled=${el.disabled}`);
  const open = `${pad}<${el.tagName.toLowerCase()}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  return [open, ...[...el.childNodes].flatMap((c) => serialize(c, depth + 1))];
}

function capture(): string {
  return [
    ...[...host!.childNodes].flatMap((c) => serialize(c)),
    `calls: ${JSON.stringify({ getNode: stub.getNode.mock.calls.length })}`,
  ].join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("bitcorn_setup_done");
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function renderApp() {
  const App = (await import("./App")).default;
  window.history.pushState({}, "", "/dashboard");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(React.createElement(App)); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("the root loading splash", () => {
  it("getNode pending → INITIALIZING…", async () => {
    stub.getNode.mockImplementation(never);
    await renderApp();
    expect(capture()).toContain("INITIALIZING…");
    expect(capture()).toMatchSnapshot();
  });
});

describe("ApiUnreachableScreen", () => {
  it("getNode rejected → the unreachable screen", async () => {
    stub.getNode.mockRejectedValue(new Error("Failed to fetch"));
    await renderApp();
    expect(capture()).toContain("CAN'T REACH YOUR BITCORN NODE");
    expect(capture()).toMatchSnapshot();
  });

  it("\"Try again\" calls getNode again; still down → still the unreachable screen", async () => {
    stub.getNode.mockRejectedValue(new Error("Failed to fetch"));
    await renderApp();
    const before = stub.getNode.mock.calls.length;
    const tryAgain = [...host!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Try again")!;
    await act(async () => { tryAgain.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(stub.getNode.mock.calls.length).toBe(before + 1);
    expect(capture()).toMatchSnapshot();
  });
});
