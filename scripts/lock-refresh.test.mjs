#!/usr/bin/env node
// lock-refresh.test.mjs: node:test suite for the pure parts of
// scripts/lock-refresh.mjs: the Step A manifest strip, the computation of L,
// the exact-spec arguments, the cut-off, and the allowlist gate on --exception.
//
//   node --test scripts/lock-refresh.test.mjs
//
// No npm, no network, no clock. Each test was run against a named mutation of
// lock-refresh.mjs and seen to go red; the PR body records each pair.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeL,
  cutoffOf,
  exceptionEntryFor,
  loadAllowlist,
  nonExactDirectSpecs,
  parseSpec,
  requiredAllowlisted,
  stripManifest,
} from "./lock-refresh.mjs";

const ETHAN = { words: "fixture words", date: "2026-12-01", record: "decisions/2026-12-01-fixture.md" };

test("R1: Step A strips the young allowlisted dependency and override, and nothing else", () => {
  const manifest = {
    name: "fx",
    dependencies: { viem: "2.58.2", react: "18.3.1" },
    devDependencies: { vitest: "2.1.9" },
    overrides: { ox: "0.15.3", isows: "1.0.7" },
  };
  const { manifest: out, stripped } = stripManifest(manifest, [
    { name: "viem", version: "2.58.2" },
    { name: "ox", version: "0.15.3" },
  ]);
  assert.deepEqual(out, { name: "fx", dependencies: { react: "18.3.1" }, devDependencies: { vitest: "2.1.9" }, overrides: { isows: "1.0.7" } });
  assert.deepEqual(stripped.map((s) => `${s.field}.${s.name}`).sort(), ["dependencies.viem", "overrides.ox"]);
  assert.equal(manifest.dependencies.viem, "2.58.2", "the input manifest is not modified");
});

test("R2: Step A keeps the same name at another version", () => {
  const { manifest: out, stripped } = stripManifest({ dependencies: { viem: "2.57.19" } }, [{ name: "viem", version: "2.58.2" }]);
  assert.deepEqual(out, { dependencies: { viem: "2.57.19" } });
  assert.deepEqual(stripped, []);
});

test("R3: L is the latest publish time among the applied versions, not now", () => {
  const times = { viem: { "2.58.2": "2026-11-30T10:00:00.000Z" }, ox: { "0.15.3": "2026-11-29T08:00:00.000Z" } };
  const L = computeL([{ name: "viem", version: "2.58.2" }, { name: "ox", version: "0.15.3" }], times);
  assert.equal(L, "2026-11-30T10:00:00.000Z");
});

test("R3b: L refuses a version with no publish time", () => {
  assert.throws(() => computeL([{ name: "viem", version: "2.58.2" }], { viem: {} }), /no publish time/);
  assert.throws(() => computeL([], {}), /no allowlisted versions/);
});

test("R4: every range direct spec is passed as name@range; exact specs are not", () => {
  const args = nonExactDirectSpecs({
    dependencies: { viem: "^2.51.0", react: "18.3.1" },
    devDependencies: { vitest: "~2.1.9", "@types/node": "22.19.1" },
    optionalDependencies: { fsevents: "^2.3.3" },
    peerDependencies: { react: "^18" },
  });
  assert.deepEqual(args, ["viem@^2.51.0", "vitest@~2.1.9", "fsevents@^2.3.3"]);
});

test("R5: name@version parses scoped and unscoped names", () => {
  assert.deepEqual(parseSpec("viem@2.57.10"), { name: "viem", version: "2.57.10" });
  assert.deepEqual(parseSpec("@noble/hashes@1.8.0"), { name: "@noble/hashes", version: "1.8.0" });
  assert.equal(parseSpec("viem"), null);
  assert.equal(parseSpec("@noble/hashes"), null);
});

test("R6: the cut-off is now minus 3 days, printed as %FT%TZ", () => {
  assert.equal(cutoffOf(Date.parse("2026-12-01T12:34:56.789Z")), "2026-11-28T12:34:56Z");
});

test("R7: --exception needs an overrule or security-fix entry at that exact version", () => {
  const entries = [
    { name: "serve", kind: "new-dependency", reason: "r", ethan: ETHAN },
    { name: "viem", version: "2.58.2", kind: "security-fix", reason: "r", advisory: "GHSA-x", date: "2026-12-01" },
  ];
  assert.equal(exceptionEntryFor(entries, "viem", "2.58.2")?.kind, "security-fix");
  assert.equal(exceptionEntryFor(entries, "viem", "2.58.1"), null);
  assert.equal(exceptionEntryFor([{ name: "viem", kind: "new-dependency", reason: "r", ethan: ETHAN }], "viem", undefined), null);
});

test("R8: a malformed or missing allowlist stops a refresh", () => {
  assert.throws(() => loadAllowlist(undefined), /missing or unreadable/);
  assert.throws(() => loadAllowlist({ schema: 1, entries: [{ name: "viem", version: "2.58.2", kind: "wish", reason: "r" }] }), /unknown kind/);
  assert.deepEqual(loadAllowlist({ schema: 1, entries: [] }), []);
});

test("R9: standing exceptions are the allowlisted versions the manifest already requires", () => {
  const entries = [
    { name: "viem", version: "2.58.2", kind: "security-fix", reason: "r", advisory: "GHSA-x", date: "2026-12-01" },
    { name: "ox", version: "0.15.3", kind: "security-fix", reason: "r", advisory: "GHSA-x", date: "2026-12-01" },
    { name: "jose", version: "6.0.0", kind: "overrule", reason: "r", ethan: ETHAN },
    { name: "serve", kind: "new-dependency", reason: "r", ethan: ETHAN },
  ];
  const got = requiredAllowlisted({ dependencies: { viem: "2.58.2", jose: "5.10.0", serve: "14.2.5" }, overrides: { ox: "0.15.3" } }, entries);
  assert.deepEqual(got, [{ name: "viem", version: "2.58.2" }, { name: "ox", version: "0.15.3" }]);
});
