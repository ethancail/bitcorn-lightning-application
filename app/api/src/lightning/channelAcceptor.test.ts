// Membership-gating slice 2 — the treasury's channel gate (T4) and its alert
// (T5).
//
// Spec: bitcorn-research specs/2026-11-05-membership-gating-spec.md §1 T4–T5;
// done-whens DW7, DW8, DW10; rulings R4, R6, R7, R9; pass 10 items 2, 4, B.
//
// WHAT IS REAL: the predicate runs against a temp-dir DB built by the real
// migration runner, through the real lane classifier (contacts tags and the
// curated ACINQ entry).
//
// WHAT IS FAKED, AND WHY: the ln-service stream and the LND client. The fake
// subscribeToOpenRequests reproduces the two library behaviours this module
// relies on, read from lightning 11.1.0's subscribe_to_open_requests.js:
// removing the last 'channel_request' listener cancels the stream (:146-153),
// and 'error' is dropped when no error listener is attached (:77-84; the
// libraryError helper below). Whether
// LND itself honours the stream is gate 1's to show, on Polar.
//
// ⚠ THE STRINGS ARE HARDCODED HERE, not imported: a test that imports the
// constant it checks cannot notice the constant changing.

import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-channel-gate-"));
process.env.DB_DIR = path.join(TMP, "db");
process.env.SECRETS_DIR = path.join(TMP, "secrets");
const TREASURY = "02" + "11".repeat(32);
process.env.TREASURY_PUBKEY = TREASURY;

const R7_ACCEPTOR_TEXT =
  "Opening a channel to the BitCorn hub requires a paid membership. Pay your membership in the BitCorn app on your node, then try again.";
const T5_HEADING = "Channel gate offline";
const T5_MESSAGE =
  "The hub isn't checking new channel requests. Opens from unpaid members will be accepted until it reconnects.";
// S4 (Ethan, 2026-11-05): the message when the stream is open and the cause is
// a recent predicate error.
const T5_PREDICATE_ERROR_MESSAGE =
  "The hub couldn't check a recent channel request and accepted it. Check the API logs.";
const ACINQ = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";

type FakeStream = { lnd: unknown; emitter: EventEmitter; cancelled: boolean };

const h = vi.hoisted(() => ({
  streams: [] as Array<{ lnd: unknown; emitter: import("events").EventEmitter; cancelled: boolean }>,
  lnd: { id: "lnd-1" } as unknown,
  lndThrows: false,
  subscribeThrows: false,
}));

vi.mock("ln-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ln-service")>();
  const { EventEmitter: EE } = await import("events");
  return {
    ...actual,
    subscribeToOpenRequests: ({ lnd }: { lnd: unknown }) => {
      if (h.subscribeThrows) throw new Error("ExpectedLndToSubscribeToChannelRequests");
      const emitter = new EE();
      const stream = { lnd, emitter, cancelled: false };
      emitter.on("removeListener", () => {
        if (!emitter.listenerCount("channel_request")) stream.cancelled = true;
      });
      h.streams.push(stream);
      return emitter;
    },
  };
});

vi.mock("./lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lnd")>();
  return {
    ...actual,
    getLndClient: () => {
      if (h.lndThrows) throw new Error("LND files not available");
      return { lnd: h.lnd, logger: null };
    },
  };
});

let db: Database.Database;
let gate: typeof import("./channelAcceptor");
let computeSubscriptionStatusForPubkey: typeof import("../subscription/statusHandler").computeSubscriptionStatusForPubkey;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  ({ db } = await import("../db"));
  gate = await import("./channelAcceptor");
  ({ computeSubscriptionStatusForPubkey } = await import("../subscription/statusHandler"));
});

beforeEach(() => {
  gate.resetChannelAcceptorForTests();
  h.streams.length = 0;
  h.lnd = { id: "lnd-1" };
  h.lndThrows = false;
  h.subscribeThrows = false;
  db.pragma("foreign_keys = OFF");
  db.exec("DELETE FROM subscription_payment; DELETE FROM subscription; DELETE FROM contacts;");
  db.pragma("foreign_keys = ON");
});

