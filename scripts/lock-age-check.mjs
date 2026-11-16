#!/usr/bin/env node
// lock-age-check.mjs: fails when any committed lock holds a package version
// younger than the npm adoption window, or that has no registry publish time,
// unless lock-allowlist.json covers it. Also fails on a new direct dependency
// that no `new-dependency` allowlist entry names.
//
// Node built-ins only, no dependencies, so it runs with nothing installed.
//
//   node scripts/lock-age-check.mjs                    # rule 6 against origin/develop
//   node scripts/lock-age-check.mjs --base origin/main # rule 6 against another base
//   node scripts/lock-age-check.mjs --release          # rule 6 skipped (no PR base)
//   node scripts/lock-age-check.mjs --only app/web     # per-lock rules for one dir
//
// Exit 0: no failures (warnings may be printed). Exit 1: at least one failure.
// Exit 2: bad usage. It fails closed: a registry error, an unreadable lock or
// allowlist, or a git error is a failure, never a skip.
//
// Spec: bitcorn-research specs/2026-11-16-lockfile-spec.md, sections 4 and 5.
// The window is 3 days: decisions/2026-11-16-npm-adoption-window-three-days.md.
//
// The core, checkLocks(), is a pure function of its inputs (locks, manifests,
// base manifests, allowlist, now, registry), so the tests in
// lock-age-check.test.mjs never touch the network or the clock.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
export const REGISTRY_PREFIX = "https://registry.npmjs.org/";

// Every package directory whose lock is checked (spec 2.1, P1 to P4).
export const PACKAGE_DIRS = [".", "app/api", "app/web", "cloudflare-worker"];

// Tracked package.json files that are not packages, each with its reason.
export const EXCLUDED_MANIFESTS = {
  "app/web/.vite/deps/package.json":
    'Vite dependency-cache stub, {"type":"module"}. It declares no dependencies and has no lock.',
};

export const DIRECT_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const KINDS = new Set(["overrule", "security-fix", "new-dependency"]);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const lockPathOf = (dir) => (dir === "." ? "package-lock.json" : `${dir}/package-lock.json`);
export const manifestPathOf = (dir) => (dir === "." ? "package.json" : `${dir}/package.json`);

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

// Validate the allowlist. Returns { entries, errors }. Any error fails the check.
export function validateAllowlist(raw) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { entries: [], errors: ["allowlist: not a JSON object"] };
  }
  if (raw.schema !== 1) errors.push(`allowlist: schema must be 1, got ${JSON.stringify(raw.schema)}`);
  if (!Array.isArray(raw.entries)) {
    errors.push("allowlist: entries must be an array");
    return { entries: [], errors };
  }
  const seenVersioned = new Set();
  const seenNewDep = new Set();
  raw.entries.forEach((e, i) => {
    const at = `allowlist entry ${i}`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      errors.push(`${at}: not an object`);
      return;
    }
    if (!KINDS.has(e.kind)) {
      errors.push(`${at}: unknown kind ${JSON.stringify(e.kind)} (overrule, security-fix or new-dependency)`);
      return;
    }
    if (!isNonEmptyString(e.name)) errors.push(`${at}: name is required`);
    if (!isNonEmptyString(e.reason)) errors.push(`${at}: reason is required`);
    const needsEthan = e.kind === "overrule" || e.kind === "new-dependency";
    if (needsEthan) {
      const x = e.ethan;
      if (!x || typeof x !== "object") errors.push(`${at}: ${e.kind} needs ethan.words, ethan.date and ethan.record`);
      else {
        if (!isNonEmptyString(x.words)) errors.push(`${at}: ethan.words is required`);
        if (!isNonEmptyString(x.date) || !ISO_DATE.test(x.date)) errors.push(`${at}: ethan.date must be YYYY-MM-DD`);
        if (!isNonEmptyString(x.record)) errors.push(`${at}: ethan.record is required`);
      }
    }
    if (e.kind === "security-fix") {
      if (!isNonEmptyString(e.advisory)) errors.push(`${at}: security-fix needs advisory`);
      if (!isNonEmptyString(e.date) || !ISO_DATE.test(e.date)) errors.push(`${at}: security-fix needs date, YYYY-MM-DD`);
    }
    if (e.kind === "new-dependency") {
      if ("version" in e) errors.push(`${at}: a new-dependency entry is name-scoped and carries no version`);
      if (seenNewDep.has(e.name)) errors.push(`${at}: duplicate new-dependency entry for ${e.name}`);
      seenNewDep.add(e.name);
    } else {
      if (!isNonEmptyString(e.version) || !EXACT_VERSION.test(e.version)) {
        errors.push(`${at}: version must be one exact version, got ${JSON.stringify(e.version)}`);
      }
      if ("resolved" in e && !isNonEmptyString(e.resolved)) errors.push(`${at}: resolved, when present, must be a URL`);
      const key = `${e.name}@${e.version}`;
      if (seenVersioned.has(key)) errors.push(`${at}: duplicate entry for ${key}`);
      seenVersioned.add(key);
    }
  });
  return { entries: errors.length ? [] : raw.entries, errors };
}

