// Daybreak edition storage seam (src/daybreak/store.ts).
//
// Numbered tests refer to the Daybreak spec's first-tests list (§3.3). Each
// has a PERMITTING case and a FORBIDDING case; every "X is not shown" rides
// with a companion proving the same read could have shown X (§5.2) — a store
// that fails open to empty must not be able to pass.
//
// Keys are written here as string literals on purpose: that pins the format
// `daybreak:<date>:<draft|working|published>` from the outside, so a change to
// the module's key builder is a visible test failure, not a silent re-address.

import { describe, expect, it } from "vitest";
import type { DaybreakCalendar } from "../../src/daybreak/dates";
import {
  DEFAULT_MAX_LOOKBACK_DAYS,
  findLatestPublished,
  publishEdition,
  readEditionStatus,
  readPublished,
  writeDraft,
  writeWorking,
} from "../../src/daybreak/store";

type Op = { op: "get" | "put" | "delete"; key: string };

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  const ops: Op[] = [];
  const kv = {
    async get(key: string) {
      ops.push({ op: "get", key });
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      ops.push({ op: "put", key });
      store.set(key, value);
    },
    async delete(key: string) {
      ops.push({ op: "delete", key });
      store.delete(key);
    },
  } as unknown as KVNamespace;
  const count = (op: Op["op"]) => ops.filter((o) => o.op === op).length;
  return { kv, store, ops, count, reset: () => (ops.length = 0) };
}

const at = (iso: string) => new Date(iso);
const TUE = "2026-09-22";
const WED = "2026-09-23";
const tueEdition = { headline: "Tuesday edition" };
const wedDraft = { headline: "Wednesday DRAFT (agent)" };
const wedWorking = { headline: "Wednesday WORKING (Kevin's edits)" };
const wedFinal = { headline: "Wednesday edition" };

// Wed 2026-09-23 (CDT, UTC−5)
const WED_0512 = at("2026-09-23T10:12:00Z");
const WED_0559 = at("2026-09-23T10:59:59Z");
const WED_0600 = at("2026-09-23T11:00:00Z");
const WED_0700 = at("2026-09-23T12:00:00Z");
const TUE_2000 = at("2026-09-23T01:00:00Z"); // Tue 20:00 CDT = Wed 01:00 UTC

async function publishTuesday(kv: KVNamespace) {
  expect((await writeDraft(kv, TUE, tueEdition)).ok).toBe(true);
  expect((await publishEdition(kv, TUE)).ok).toBe(true);
}

function stored(store: Map<string, string>, key: string): unknown {
  const raw = store.get(key);
  return raw === undefined ? undefined : JSON.parse(raw);
}

// ─── Member reads touch only the published key ─────────────────────────────

describe("test 1: a draft key with NO working and NO published key → HELD-OVER edition, never the draft", () => {
  it("renders Tuesday held over; the Wednesday draft never appears — and would, once published", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    expect((await writeDraft(kv, WED, wedDraft)).ok).toBe(true);

    const res = await readEditionStatus(kv, WED_0700);
    expect(res).toEqual({ ok: true, state: "held_over", dueDate: WED, edition: { date: TUE, content: tueEdition } }); // permitting
    expect(JSON.stringify(res)).not.toContain("DRAFT"); // forbidding

    // anti-vacuity: the same read, after publish, DOES show Wednesday — as current
    expect((await publishEdition(kv, WED)).ok).toBe(true);
    const after = await readEditionStatus(kv, WED_0700);
    expect(after).toEqual({ ok: true, state: "current", dueDate: WED, edition: { date: WED, content: wedDraft } });
  });
});

describe("test 2: a working key with NO published key → ALSO the held-over edition, never Kevin's unpublished edits", () => {
  it("renders Tuesday held over; the working content never appears — and would, once published", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    expect((await writeDraft(kv, WED, wedDraft)).ok).toBe(true);
    expect((await writeWorking(kv, WED, wedWorking)).ok).toBe(true);

    const res = await readEditionStatus(kv, WED_0700);
    expect(res).toEqual({ ok: true, state: "held_over", dueDate: WED, edition: { date: TUE, content: tueEdition } });
    expect(JSON.stringify(res)).not.toContain("WORKING");
    expect(JSON.stringify(res)).not.toContain("DRAFT");

    expect((await publishEdition(kv, WED)).ok).toBe(true);
    const after = await readEditionStatus(kv, WED_0700);
    expect(after).toEqual({ ok: true, state: "current", dueDate: WED, edition: { date: WED, content: wedWorking } });
  });
});

