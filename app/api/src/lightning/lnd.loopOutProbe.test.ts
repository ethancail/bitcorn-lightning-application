// probeLoopOutPaymentRoute — the Loop Out sibling of probeRouteToLoopServer
// (loop-fee-ceilings spec §3 Q5, §4 A and B). ln-service is the mock; lnd.ts is
// the real code. Pins what the sibling's header claims about its divergence:
// it probes local → destination (no `start`), passes no max_fee (an over-cap
// route must come back as a route with its fee, not as "no route"), honours an
// outgoing channel, returns the route's fee, and never throws.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ln = vi.hoisted(() => ({
  getRouteToDestination: vi.fn(),
}));

vi.mock("ln-service", () => ({
  authenticatedLndGrpc: () => ({ lnd: { mocked: true } }),
  getRouteToDestination: ln.getRouteToDestination,
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: { ...actual, existsSync: () => true, readFileSync: () => Buffer.from("x") },
    existsSync: () => true,
    readFileSync: () => Buffer.from("x"),
  };
});

import { probeLoopOutPaymentRoute, invalidateLndClient } from "./lnd";

const DEST = "03" + "fb".repeat(32);

beforeEach(() => {
  ln.getRouteToDestination.mockReset();
  invalidateLndClient();
});

describe("probeLoopOutPaymentRoute", () => {
  it("returns the route's fee; probes from the local node with no start and no max_fee", async () => {
    ln.getRouteToDestination.mockResolvedValue({ route: { fee: 2_501, hops: [], tokens: 250_000 } });
    await expect(probeLoopOutPaymentRoute(DEST, 250_000)).resolves.toEqual({ routable: true, feeSat: 2_501 });
    const args = ln.getRouteToDestination.mock.calls[0][0];
    expect(args).toMatchObject({ destination: DEST, tokens: 250_000 });
    expect(args).not.toHaveProperty("start");
    expect(args).not.toHaveProperty("max_fee");
    expect(args).not.toHaveProperty("outgoing_channel");
  });

  it("passes an outgoing channel through when given", async () => {
    ln.getRouteToDestination.mockResolvedValue({ route: { fee: 1 } });
    await probeLoopOutPaymentRoute(DEST, 30_000, "943963x1975x1");
    expect(ln.getRouteToDestination.mock.calls[0][0]).toMatchObject({ outgoing_channel: "943963x1975x1" });
  });

  it("no route → not routable", async () => {
    ln.getRouteToDestination.mockResolvedValue({});
    await expect(probeLoopOutPaymentRoute(DEST, 250_000)).resolves.toEqual({ routable: false });
  });

  it("an LND error → not routable, never a throw", async () => {
    ln.getRouteToDestination.mockRejectedValue([503, "UnexpectedErrorQueryingRoutes"]);
    await expect(probeLoopOutPaymentRoute(DEST, 250_000)).resolves.toMatchObject({ routable: false });
  });
});
