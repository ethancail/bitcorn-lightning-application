// Editor-facing copy for the Daybreak Editor — spec §3.4.5, ruling (C): Ethan
// approves every string in the PR. Until he does, the strings below are pinned
// AS DRAFTED, so any change to one is deliberate and visible in review.
//
// ⚠ COPY RULE, ENFORCED — the farmer-is-the-operator ban, reused: the ban list
// is ../daybreak/daybreakCopy.test.ts's, which is
// ../components/certExpiryNotice.test.ts:225-231 verbatim; a parity check
// below fails if that source list changes and this one does not follow.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allEditorCopy,
  bandCopy,
  closeAsOfCopy,
  EDITION_LABEL,
  EDITOR_LOADING,
  EDITOR_NAV_LABEL,
  EDITOR_TITLE,
  FIELD_LABELS,
  LOAD_FAILED_GENERIC,
  loadFailedCopy,
  NO_DRAFT_NOTE,
  NOT_PUBLISHED_NOTE,
  PUBLISH_FAILED,
  PUBLISH_LABEL,
  PUBLISHED,
  PUBLISHED_NOTE,
  PUBLISHING_LABEL,
  publishStatusCopy,
  RECENT_NOT_LIVE_NOTE,
  SAVE_LABEL,
  SAVED,
  saveFailedCopy,
  SAVING_LABEL,
  Z_AVAILABLE_NO_DETAIL,
  Z_PENDING,
} from "./editorCopy";

const BANNED = [
  /ask your (node )?operator/i,
  /contact your (node )?operator/i,
  /ask the operator/i,
  /your operator/i,
  /the node operator/i,
];

// Every code the editor's browser can receive on a failed read or save
// (app/api/src/daybreak/editorProxy.ts).
const LOAD_CODES = [
  "treasury_role_required",
  "editor_not_configured",
  "worker_not_configured",
  "worker_auth_rejected",
  "worker_unreachable",
  "worker_unavailable",
];

describe("the farmer-is-the-operator ban covers every editor string", () => {
  it("permitting: the enumeration is real copy", () => {
    const all = allEditorCopy();
    expect(all.length).toBeGreaterThan(30);
    for (const s of all) expect(s.trim().length).toBeGreaterThan(0);
  });

  it("forbidding: no output matches the ban list", () => {
    for (const s of allEditorCopy()) for (const re of BANNED) expect(s, `matched ${re}`).not.toMatch(re);
  });

  it("anti-vacuity: the ban list matches the phrases it is meant to catch", () => {
    for (const probe of ["Please ask your node operator", "contact your operator", "ask the operator to fix it", "your operator", "the node operator"]) {
      expect(BANNED.some((re) => re.test(probe)), probe).toBe(true);
    }
  });

  it("parity: each regex is the one in certExpiryNotice.test.ts and daybreakCopy.test.ts", () => {
    for (const src of [
      readFileSync(join(__dirname, "..", "components", "certExpiryNotice.test.ts"), "utf8"),
      readFileSync(join(__dirname, "..", "daybreak", "daybreakCopy.test.ts"), "utf8"),
    ]) {
      for (const re of BANNED) expect(src).toContain(re.toString());
    }
  });
});

describe("one generic message for anything without a recognised code", () => {
  it("permitting: no error, no code, a non-string code, an unknown code and HTTP status text all get the generic load message", () => {
    for (const err of [null, undefined, {}, { code: 502 }, { code: "brand_new_code" }, { code: "Bad Gateway" }, { code: "Failed to fetch" }]) {
      expect(loadFailedCopy(err as any)).toBe(LOAD_FAILED_GENERIC);
    }
  });

  it("forbidding: no message echoes what it was given", () => {
    for (const code of ["brand_new_code", "Bad Gateway", "Failed to fetch"]) {
      expect(loadFailedCopy({ code })).not.toContain(code);
      expect(saveFailedCopy({ code }, true)).not.toContain(code);
      expect(saveFailedCopy({ code: "editor_refused", body: { reason: code } }, false)).not.toContain(code);
    }
  });

  it("anti-vacuity: every recognised load code gets its OWN words", () => {
    for (const code of LOAD_CODES) expect(loadFailedCopy({ code }), code).not.toBe(LOAD_FAILED_GENERIC);
  });

  it("a Worker refusal is read from editor_refused's reason; the proxy's own codes directly", () => {
    expect(saveFailedCopy({ code: "editor_refused", body: { reason: "invalid_link" } }, false)).toContain("https://");
    expect(saveFailedCopy({ code: "body_too_large" }, false)).toContain("too long");
    expect(saveFailedCopy({ code: "editor_refused", body: { reason: "body_too_large" } }, false)).toContain("too long");
  });

  it("a save that was Publish's first step says nothing was published; a plain save does not", () => {
    expect(saveFailedCopy({ code: "worker_unreachable" }, true)).toContain("Nothing was published.");
    expect(saveFailedCopy({ code: "worker_unreachable" }, false)).not.toContain("published");
  });
});

