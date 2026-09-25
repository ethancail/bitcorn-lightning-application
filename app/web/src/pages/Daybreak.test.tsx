// Daybreak member screen, rendered — spec §3.4.3 (bitcorn-research,
// specs/2026-09-21-bitcorn-daybreak-spec.md), first tests 38, 40–44 and 46's
// permitting half, plus §3.5/§3.6 (inherits text scale; no orange, no red).
//
// ─── WHY FETCH IS STUBBED, NOT THE API CLIENT ───────────────────────────────
// Test 40 is about what reaches the screen from the REAL client: apiFetch turns
// a non-JSON error body into `{ error: res.statusText }` (api/client.ts:68),
// and a network failure into a browser TypeError. Mocking `api` would skip
// exactly that path. So every test here stubs global fetch and lets the real
// client run.
//
// ─── THE SHAPE OF EVERY FORBIDDING TEST ─────────────────────────────────────
// Each absence assertion is paired with a positive built from the same fixture
// with one thing changed (the house rule, MemberDashboard.namePrompt.test.tsx
// header), so "not there" cannot pass on a screen that renders nothing.
//
// Band tables here are TEST FIXTURES, not Kevin's labels.
//
// Harness: react-dom/client createRoot inside act(), no Testing Library.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import React from "react";
import Daybreak from "./Daybreak";
import { CLOSER_SIGNATURE, GENERIC_ERROR, HELD_OVER_MARK, bandsUnavailableCopy, daybreakErrorCopy, zUnavailableCopy } from "../daybreak/daybreakCopy";

type Band = { lower: number | null; upper: number | null; label: string };

const ORIGINAL: Band[] = [
  { lower: null, upper: -1, label: "Fixture A" },
  { lower: -1, upper: -0.25, label: "Fixture B" },
  { lower: -0.25, upper: 0.25, label: "Fixture C" },
  { lower: 0.25, upper: 1, label: "Fixture D" },
  { lower: 1, upper: null, label: "Fixture E" },
];

// Shifted boundaries, different labels, a different count; zero sits in index 1.
const RECALIBRATED: Band[] = [
  { lower: null, upper: -2, label: "Recal P" },
  { lower: -2, upper: 0.5, label: "Recal Q" },
  { lower: 0.5, upper: 3, label: "Recal R" },
  { lower: 3, upper: null, label: "Recal S" },
];

const CLOSES = {
  corn: { date: "2026-09-28", close: 4.1025, fetchedAt: "2026-09-28T23:10:00.000Z" },
  btc: { date: "2026-09-28", close: 63120.5, fetchedAt: "2026-09-28T23:10:01.000Z" },
};

function zWith(value: number, bands: unknown) {
  return { status: "available", value, ...CLOSES, bands };
}

const Z_ORIGINAL = zWith(-0.42, { status: "available", table: ORIGINAL, index: 1 });

function edition(opts: { state?: string; date?: string; z?: unknown; sections?: Record<string, unknown> } = {}) {
  const sections = opts.sections ?? {
    lead: "Corn opened flat.\n\nBitcoin held its range.",
    kevinsRead: "Kevin's paragraph.",
    insideAgriculture: "An agriculture note.",
    worthReading: { title: "A worthwhile read", note: "Why it matters.", link: "https://example.com/read" },
    closer: "See you tomorrow.",
  };
  return {
    state: opts.state ?? "current",
    dueDate: "2026-09-29",
    edition: { date: opts.date ?? "2026-09-29", content: { ...sections, workerOwned: { z: opts.z ?? Z_ORIGINAL } } },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

async function renderWith(respond: () => Promise<Response> | Response) {
  fetchMock = vi.fn(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(Daybreak));
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.unstubAllGlobals();
});

const q = (el: Element, id: string) => el.querySelector(`[data-testid="${id}"]`);
const qa = (el: Element, id: string) => Array.from(el.querySelectorAll(`[data-testid="${id}"]`));
const text = (el: Element | null) => el?.textContent ?? "";

// ─── The request ───────────────────────────────────────────────────────────

describe("the request", () => {
  it("calls GET /api/daybreak/edition with no query string — the proxy matches the URL exactly", async () => {
    await renderWith(() => json(edition()));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.endsWith("/api/daybreak/edition")).toBe(true);
    expect(url).not.toContain("?");
  });
});