describe("test 3 (status level): an evening Central read after UTC midnight", () => {
  it("Tuesday's published edition is CURRENT at 20:00 CDT, never held over", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    const res = await readEditionStatus(kv, TUE_2000);
    expect(res).toEqual({ ok: true, state: "current", dueDate: TUE, edition: { date: TUE, content: tueEdition } });
    expect(res.ok && res.state).not.toBe("held_over");
  });
});

describe("test 4 (status level): the same instant from two browser timezones", () => {
  const chicago = at("2026-09-23T06:30:00-05:00");
  const newYork = at("2026-09-23T07:30:00-04:00");

  it("both held over while Wednesday is missing; both current once it is published; never different", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    const a1 = await readEditionStatus(kv, chicago);
    const b1 = await readEditionStatus(kv, newYork);
    expect(a1.ok && a1.state).toBe("held_over");
    expect(b1).toEqual(a1);

    await writeDraft(kv, WED, wedFinal);
    await publishEdition(kv, WED);
    const a2 = await readEditionStatus(kv, chicago);
    const b2 = await readEditionStatus(kv, newYork);
    expect(a2.ok && a2.state).toBe("current");
    expect(b2).toEqual(a2);
  });
});

// ─── The due time decides only when ABSENCE becomes late ───────────────────

describe("test 7: before 06:00 Central on a due day, with that day unpublished", () => {
  it("the previous edition renders CURRENT at 05:59:59 CDT — never held over", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    const res = await readEditionStatus(kv, WED_0559);
    expect(res).toEqual({ ok: true, state: "current", dueDate: TUE, edition: { date: TUE, content: tueEdition } });
    expect(res.ok && res.state).not.toBe("held_over");
  });

  it("…and pre-dawn just after Central midnight too (00:01 CDT)", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    const res = await readEditionStatus(kv, at("2026-09-23T05:01:00Z"));
    expect(res.ok && res.state).toBe("current");
  });
});

describe("test 8: after 06:00 Central on a due day, with that day still unpublished", () => {
  it("the previous edition renders HELD OVER, with its visible date — from exactly 06:00", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    for (const now of [WED_0600, WED_0700]) {
      const res = await readEditionStatus(kv, now);
      expect(res).toEqual({ ok: true, state: "held_over", dueDate: WED, edition: { date: TUE, content: tueEdition } });
    }
  });

  it("anti-vacuity: with that day PUBLISHED, the same read is current and carries no held-over mark", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    await writeDraft(kv, WED, wedFinal);
    await publishEdition(kv, WED);
    const res = await readEditionStatus(kv, WED_0700);
    expect(res).toEqual({ ok: true, state: "current", dueDate: WED, edition: { date: WED, content: wedFinal } });
  });
});

describe("test 9: an edition published before 06:00 Central renders immediately", () => {
  it("published at 05:12 CDT → the 05:12 read shows it, current — never withheld until the due time", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    // anti-vacuity: before the publish, the 05:12 read shows Tuesday
    const before = await readEditionStatus(kv, WED_0512);
    expect(before.ok && before.state === "current" && before.edition.date).toBe(TUE);

    await writeDraft(kv, WED, wedFinal);
    await publishEdition(kv, WED);
    const res = await readEditionStatus(kv, WED_0512);
    expect(res.ok && res.state).toBe("current"); // permitting
    expect(res.ok && res.state !== "unavailable" && res.edition).toEqual({ date: WED, content: wedFinal });
    expect(res.ok && res.state !== "unavailable" && res.edition.date).not.toBe(TUE); // forbidding
  });
});

// ─── Held over is decided by DATE COMPARISON (Ethan, 2026-09-23) ──────────

