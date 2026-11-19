#!/usr/bin/env node
// lock-age-check.test.mjs: node:test suite for scripts/lock-age-check.mjs.
//
//   node --test scripts/lock-age-check.test.mjs
//
// Every test calls the pure core, checkLocks(), with fixture locks, a fixed
// `now` and a fixture registry. Nothing here touches the network or the clock.
// The rows follow the lockfile spec's section 6.2 (T1 to T9c). Each was run
// against a named mutation of the check and seen to go red; the PR body
// records each pair.

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkLocks, validateAllowlist, WINDOW_MS } from "./lock-age-check.mjs";

const NOW = Date.parse("2026-12-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const REG = "https://registry.npmjs.org/";
const at = (msBeforeNow) => new Date(NOW - msBeforeNow).toISOString();

const ETHAN = { words: "fixture words", date: "2026-12-01", record: "decisions/2026-12-01-fixture.md" };

function lockOf(entries) {
  const packages = { "": { name: "fixture" } };
  for (const [key, meta] of Object.entries(entries)) packages[key] = meta;
  return { name: "fixture", lockfileVersion: 3, requires: true, packages };
}

const reg = (name, version) => ({ version, resolved: `${REG}${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity: "sha512-x" });

// Registry fixture: { name: { version: isoTime } }. A name absent from it throws,
// as a failed fetch does.
function registryOf(times) {
  return async (name) => {
    if (!(name in times)) throw new Error(`fixture: no packument for ${name}`);
    return times[name] === "NO_TIME" ? { name } : { time: times[name] };
  };
}

async function run(opts) {
  const { lock, manifest = { name: "fixture" }, base, times = {}, tracked = null, locks, manifests } = opts;
  // "allowlist" in opts, not a default parameter: V2 passes undefined on purpose.
  const allowlist = "allowlist" in opts ? opts.allowlist : { schema: 1, entries: [] };
  return checkLocks({
    dirs: ["fx"],
    packageDirs: ["fx"],
    trackedManifests: tracked,
    manifests: manifests ?? { fx: manifest },
    locks: locks ?? { fx: lock },
    baseManifests: base === undefined ? null : { fx: base },
    allowlist,
    now: NOW,
    registry: registryOf(times),
  });
}

const rules = (r) => r.failures.map((f) => f.rule);

test("T1: an entry published 1 day before now is red, named", async () => {
  const r = await run({ lock: lockOf({ "node_modules/viem": reg("viem", "2.58.2") }), times: { viem: { "2.58.2": at(1 * DAY) } } });
  assert.deepEqual(rules(r), [1]);
  assert.match(r.failures[0].msg, /viem@2\.58\.2/);
});

test("T2: T1's entry with a matching allowlist entry is green, counted young-allowlisted", async () => {
  const allowlist = { schema: 1, entries: [{ name: "viem", version: "2.58.2", kind: "overrule", reason: "fixture", ethan: ETHAN }] };
  const r = await run({ lock: lockOf({ "node_modules/viem": reg("viem", "2.58.2") }), times: { viem: { "2.58.2": at(1 * DAY) } }, allowlist });
  assert.deepEqual(r.failures, []);
  assert.equal(r.perDir.fx.youngAllowlisted, 1);
  assert.deepEqual(r.warnings, []);
});

test("T2b: an allowlist entry for the same name at another version does not cover it", async () => {
  const allowlist = { schema: 1, entries: [{ name: "viem", version: "2.58.1", kind: "overrule", reason: "fixture", ethan: ETHAN }] };
  const r = await run({ lock: lockOf({ "node_modules/viem": reg("viem", "2.58.2") }), times: { viem: { "2.58.2": at(1 * DAY) } }, allowlist });
  assert.deepEqual(rules(r), [1]);
});

const PKG_PR = "https://pkg.pr.new/ox@386a3439fe1ce76d237930f8c6e6bb493746069a";
const urlLock = () => lockOf({ "node_modules/ox": { version: "0.14.26-386a343.0", resolved: PKG_PR } });

test("T3: a pkg.pr.new entry has no publish time and is red", async () => {
  const r = await run({ lock: urlLock() });
  assert.deepEqual(rules(r), [2]);
  assert.match(r.failures[0].msg, /no registry publish time/);
});

test("T3b: the same entry with that exact URL allowlisted is green", async () => {
  const allowlist = { schema: 1, entries: [{ name: "ox", version: "0.14.26-386a343.0", resolved: PKG_PR, kind: "overrule", reason: "fixture", ethan: ETHAN }] };
  const r = await run({ lock: urlLock(), allowlist });
  assert.deepEqual(r.failures, []);
  assert.equal(r.perDir.fx.youngAllowlisted, 1);
});

test("T3c: name@version allowlisted with a different URL does not cover it", async () => {
  const allowlist = { schema: 1, entries: [{ name: "ox", version: "0.14.26-386a343.0", resolved: "https://pkg.pr.new/ox@0000000", kind: "overrule", reason: "fixture", ethan: ETHAN }] };
  const r = await run({ lock: urlLock(), allowlist });
  assert.deepEqual(rules(r), [2]);
});

test("T4a: a registry fetch that throws is red", async () => {
  const r = await run({ lock: lockOf({ "node_modules/viem": reg("viem", "2.50.0") }), times: {} });
  assert.deepEqual(rules(r), [3]);
  assert.match(r.failures[0].msg, /registry fetch failed/);
});

test("T4b: a packument with no time object is red", async () => {
  const r = await run({ lock: lockOf({ "node_modules/viem": reg("viem", "2.50.0") }), times: { viem: "NO_TIME" } });
  assert.deepEqual(rules(r), [3]);
  assert.match(r.failures[0].msg, /no time object/);
});

test("T5: anti-vacuity, N old entries are green and the count checked equals N", async () => {
  const entries = {};
  const times = {};
  const N = 7;
  for (let i = 0; i < N; i++) {
    entries[`node_modules/p${i}`] = reg(`p${i}`, "1.0.0");
    times[`p${i}`] = { "1.0.0": at(400 * DAY) };
  }
  const r = await run({ lock: lockOf(entries), times });
  assert.deepEqual(r.failures, []);
  assert.equal(r.perDir.fx.checked, N);
});

test("T6: a package directory with a package.json and no lock is red", async () => {
  const r = await run({ lock: null });
  assert.deepEqual(rules(r), [4]);
  assert.match(r.failures[0].msg, /no lockfile/);
});

test("T6b: a tracked package.json in neither list is red; an excluded one is not", async () => {
  const r = await checkLocks({
    dirs: [],
    packageDirs: ["fx"],
    excluded: { "app/web/.vite/deps/package.json": "stub" },
    trackedManifests: ["fx/package.json", "app/web/.vite/deps/package.json", "stray/package.json"],
    manifests: {},
    locks: {},
    baseManifests: null,
    allowlist: { schema: 1, entries: [] },
    now: NOW,
    registry: registryOf({}),
  });
  assert.deepEqual(rules(r), [4]);
  assert.match(r.failures[0].msg, /stray\/package\.json/);
});

test("T7: exactly 3 days is green; 3 days less 1 s is red", async () => {
  assert.equal(WINDOW_MS, 3 * DAY);
  const lock = lockOf({ "node_modules/viem": reg("viem", "2.58.2") });
  const edge = await run({ lock, times: { viem: { "2.58.2": at(3 * DAY) } } });
  assert.deepEqual(edge.failures, []);
  const inside = await run({ lock, times: { viem: { "2.58.2": at(3 * DAY - 1000) } } });
  assert.deepEqual(rules(inside), [1]);
});

test("T8: an unused allowlist entry warns and does not fail", async () => {
  const allowlist = { schema: 1, entries: [{ name: "gone", version: "1.0.0", kind: "security-fix", reason: "fixture", advisory: "GHSA-xxxx", date: "2026-12-01" }] };
  const r = await run({ lock: lockOf({ "node_modules/viem": reg("viem", "2.50.0") }), times: { viem: { "2.50.0": at(400 * DAY) } }, allowlist });
  assert.deepEqual(r.failures, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].msg, /gone@1\.0\.0.*unused/);
});

const oldLock = () => lockOf({ "node_modules/serve": reg("serve", "14.2.5"), "node_modules/chalk": reg("chalk", "5.0.0") });
const oldTimes = { serve: { "14.2.5": at(400 * DAY) }, chalk: { "5.0.0": at(400 * DAY) } };

test("T9: a new direct dependency with no new-dependency entry is red, named", async () => {
  const r = await run({ lock: oldLock(), times: oldTimes, manifest: { dependencies: { serve: "14.2.5" } }, base: {} });
  assert.deepEqual(rules(r), [6]);
  assert.match(r.failures[0].msg, /serve is a new direct dependency/);
});

test("T9a: a package.json absent on the base counts as empty", async () => {
  const r = await run({ lock: oldLock(), times: oldTimes, manifest: { dependencies: { serve: "14.2.5" } }, base: null });
  assert.deepEqual(rules(r), [6]);
});

test("T9b: T9 with a new-dependency entry naming it is green", async () => {
  const allowlist = { schema: 1, entries: [{ name: "serve", kind: "new-dependency", reason: "fixture", ethan: ETHAN }] };
  const r = await run({ lock: oldLock(), times: oldTimes, manifest: { dependencies: { serve: "14.2.5" } }, base: {}, allowlist });
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings, []);
});

test("T9c: a name that is only a transitive lock entry is not new", async () => {
  const r = await run({ lock: oldLock(), times: oldTimes, manifest: { dependencies: { serve: "14.2.5" } }, base: { dependencies: { serve: "14.2.5" } } });
  assert.deepEqual(r.failures, []);
});

test("T9d: a name moved from devDependencies to dependencies is not new", async () => {
  const r = await run({ lock: oldLock(), times: oldTimes, manifest: { dependencies: { serve: "14.2.5" } }, base: { devDependencies: { serve: "14.2.5" } } });
  assert.deepEqual(r.failures, []);
});

test("T9e: a new-dependency entry never covers an age failure", async () => {
  const allowlist = { schema: 1, entries: [{ name: "viem", kind: "new-dependency", reason: "fixture", ethan: ETHAN }] };
  const r = await run({ lock: lockOf({ "node_modules/viem": reg("viem", "2.58.2") }), times: { viem: { "2.58.2": at(1 * DAY) } }, allowlist });
  assert.ok(rules(r).includes(1));
});

// Allowlist validation (spec section 4): fail closed.
const ok = (e) => validateAllowlist({ schema: 1, entries: [e] }).errors;
const sf = { name: "viem", version: "2.58.2", kind: "security-fix", reason: "r", advisory: "GHSA-x", date: "2026-12-01" };
const ov = { name: "viem", version: "2.58.2", kind: "overrule", reason: "r", ethan: ETHAN };
const nd = { name: "serve", kind: "new-dependency", reason: "r", ethan: ETHAN };

test("V0: well-formed entries of all three kinds validate", () => {
  assert.deepEqual(ok(sf), []);
  assert.deepEqual(ok(ov), []);
  assert.deepEqual(ok(nd), []);
});

test("V1: each malformed allowlist is rejected", () => {
  const { advisory, ...sfNoAdvisory } = sf;
  const { date, ...sfNoDate } = sf;
  const { ethan, ...ovNoEthan } = ov;
  const { ethan: _e, ...ndNoEthan } = nd;
  const cases = {
    "security-fix without advisory": [sfNoAdvisory],
    "security-fix without date": [sfNoDate],
    "overrule without ethan": [ovNoEthan],
    "new-dependency without ethan": [ndNoEthan],
    "unknown kind": [{ ...ov, kind: "wish" }],
    "range version": [{ ...ov, version: "^2.58.2" }],
    "no reason": [{ ...ov, reason: "" }],
    "duplicate name and version": [ov, sf],
    "new-dependency with a version": [{ ...nd, version: "1.0.0" }],
    "duplicate new-dependency": [nd, nd],
  };
  for (const [label, entries] of Object.entries(cases)) {
    assert.notDeepEqual(validateAllowlist({ schema: 1, entries }).errors, [], label);
  }
  assert.notDeepEqual(validateAllowlist({ schema: 2, entries: [] }).errors, [], "schema 2");
  assert.notDeepEqual(validateAllowlist([]).errors, [], "array");
});

test("V2: a missing allowlist fails the check (rule 5)", async () => {
  const r = await run({ lock: lockOf({}), allowlist: undefined });
  assert.deepEqual(rules(r), [5]);
});

test("V3: a malformed allowlist covers nothing", async () => {
  const allowlist = { schema: 1, entries: [{ name: "viem", version: "2.58.2", kind: "overrule", reason: "r" }] };
  const r = await run({ lock: lockOf({ "node_modules/viem": reg("viem", "2.58.2") }), times: { viem: { "2.58.2": at(1 * DAY) } }, allowlist });
  assert.deepEqual(rules(r).sort(), [1, 5]);
});
