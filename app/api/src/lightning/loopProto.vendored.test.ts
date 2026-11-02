// The vendored loop proto set loads, and is the set of the loopd we ship.
//
// loop-fee-ceilings spec D20. The F8 autoloop switch-off writes the full
// LiquidityParameters set back (SetLiquidityParams replaces it whole), so a
// vendored client.proto that lacks fields would silently drop them on the
// round-trip — fast_swap_publication (26) is the one that bites. The copy
// vendored before this arc stopped at field 24.
//
// loop v0.33.0-beta's client.proto imports lnrpc/lightning.proto, so lnd
// v0.20.1-beta's (the lnd loop v0.33.0-beta pins in go.mod) is vendored beside
// it. Provenance when vendored: lightning.proto was taken from the lnd repo's
// v0.20.1-beta tag (commit 848b72ce96eb68fa90fd4336523ca4c59bddcd4c) and was
// byte-identical to the Go module-cache copy; client.proto and common.proto
// from loop v0.33.0-beta (commit 21acb234866f24273f20559f4a1d98266945fd0a).
// The sha256 pins below hold the files to exactly those bytes.
//
// Nothing is mocked: importing ./loop runs its real loadSync with its real
// options and PROTO_DIR, which is what production loads at startup.
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { PROTO_DIR, packageDef } from "./loop";

const PINS: Record<string, string> = {
  "looprpc/client.proto":
    "7f7fdc11180eaead3f697993ee69fb1deae15cd8ab8c42f74f03c4e1bc1cc47f",
  "swapserverrpc/common.proto":
    "81de998243a6fddda43292d468c2c13536960056b245fafb7bd76fffea842bc8",
  "lnrpc/lightning.proto":
    "8de51253eaa478175ab21be522862cfa33c07d9dc390d7aa4544bf4220ac4f3a",
};

describe("vendored loop proto set (D20)", () => {
  it("LiquidityParameters carries fields 1–27", () => {
    const msg = (packageDef as any)["looprpc.LiquidityParameters"];
    const numbers = (msg.type.field as Array<{ number: number }>)
      .map((f) => f.number)
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
  });

  it("SwapClient exposes GetLiquidityParams and SetLiquidityParams", () => {
    const svc = (packageDef as any)["looprpc.SwapClient"];
    expect(Object.keys(svc)).toEqual(
      expect.arrayContaining(["GetLiquidityParams", "SetLiquidityParams"])
    );
  });

  it.each(Object.entries(PINS))("%s matches its pinned sha256", (rel, sha) => {
    const bytes = fs.readFileSync(path.join(PROTO_DIR, rel));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
  });
});