export function nameOfEntry(key, meta) {
  if (meta && isNonEmptyString(meta.name)) return meta.name;
  const i = key.lastIndexOf("node_modules/");
  return i === -1 ? key : key.slice(i + "node_modules/".length);
}

export function directNames(manifest) {
  const names = new Set();
  if (!manifest) return names;
  for (const f of DIRECT_FIELDS) for (const n of Object.keys(manifest[f] || {})) names.add(n);
  return names;
}

// The core. Inputs:
//   dirs:            package directories to apply the per-lock rules to
//   trackedManifests: every tracked package.json path (for discovery), or null to skip discovery
//   manifests:       { dir: parsed package.json | null }
//   locks:           { dir: parsed package-lock.json | null }
//   baseManifests:   { dir: parsed package.json | null } on the base, or null to skip rule 6
//   allowlist:       parsed lock-allowlist.json, or undefined when missing/unreadable
//   now:             ms since epoch
//   registry:        async (name) => packument; throws on a fetch failure
// Returns { perDir, global, failures, warnings }.
export async function checkLocks({
  dirs,
  trackedManifests,
  manifests,
  locks,
  baseManifests,
  allowlist,
  now,
  registry,
  windowMs = WINDOW_MS,
  packageDirs = PACKAGE_DIRS,
  excluded = EXCLUDED_MANIFESTS,
}) {
  const failures = [];
  const warnings = [];
  const perDir = {};
  const cutoff = now - windowMs;
  const fail = (dir, rule, msg) => {
    failures.push({ dir, rule, msg });
    if (dir && perDir[dir]) perDir[dir].failures++;
  };
  const warn = (dir, msg) => {
    warnings.push({ dir, msg });
    if (dir && perDir[dir]) perDir[dir].warnings++;
  };
  for (const d of dirs) perDir[d] = { checked: 0, youngAllowlisted: 0, agedOutAllowlisted: 0, warnings: 0, failures: 0 };

  // Rule 5: the allowlist, validated first. A malformed list covers nothing.
  let entries = [];
  if (allowlist === undefined) fail(null, 5, "lock-allowlist.json is missing or unreadable");
  else {
    const v = validateAllowlist(allowlist);
    for (const e of v.errors) fail(null, 5, e);
    entries = v.entries;
  }
  const versioned = entries.filter((e) => e.kind !== "new-dependency");
  const newDepEntries = entries.filter((e) => e.kind === "new-dependency");
  const used = new Set();

  // Discovery cross-check: every tracked package.json is a package dir or excluded.
  if (trackedManifests) {
    const known = new Set(packageDirs.map(manifestPathOf));
    for (const p of trackedManifests) {
      if (p.split("/").includes("node_modules")) continue;
      if (!known.has(p) && !(p in excluded)) {
        fail(null, 4, `${p}: tracked package.json is neither a package directory nor excluded. Add it to PACKAGE_DIRS (with a lock) or to EXCLUDED_MANIFESTS (with a reason).`);
      }
    }
  }

  // Collect entries per dir; rule 4 for a missing lock.
  const work = [];
  for (const dir of dirs) {
    const lockPath = lockPathOf(dir);
    if (!manifests[dir]) {
      fail(dir, 4, `${manifestPathOf(dir)}: listed package directory has no package.json`);
      continue;
    }
    const lock = locks[dir];
    if (!lock) {
      fail(dir, 4, `${lockPath}: ${manifestPathOf(dir)} exists and there is no lockfile. Write it with npm run lock:refresh -- ${dir}.`);
      continue;
    }
    if (!lock.packages || typeof lock.packages !== "object") {
      fail(dir, 4, `${lockPath}: no "packages" object (lockfileVersion ${lock.lockfileVersion}); needs lockfileVersion 2 or 3`);
      continue;
    }
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (key === "") continue;
      perDir[dir].checked++;
      work.push({ dir, lockPath, key, meta: meta || {}, name: nameOfEntry(key, meta), version: meta?.version });
    }
  }

  // Registry reads: one per unique name.
  const registryNames = [...new Set(work.filter((w) => isRegistry(w.meta)).map((w) => w.name))];
  const docs = new Map();
  await Promise.all(
    registryNames.map(async (name) => {
      try {
        const doc = await registry(name);
        docs.set(name, { doc });
      } catch (err) {
        docs.set(name, { err: String(err?.message || err) });
      }
    }),
  );

  for (const w of work) {
    const where = `${w.lockPath} ${w.key} ${w.name}@${w.version}`;
    const covering = versioned.find(
      (e) => e.name === w.name && e.version === w.version && (e.resolved === undefined ? isRegistry(w.meta) : e.resolved === w.meta.resolved),
    );
    if (!isRegistry(w.meta)) {
      // Rule 2: no registry publish time. Covered only by an exact resolved match.
      if (covering && covering.resolved !== undefined) {
        used.add(covering);
        perDir[w.dir].youngAllowlisted++;
        continue;
      }
      fail(w.dir, 2, `${where}: no registry publish time (resolved ${JSON.stringify(w.meta.resolved ?? null)}${w.meta.link ? ", link" : ""}). Remedy: an allowlist entry whose resolved equals this URL exactly.`);
      continue;
    }
    const got = docs.get(w.name);
    if (!got || got.err) {
      fail(w.dir, 3, `${where}: registry fetch failed: ${got ? got.err : "not fetched"}. Re-run; a check that cannot look does not pass.`);
      continue;
    }
    const time = got.doc?.time;
    if (!time || typeof time !== "object") {
      fail(w.dir, 3, `${where}: packument has no time object`);
      continue;
    }
    const t = time[w.version];
    const published = typeof t === "string" ? Date.parse(t) : NaN;
    if (Number.isNaN(published)) {
      fail(w.dir, 2, `${where}: registry has no publish time for this version`);
      continue;
    }
    const young = published > cutoff;
    if (covering) {
      used.add(covering);
      if (young) perDir[w.dir].youngAllowlisted++;
      else perDir[w.dir].agedOutAllowlisted++;
      continue;
    }
    if (young) {
      fail(w.dir, 1, `${where}: published ${t}, younger than the cut-off ${iso(cutoff)}. Remedy: wait until it is 3 days old, hold it back with overrides, or an allowlist entry (overrule: Ethan's words; security-fix: reason, advisory, date).`);
    }
  }

  // Rule 6: new direct dependencies.
  if (baseManifests) {
    const newNames = new Set();
    for (const dir of dirs) {
      if (!manifests[dir]) continue;
      const base = directNames(baseManifests[dir]);
      for (const name of directNames(manifests[dir])) {
        if (base.has(name)) continue;
        newNames.add(name);
        const entry = newDepEntries.find((e) => e.name === name);
        if (entry) {
          used.add(entry);
          continue;
        }
        fail(dir, 6, `${manifestPathOf(dir)}: ${name} is a new direct dependency (absent on the base). Remedy: a new-dependency allowlist entry carrying Ethan's words, their date and the vault record that logs them.`);
      }
    }
  }

  for (const e of entries) {
    if (used.has(e)) continue;
    const what = e.kind === "new-dependency" ? `${e.name} (new-dependency)` : `${e.name}@${e.version} (${e.kind})`;
    warn(null, `allowlist entry ${what} is unused; a later PR may remove it`);
  }

  return { perDir, failures, warnings, cutoff };
}