describe("held over by date comparison, not by the due date's own key", () => {
  const THU = "2026-09-24";
  const FRI = "2026-09-25"; // due (Mon–Fri) — left MISSING below
  const SAT = "2026-09-26"; // off-calendar
  const SAT_NOON = at("2026-09-26T17:00:00Z"); // Sat 12:00 CDT → due date is Fri
  const thuEdition = { headline: "Thursday edition" };
  const satEdition = { headline: "Saturday special edition" };

  async function publish(kv: KVNamespace, date: string, content: Record<string, unknown>) {
    expect((await writeDraft(kv, date, content)).ok).toBe(true);
    expect((await publishEdition(kv, date)).ok).toBe(true);
  }

  it("an off-calendar edition dated AFTER a missing due date renders CURRENT — never held over", async () => {
    const { kv, store } = mockKV();
    await publish(kv, THU, thuEdition);
    await publish(kv, SAT, satEdition);
    expect(store.has("daybreak:2026-09-25:published")).toBe(false); // the due edition really is missing

    const res = await readEditionStatus(kv, SAT_NOON);
    expect(res).toEqual({ ok: true, state: "current", dueDate: FRI, edition: { date: SAT, content: satEdition } }); // permitting
    expect(res.ok && res.state).not.toBe("held_over"); // forbidding
  });

  it("a missing due date with only OLDER editions still renders HELD OVER — and flips once it is published", async () => {
    const { kv } = mockKV();
    await publish(kv, THU, thuEdition);

    const res = await readEditionStatus(kv, SAT_NOON);
    expect(res).toEqual({ ok: true, state: "held_over", dueDate: FRI, edition: { date: THU, content: thuEdition } }); // permitting
    expect(res.ok && res.state).not.toBe("current"); // forbidding

    // anti-vacuity: the same read with the due edition present is current
    await publish(kv, FRI, { headline: "Friday edition" });
    const after = await readEditionStatus(kv, SAT_NOON);
    expect(after.ok && after.state).toBe("current");
    expect(after.ok && after.state !== "unavailable" && after.edition.date).toBe(FRI);
  });

  it("a due edition published LATE, dated its own due date, renders CURRENT once published", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    const WED_0900 = at("2026-09-23T14:00:00Z");
    const WED_0931 = at("2026-09-23T14:31:00Z");

    // Before: 09:00 Wed, three hours past due, Wednesday missing → held over.
    const before = await readEditionStatus(kv, WED_0900);
    expect(before.ok && before.state).toBe("held_over");

    // Kevin publishes Wednesday's edition at 09:30.
    await writeDraft(kv, WED, wedFinal);
    await publishEdition(kv, WED);
    const res = await readEditionStatus(kv, WED_0931);
    expect(res).toEqual({ ok: true, state: "current", dueDate: WED, edition: { date: WED, content: wedFinal } }); // permitting
    expect(res.ok && res.state).not.toBe("held_over"); // forbidding: lateness is not sticky
  });
});

describe("visibility: an edition is visible from Central midnight of its own date, never earlier (Ethan, 2026-09-23)", () => {
  const TUE_2100 = at("2026-09-23T02:00:00Z"); // Tue 21:00 CDT
  const TUE_235959 = at("2026-09-23T04:59:59Z"); // Tue 23:59:59 CDT
  const WED_0000 = at("2026-09-23T05:00:00Z"); // Wed 00:00 CDT

  it("a Wednesday edition published at 21:00 Tuesday is NOT visible Tuesday, and IS visible at 00:00 Wednesday", async () => {
    const { kv, store } = mockKV();
    await publishTuesday(kv);
    await writeDraft(kv, WED, wedFinal);
    await publishEdition(kv, WED); // published Tuesday evening
    expect(store.has("daybreak:2026-09-23:published")).toBe(true);

    for (const now of [TUE_2100, TUE_235959]) {
      const res = await readEditionStatus(kv, now);
      expect(res).toEqual({ ok: true, state: "current", dueDate: TUE, edition: { date: TUE, content: tueEdition } }); // Tuesday still shows Tuesday
      expect(JSON.stringify(res)).not.toContain("Wednesday"); // forbidding: never early
    }

    const res = await readEditionStatus(kv, WED_0000);
    expect(res).toEqual({ ok: true, state: "current", dueDate: TUE, edition: { date: WED, content: wedFinal } }); // permitting
  });
});

describe("status: nothing published at all", () => {
  it("→ unavailable (and a single published edition anywhere in the window flips it)", async () => {
    const { kv } = mockKV();
    await writeDraft(kv, WED, wedDraft);
    await writeWorking(kv, WED, wedWorking);
    expect(await readEditionStatus(kv, WED_0700)).toEqual({ ok: true, state: "unavailable" });
    await publishTuesday(kv);
    expect((await readEditionStatus(kv, WED_0700)).ok).toBe(true);
    const res = await readEditionStatus(kv, WED_0700);
    expect(res.ok && res.state).toBe("held_over");
  });
});