// ─── Test 40 ───────────────────────────────────────────────────────────────

describe("test 40: every non-code outcome shows the ONE generic state; status and browser text never shown", () => {
  const NON_CODE: Array<[string, () => Promise<Response> | Response, string[]]> = [
    [
      "a non-JSON 502 error page",
      () => new Response("<html><body>Bad Gateway</body></html>", { status: 502, statusText: "Bad Gateway", headers: { "Content-Type": "text/html" } }),
      ["Bad Gateway", "502"],
    ],
    [
      "a network failure",
      () => {
        throw new TypeError("Failed to fetch");
      },
      ["Failed to fetch", "TypeError"],
    ],
    ["an unknown code", () => json({ error: "brand_new_code" }, 503), ["brand_new_code", "503"]],
    ["a 200 whose body is not an edition", () => json({ something: "else" }), ["something", "else"]],
  ];

  for (const [name, respond, leaks] of NON_CODE) {
    it(`${name} → the generic "couldn't load" state, and none of ${JSON.stringify(leaks)}`, async () => {
      const el = await renderWith(respond);
      const err = q(el, "daybreak-error");
      expect(err, "the error state must render").not.toBeNull();
      expect(text(err)).toContain(GENERIC_ERROR.headline);
      expect(text(err)).toContain(GENERIC_ERROR.body);
      for (const leak of leaks) expect(text(el)).not.toContain(leak);
    });
  }

  it("anti-vacuity: a RECOGNISED code renders its own words, not the generic state", async () => {
    const el = await renderWith(() => json({ error: "worker_unreachable" }, 503));
    const own = daybreakErrorCopy({ code: "worker_unreachable" });
    expect(own).not.toEqual(GENERIC_ERROR);
    expect(text(q(el, "daybreak-error"))).toContain(own.headline);
    expect(text(q(el, "daybreak-error"))).not.toContain(GENERIC_ERROR.headline);
  });

  it("anti-vacuity: the Worker's nested 503 reason reaches the copy", async () => {
    const el = await renderWith(() => json({ error: "worker_unavailable", reason: "daybreak_read_failed" }, 503));
    expect(text(q(el, "daybreak-error"))).toContain(daybreakErrorCopy({ code: "worker_unavailable", reason: "daybreak_read_failed" }).body);
    expect(text(el)).not.toContain("daybreak_read_failed");
  });

  it("anti-vacuity: a good edition shows no error state", async () => {
    const el = await renderWith(() => json(edition()));
    expect(q(el, "daybreak-error")).toBeNull();
    expect(q(el, "daybreak-date")).not.toBeNull();
  });
});

// ─── Test 41 ───────────────────────────────────────────────────────────────