export function isRegistry(meta) {
  return !meta.link && typeof meta.resolved === "string" && meta.resolved.startsWith(REGISTRY_PREFIX);
}

export const iso = (ms) => new Date(ms).toISOString();

export function report(result, { out = console.log } = {}) {
  let total = 0;
  for (const [dir, c] of Object.entries(result.perDir)) {
    total += c.checked;
    out(`[${lockPathOf(dir)}] checked=${c.checked} young-allowlisted=${c.youngAllowlisted} aged-out-allowlisted=${c.agedOutAllowlisted} warnings=${c.warnings} failures=${c.failures}`);
  }
  for (const w of result.warnings) out(`WARN ${w.msg}`);
  for (const f of result.failures) out(`FAIL rule ${f.rule}: ${f.msg}`);
  out(`TOTAL checked=${total} failures=${result.failures.length} warnings=${result.warnings.length}`);
  return result.failures.length === 0 ? 0 : 1;
}

// ---- CLI -------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`${file}: ${err.message}`);
  }
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// A package.json on the base: null when absent there; throws on any git error.
function baseManifest(root, ref, rel) {
  const listed = git(root, ["ls-tree", "--name-only", ref, "--", rel]).trim();
  if (listed === "") return null;
  return JSON.parse(git(root, ["show", `${ref}:${rel}`]));
}

