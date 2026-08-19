import { beforeEach, describe, expect, it, vi } from "vitest";

// deriveNodeRole is pure, but sync.ts's module graph is not: `../db` runs
// fs.mkdirSync("/data/db") at import time and `./lnd` builds a gRPC client.
// Mock the graph so these tests exercise role derivation and nothing else.
// ENV lives in a hoisted box because vi.mock factories are lifted above
// const declarations, and because deriveNodeRole reads ENV.treasuryPubkey at
// call time — each test needs to vary it.
const h = vi.hoisted(() => ({ env: { treasuryPubkey: "", debug: false } }));

vi.mock("../config/env", () => ({ ENV: h.env }));
vi.mock("../db", () => ({ db: {} }));
vi.mock("./lnd", () => ({
  isLndAvailable: vi.fn(),
  getLndInfo: vi.fn(),
  getLndChannels: vi.fn(),
}));
vi.mock("./persist", () => ({ persistNodeInfo: vi.fn() }));
vi.mock("./persist-channels", () => ({ persistPeers: vi.fn(), persistChannels: vi.fn() }));
vi.mock("./persist-inbound", () => ({ syncInboundPayments: vi.fn() }));
vi.mock("./persist-forwarded", () => ({ syncForwardingHistory: vi.fn() }));
vi.mock("./network-payments", () => ({ syncNetworkInvoiceSettlements: vi.fn() }));

const { deriveNodeRole } = await import("./sync");

const TREASURY =
  "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
const OTHER_NODE =
  "03a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

beforeEach(() => {
  h.env.treasuryPubkey = "";
});

// An unconfigured node must never be mistaken for the treasury. This is the
// asymmetric direction: assertTreasury() in utils/role.ts throws on every
// role except "treasury", so a false "treasury" is the one misclassification
// that GRANTS privilege instead of withholding it.
describe("deriveNodeRole — empty identity must not classify as treasury", () => {
  it("no LND pubkey and no TREASURY_PUBKEY is not treasury", () => {
    h.env.treasuryPubkey = "";
    expect(deriveNodeRole("", false)).not.toBe("treasury");
  });

  it("no LND pubkey and no TREASURY_PUBKEY falls through to external", () => {
    h.env.treasuryPubkey = "";
    expect(deriveNodeRole("", false)).toBe("external");
  });

  it("no LND pubkey and no TREASURY_PUBKEY is member when a treasury channel exists", () => {
    h.env.treasuryPubkey = "";
    expect(deriveNodeRole("", true)).toBe("member");
  });

  it("no LND pubkey against a configured TREASURY_PUBKEY is not treasury", () => {
    h.env.treasuryPubkey = TREASURY;
    expect(deriveNodeRole("", false)).not.toBe("treasury");
  });

  it("unset TREASURY_PUBKEY does not make a real node treasury", () => {
    h.env.treasuryPubkey = "";
    expect(deriveNodeRole(OTHER_NODE, false)).not.toBe("treasury");
  });
});

// The outage direction: the guard must not reject real comparisons. A fix
// that refuses every comparison would satisfy the block above and break
// every one of these.
describe("deriveNodeRole — real identities still classify correctly", () => {
  it("a real pubkey matching TREASURY_PUBKEY is treasury", () => {
    h.env.treasuryPubkey = TREASURY;
    expect(deriveNodeRole(TREASURY, false)).toBe("treasury");
  });

  it("a real pubkey matching TREASURY_PUBKEY is treasury even with a treasury channel", () => {
    h.env.treasuryPubkey = TREASURY;
    expect(deriveNodeRole(TREASURY, true)).toBe("treasury");
  });

  it("a real non-matching pubkey with a treasury channel is member", () => {
    h.env.treasuryPubkey = TREASURY;
    expect(deriveNodeRole(OTHER_NODE, true)).toBe("member");
  });

  it("a real non-matching pubkey with no treasury channel is external", () => {
    h.env.treasuryPubkey = TREASURY;
    expect(deriveNodeRole(OTHER_NODE, false)).toBe("external");
  });
});
