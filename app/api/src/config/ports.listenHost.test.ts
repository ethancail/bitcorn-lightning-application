// API_LISTEN_HOST — the API's bind address, dev-safety R2
// (vault: decisions/2026-11-13-dev-safety-rulings-r1-to-r5-keypair-log-by-network-api-listen-host-harness-lock.md).
//
// Unset: no host is passed to listen(), today's bind (production sets no such
// variable). Set: it must pass net.isIP(). Empty or invalid: ports.ts throws
// when it is loaded, which is at boot, before anything listens. The empty case
// matters most: listen(port, "") binds every interface, so treating "" as
// unset would fail open.

import fs from "fs";
import http from "http";
import { AddressInfo } from "net";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const saved = process.env.API_LISTEN_HOST;
afterEach(() => {
  if (saved === undefined) delete process.env.API_LISTEN_HOST;
  else process.env.API_LISTEN_HOST = saved;
});

async function loadPorts(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env.API_LISTEN_HOST;
  else process.env.API_LISTEN_HOST = value;
  return (await import("./ports")).PORTS;
}

async function boundAddress(host: string | undefined): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const { address } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return address;
}

describe("R2 — resolving API_LISTEN_HOST at load", () => {
  it("unset: no host", async () => {
    expect((await loadPorts(undefined)).listenHost).toBeUndefined();
  });
  for (const ip of ["127.0.0.1", "::1"]) {
    it(`${ip}: taken as given`, async () => {
      expect((await loadPorts(ip)).listenHost).toBe(ip);
    });
  }
  it(`"": refused as set but empty, never read as unset`, async () => {
    await expect(loadPorts("")).rejects.toThrow(/API_LISTEN_HOST is set but empty/);
  });
  for (const bad of ["localhost", "bogus"]) {
    it(`${JSON.stringify(bad)}: refused as not an IP address`, async () => {
      await expect(loadPorts(bad)).rejects.toThrow(/API_LISTEN_HOST must be an IP address/);
    });
  }
});

describe("R2 — a real bind", () => {
  it("127.0.0.1: server.address() is 127.0.0.1", async () => {
    const ports = await loadPorts("127.0.0.1");
    expect(await boundAddress(ports.listenHost)).toBe("127.0.0.1");
  });
  it("unset: the same address as a listen() given no host at all, today's bind", async () => {
    const ports = await loadPorts(undefined);
    const today = await boundAddress(undefined);
    expect(await boundAddress(ports.listenHost)).toBe(today);
    expect(today).not.toBe("127.0.0.1");
  });
});

// index.ts's main() is not exported and boots every side effect, so its
// listen() cannot be driven from a test without restructuring index.ts (out of
// R2's scope: "change nothing else in index.ts"). This pins the call's text.
describe("R2 — index.ts passes the host to listen()", () => {
  it("the one server.listen call passes PORTS.listenHost", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
    const calls = src.match(/server\.listen\([^)]*\)/g);
    expect(calls).toEqual(["server.listen(PORTS.userApi, PORTS.listenHost, ()"]);
  });
});