describe("strings AS DRAFTED, pinned verbatim — for Ethan's approval in the PR", () => {
  it("labels, headings and buttons", () => {
    expect([EDITOR_NAV_LABEL, EDITOR_TITLE, EDITOR_LOADING]).toEqual(["Daybreak Editor", "Daybreak Editor", "Loading the editions…"]);
    expect(EDITION_LABEL).toEqual({ next: "Next due edition", recent: "Most recent edition" });
    expect(FIELD_LABELS).toEqual({ lead: "Lead", wrTitle: "Title", wrNote: "Note", wrLink: "Link (https://)", closer: "Closer" });
    expect([SAVE_LABEL, SAVING_LABEL, PUBLISH_LABEL, PUBLISHING_LABEL]).toEqual(["Save", "Saving…", "Save and publish", "Publishing…"]);
  });

  it("publication state", () => {
    expect(PUBLISHED_NOTE).toBe("Published — members can see this edition.");
    expect(NOT_PUBLISHED_NOTE).toBe("Not published yet.");
    expect(RECENT_NOT_LIVE_NOTE).toBe("Not published yet — members are seeing an older edition, marked held over, until you publish this one.");
    expect(publishStatusCopy("next", false)).toBe(NOT_PUBLISHED_NOTE);
    expect(publishStatusCopy("recent", false)).toBe(RECENT_NOT_LIVE_NOTE);
    expect(publishStatusCopy("next", true)).toBe(PUBLISHED_NOTE);
    expect(publishStatusCopy("recent", true)).toBe(PUBLISHED_NOTE);
    expect(NO_DRAFT_NOTE).toBe("There's no draft for this edition yet. Your first save creates it and computes the Z-Score.");
  });

  it("the Z", () => {
    expect(Z_PENDING).toBe("Computed on first save.");
    expect(Z_AVAILABLE_NO_DETAIL).toBe("Computed. The score will show when the page refreshes.");
    expect(bandCopy("Fixture B")).toBe("Band: Fixture B");
    expect(closeAsOfCopy("Corn", "Tuesday, October 6, 2026")).toBe("Corn: as of Tuesday, October 6, 2026's close");
    expect(closeAsOfCopy("Bitcoin", "Tuesday, October 6, 2026")).toBe("Bitcoin: as of Tuesday, October 6, 2026's close");
  });

  it("outcomes", () => {
    expect(SAVED).toBe("Saved. Members won't see this until you publish.");
    expect(PUBLISHED).toBe("Published. Members can see this edition now.");
    expect(PUBLISH_FAILED).toBe("Saved, but not published. Your text is saved — try publishing again.");
  });

  it("load failed", () => {
    const off = "Editing is off until the editions load, so nothing can be overwritten unseen.";
    expect(LOAD_FAILED_GENERIC).toBe(`Couldn't load the editions. ${off}`);
    expect(LOAD_CODES.map((code) => loadFailedCopy({ code }))).toEqual([
      `The Daybreak Editor only works on the treasury node. ${off}`,
      `The Daybreak Editor isn't set up on this node yet. ${off}`,
      `This node is missing the address of BitCorn's services. ${off}`,
      `BitCorn's Daybreak service didn't accept this node's editor key. ${off}`,
      `This node couldn't reach BitCorn's Daybreak service just now. ${off}`,
      `BitCorn's Daybreak service couldn't answer just now. ${off}`,
    ]);
  });

  it("save failed", () => {
    const cases: Array<[string, string]> = [
      ["invalid_link", "Couldn't save: Worth Reading needs a full link starting with https://."],
      ["worth_reading_incomplete", "Couldn't save: Worth Reading needs a title, a note and a link — or leave all three empty."],
      ["body_too_large", "Couldn't save: this edition is too long."],
      ["not_editable_date", "Couldn't save: this edition can no longer be edited, because a newer one is now due. Reload the page to see the current editions."],
      ["worker_unreachable", "Couldn't save: this node couldn't reach BitCorn's Daybreak service."],
      ["worker_unavailable", "Couldn't save: BitCorn's Daybreak service couldn't answer just now."],
      ["something_else", "Couldn't save."],
    ];
    for (const [code, head] of cases) {
      expect(saveFailedCopy({ code }, false)).toBe(`${head} Your text is still here.`);
      expect(saveFailedCopy({ code }, true)).toBe(`${head} Nothing was published. Your text is still here.`);
    }
  });
});