describe("test 41: sections render as text, never as HTML", () => {
  const HOSTILE = {
    lead: "First <b>x</b> paragraph.\n\nSecond <img src=x onerror=alert(1)> paragraph.",
    closer: "<script>window.__pwned = true</script>",
  };

  it("permitting: markup characters render literally, and a blank line splits paragraphs", async () => {
    const el = await renderWith(() => json(edition({ sections: HOSTILE })));
    const lead = q(el, "daybreak-section-lead")!;
    expect(lead).not.toBeNull();
    const ps = lead.querySelectorAll("p");
    expect(ps.length).toBe(2);
    expect(ps[0].textContent).toBe("First <b>x</b> paragraph.");
    expect(text(q(el, "daybreak-section-closer"))).toContain("<script>window.__pwned = true</script>");
  });

  it("forbidding: no element is created from section content", async () => {
    const el = await renderWith(() => json(edition({ sections: HOSTILE })));
    const lead = q(el, "daybreak-section-lead")!;
    expect(lead.querySelector("b")).toBeNull();
    expect(lead.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect((window as any).__pwned).toBeUndefined();
  });

  it("an absent or unknown section is not rendered; a present one is", async () => {
    const el = await renderWith(() => json(edition({ sections: { lead: "Only a lead.", mystery: "unknown key text" } })));
    expect(q(el, "daybreak-section-lead")).not.toBeNull();
    for (const k of ["kevinsRead", "insideAgriculture", "worthReading", "closer"]) expect(q(el, `daybreak-section-${k}`), k).toBeNull();
    expect(text(el)).not.toContain("unknown key text");
  });

  it("the spec's section names head their sections", async () => {
    const el = await renderWith(() => json(edition()));
    expect(text(q(el, "daybreak-section-kevinsRead"))).toContain("Kevin's Read");
    expect(text(q(el, "daybreak-section-insideAgriculture"))).toContain("Inside Agriculture");
    expect(text(q(el, "daybreak-section-worthReading"))).toContain("Worth Reading");
  });

  it("the Closer's signature is rendered by the screen with the Closer, and not without it", async () => {
    const withCloser = await renderWith(() => json(edition()));
    expect(text(q(withCloser, "daybreak-section-closer"))).toContain(CLOSER_SIGNATURE);
    await act(async () => root!.unmount());
    root = null;
    withCloser.remove();
    const without = await renderWith(() => json(edition({ sections: { lead: "Lead only." } })));
    expect(text(without)).not.toContain(CLOSER_SIGNATURE);
  });
});

// ─── Test 42 ───────────────────────────────────────────────────────────────

describe("test 42: a non-https link is not rendered as a link", () => {
  const withLink = (link: string) => edition({ sections: { worthReading: { title: "A worthwhile read", note: "Why.", link } } });

  it("permitting: an https: URL renders as a link", async () => {
    const el = await renderWith(() => json(withLink("https://example.com/read")));
    const a = q(el, "daybreak-section-worthReading")!.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://example.com/read");
    expect(a!.textContent).toContain("A worthwhile read");
  });

  for (const bad of ["http://example.com/read", "javascript:alert(1)", "data:text/html,<b>x</b>", "/relative/read"]) {
    it(`forbidding: ${bad} never renders as a link (the title still shows as text)`, async () => {
      const el = await renderWith(() => json(withLink(bad)));
      const section = q(el, "daybreak-section-worthReading")!;
      expect(section).not.toBeNull();
      expect(section.querySelector("a")).toBeNull();
      expect(el.querySelector(`a[href]`)).toBeNull();
      expect(text(section)).toContain("A worthwhile read");
      expect(text(el)).not.toContain(bad);
    });
  }
});

// ─── Test 43 ───────────────────────────────────────────────────────────────

describe("test 43: a held-over edition shows its date and the mark", () => {
  it("permitting: held_over renders the edition's own date and the held-over mark", async () => {
    const el = await renderWith(() => json(edition({ state: "held_over", date: "2026-09-25" })));
    expect(text(q(el, "daybreak-date"))).toMatch(/\b25\b/);
    expect(q(el, "daybreak-held-over")).not.toBeNull();
    expect(text(q(el, "daybreak-held-over"))).toContain(HELD_OVER_MARK);
  });

  it("forbidding: a current edition never shows the mark — but still shows its date", async () => {
    const el = await renderWith(() => json(edition({ state: "current", date: "2026-09-25" })));
    expect(q(el, "daybreak-held-over")).toBeNull();
    expect(text(el)).not.toContain(HELD_OVER_MARK);
    expect(text(q(el, "daybreak-date"))).toMatch(/\b25\b/);
  });
});

// ─── Test 44 ───────────────────────────────────────────────────────────────

describe("test 44: calendar dates are never timezone-converted", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  for (const zone of ["America/Chicago", "America/New_York", "Pacific/Honolulu", "Asia/Tokyo"]) {
    it(`${zone}: edition 2026-09-29 shows the 29th, never the 28th or 30th`, async () => {
      process.env.TZ = zone;
      const el = await renderWith(() => json(edition({ date: "2026-09-29" })));
      const d = text(q(el, "daybreak-date"));
      expect(d).toMatch(/\b29\b/);
      expect(d).not.toMatch(/\b28\b/);
      expect(d).not.toMatch(/\b30\b/);
    });
  }
});

// ─── Tests 38 + 46 (render) ────────────────────────────────────────────────

