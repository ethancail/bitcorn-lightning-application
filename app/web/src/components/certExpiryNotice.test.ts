import { describe, it, expect } from "vitest";
import {
  certExpiryNotice,
  CERT_EXPIRY_WARN_DAYS,
  type CertExpiryInput,
} from "./certExpiryNotice";

// Fixed clock. Nothing here reads Date.now(), so these cases never rot.
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0); // 2026-08-24T12:00:00Z
const DAY = 24 * 60 * 60 * 1000;

// ─── The API's OWN sentences, mirrored verbatim ─────────────────────────────
//
// These are the strings app/api/src/lightning/certExpiry.ts:157-180 actually
// produces, copied character-for-character. The helper under test is a
// pass-through for the prose, so using the real sentences is what makes the
// copy assertions below mean anything — a paraphrase would test a string this
// module invented rather than the one a farmer reads. The API side has its own
// ban test over the source of these (certExpiry.test.ts:152-161); this one
// covers the rendered side, where the suppression decisions are made.

const EXPIRED: CertExpiryInput = {
  level: "expired",
  message:
    "LND's TLS certificate EXPIRED on 2026-08-21 (3 days ago). " +
    "Lightning calls will keep failing until LND issues a new one. " +
    "Restart the Lightning app to regenerate it.",
  not_after_ms: NOW - 3 * DAY,
};

const EXPIRING_SOON: CertExpiryInput = {
  level: "expiring_soon",
  message:
    "LND's TLS certificate expires on 2026-09-07 (14 days away). " +
    "Restart the Lightning app before then to regenerate it; Lightning calls " +
    "will fail once it lapses.",
  not_after_ms: NOW + 14 * DAY,
};

const OK: CertExpiryInput = {
  level: "ok",
  message: null,
  not_after_ms: NOW + 400 * DAY,
};