afterEach(() => {
  vi.useRealTimers();
});

const MS_PER_DAY = 86_400_000;

function seedRow(pubkey: string, tier: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO subscription (member_pubkey, deposit_address, derivation_path,
                               paid_through, created_at, current_tier)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(pubkey, `bcrt1q${pubkey.slice(2, 22)}`, `label-${pubkey}`, now, now - 90 * MS_PER_DAY, tier);
}

function tag(pubkey: string, tags: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO contacts (pubkey, name, tags, created_at, updated_at) VALUES (?, 'peer', ?, ?, ?)`,
  ).run(pubkey, tags, now, now);
}

/**
 * A stream error the way the library raises it (emitError, :77-84): DROPPED
 * when no 'error' listener is attached, emitted otherwise. Emitting 'error' on
 * the emitter directly would throw with no listener, which is not what a
 * production stream does — it goes silent.
 */
function libraryError(stream: { emitter: EventEmitter }, err: unknown) {
  if (!stream.emitter.listenerCount("error")) return;
  stream.emitter.emit("error", err);
}

function fakeRequest(partner: string) {
  return {
    partner_public_key: partner,
    capacity: 1_000_000,
    id: "aa".repeat(32),
    is_private: false,
    accept: vi.fn(),
    reject: vi.fn(),
  };
}

const PAID = "03" + "a1".repeat(32);
const UNPAID = "03" + "b2".repeat(32);
const PAST_30 = "03" + "c3".repeat(32);
const CLOSE_DUE = "03" + "d4".repeat(32);
const UNTAGGED = "03" + "e5".repeat(32);
const EXT_TAGGED = "03" + "f6".repeat(32);
const EXT_PEER_TAGGED = "03" + "07".repeat(32);
const EXT_WITH_PREPAY_ROW = "03" + "08".repeat(32);

function seedPopulation() {
  seedRow(PAID, "current");
  seedRow(UNPAID, "prepay");
  seedRow(PAST_30, "routing_lapsed");
  seedRow(CLOSE_DUE, "close_due");
  tag(EXT_TAGGED, "external");
  tag(EXT_PEER_TAGGED, "external-peer");
  tag(EXT_WITH_PREPAY_ROW, "external");
  seedRow(EXT_WITH_PREPAY_ROW, "prepay");
}

// ─── T4: who is admitted ───────────────────────────────────────────────────

describe("DW7/DW8 — the acceptor admits paid members and peers classified external, refuses the rest", () => {
  const ADMITTED: Array<[string, string]> = [
    ["a paid member (current)", PAID],
    ["a peer tagged `external`", EXT_TAGGED],
    ["a peer tagged `external-peer`", EXT_PEER_TAGGED],
    ["ACINQ, through the curated list, with no contact row", ACINQ],
    ["a node classified external that self-allocated a prepay row", EXT_WITH_PREPAY_ROW],
  ];
  const REFUSED: Array<[string, string]> = [
    ["a never-paid member (prepay)", UNPAID],
    ["a member past + 30 (routing_lapsed)", PAST_30],
    ["a member past + 60 (close_due)", CLOSE_DUE],
    ["an untagged opener with no subscription row (gate 1's case)", UNTAGGED],
  ];

  it.each(ADMITTED)("accepts %s", (_label, pubkey) => {
    seedPopulation();
    const req = fakeRequest(pubkey);
    expect(gate.handleOpenRequest(req as any)).toBe("accepted");
    expect(req.accept).toHaveBeenCalledTimes(1);
    expect(req.reject).not.toHaveBeenCalled();
  });

  it.each(REFUSED)("refuses %s, with R7's acceptor text", (_label, pubkey) => {
    seedPopulation();
    const req = fakeRequest(pubkey);
    expect(gate.handleOpenRequest(req as any)).toBe("rejected");
    expect(req.accept).not.toHaveBeenCalled();
    expect(req.reject).toHaveBeenCalledWith({ reason: R7_ACCEPTOR_TEXT });
  });

  it("matches keys in lowercase: a paid member's key arriving in uppercase is admitted", () => {
    seedPopulation();
    const req = fakeRequest(PAID.toUpperCase());
    expect(gate.handleOpenRequest(req as any)).toBe("accepted");
  });

  it("the acceptor text is ASCII and under LND's 500-character limit", () => {
    expect(gate.ACCEPTOR_REJECT_REASON).toBe(R7_ACCEPTOR_TEXT);
    expect(R7_ACCEPTOR_TEXT.length).toBe(133);
    expect(/^[\x20-\x7e]+$/.test(R7_ACCEPTOR_TEXT)).toBe(true);
  });
});

describe("R6 — a throwing predicate accepts the open and counts toward the alert", () => {
  it("a database error accepts, records the error, and raises the alert for an hour", () => {
    seedPopulation();
    const now = Date.now();
    db.exec("ALTER TABLE subscription RENAME TO subscription_away");
    let outcome: string;
    const req = fakeRequest(UNPAID);
    try {
      outcome = gate.handleOpenRequest(req as any, now);
    } finally {
      db.exec("ALTER TABLE subscription_away RENAME TO subscription");
    }
    expect(outcome).toBe("accepted_on_error");
    expect(req.accept).toHaveBeenCalledTimes(1);
    expect(req.reject).not.toHaveBeenCalled();
    const health = { ...gate.getChannelAcceptorHealth(), applicable: true, stream_open: true };
    expect(health.last_predicate_error_at).toBe(now);
    expect(gate.channelGateAlert(health, now + 59 * 60_000)?.heading).toBe(T5_HEADING);
    expect(gate.channelGateAlert(health, now + 60 * 60_000)?.heading).toBe(T5_HEADING);
    expect(gate.channelGateAlert(health, now + 60 * 60_000 + 1)).toBeNull();
  });
});

describe("S4 — the alert's message names its cause; heading and severity unchanged", () => {
  const now = 1_790_000_000_000;
  const recent = now - 10 * 60_000;

  it("stream not open, no predicate error: the stream message", () => {
    const a = gate.channelGateAlert({ applicable: true, stream_open: false, last_predicate_error_at: null }, now);
    expect(a?.message).toBe(T5_MESSAGE);
    expect(a?.heading).toBe(T5_HEADING);
    expect(a?.severity).toBe("warning");
  });

  it("stream open, predicate error in the last hour: the predicate-error message", () => {
    const a = gate.channelGateAlert({ applicable: true, stream_open: true, last_predicate_error_at: recent }, now);
    expect(a?.message).toBe(T5_PREDICATE_ERROR_MESSAGE);
    expect(a?.heading).toBe(T5_HEADING);
    expect(a?.severity).toBe("warning");
  });

  it("both true: the stream message wins", () => {
    const a = gate.channelGateAlert({ applicable: true, stream_open: false, last_predicate_error_at: recent }, now);
    expect(a?.message).toBe(T5_MESSAGE);
    expect(a?.heading).toBe(T5_HEADING);
    expect(a?.severity).toBe("warning");
  });

  it("stream not open with a predicate error older than an hour: the stream message", () => {
    const old = now - 60 * 60_000 - 1;
    const a = gate.channelGateAlert({ applicable: true, stream_open: false, last_predicate_error_at: old }, now);
    expect(a?.message).toBe(T5_MESSAGE);
  });
});

// ─── T4: the verdict in the status response ────────────────────────────────

describe("R4 / item 2 — the status response carries the gate's own verdict as open_channel_allowed", () => {
  it("is the acceptor's predicate: the two paths cannot disagree", () => {
    seedPopulation();
    for (const pk of [PAID, UNPAID, PAST_30, CLOSE_DUE, UNTAGGED, EXT_TAGGED, EXT_PEER_TAGGED, ACINQ, EXT_WITH_PREPAY_ROW]) {
      const outcome = gate.handleOpenRequest(fakeRequest(pk) as any);
      const verdict = computeSubscriptionStatusForPubkey(pk).open_channel_allowed;
      expect(verdict, pk).toBe(outcome === "accepted");
    }
  });

  it("true for a paid member, false for an unpaid one, on the applicable case", () => {
    seedPopulation();
    const paid = computeSubscriptionStatusForPubkey(PAID);
    const unpaid = computeSubscriptionStatusForPubkey(UNPAID);
    expect(paid.applicable).toBe(true);
    expect(paid.open_channel_allowed).toBe(true);
    expect(unpaid.applicable).toBe(true);
    expect(unpaid.open_channel_allowed).toBe(false);
  });

  it("is carried on not-applicable cases too: an external peer with a channel reads true", () => {
    tag(EXT_TAGGED, "external");
    db.prepare(
      `INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat,
                                 remote_balance_sat, active, private, updated_at)
       VALUES ('9x9x9', ?, 1000000, 500000, 500000, 1, 0, ?)`,
    ).run(EXT_TAGGED, Date.now());
    try {
      const status = computeSubscriptionStatusForPubkey(EXT_TAGGED);
      expect(status).toMatchObject({ applicable: false, reason: "external_peer", open_channel_allowed: true });
    } finally {
      db.exec("DELETE FROM lnd_channels");
    }
  });

  it("null when the predicate cannot be evaluated (unknown, so the app check lets the open through)", () => {
    db.exec("ALTER TABLE subscription RENAME TO subscription_away");
    try {
      expect(gate.openChannelVerdict(UNPAID)).toBeNull();
    } finally {
      db.exec("ALTER TABLE subscription_away RENAME TO subscription");
    }
  });

  it("keeps everything else in the response, grace.fresh_until included (T1)", () => {
    seedPopulation();
    const status = computeSubscriptionStatusForPubkey(PAID);
    if (status.applicable !== true) throw new Error("unreachable");
    expect(Object.keys(status.grace).sort()).toEqual(["close_at", "fresh_until", "routing_until", "worker_until"]);
  });
});

// ─── T4: registration and the stream (R9, item B) ─────────────────────────

describe("R9 — registers only when this node's own pubkey is the treasury's", () => {
  it("a member node never opens the stream, and raises nothing", () => {
    gate.startChannelAcceptor(() => "03" + "99".repeat(32));
    expect(h.streams).toHaveLength(0);
    const health = gate.getChannelAcceptorHealth();
    expect(health).toMatchObject({ applicable: false, stream_open: false });
    expect(gate.channelGateAlert(health, Date.now())).toBeNull();
  });

  it("an unknown own pubkey (node info not yet synced) opens nothing", () => {
    gate.startChannelAcceptor(() => null);
    expect(h.streams).toHaveLength(0);
  });

  it("the treasury opens one stream on its LND client, with an error listener attached", () => {
    gate.startChannelAcceptor(() => TREASURY.toUpperCase());
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0].lnd).toBe(h.lnd);
    expect(h.streams[0].emitter.listenerCount("error")).toBeGreaterThan(0);
    expect(h.streams[0].emitter.listenerCount("end")).toBeGreaterThan(0);
    expect(gate.getChannelAcceptorHealth()).toMatchObject({ applicable: true, stream_open: true });
    expect(gate.channelGateAlert(gate.getChannelAcceptorHealth(), Date.now())).toBeNull();
    gate.superviseChannelAcceptor();
    expect(h.streams).toHaveLength(1); // idempotent
  });

  it("registers on the first tick after node info arrives", () => {
    vi.useFakeTimers();
    let own: string | null = null;
    gate.startChannelAcceptor(() => own);
    expect(h.streams).toHaveLength(0);
    own = TREASURY;
    vi.advanceTimersByTime(gate.SUPERVISOR_INTERVAL_MS);
    expect(h.streams).toHaveLength(1);
  });

  it("stands down (cancels) if this node stops being the treasury", () => {
    let own: string | null = TREASURY;
    gate.startChannelAcceptor(() => own);
    own = "03" + "99".repeat(32);
    gate.superviseChannelAcceptor();
    expect(h.streams[0].cancelled).toBe(true);
    expect(gate.getChannelAcceptorHealth().stream_open).toBe(false);
  });

  it("routes a channel_request on the stream through the gate", () => {
    seedPopulation();
    gate.startChannelAcceptor(() => TREASURY);
    const req = fakeRequest(UNPAID);
    h.streams[0].emitter.emit("channel_request", req);
    expect(req.reject).toHaveBeenCalledWith({ reason: R7_ACCEPTOR_TEXT });
  });
});

describe("item B — re-subscribes on end, on error, and when the LND client is rebuilt", () => {
  it("on `end`: the stream is down (alert raised), then re-opened after the delay (alert cleared)", () => {
    vi.useFakeTimers();
    gate.startChannelAcceptor(() => TREASURY);
    h.streams[0].emitter.emit("end", {});
    const down = gate.getChannelAcceptorHealth();
    expect(down.stream_open).toBe(false);
    const alert = gate.channelGateAlert(down, Date.now());
    expect(alert?.heading).toBe(T5_HEADING);
    expect(alert?.message).toBe(T5_MESSAGE);
    vi.advanceTimersByTime(gate.RESUBSCRIBE_DELAY_MS);
    expect(h.streams).toHaveLength(2);
    expect(gate.getChannelAcceptorHealth().stream_open).toBe(true);
    expect(gate.channelGateAlert(gate.getChannelAcceptorHealth(), Date.now())).toBeNull();
  });

  it("on `error`: noticed (the library drops it without a listener), the stream is down, then re-opened", () => {
    vi.useFakeTimers();
    gate.startChannelAcceptor(() => TREASURY);
    libraryError(h.streams[0], [503, "UnexpectedErrorInChannelAcceptor"]);
    expect(gate.getChannelAcceptorHealth().stream_open).toBe(false);
    expect(gate.channelGateAlert(gate.getChannelAcceptorHealth(), Date.now())?.heading).toBe(T5_HEADING);
    vi.advanceTimersByTime(gate.RESUBSCRIBE_DELAY_MS);
    expect(h.streams).toHaveLength(2);
    expect(gate.getChannelAcceptorHealth().stream_open).toBe(true);
  });

  it("when the LND client is rebuilt: the old stream is cancelled and a new one opens on the new client", () => {
    gate.startChannelAcceptor(() => TREASURY);
    const first = h.streams[0];
    h.lnd = { id: "lnd-2 (cert rotated)" };
    gate.superviseChannelAcceptor();
    expect(first.cancelled).toBe(true);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1].lnd).toBe(h.lnd);
    // A late event from the old stream does not take the new one down.
    first.emitter.emit("end", {});
    libraryError(first, new Error("CANCELLED"));
    expect(gate.getChannelAcceptorHealth().stream_open).toBe(true);
  });

  it("the supervisor tick is what notices a rebuild", () => {
    vi.useFakeTimers();
    gate.startChannelAcceptor(() => TREASURY);
    h.lnd = { id: "lnd-2" };
    vi.advanceTimersByTime(gate.SUPERVISOR_INTERVAL_MS);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1].lnd).toBe(h.lnd);
  });

  it("no LND client: no stream, alert raised; the stream opens once the client is back", () => {
    h.lndThrows = true;
    gate.startChannelAcceptor(() => TREASURY);
    expect(h.streams).toHaveLength(0);
    expect(gate.channelGateAlert(gate.getChannelAcceptorHealth(), Date.now())?.heading).toBe(T5_HEADING);
    h.lndThrows = false;
    gate.superviseChannelAcceptor();
    expect(h.streams).toHaveLength(1);
  });

  it("a subscribe that throws leaves the stream down and retries after the delay", () => {
    vi.useFakeTimers();
    h.subscribeThrows = true;
    gate.startChannelAcceptor(() => TREASURY);
    expect(gate.getChannelAcceptorHealth().stream_open).toBe(false);
    h.subscribeThrows = false;
    vi.advanceTimersByTime(gate.RESUBSCRIBE_DELAY_MS);
    expect(h.streams).toHaveLength(1);
    expect(gate.getChannelAcceptorHealth().stream_open).toBe(true);
  });
});