export async function fetchPackument(name) {
  const url = REGISTRY_PREFIX + name.replace("/", "%2f");
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
      const doc = await r.json();
      return { time: doc.time };
    } catch (err) {
      last = err;
      if (attempt < 3) await new Promise((s) => setTimeout(s, 500 * attempt));
    }
  }
  throw new Error(`${url}: ${last?.message || last} (3 attempts)`);
}

function limit(n, fn) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || queue.length === 0) return;
    active++;
    const { args, resolve, reject } = queue.shift();
    fn(...args).then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (...args) => new Promise((resolve, reject) => {
    queue.push({ args, resolve, reject });
    next();
  });
}

async function main(argv) {
  let base = "origin/develop";
  let release = false;
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--release") release = true;
    else if (a === "--base") base = argv[++i];
    else if (a === "--only") only.push(argv[++i]);
    else {
      console.error(`lock-age-check: unknown argument ${a}`);
      return 2;
    }
  }
  if (!base) {
    console.error("lock-age-check: --base needs a ref");
    return 2;
  }
  for (const d of only) {
    if (!PACKAGE_DIRS.includes(d)) {
      console.error(`lock-age-check: --only ${d} is not a package directory (${PACKAGE_DIRS.join(", ")})`);
      return 2;
    }
  }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const dirs = only.length ? only : PACKAGE_DIRS;
  const now = Date.now();

  const trackedManifests = git(root, ["ls-files", "-z"])
    .split("\0")
    .filter((p) => p === "package.json" || p.endsWith("/package.json"));
  const manifests = {};
  const locks = {};
  for (const d of dirs) {
    manifests[d] = readJson(path.join(root, manifestPathOf(d)));
    locks[d] = readJson(path.join(root, lockPathOf(d)));
  }
  let allowlist;
  try {
    allowlist = readJson(path.join(root, "lock-allowlist.json")) ?? undefined;
  } catch (err) {
    console.log(`FAIL rule 5: ${err.message}`);
    allowlist = undefined;
  }
  let baseManifests = null;
  if (!release) {
    baseManifests = {};
    for (const d of dirs) baseManifests[d] = baseManifest(root, base, manifestPathOf(d));
  }

  console.log(`lock-age-check: now=${iso(now)} window=3d cutoff=${iso(now - WINDOW_MS)} dirs=${dirs.join(",")} rule6=${release ? "skipped (--release)" : `base ${base}`}`);
  const result = await checkLocks({
    dirs,
    trackedManifests,
    manifests,
    locks,
    baseManifests,
    allowlist,
    now,
    registry: limit(12, fetchPackument),
  });
  return report(result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`lock-age-check: FAIL (could not run): ${err?.stack || err}`);
      process.exit(1);
    },
  );
}
