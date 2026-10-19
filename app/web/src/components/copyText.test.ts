// copyText — the shared copy helper (member-ui-fixes item 3, on #341's
// pattern in stablecoin/components/EmptyState.tsx).
//
// Members reach their node over plain HTTP, where navigator.clipboard is
// undefined or rejects, so the hidden-textarea + execCommand("copy") fallback
// is the common path. The helper reports success only when one of the two
// paths actually copied.
//
// jsdom implements neither navigator.clipboard nor document.execCommand, so
// both are stubbed per test and removed afterwards (EmptyState.copy.test.tsx's
// stubs).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copyText";

const VALUE = "bc1q" + "x".repeat(38);

// What every textarea in the document held at the moment execCommand ran.
let textareasAtCall: string[][];

function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

function stubExecCommand(impl: () => boolean) {
  const fn = vi.fn((_cmd: string) => {
    textareasAtCall.push(Array.from(document.querySelectorAll("textarea")).map((t) => t.value));
    return impl();
  });
  Object.defineProperty(document, "execCommand", { value: fn, configurable: true, writable: true });
  return fn;
}

beforeEach(() => {
  textareasAtCall = [];
});

afterEach(() => {
  delete (navigator as any).clipboard;
  delete (document as any).execCommand;
});

describe("copyText", () => {
  it("clipboard API present and resolving: copies through it, never touches execCommand, succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    const exec = stubExecCommand(() => true);

    expect(await copyText(VALUE)).toBe(true);
    expect(writeText).toHaveBeenCalledWith(VALUE);
    expect(exec).not.toHaveBeenCalled();
  });

  it("clipboard API absent: a textarea holds exactly the value when execCommand('copy') runs, succeeds", async () => {
    stubClipboard(undefined);
    const exec = stubExecCommand(() => true);

    expect(await copyText(VALUE)).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(textareasAtCall).toEqual([[VALUE]]);
  });

  it("clipboard API rejects: falls back to the textarea copy, succeeds", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    stubClipboard({ writeText });
    const exec = stubExecCommand(() => true);

    expect(await copyText(VALUE)).toBe(true);
    expect(writeText).toHaveBeenCalledWith(VALUE);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(textareasAtCall).toEqual([[VALUE]]);
  });

  it("execCommand returns false: fails", async () => {
    stubClipboard(undefined);
    const exec = stubExecCommand(() => false);

    expect(await copyText(VALUE)).toBe(false);
    // The fallback really ran and really failed — not a crash before it.
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("execCommand throws: fails rather than throwing", async () => {
    stubClipboard(undefined);
    stubExecCommand(() => { throw new Error("unsupported"); });

    expect(await copyText(VALUE)).toBe(false);
  });

  for (const [name, impl] of [
    ["succeeds", () => true],
    ["returns false", () => false],
    ["throws", () => { throw new Error("unsupported"); }],
  ] as const) {
    it(`the textarea is removed afterwards when execCommand ${name}`, async () => {
      stubClipboard(undefined);
      stubExecCommand(impl);

      await copyText(VALUE);
      // Anti-vacuity: the textarea existed while the copy ran.
      expect(textareasAtCall).toEqual([[VALUE]]);
      expect(document.querySelectorAll("textarea").length).toBe(0);
    });
  }
});