describe("status: the calendar is a PARAMETER", () => {
  const mwf: DaybreakCalendar = { dueWeekdays: [1, 3, 5], holidays: [] };
  const TUE_0700 = at("2026-09-22T12:00:00Z");

  it("Mon/Wed/Fri: Tuesday 07:00 with only Monday published is CURRENT (Tuesday is not due)", async () => {
    const { kv } = mockKV();
    await writeDraft(kv, "2026-09-21", { headline: "Monday" });
    await publishEdition(kv, "2026-09-21");
    const res = await readEditionStatus(kv, TUE_0700, mwf);
    expect(res).toEqual({ ok: true, state: "current", dueDate: "2026-09-21", edition: { date: "2026-09-21", content: { headline: "Monday" } } });
    // anti-vacuity: the default Mon–Fri calendar DOES call Tuesday late
    const dflt = await readEditionStatus(kv, TUE_0700);
    expect(dflt.ok && dflt.state).toBe("held_over");
  });

  it("a holiday on the due date means its absence is not late", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    const res = await readEditionStatus(kv, WED_0700, { dueWeekdays: [1, 2, 3, 4, 5], holidays: [WED] });
    expect(res.ok && res.state).toBe("current");
  });
});

// ─── Writes require an explicit date ───────────────────────────────────────

describe("test 5: a write carrying no target date", () => {
  it("permitting: an explicit date is accepted and files under that date (draft and working)", async () => {
    const { kv, store } = mockKV();
    expect(await writeDraft(kv, WED, wedDraft)).toEqual({ ok: true });
    expect(await writeWorking(kv, WED, wedWorking)).toEqual({ ok: true });
    expect(stored(store, "daybreak:2026-09-23:draft")).toEqual(wedDraft);
    expect(stored(store, "daybreak:2026-09-23:working")).toEqual(wedWorking);
    expect([...store.keys()].sort()).toEqual(["daybreak:2026-09-23:draft", "daybreak:2026-09-23:working"]);
  });

  const bad: Array<[string, unknown]> = [
    ["missing (undefined)", undefined],
    ["null", null],
    ["empty string", ""],
    ["unpadded", "2026-9-23"],
    ["with a time", "2026-09-23T00:00:00Z"],
    ["impossible", "2026-02-30"],
    ["a Date object", new Date("2026-09-23T12:00:00Z")],
    ["a number", 20260923],
  ];
  for (const [label, date] of bad) {
    it(`forbidding: a ${label} date is REJECTED and nothing is written — never defaulted from a clock`, async () => {
      const { kv, store, count } = mockKV();
      for (const write of [writeDraft, writeWorking]) {
        const res = await write(kv, date as string, wedDraft);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe("invalid_date");
      }
      expect(count("put")).toBe(0);
      expect(store.size).toBe(0);
    });
  }

  it("publish and published-read reject a malformed date too", async () => {
    const { kv, count } = mockKV();
    const p = await publishEdition(kv, undefined as unknown as string);
    expect(p.ok === false && p.reason).toBe("invalid_date");
    const r = await readPublished(kv, "2026-9-23");
    expect(r.ok === false && r.reason).toBe("invalid_date");
    expect(count("get") + count("put")).toBe(0);
  });

  it("content must be a plain object; anything else is rejected and nothing is written", async () => {
    const { kv, count } = mockKV();
    for (const c of [null, undefined, [], "text", 42, new Date()]) {
      const res = await writeDraft(kv, WED, c as unknown as Record<string, unknown>);
      expect(res.ok === false && res.reason).toBe("invalid_content");
    }
    expect(count("put")).toBe(0);
    expect((await writeDraft(kv, WED, {})).ok).toBe(true); // anti-vacuity
  });
});

// ─── Publish: working if present, else draft; working is KEPT ──────────────

