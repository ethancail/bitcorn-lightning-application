// The Daybreak Editor, rendered — spec §3.4.5 (bitcorn-research,
// specs/2026-09-21-bitcorn-daybreak-spec.md), first tests 80, 81, 82, 85, 86
// and the screen halves of 73 and 76.
//
// ─── WHY FETCH IS STUBBED, NOT THE API CLIENT ───────────────────────────────
// Tests 85 and 86 are about which requests LEAVE the browser and in what order,
// and test 80 about what reaches the screen from the REAL client (a non-JSON
// error becomes `{ error: res.statusText }`; a network failure a TypeError).
// Mocking `api` would skip exactly that. So global fetch is a recording spy and
// the real client runs.
//
// Each absence assertion is paired with a positive from the same fixture with
// one thing changed, so "not there" cannot pass on a screen that renders nothing.
//
// Band tables here are TEST FIXTURES, not Kevin's labels.
//
// Harness: react-dom/client createRoot inside act(), no Testing Library.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";

const N = "2026-10-07"; // the next due edition
const P = "2026-10-06"; // the most recent

const BANDS = [
  { lower: null, upper: -1, label: "Fixture A" },
  { lower: -1, upper: -0.25, label: "Fixture B" },
  { lower: -0.25, upper: 0.25, label: "Fixture C" },
  { lower: 0.25, upper: null, label: "Fixture D" },
];

const zAvailable = (closeDate = P) => ({
  status: "available",
  value: -0.42,
  corn: { date: closeDate, close: 4.1025, fetchedAt: "2026-10-06T23:10:00.000Z" },
  btc: { date: closeDate, close: 63120.5, fetchedAt: "2026-10-06T23:10:01.000Z" },
  bands: { status: "available", table: BANDS, index: 1 },
});

const STORED_N = {
  lead: "Stored lead for the next edition.",
  kevinsRead: "Stored read.",
  insideAgriculture: "Stored agriculture.",
  worthReading: { title: "Stored title", note: "Stored note.", link: "https://example.com/stored" },
  closer: "Stored closer.",
};
const STORED_P = { lead: "Stored lead for the most recent edition.", closer: "Yesterday's closer." };

type Entry = { date: string; published: boolean; content?: Record<string, unknown>; code?: string };

function readBody(opts: { next?: Partial<Entry>; recent?: Partial<Entry>; z?: unknown } = {}) {
  const z = opts.z ?? zAvailable();
  return {
    next: { date: N, published: false, content: { ...STORED_N, workerOwned: { z } }, ...opts.next },
    recent: { date: P, published: true, content: { ...STORED_P, workerOwned: { z } }, ...opts.recent },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { method: string; path: string; body: any };
type Handler = (call: Call) => Promise<Response> | Response;

let calls: Call[] = [];
let handlers: { read: Handler; save: Handler; publish: Handler };
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function stubFetch(h: Partial<typeof handlers>) {
  handlers = {
    read: () => json(readBody()),
    save: (c) => json({ date: c.body?.date, z: { status: "available" } }),
    publish: (c) => json({ date: c.body?.date }),
    ...h,
  };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      let body: any = null;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      const call = { method, path, body };
      calls.push(call);
      if (method === "GET" && path === "/api/daybreak/editor") return handlers.read(call);
      if (method === "POST" && path === "/api/daybreak/editor/save") return handlers.save(call);
      if (method === "POST" && path === "/api/daybreak/editor/publish") return handlers.publish(call);
      throw new Error(`unexpected request ${method} ${path}`);
    }),
  );
}

