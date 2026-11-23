// node-version-alert: the check, the in-memory value, and the member copy.
//
// The comparison table is spec §(f)'s cases plus three Ethan added at Phase 1
// (item 4): 0.20.9 fires, 0.22.0 and 1.0.0 are quiet. Without those three, a
// comparison that looks at the PATCH number alone passes every spec case —
// 0.20.0 (0 < 2) fires, 0.21.1 fires, 0.21.2 and 0.21.8 are quiet — so the
// table could not tell a broken comparator from a working one.
//
// ⚠ THE MEMBER TEXT IS HARDCODED HERE, not imported: a test that imports the
// constant it checks cannot notice the constant changing.

import { beforeEach, describe, expect, it } from "vitest";
import {
  LND_MIN_VERSION,
  getLndVersion,
  isBelowMinimum,
  lndVersionAlert,
  nodeUpdateNoticeText,
  parseLndVersion,
  recordLndVersion,
  resetLndVersionForTests,
} from "./lndVersion";

const RULED_MEMBER_TEXT =
  "Your Lightning Node app is out of date, and part of it has stopped working. " +
  "Update it in your Umbrel's App Store, and update Bitcoin Node and Electrs too if you have them.";

// LND's own format, as getWalletInfo returns it.
const lnd = (v: string) => `${v}-beta commit=v${v}-beta`;

const FIRES = ["0.20.0", "0.21.1", "0.20.9"];
const QUIET = ["0.21.2", "0.21.8", "0.22.0", "1.0.0"];

beforeEach(() => resetLndVersionForTests());

describe("the minimum", () => {
  it("is 0.21.2 (R2)", () => {
    expect(LND_MIN_VERSION).toEqual([0, 21, 2]);
  });
});

describe("parseLndVersion", () => {
  it("reads major.minor.patch from LND's version string", () => {
    expect(parseLndVersion("0.20.0-beta commit=v0.20.0-beta")).toEqual([0, 20, 0]);
  });

  it("a -patch suffix parses (defensive: LND itself does not report Umbrel's suffix)", () => {
    expect(parseLndVersion("0.21.1-beta-patch.1")).toEqual([0, 21, 1]);
  });

  it("unparseable and missing are null", () => {
    for (const raw of ["", "beta", "unknown", "0.21", "v", "commit=v0.21.8-beta"]) {
      expect(parseLndVersion(raw), JSON.stringify(raw)).toBeNull();
    }
    expect(parseLndVersion(null)).toBeNull();
    expect(parseLndVersion(undefined)).toBeNull();
  });
});

describe("the comparison, through both surfaces", () => {
  for (const v of FIRES) {
    it(`${v} fires`, () => {
      expect(isBelowMinimum(parseLndVersion(lnd(v))!)).toBe(true);
      expect(nodeUpdateNoticeText(lnd(v))).toBe(RULED_MEMBER_TEXT);
      expect(lndVersionAlert(lnd(v), 1)).not.toBeNull();
    });
  }

  for (const v of QUIET) {
    it(`${v} is quiet`, () => {
      expect(isBelowMinimum(parseLndVersion(lnd(v))!)).toBe(false);
      expect(nodeUpdateNoticeText(lnd(v))).toBeNull();
      expect(lndVersionAlert(lnd(v), 1)).toBeNull();
    });
  }

  it("a -patch suffix is compared on its LND version", () => {
    expect(nodeUpdateNoticeText("0.21.1-beta-patch.1")).toBe(RULED_MEMBER_TEXT);
    expect(nodeUpdateNoticeText("0.21.2-beta-patch.1")).toBeNull();
  });

  it("unparseable is quiet", () => {
    expect(nodeUpdateNoticeText("garbage")).toBeNull();
    expect(lndVersionAlert("garbage", 1)).toBeNull();
  });

  it("missing is quiet", () => {
    expect(nodeUpdateNoticeText(null)).toBeNull();
    expect(lndVersionAlert(null, 1)).toBeNull();
  });
});