describe("test 10: publish source precedence", () => {
  it("with a working key: published receives the WORKING content, never the draft", async () => {
    const { kv, store } = mockKV();
    await writeDraft(kv, WED, wedDraft);
    await writeWorking(kv, WED, wedWorking);
    expect(await publishEdition(kv, WED)).toEqual({ ok: true, source: "working" });
    expect(stored(store, "daybreak:2026-09-23:published")).toEqual(wedWorking);
    expect(stored(store, "daybreak:2026-09-23:published")).not.toEqual(wedDraft);
  });

  it("with no working key: published receives the DRAFT content, and nothing else is written", async () => {
    const { kv, store, ops, reset } = mockKV();
    await writeDraft(kv, WED, wedDraft);
    reset();
    expect(await publishEdition(kv, WED)).toEqual({ ok: true, source: "draft" });
    expect(stored(store, "daybreak:2026-09-23:published")).toEqual(wedDraft);
    expect(ops.filter((o) => o.op !== "get")).toEqual([{ op: "put", key: "daybreak:2026-09-23:published" }]);
    expect([...store.keys()].sort()).toEqual(["daybreak:2026-09-23:draft", "daybreak:2026-09-23:published"]);
  });

  it("with neither: an explicit error, and nothing is written", async () => {
    const { kv, store, count } = mockKV();
    const res = await publishEdition(kv, WED);
    expect(res.ok === false && res.reason).toBe("nothing_to_publish");
    expect(count("put")).toBe(0);
    expect(store.size).toBe(0);
  });

  it("only the requested date's keys are read or written", async () => {
    const { kv, ops, reset } = mockKV();
    await writeDraft(kv, TUE, tueEdition);
    await writeDraft(kv, WED, wedDraft);
    reset();
    await publishEdition(kv, WED);
    expect(ops.every((o) => o.key.startsWith("daybreak:2026-09-23:"))).toBe(true);
  });
});

describe("test 11: a drafting-agent write AFTER a working key exists", () => {
  it("the next publish still writes the WORKING content; the late draft does not change it", async () => {
    const { kv, store } = mockKV();
    await writeDraft(kv, WED, wedDraft);
    await writeWorking(kv, WED, wedWorking);
    const lateDraft = { headline: "Wednesday LATE DRAFT (agent re-run)" };
    await writeDraft(kv, WED, lateDraft);
    expect(stored(store, "daybreak:2026-09-23:draft")).toEqual(lateDraft); // the late write did land
    await publishEdition(kv, WED);
    expect(stored(store, "daybreak:2026-09-23:published")).toEqual(wedWorking);
    expect(store.get("daybreak:2026-09-23:published")).not.toContain("LATE DRAFT");
  });
});

describe("test 12: edit, then republish", () => {
  it("the published content is REPLACED; the earlier one does not persist; working is still present", async () => {
    const { kv, store } = mockKV();
    await writeDraft(kv, WED, wedDraft);
    await writeWorking(kv, WED, wedWorking);
    await publishEdition(kv, WED);
    expect(stored(store, "daybreak:2026-09-23:published")).toEqual(wedWorking);
    expect(store.has("daybreak:2026-09-23:working")).toBe(true); // F.3: KEPT after the first publish

    const corrected = { headline: "Wednesday CORRECTED" };
    await writeWorking(kv, WED, corrected);
    expect(await publishEdition(kv, WED)).toEqual({ ok: true, source: "working" });
    expect(stored(store, "daybreak:2026-09-23:published")).toEqual(corrected);
    expect(store.get("daybreak:2026-09-23:published")).not.toContain("WORKING");
    expect(stored(store, "daybreak:2026-09-23:working")).toEqual(corrected);
    expect(store.has("daybreak:2026-09-23:draft")).toBe(true);
  });
});

// ─── Fail closed on read ───────────────────────────────────────────────────