describe("tests 38 + 46: the gauge renders ONLY the stamped table, coloured by position", () => {
  const segColours = (el: Element) => qa(el, "daybreak-gauge-band").map((s) => s.getAttribute("stroke"));
  const bounds = (el: Element) => qa(el, "daybreak-gauge-bound").map((t) => t.textContent);
  const legend = (el: Element) => qa(el, "daybreak-band-label").map((t) => t.textContent);

  it("test 46 permitting: a RECALIBRATED stamped table shows those boundaries, those labels and the stamped classification", async () => {
    const el = await renderWith(() => json(edition({ z: zWith(1.2, { status: "available", table: RECALIBRATED, index: 2 }) })));
    expect(bounds(el)).toEqual(["−2", "0.5", "3"]);
    expect(legend(el)).toEqual(["Recal P", "Recal Q", "Recal R", "Recal S"]);
    expect(text(q(el, "daybreak-band-current"))).toBe("Recal R");
  });

  it("test 38 permitting: the band holding 0 is amber, lower green, higher blue — under the recalibrated table", async () => {
    const el = await renderWith(() => json(edition({ z: zWith(1.2, { status: "available", table: RECALIBRATED, index: 2 }) })));
    expect(segColours(el)).toEqual(["var(--green)", "var(--amber)", "var(--blue)", "var(--blue)"]);
  });

  it("test 46 anti-vacuity: the same render with the ORIGINAL table shows the original boundaries and labels", async () => {
    const el = await renderWith(() => json(edition({ z: Z_ORIGINAL })));
    expect(bounds(el)).toEqual(["−1", "−0.25", "0.25", "1"]);
    expect(legend(el)).toEqual(["Fixture A", "Fixture B", "Fixture C", "Fixture D", "Fixture E"]);
    expect(text(q(el, "daybreak-band-current"))).toBe("Fixture B");
    expect(segColours(el)).toEqual(["var(--green)", "var(--green)", "var(--amber)", "var(--blue)", "var(--blue)"]);
  });

  it("test 38 forbidding: no band is red, and nothing on the screen uses red or the reserved orange", async () => {
    const el = await renderWith(() => json(edition({ z: zWith(1.2, { status: "available", table: RECALIBRATED, index: 2 }) })));
    const html = el.innerHTML;
    expect(html).not.toContain("--red");
    expect(html).not.toContain("--orange");
    expect(html).toContain("var(--amber)"); // anti-vacuity: the scan sees the gauge's colours
  });

  it("the Z is shown as the Worker delivered it, rounded for display", async () => {
    const el = await renderWith(() => json(edition({ z: Z_ORIGINAL })));
    expect(text(q(el, "daybreak-gauge-value"))).toBe("−0.42");
  });
});

describe("bands unavailable: the gauge shows the Z with NO band label", () => {
  it("permitting (paired): with bands available, the same Z shows a band label and a legend", async () => {
    const el = await renderWith(() => json(edition({ z: Z_ORIGINAL })));
    expect(q(el, "daybreak-band-current")).not.toBeNull();
    expect(qa(el, "daybreak-band-label").length).toBe(5);
  });

  it("forbidding: with bands unavailable, the Z is shown, with no band label, no legend and no band segments", async () => {
    const el = await renderWith(() => json(edition({ z: zWith(-0.42, { status: "unavailable", reason: "absent" }) })));
    expect(text(q(el, "daybreak-gauge-value"))).toBe("−0.42");
    expect(q(el, "daybreak-band-current")).toBeNull();
    expect(qa(el, "daybreak-band-label")).toEqual([]);
    expect(qa(el, "daybreak-gauge-band")).toEqual([]);
    expect(text(el)).toContain(bandsUnavailableCopy("absent"));
    expect(text(el)).not.toContain("Fixture");
  });

  it("a Z that is unavailable shows its reason's words and no gauge", async () => {
    const el = await renderWith(() => json(edition({ z: { status: "unavailable", reason: "stale_close" } })));
    expect(text(el)).toContain(zUnavailableCopy("stale_close"));
    expect(q(el, "daybreak-gauge-value")).toBeNull();
    expect(text(el)).not.toContain("stale_close");
  });
});

// ─── §3.5 D5: the edition inherits the member's text scale ─────────────────

describe("§3.5: gauge text is sized in rem so it follows the member's text scale", () => {
  it("every SVG text element takes a rem font size, and none carries a fixed font-size attribute", async () => {
    const el = await renderWith(() => json(edition({ z: Z_ORIGINAL })));
    const texts = Array.from(el.querySelectorAll("svg text"));
    expect(texts.length).toBeGreaterThan(0); // anti-vacuity: there is SVG text to check
    for (const t of texts) {
      expect(t.getAttribute("font-size"), "no fixed font-size attribute").toBeNull();
      expect((t as SVGElement).style.fontSize).toMatch(/rem$/);
    }
  });
});
