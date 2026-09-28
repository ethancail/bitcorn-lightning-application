// The Daybreak poll — spec §3.4.3, Ruling 3 and first test 39: every 5 minutes
// while the tab is visible, NO fetch while it is hidden, and one immediate
// fetch when it becomes visible again.
//
// Harness: react-dom/client createRoot inside act(), no Testing Library (the
// repo's approach, vitest.config.ts header). Fake timers drive the interval;
// document.visibilityState is overridden per test and a real
// "visibilitychange" event is dispatched, so the hook's own listener runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

const stub = vi.hoisted(() => ({ getDaybreakEdition: vi.fn() }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...(actual as any).api, ...stub } };
});

import { useDaybreakEdition } from "./useDaybreakEdition";

const MIN = 60_000;
let visibility: DocumentVisibilityState = "visible";
let host: HTMLDivElement;
let root: Root;

function Harness() {
  useDaybreakEdition();
  return null;
}

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(Harness));
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const calls = () => stub.getDaybreakEdition.mock.calls.length;

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => visibility === "hidden" });
  stub.getDaybreakEdition.mockReset();
  stub.getDaybreakEdition.mockResolvedValue({ state: "unavailable" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("test 39: the poll pauses while hidden and fetches on return", () => {
  it("permitting: while visible — one fetch at mount, then one every 5 minutes", async () => {
    await mount();
    expect(calls()).toBe(1);
    await advance(5 * MIN - 1);
    expect(calls()).toBe(1);
    await advance(1);
    expect(calls()).toBe(2);
    await advance(5 * MIN);
    expect(calls()).toBe(3);
  });

  it("permitting: becoming visible fires ONE immediate fetch", async () => {
    await mount();
    await act(async () => setVisibility("hidden"));
    const before = calls();
    await act(async () => setVisibility("visible"));
    expect(calls()).toBe(before + 1);
  });

  it("forbidding: NO fetch fires while hidden, however long", async () => {
    await mount();
    expect(calls()).toBe(1);
    await act(async () => setVisibility("hidden"));
    await advance(30 * MIN);
    expect(calls()).toBe(1);
  });

  it("anti-vacuity: the same 30 minutes VISIBLE does fetch — six more times", async () => {
    await mount();
    await advance(30 * MIN);
    expect(calls()).toBe(7);
  });

  it("after returning, the 5-minute cadence resumes from the return", async () => {
    await mount();
    await act(async () => setVisibility("hidden"));
    await advance(12 * MIN);
    await act(async () => setVisibility("visible"));
    expect(calls()).toBe(2);
    await advance(5 * MIN);
    expect(calls()).toBe(3);
  });

  it("forbidding: a tab that mounts hidden does not fetch until it is shown", async () => {
    visibility = "hidden";
    await mount();
    await advance(10 * MIN);
    expect(calls()).toBe(0);
    await act(async () => setVisibility("visible"));
    expect(calls()).toBe(1);
  });

  it("unmounting stops the poll", async () => {
    await mount();
    await act(async () => root.unmount());
    root = createRoot(host); // so afterEach's unmount has a root
    await advance(20 * MIN);
    expect(calls()).toBe(1);
  });
});