describe("fail closed: an unparseable or wrong-shape stored value is an explicit error", () => {
  const good = JSON.stringify(tueEdition);
  const cases: Array<[string, string, string]> = [
    ["unparseable", "{not json", "unparseable"],
    ["truncated", good.slice(0, -2), "unparseable"],
    ["an array", "[]", "wrong_shape"],
    ["JSON null", "null", "wrong_shape"],
    ["a number", "42", "wrong_shape"],
    ["a string", '"Tuesday"', "wrong_shape"],
  ];

  it("permitting: the well-formed value reads back exactly", async () => {
    const { kv } = mockKV({ "daybreak:2026-09-22:published": good });
    expect(await readPublished(kv, TUE)).toEqual({ ok: true, found: true, content: tueEdition });
    expect(await readPublished(kv, WED)).toEqual({ ok: true, found: false }); // absent ≠ error
  });

  for (const [label, raw, reason] of cases) {
    it(`${label} published value → ${reason}, never empty, never partial — at every read surface`, async () => {
      const { kv } = mockKV({ "daybreak:2026-09-22:published": raw });
      const r = await readPublished(kv, TUE);
      expect(r).toMatchObject({ ok: false, reason });
      expect("content" in r).toBe(false);

      const latest = await findLatestPublished(kv, TUE);
      expect(latest).toMatchObject({ ok: false, reason });

      // The status read does NOT skip the corrupt edition to show an older one
      // or report "unavailable": it errors.
      const { kv: kv2 } = mockKV({
        "daybreak:2026-09-21:published": JSON.stringify({ headline: "Monday" }),
        "daybreak:2026-09-22:published": raw,
      });
      const s = await readEditionStatus(kv2, at("2026-09-22T20:00:00Z"));
      expect(s).toMatchObject({ ok: false, reason });
      expect(JSON.stringify(s)).not.toContain("Monday");
    });
  }

  it("publish fails closed on a corrupt WORKING key — it does not fall through to the draft", async () => {
    const { kv, store, count } = mockKV({
      "daybreak:2026-09-23:working": "{not json",
      "daybreak:2026-09-23:draft": JSON.stringify(wedDraft),
    });
    const res = await publishEdition(kv, WED);
    expect(res).toMatchObject({ ok: false, reason: "unparseable" });
    expect(count("put")).toBe(0);
    expect(store.has("daybreak:2026-09-23:published")).toBe(false);
  });

  it("publish fails closed on a corrupt DRAFT key when there is no working key", async () => {
    const { kv, count } = mockKV({ "daybreak:2026-09-23:draft": "[1,2]" });
    expect(await publishEdition(kv, WED)).toMatchObject({ ok: false, reason: "wrong_shape" });
    expect(count("put")).toBe(0);
  });
});

// ─── Finding the latest published edition: a bounded walk, no enumeration ─

describe("findLatestPublished — walks back day by day, bounded", () => {
  it("finds the most recent published edition at or before the given date", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    expect(await findLatestPublished(kv, "2026-09-25")).toEqual({ ok: true, found: true, date: TUE, content: tueEdition });
    expect(await findLatestPublished(kv, TUE)).toEqual({ ok: true, found: true, date: TUE, content: tueEdition });
  });

  it("an edition dated AFTER the start date is not found", async () => {
    const { kv } = mockKV();
    await publishTuesday(kv);
    expect(await findLatestPublished(kv, "2026-09-21")).toMatchObject({ ok: true, found: false });
  });

  it("the bound is the number of dates examined, starting date included", async () => {
    const { kv, count, reset } = mockKV({ "daybreak:2026-09-21:published": JSON.stringify({ headline: "Monday" }) });
    // 09-23, 09-22, 09-21: the third date examined
    expect((await findLatestPublished(kv, WED, 3)).ok).toBe(true);
    expect(await findLatestPublished(kv, WED, 3)).toMatchObject({ found: true, date: "2026-09-21" });
    reset();
    expect(await findLatestPublished(kv, WED, 2)).toEqual({ ok: true, found: false });
    expect(count("get")).toBe(2); // exhausted after exactly two reads
  });

  it(`default bound is ${DEFAULT_MAX_LOOKBACK_DAYS} dates: found at the last one, unavailable one day beyond`, async () => {
    expect(DEFAULT_MAX_LOOKBACK_DAYS).toBe(14);
    // 2026-09-23 minus 13 days = 2026-09-10 (14th date examined); minus 14 = 2026-09-09
    const inside = mockKV({ "daybreak:2026-09-10:published": JSON.stringify({ h: 1 }) });
    expect(await findLatestPublished(inside.kv, WED)).toMatchObject({ ok: true, found: true, date: "2026-09-10" });
    const beyond = mockKV({ "daybreak:2026-09-09:published": JSON.stringify({ h: 1 }) });
    expect(await findLatestPublished(beyond.kv, WED)).toEqual({ ok: true, found: false });
    expect(beyond.count("get")).toBe(14);
    expect(await readEditionStatus(beyond.kv, WED_0700)).toEqual({ ok: true, state: "unavailable" });
  });

  it("reads only published keys, and walks across a month boundary", async () => {
    const { kv, ops } = mockKV({ "daybreak:2026-08-30:published": JSON.stringify({ h: 1 }) });
    expect(await findLatestPublished(kv, "2026-09-02")).toMatchObject({ found: true, date: "2026-08-30" });
    expect(ops.map((o) => o.key)).toEqual([
      "daybreak:2026-09-02:published",
      "daybreak:2026-09-01:published",
      "daybreak:2026-08-31:published",
      "daybreak:2026-08-30:published",
    ]);
  });
});