describe("the treasury alert", () => {
  it("is a warning with its heading, the version and the minimum", () => {
    const raw = lnd("0.20.0");
    expect(lndVersionAlert(raw, 1_700_000_000_000)).toEqual({
      type: "LND_VERSION_OUTDATED",
      heading: "Lightning Node app is out of date",
      severity: "warning",
      message:
        "This node runs LND 0.20.0; BitCorn needs 0.21.2 or later. " +
        "Update Lightning Node, Bitcoin Node and Electrs in the Umbrel App Store.",
      data: { version: raw, minimum: "0.21.2" },
      at: 1_700_000_000_000,
    });
  });
});

describe("the in-memory value", () => {
  it("is null before the first read", () => {
    expect(getLndVersion()).toBeNull();
  });

  it("holds the latest version recorded", () => {
    recordLndVersion(lnd("0.20.0"));
    recordLndVersion(lnd("0.21.8"));
    expect(getLndVersion()).toBe(lnd("0.21.8"));
  });

  it("keeps the last good version when a read carries none", () => {
    recordLndVersion(lnd("0.20.0"));
    recordLndVersion(undefined);
    recordLndVersion(null);
    recordLndVersion("");
    expect(getLndVersion()).toBe(lnd("0.20.0"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⚠ COPY RULE, ENFORCED, over the member text (Ethan, 2026-11-20, after
// member-first-run-ui's review). Member copy says no "operator" (the farmer IS
// the operator of their own node), no "channel" (members read "connection"),
// no "treasury", no "hub", and never the misspelling "Bitcorn". Same shape as
// components/certExpiryNotice.test.ts:216-282 in app/web, including its
// anti-vacuity checks, so the ban list cannot all be wrong and pass silently.
// ═══════════════════════════════════════════════════════════════════════════

describe("member copy: no operator, channel, treasury, hub or Bitcorn", () => {
  // [regex, a probe it must catch]. "Bitcorn" is case-sensitive on purpose:
  // the brand is written "BitCorn" in member copy.
  const BANNED: Array<[RegExp, string]> = [
    [/operator/i, "ask your node operator"],
    [/channel/i, "your channel is open"],
    [/treasury/i, "the treasury node"],
    [/\bhub\b/i, "connect to the hub"],
    [/Bitcorn/, "update Bitcorn"],
  ];

  it("is the ruled sentence", () => {
    expect(nodeUpdateNoticeText(lnd("0.20.0"))).toBe(RULED_MEMBER_TEXT);
  });

  it("no banned word appears in the member text", () => {
    const text = nodeUpdateNoticeText(lnd("0.20.0")) ?? "";
    expect(text.length).toBeGreaterThan(0);
    for (const [re] of BANNED) {
      expect(text, `matched ${re}`).not.toMatch(re);
    }
  });

  it("the ban list itself catches each phrase it is meant to catch", () => {
    for (const [re, probe] of BANNED) {
      expect(re.test(probe), `${re} missed its probe: ${probe}`).toBe(true);
    }
  });

  it("each banned word, put into the member text, is caught", () => {
    const text = nodeUpdateNoticeText(lnd("0.20.0"))!;
    for (const [re, probe] of BANNED) {
      expect(`${text} ${probe}`, `${re} did not catch "${probe}" inside the text`).toMatch(re);
    }
  });

  it("the narrow bans stay narrow: BitCorn and GitHub pass", () => {
    expect(/Bitcorn/.test("BitCorn")).toBe(false);
    expect(/\bhub\b/i.test("GitHub")).toBe(false);
  });

  it("names the app and the place to update it", () => {
    const text = nodeUpdateNoticeText(lnd("0.20.0")) ?? "";
    expect(text).toMatch(/Lightning Node/);
    expect(text).toMatch(/App Store/);
    expect(text).toMatch(/Bitcoin Node/);
    expect(text).toMatch(/Electrs/);
  });
});