async function flush(n = 6) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function renderEditor(h: Partial<typeof handlers> = {}) {
  stubFetch(h);
  const { default: DaybreakEditor } = await import("./DaybreakEditor");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(DaybreakEditor));
  });
  await flush();
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const q = (el: Element, id: string) => el.querySelector(`[data-testid="${id}"]`);
const qa = (el: Element, id: string) => Array.from(el.querySelectorAll(`[data-testid="${id}"]`));
const text = (el: Element | null) => el?.textContent ?? "";
const field = (el: Element, name: string) => el.querySelector(`[data-field="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
const editable = (el: Element) => Array.from(el.querySelectorAll("input, textarea, select")).filter((i) => !(i as HTMLInputElement).disabled);
const posts = () => calls.filter((c) => c.method === "POST").map((c) => c.path);

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(el: Element | null) {
  expect(el, "the element to click exists").not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function edit(el: Element, name: string, value: string) {
  await act(async () => {
    typeInto(field(el, name)!, value);
  });
}

function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 80 — the screen's states (R11).
// ═══════════════════════════════════════════════════════════════════════════

describe("test 80: each state renders from its fixture", () => {
  it("ANTI-VACUITY / editing: the editing fixture renders every field, holding the stored copy", async () => {
    const el = await renderEditor();
    for (const name of ["lead", "kevinsRead", "insideAgriculture", "wrTitle", "wrNote", "wrLink", "closer"]) {
      expect(field(el, name), name).not.toBeNull();
    }
    expect(field(el, "lead")!.value).toBe(STORED_N.lead);
    expect(field(el, "wrLink")!.value).toBe(STORED_N.worthReading.link);
    expect(editable(el).length).toBe(7);
    expect(q(el, "editor-no-draft")).toBeNull();
  });

  it("FORBIDS / loading: a placeholder and NO input while the read is pending", async () => {
    const el = await renderEditor({ read: () => new Promise<Response>(() => {}) });
    expect(q(el, "editor-loading")).not.toBeNull();
    expect(el.querySelectorAll("input, textarea").length).toBe(0);
    expect(q(el, "editor-save")).toBeNull();
    expect(q(el, "editor-publish")).toBeNull();
  });

  for (const [what, respond] of [
    ["a 502 with a non-JSON body", () => new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" })],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 200 the editor cannot read", () => json({ next: "nonsense" })],
    ["a coded 503", () => json({ error: "editor_not_configured" }, 503)],
  ] as const) {
    it(`FORBIDS / load failed (${what}): one message, a Retry, NO form, and no status or browser error text`, async () => {
      const el = await renderEditor({ read: respond as Handler });
      const failed = q(el, "editor-load-failed");
      expect(failed).not.toBeNull();
      expect(el.querySelectorAll("input, textarea").length).toBe(0);
      expect(q(el, "editor-save")).toBeNull();
      expect(failed!.querySelector("button")?.textContent).toContain("Try again");
      for (const leak of ["Bad Gateway", "Failed to fetch", "502", "503", "editor_not_configured", "TypeError"]) {
        expect(text(el), leak).not.toContain(leak);
      }
    });
  }

  it("PERMITS / load failed → Retry: a successful re-read brings the form", async () => {
    let fail = true;
    const el = await renderEditor({ read: () => (fail ? json({ error: "worker_unreachable" }, 503) : json(readBody())) });
    expect(q(el, "editor-load-failed")).not.toBeNull();
    fail = false;
    await click(q(el, "editor-load-failed")!.querySelector("button"));
    await flush();
    expect(q(el, "editor-load-failed")).toBeNull();
    expect(field(el, "lead")!.value).toBe(STORED_N.lead);
  });

  it("no draft: an empty form for the edition date, noting that the first save computes the Z", async () => {
    const el = await renderEditor({ read: () => json(readBody({ next: { content: undefined, code: "no_draft" } })) });
    expect(text(q(el, "editor-edition-date"))).toMatch(/\b7\b/);
    expect(q(el, "editor-no-draft")).not.toBeNull();
    expect(text(q(el, "editor-z-status"))).toContain("Computed on first save.");
    expect(editable(el).length).toBe(7);
    for (const i of editable(el)) expect((i as HTMLInputElement).value).toBe("");
  });

  it("saving: inputs and BOTH buttons are disabled while the save is in flight", async () => {
    const save = deferred();
    const el = await renderEditor({ save: () => save.promise });
    await click(q(el, "editor-save"));
    expect(editable(el)).toHaveLength(0);
    expect((q(el, "editor-save") as HTMLButtonElement).disabled).toBe(true);
    expect((q(el, "editor-publish") as HTMLButtonElement).disabled).toBe(true);
    save.resolve(json({ date: N, z: { status: "available" } }));
    await flush();
    expect(editable(el)).toHaveLength(7); // anti-vacuity: re-enabled after
  });

  it("saved: a confirmation, with the Z's status updated from the save's response", async () => {
    // The post-save re-read FAILS, so the status shown can only have come from
    // the save's own response.
    let reads = 0;
    const el = await renderEditor({
      read: () => (reads++ === 0 ? json(readBody({ next: { content: undefined, code: "no_draft" } })) : json({ error: "worker_unreachable" }, 503)),
      save: () => json({ date: N, z: { status: "unavailable", reason: "fetch_failed" } }),
    });
    expect(text(q(el, "editor-z-status"))).toContain("Computed on first save."); // before the save
    await edit(el, "lead", "A first lead.");
    await click(q(el, "editor-save"));
    await flush();
    expect(q(el, "editor-toast")?.getAttribute("data-kind")).toBe("success");
    expect(text(q(el, "editor-toast"))).toContain("Saved.");
    expect(text(q(el, "editor-z-status"))).toContain("The latest corn or bitcoin price couldn't be fetched");
    expect(reads, "the re-read was attempted, and failed").toBe(2);
    expect(q(el, "editor-no-draft"), "the no-draft note is gone once the save created the draft").toBeNull();
  });

  it("save failed: a message, with the form and the typed text kept", async () => {
    const el = await renderEditor({ save: () => json({ error: "editor_refused", reason: "invalid_link", field: "worthReading.link" }, 400) });
    await edit(el, "wrLink", "http://not-https.example");
    await click(q(el, "editor-save"));
    await flush();
    expect(q(el, "editor-toast")?.getAttribute("data-kind")).toBe("error");
    expect(text(q(el, "editor-toast"))).toContain("https://");
    expect(field(el, "wrLink")!.value).toBe("http://not-https.example");
    expect(editable(el)).toHaveLength(7);
  });

  it("published: the most recent edition, published, opens as live; republishing stays available", async () => {
    const el = await renderEditor();
    await click(el.querySelector('[data-testid="editor-edition-choice"][data-slot="recent"]'));
    expect(text(q(el, "editor-publish-status"))).toContain("members can see this edition");
    expect((q(el, "editor-publish") as HTMLButtonElement).disabled).toBe(false);
  });

  it("the most recent edition, UNPUBLISHED, reads as not yet live — members see held over", async () => {
    const el = await renderEditor({ read: () => json(readBody({ recent: { published: false } })) });
    await click(el.querySelector('[data-testid="editor-edition-choice"][data-slot="recent"]'));
    const s = text(q(el, "editor-publish-status"));
    expect(s).toContain("Not published yet");
    expect(s).toContain("held over");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Worth Reading is all three fields or none — the screen refuses a partial.
// The Worker refuses a missing link, but ACCEPTS an empty title or note, so
// this refusal is the screen's own and nothing is sent.
// ═══════════════════════════════════════════════════════════════════════════

describe("a partly filled Worth Reading is refused by the screen, and nothing is sent", () => {
  const INCOMPLETE = "Couldn't save: Worth Reading needs a title, a note and a link — or leave all three empty.";
  const FULL = { wrTitle: "A title", wrNote: "A note.", wrLink: "https://example.com/read" };
  const NONE = { wrTitle: "", wrNote: "", wrLink: "" };
  // Every way to fill some but not all of the three.
  const PARTIALS: Array<Record<string, string>> = [
    { ...NONE, wrTitle: FULL.wrTitle },
    { ...NONE, wrNote: FULL.wrNote },
    { ...NONE, wrLink: FULL.wrLink },
    { ...FULL, wrTitle: "" },
    { ...FULL, wrNote: "   " }, // whitespace is empty
    { ...FULL, wrLink: "" },
  ];

  async function fill(el: Element, values: Record<string, string>) {
    for (const [name, value] of Object.entries(values)) await edit(el, name, value);
  }

  for (const partial of PARTIALS) {
    const shape = Object.entries(partial).map(([k, v]) => `${k}=${v.trim() ? "set" : "empty"}`).join(" ");
    it(`FORBIDS (${shape}): Save sends nothing and says exactly why; the text is kept`, async () => {
      const el = await renderEditor();
      await fill(el, partial);
      await click(q(el, "editor-save"));
      await flush();
      expect(posts()).toEqual([]);
      expect(text(q(el, "editor-toast"))).toBe(`${INCOMPLETE} Your text is still here.`);
      for (const [name, value] of Object.entries(partial)) expect(field(el, name)!.value).toBe(value);
    });

    it(`FORBIDS (${shape}): Save and publish sends neither request and says nothing was published`, async () => {
      const el = await renderEditor();
      await fill(el, partial);
      await click(q(el, "editor-publish"));
      await flush();
      expect(posts()).toEqual([]);
      expect(text(q(el, "editor-toast"))).toBe(`${INCOMPLETE} Nothing was published. Your text is still here.`);
    });
  }

  it("PERMITS: all three filled — the save is sent with all three", async () => {
    const el = await renderEditor();
    await fill(el, FULL);
    await click(q(el, "editor-save"));
    await flush();
    expect(posts()).toEqual(["/api/daybreak/editor/save"]);
    expect(calls.find((c) => c.method === "POST")!.body.sections.worthReading).toEqual({ title: FULL.wrTitle, note: FULL.wrNote, link: FULL.wrLink });
  });

  it("PERMITS: all three empty — the save is sent with no Worth Reading at all", async () => {
    const el = await renderEditor();
    await fill(el, NONE);
    await click(q(el, "editor-publish"));
    await flush();
    expect(posts()).toEqual(["/api/daybreak/editor/save", "/api/daybreak/editor/publish"]);
    expect("worthReading" in calls.find((c) => c.method === "POST")!.body.sections).toBe(false);
  });

  it("ANTI-VACUITY: completing the missing field lets the very same form save", async () => {
    const el = await renderEditor();
    await fill(el, { ...FULL, wrNote: "" });
    await click(q(el, "editor-save"));
    await flush();
    expect(posts()).toEqual([]);
    await edit(el, "wrNote", FULL.wrNote);
    await click(q(el, "editor-save"));
    await flush();
    expect(posts()).toEqual(["/api/daybreak/editor/save"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 73, the screen half — which editions (R6, ruling (A)).
// ═══════════════════════════════════════════════════════════════════════════

describe("test 73 (screen): the editor opens on N, and P is the one other choice", () => {
  it("PERMITS: N is the default — its date and its stored copy are what open", async () => {
    const el = await renderEditor();
    const chosen = el.querySelector('[data-testid="editor-edition-choice"][aria-pressed="true"]');
    expect(chosen?.getAttribute("data-slot")).toBe("next");
    expect(text(chosen)).toContain("Next due edition");
    expect(text(q(el, "editor-edition-date"))).toMatch(/\b7\b/);
    expect(field(el, "lead")!.value).toBe(STORED_N.lead);
  });

  it("FORBIDS: exactly two choices — N and P — and no other date can be reached", async () => {
    const el = await renderEditor();
    const choices = qa(el, "editor-edition-choice");
    expect(choices.map((c) => c.getAttribute("data-slot"))).toEqual(["next", "recent"]);
    expect(el.querySelectorAll('input[type="date"], [data-testid*="calendar"]').length).toBe(0);
  });

  it("ANTI-VACUITY: choosing P switches the date and the form, and a save sends P's date", async () => {
    const el = await renderEditor();
    await click(el.querySelector('[data-testid="editor-edition-choice"][data-slot="recent"]'));
    expect(text(q(el, "editor-edition-date"))).toMatch(/\b6\b/);
    expect(field(el, "lead")!.value).toBe(STORED_P.lead);
    await click(q(el, "editor-save"));
    await flush();
    expect(calls.find((c) => c.path === "/api/daybreak/editor/save")?.body.date).toBe(P);
  });

  it("an unsaved edit on one edition survives switching to the other and back", async () => {
    const el = await renderEditor();
    await edit(el, "lead", "Unsaved words for N.");
    await click(el.querySelector('[data-testid="editor-edition-choice"][data-slot="recent"]'));
    await click(el.querySelector('[data-testid="editor-edition-choice"][data-slot="next"]'));
    expect(field(el, "lead")!.value).toBe("Unsaved words for N.");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 76, the screen half — the Z's status, prominent (R10).
// ═══════════════════════════════════════════════════════════════════════════

describe("test 76 (screen): the Z's status sits above the sections", () => {
  it("PERMITS: an available Z renders its value, the stamped band's label and both close dates, ABOVE the sections", async () => {
    const el = await renderEditor();
    const status = q(el, "editor-z-status")!;
    expect(text(q(el, "editor-z-value"))).toBe("−0.42");
    expect(text(q(el, "editor-z-band"))).toContain("Fixture B");
    const closes = qa(el, "editor-z-close").map(text);
    expect(closes).toHaveLength(2);
    expect(closes[0]).toMatch(/^Corn: as of .*\b6\b.*'s close$/);
    expect(closes[1]).toMatch(/^Bitcoin: as of .*\b6\b.*'s close$/);
    const firstField = field(el, "lead")!;
    expect(status.compareDocumentPosition(firstField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("PERMITS: an unavailable Z renders its reason as text", async () => {
    const el = await renderEditor({ read: () => json(readBody({ z: { status: "unavailable", reason: "future_dated_close" } })) });
    expect(text(q(el, "editor-z-status"))).toContain("A price was dated after this edition, so it wasn't used.");
    expect(text(q(el, "editor-z-status"))).not.toContain("future_dated_close");
  });

  it("FORBIDS: text claiming the Z is unavailable, while it is available, is saved with NO warning and nothing blocks it", async () => {
    const el = await renderEditor();
    await edit(el, "lead", "The Z-Score is unavailable today.");
    await click(q(el, "editor-save"));
    await flush();
    const save = calls.find((c) => c.path === "/api/daybreak/editor/save");
    expect(save?.body.sections.lead).toBe("The Z-Score is unavailable today.");
    expect(q(el, "editor-toast")?.getAttribute("data-kind")).toBe("success");
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(q(el, "editor-z-status"), "anti-vacuity: the status element is in this same render").not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 81 — phone-first; no autoBuy, no calendar (R11).
// ═══════════════════════════════════════════════════════════════════════════

const EDITOR_FILES = [
  join(__dirname, "DaybreakEditor.tsx"),
  ...readdirSync(join(__dirname, "..", "daybreakEditor"))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(__dirname, "..", "daybreakEditor", f)),
];

const AUTOBUY_IMPORT = /(?:from\s+|import\s*\(\s*)["'][^"']*components\/autoBuy\//;
const FORBIDDEN_SOURCE: Array<[string, RegExp]> = [
  ["an import from components/autoBuy/", AUTOBUY_IMPORT],
  ["MonthGrid", /\bMonthGrid\b/],
  ["YearHeatmap", /\bYearHeatmap\b/],
  ["an import from DayForm", /(?:from\s+|import\s*\(\s*)["'][^"']*DayForm["']/],
  ["DayForm's grid", /2fr 1fr 8rem auto auto/],
  ["a clock-derived date (new Date / Date.now)", /new Date\s*\(|Date\.now\s*\(/],
  ["todayUtcDate", /\btodayUtcDate\b/],
];

describe("test 81: phone-first, one column; no autoBuy import, no calendar, no clock", () => {
  it("PERMITS: all five sections render in one column, with no multi-column grid anywhere", async () => {
    const el = await renderEditor();
    expect(qa(el, "editor-section").map((s) => s.getAttribute("data-section"))).toEqual([
      "lead",
      "kevinsRead",
      "insideAgriculture",
      "worthReading",
      "closer",
    ]);
    const multi = Array.from(el.querySelectorAll<HTMLElement>("*")).filter((n) => {
      const g = n.style.gridTemplateColumns;
      return g !== "" && g.trim().split(/\s+/).length > 1;
    });
    expect(multi.map((n) => n.outerHTML.slice(0, 80))).toEqual([]);
  });

  it("FORBIDS: a source scan of the editor's files finds no autoBuy import, calendar, DayForm grid or clock-derived date", () => {
    expect(EDITOR_FILES.length, "the scan covers the page and its modules").toBeGreaterThanOrEqual(3);
    for (const f of EDITOR_FILES) {
      const src = readFileSync(f, "utf8");
      for (const [what, re] of FORBIDDEN_SOURCE) expect(re.test(src), `${f} contains ${what}`).toBe(false);
    }
  });

  it("ANTI-VACUITY: the same scan over ValuationInput.tsx finds its autoBuy import and todayUtcDate", () => {
    const src = readFileSync(join(__dirname, "ValuationInput.tsx"), "utf8");
    expect(AUTOBUY_IMPORT.test(src)).toBe(true);
    expect(/\btodayUtcDate\b/.test(src)).toBe(true);
    const lookup = Object.fromEntries(FORBIDDEN_SOURCE);
    expect(lookup["an import from DayForm"].test(src), "ValuationInput imports DayForm").toBe(true);
    const dayForm = readFileSync(join(__dirname, "..", "components", "valuation", "DayForm.tsx"), "utf8");
    expect(lookup["DayForm's grid"].test(dayForm), "DayForm carries the grid the scan names").toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 82 — Central dates, never converted (R11).
// ═══════════════════════════════════════════════════════════════════════════

describe("test 82: Central calendar dates render as written, in every zone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  const ZONES = ["America/Chicago", "America/New_York", "Pacific/Honolulu", "Asia/Tokyo"];
  const fixture = () => json(readBody({ next: { date: P }, recent: { date: "2026-10-05" }, z: zAvailable("2026-10-06") }));

  for (const zone of ZONES) {
    it(`${zone}: edition 2026-10-06 and its close dates show the 6th — never the 5th or the 7th`, async () => {
      process.env.TZ = zone;
      const el = await renderEditor({ read: fixture });
      const shown = [text(q(el, "editor-edition-date")), ...qa(el, "editor-z-close").map(text)];
      expect(shown).toHaveLength(3);
      for (const s of shown) {
        expect(s).toMatch(/\b6\b/);
        expect(s).not.toMatch(/\b5\b/);
        expect(s).not.toMatch(/\b7\b/);
      }
    });
  }

  it("FORBIDS: no publish time and no 'updated' mark appear", async () => {
    process.env.TZ = "America/Chicago";
    const el = await renderEditor({ read: fixture });
    await click(el.querySelector('[data-testid="editor-edition-choice"][data-slot="recent"]'));
    const all = text(el);
    expect(all).not.toMatch(/updated/i);
    expect(all).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    expect(text(q(el, "editor-publish-status")), "anti-vacuity: the published edition's status IS shown").toContain("Published");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 85 — Publish saves first (ruling (B)).
// ═══════════════════════════════════════════════════════════════════════════

describe("test 85: Publish sends the save, and the publish only after the save succeeds", () => {
  it("ANTI-VACUITY: before Publish, the stored copy differs from the form's text", async () => {
    const el = await renderEditor();
    await edit(el, "lead", "Edited, not yet saved.");
    expect(field(el, "lead")!.value).not.toBe(STORED_N.lead);
    expect(posts()).toEqual([]);
  });

  it("PERMITS: save then publish, in that order; the save carries the FORM's text; the publish carries the date", async () => {
    const el = await renderEditor();
    await edit(el, "lead", "Edited, not yet saved.");
    await click(q(el, "editor-publish"));
    await flush();
    expect(posts()).toEqual(["/api/daybreak/editor/save", "/api/daybreak/editor/publish"]);
    const [save, publish] = calls.filter((c) => c.method === "POST");
    expect(save.body).toEqual({ date: N, sections: { ...STORED_N, lead: "Edited, not yet saved." } });
    expect(publish.body).toEqual({ date: N });
    expect(text(q(el, "editor-toast"))).toContain("Published.");
  });

  it("FORBIDS: the publish is never sent before the save responds, and the pre-edit text is never what is saved", async () => {
    const save = deferred();
    const el = await renderEditor({ save: () => save.promise });
    await edit(el, "lead", "Edited, not yet saved.");
    await click(q(el, "editor-publish"));
    await flush();
    expect(posts()).toEqual(["/api/daybreak/editor/save"]);
    save.resolve(json({ date: N, z: { status: "available" } }));
    await flush();
    expect(posts()).toEqual(["/api/daybreak/editor/save", "/api/daybreak/editor/publish"]);
    expect(calls.some((c) => c.body?.sections?.lead === STORED_N.lead)).toBe(false);
  });

  it("FORBIDS: a republish of the published most recent edition also sends the save first", async () => {
    const el = await renderEditor();
    await click(el.querySelector('[data-testid="editor-edition-choice"][data-slot="recent"]'));
    await edit(el, "closer", "A corrected closer.");
    await click(q(el, "editor-publish"));
    await flush();
    expect(posts()).toEqual(["/api/daybreak/editor/save", "/api/daybreak/editor/publish"]);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body.date)).toEqual([P, P]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 86 — a failed save blocks the publish (ruling (B)).
// ═══════════════════════════════════════════════════════════════════════════

describe("test 86: when the save fails, NO publish request is sent", () => {
  const failures: Array<[string, Handler]> = [
    ["a 400 validation code (a non-https link)", () => json({ error: "editor_refused", reason: "invalid_link", field: "worthReading.link" }, 400)],
    ["a 413", () => json({ error: "body_too_large" }, 413)],
    ["a 5xx", () => json({ error: "upstream_error", status: 500 }, 502)],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ];

  for (const [what, save] of failures) {
    it(`FORBIDS (${what}): no publish request; the save-failed state says nothing was published and keeps the text`, async () => {
      const el = await renderEditor({ save });
      await edit(el, "wrLink", "http://not-https.example");
      await click(q(el, "editor-publish"));
      await flush();
      expect(posts()).toEqual(["/api/daybreak/editor/save"]);
      expect(q(el, "editor-toast")?.getAttribute("data-kind")).toBe("error");
      expect(text(q(el, "editor-toast"))).toContain("Nothing was published.");
      expect(field(el, "wrLink")!.value).toBe("http://not-https.example");
      expect(text(el)).not.toContain("Failed to fetch");
    });
  }

  it("PERMITS / ANTI-VACUITY: the same Publish, with the link fixed, publishes", async () => {
    const el = await renderEditor({
      save: (c) =>
        c.body.sections.worthReading?.link?.startsWith("https://")
          ? json({ date: N, z: { status: "available" } })
          : json({ error: "editor_refused", reason: "invalid_link", field: "worthReading.link" }, 400),
    });
    await edit(el, "wrLink", "https://example.com/fixed");
    await click(q(el, "editor-publish"));
    await flush();
    expect(posts()).toEqual(["/api/daybreak/editor/save", "/api/daybreak/editor/publish"]);
    expect(text(q(el, "editor-toast"))).toContain("Published.");
  });

  it("publish failed after a successful save: the message says it is saved and not published", async () => {
    const el = await renderEditor({ publish: () => json({ error: "worker_unreachable" }, 503) });
    await click(q(el, "editor-publish"));
    await flush();
    expect(posts()).toEqual(["/api/daybreak/editor/save", "/api/daybreak/editor/publish"]);
    expect(text(q(el, "editor-toast"))).toBe("Saved, but not published. Your text is saved — try publishing again.");
  });
});