const UNKNOWN: CertExpiryInput = {
  level: "unknown",
  message:
    "Could not read LND's TLS certificate expiry: could not read /lnd/tls.cert: " +
    "ENOENT: no such file or directory, open '/lnd/tls.cert'",
  not_after_ms: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// CTRL-1 — THE PAIR THAT MATTERS MOST.
//
// This ships as a release and members update by clicking, so it lands on a
// large majority of nodes with nothing wrong. 594aadf's own commit body names
// the failure mode: "mutating the helper to always render would satisfy every
// 'shows a warning' assertion while putting a permanent scare-line on healthy
// dashboards." Both halves are required — the render assertion alone is
// satisfied by a constant.
// ═══════════════════════════════════════════════════════════════════════════

describe("CTRL-1 — warns on expiring_soon, and says NOTHING to a healthy node", () => {
  it("renders a warning when the certificate is expiring soon", () => {
    const n = certExpiryNotice(EXPIRING_SOON, NOW)!;
    expect(n).not.toBeNull();
    expect(n.severity).toBe("warning");
    expect(n.text).toMatch(/expires on/i);
    expect(n.text).toMatch(/restart the lightning app/i);
  });

  it("⚠ says nothing at all when the certificate is fine", () => {
    expect(certExpiryNotice(OK, NOW)).toBeNull();
  });

  it("the two are a real discrimination, not a constant", () => {
    // Mutating the `ok` branch to always return a notice turns THIS red, which
    // is what the assertion above cannot do on its own.
    expect(certExpiryNotice(OK, NOW)).toBeNull();
    expect(certExpiryNotice(EXPIRING_SOON, NOW)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CTRL-2 — renders on expired, stays silent on unknown.
//
// `unknown` is the permanent steady state on a node with no Lightning app
// installed, and its string is a raw errno naming no remediation. Suppression
// is a UI policy; the API goes on sending it truthfully.
// ═══════════════════════════════════════════════════════════════════════════

describe("CTRL-2 — renders on expired, and NOTHING on unknown", () => {
  it("renders critical when the certificate has already lapsed", () => {
    const n = certExpiryNotice(EXPIRED, NOW)!;
    expect(n).not.toBeNull();
    expect(n.severity).toBe("critical");
    expect(n.text).toMatch(/EXPIRED on/);
  });

  it("⚠ says nothing when the cert could not be read", () => {
    expect(certExpiryNotice(UNKNOWN, NOW)).toBeNull();
  });

  it("no rendered text ever carries the raw errno", () => {
    // The specific harm, asserted directly rather than via the level: a farmer
    // must never read ENOENT off their own dashboard.
    for (const cert of [EXPIRED, EXPIRING_SOON, OK, UNKNOWN]) {
      const text = certExpiryNotice(cert, NOW)?.text ?? "";
      expect(text).not.toMatch(/ENOENT/);
      expect(text).not.toMatch(/no such file or directory/i);
    }
  });

  it("expired and unknown are a real discrimination, not a constant", () => {
    expect(certExpiryNotice(UNKNOWN, NOW)).toBeNull();
    expect(certExpiryNotice(EXPIRED, NOW)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEVERITY, AND THE NOT-YET-LOADED DEFAULT.
// ═══════════════════════════════════════════════════════════════════════════

describe("severity separates lapsed from approaching", () => {
  it("expired outranks expiring_soon", () => {
    expect(certExpiryNotice(EXPIRED, NOW)!.severity).toBe("critical");
    expect(certExpiryNotice(EXPIRING_SOON, NOW)!.severity).toBe("warning");
    expect(certExpiryNotice(EXPIRED, NOW)!.severity).not.toBe(
      certExpiryNotice(EXPIRING_SOON, NOW)!.severity,
    );
  });
});

describe("nothing is claimed before the data arrives", () => {
  it("renders nothing when stats have not loaded", () => {
    expect(certExpiryNotice(null, NOW)).toBeNull();
    expect(certExpiryNotice(undefined, NOW)).toBeNull();
  });

  it("renders nothing when the API's own read threw (field null)", () => {
    // The API sends cert_expiry: null only when its computation threw. An
    // absent answer is not evidence of a problem, and must not read as one.
    expect(certExpiryNotice(null, NOW)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE THRESHOLD IS A REAL THRESHOLD, not decoration.
// ═══════════════════════════════════════════════════════════════════════════

describe("CERT_EXPIRY_WARN_DAYS narrows the dashboard's window", () => {
  it("defaults to the API's own 30 days, so out of the box it changes nothing", () => {
    expect(CERT_EXPIRY_WARN_DAYS).toBe(30);
    // 14 days of runway is inside 30, so the default renders it.
    expect(certExpiryNotice(EXPIRING_SOON, NOW)).not.toBeNull();
  });

  it("a narrower threshold holds the banner back", () => {
    // Same input, same clock — only the threshold moves. If the helper ignored
    // not_after_ms and trusted the level alone, this would still render.
    expect(certExpiryNotice(EXPIRING_SOON, NOW, 7)).toBeNull();
    expect(certExpiryNotice(EXPIRING_SOON, NOW, 14)).not.toBeNull();
  });

  it("never suppresses an already-expired certificate, whatever the threshold", () => {
    expect(certExpiryNotice(EXPIRED, NOW, 0)).not.toBeNull();
    expect(certExpiryNotice(EXPIRED, NOW, 1)).not.toBeNull();
  });

  it("days are floored, so the runway is never overstated", () => {
    // 7 days and 23 hours floors to 7, which is inside a 7-day threshold.
    const almostEight: CertExpiryInput = {
      ...EXPIRING_SOON,
      not_after_ms: NOW + 7 * DAY + 23 * 60 * 60 * 1000,
    };
    expect(certExpiryNotice(almostEight, NOW, 7)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C3 — THE REMEDIATION IS ONE STEP, AND MENTIONS BITCORN NOWHERE.
//
// v1.18.7's self-heal rebuilds the LND client on a cert-bytes change
// (lnd.ts:111-136), so the second "then restart Bitcorn" step ceased to exist.
// The API's strings are already one-step; this pins that the rendered side has
// not reintroduced the two-step form.
// ═══════════════════════════════════════════════════════════════════════════

describe("the rendered remediation is ONE step", () => {
  it("names restarting the Lightning app and nothing after it", () => {
    for (const cert of [EXPIRED, EXPIRING_SOON]) {
      const text = certExpiryNotice(cert, NOW)!.text;
      expect(text).toMatch(/restart(ing)? the lightning app/i);
      expect(text).not.toMatch(/then bitcorn/i);
      expect(text).not.toMatch(/bitcorn/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⚠ COPY RULE, ENFORCED. On a member node the farmer IS the operator, so
// "ask your node operator" routes them back to themselves. Same shape as
// ./actionConfirm/confirmAction.test.ts:160-170, including its anti-vacuity
// check — without that, every regex could be wrong and the whole block would
// pass silently.
// ═══════════════════════════════════════════════════════════════════════════

describe("no copy tells the operator to ask an operator", () => {
  const BANNED = [
    /ask your (node )?operator/i,
    /contact your (node )?operator/i,
    /ask the operator/i,
    /your operator/i,
    /the node operator/i,
  ];

  it("no notice text at ANY of the four levels matches a banned phrasing", () => {
    const ALL: Array<[string, CertExpiryInput]> = [
      ["expired", EXPIRED],
      ["expiring_soon", EXPIRING_SOON],
      ["ok", OK],
      ["unknown", UNKNOWN],
    ];
    for (const [label, cert] of ALL) {
      const text = certExpiryNotice(cert, NOW)?.text ?? "";
      for (const re of BANNED) {
        expect(text, `${label} matched ${re}`).not.toMatch(re);
      }
    }
  });

  it("the ban list itself matches the phrases it is meant to catch", () => {
    // Without this the regexes could all be wrong and every check above would
    // pass vacuously — the exact trap confirmAction.test.ts:167-170 guards.
    const PROBES = [
      "Please ask your node operator for help",
      "If this persists, contact your operator with the pubkey above",
      "You should ask the operator to fix it",
      "Share this with your operator",
      "This needs the node operator, not a retry.",
    ];
    for (const probe of PROBES) {
      expect(
        BANNED.some((re) => re.test(probe)),
        `no banned regex matched: ${probe}`,
      ).toBe(true);
    }
  });

  it("every regex in the ban list is load-bearing — none matches nothing", () => {
    // A regex that can never match is a dead entry that would silently stop
    // guarding the phrase it names.
    const CORPUS = [
      "ask your node operator",
      "ask your operator",
      "contact your node operator",
      "contact your operator",
      "ask the operator",
      "your operator",
      "the node operator",
    ].join(" | ");
    for (const re of BANNED) {
      expect(CORPUS, `dead regex: ${re}`).toMatch(re);
    }
  });
});
