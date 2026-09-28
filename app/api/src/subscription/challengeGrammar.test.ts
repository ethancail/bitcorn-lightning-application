// The shared signed-string grammar — spec 2026-09-25-member-name-signed-
// transport §3, Q3, §12 P13. Decision D8.
//
// The literals are HARDCODED: moving CHALLENGE_PREFIX into this module must
// not change its bytes (D8 call 1), and a test importing the constant it pins
// could not notice if it did.

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { CHALLENGE_PREFIX, NAME_SIGNATURE_PREFIX, buildNameSignedString } from "./challengeGrammar";

describe("challenge grammar", () => {
  it("CHALLENGE_PREFIX is byte-identical to the pre-D8 literal", () => {
    expect(CHALLENGE_PREFIX).toBe("bitcorn:token-request:");
  });

  it("NAME_SIGNATURE_PREFIX is its own string and does NOT start with the challenge prefix", () => {
    expect(NAME_SIGNATURE_PREFIX).toBe("bitcorn:member-name:");
    expect(NAME_SIGNATURE_PREFIX.startsWith("bitcorn:token-request:")).toBe(false);
    // …so a name-signed string fails the challenge parser's FIRST check.
    expect(buildNameSignedString("bitcorn:token-request:02ab:1", "x").startsWith("bitcorn:token-request:")).toBe(false);
  });

  it("builds bitcorn:member-name:<challenge>:<name> with both parts exactly as given", () => {
    const challenge = "bitcorn:token-request:" + "02" + "ab".repeat(32) + ":1790000000";
    expect(buildNameSignedString(challenge, "Green  Acres")).toBe(
      `bitcorn:member-name:${challenge}:Green  Acres`,
    );
  });

  it("the prefix now has exactly ONE definition in src/ (Q3: it used to be duplicated)", () => {
    const src = path.resolve(__dirname, "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) {
          if (/=\s*["']bitcorn:token-request:["']/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(src, p));
        }
      }
    };
    walk(src);
    expect(hits).toEqual(["subscription/challengeGrammar.ts"]);
  });
});
