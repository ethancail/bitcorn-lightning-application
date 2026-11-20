#!/usr/bin/env node
// lock-refresh.mjs: the only thing that writes a package-lock.json. Run it as
// `npm run lock:refresh`. Every other install, everywhere, is `npm ci`.
//
//   npm run lock:refresh                               # every package directory
//   npm run lock:refresh -- app/web                    # one directory
//   npm run lock:refresh -- app/web viem@2.57.10       # add or change one dependency
//   npm run lock:refresh -- app/web viem@2.58.2 --exception             # allowlisted young version
//   npm run lock:refresh -- app/api semver@7.8.7 --exception --override # allowlisted transitive fix
//
// The cut-off C is now minus 3 days (the npm adoption window), computed once per
// run and printed. Every lock is written with
//   npm install --package-lock-only --ignore-scripts --save-exact --before=<C>
// so writing a lock runs no package code, and every direct spec is written as
// one exact version. Any direct spec that is still a range is passed to npm as
// name@range, which resolves it under C and writes the exact version into the
// same field of package.json in the same npm call as the lock.
//
// With no name@version it regenerates the lock from scratch, so the whole tree
// rolls forward to the newest versions at or before C. With --exception it
// runs the two-step lift of the lockfile spec, section 3.2: Step A writes the
// lock under C with the allowlisted young requirements stripped, and Step B
// restores them and lifts the cut-off to L, the latest publish time among the
// allowlisted versions applied, not to now. Allowlisted versions a manifest
// already requires are re-applied the same way on every normal run.
//
// npm runs in a temporary directory, never against the worktree's node_modules
// (see refreshDir). At the end it runs scripts/lock-age-check.mjs over every
// directory it wrote, and exits with that check's result. On an npm failure
// it writes nothing.
//
// Spec: bitcorn-research specs/2026-11-16-lockfile-spec.md, section 3.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DIRECT_FIELDS,
  PACKAGE_DIRS,
  WINDOW_MS,
  directNames,
  fetchPackument,
  lockPathOf,
  manifestPathOf,
  validateAllowlist,
} from "./lock-age-check.mjs";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const isExact = (v) => typeof v === "string" && EXACT_VERSION.test(v);

// %FT%TZ, as `date -u +%FT%TZ` prints it: no milliseconds.
export const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export const cutoffOf = (nowMs) => isoSeconds(nowMs - WINDOW_MS);

// "name@version", scoped or not. Returns null when it is not one.
export function parseSpec(arg) {
  const at = arg.lastIndexOf("@");
  if (at <= 0) return null;
  const name = arg.slice(0, at);
  const version = arg.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

// Every direct spec that is not yet one exact version, as name@range, so npm
// resolves it under C and writes it back exactly (--save-exact).
export function nonExactDirectSpecs(manifest, skip = new Set()) {
  const out = [];
  for (const f of DIRECT_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[f] || {})) {
      if (skip.has(name) || isExact(spec)) continue;
      out.push(`${name}@${spec}`);
    }
  }
  return out;
}

// Step A: a copy of the manifest with every dependency and top-level override
// whose requirement is exactly an allowlisted version still younger than C
// removed. Direct specs are exact (--save-exact), so "can be met only by that
// version" is "is that exact version". A range is left alone: under C it either
// resolves to an older match or fails ETARGET, and the script then stops.
export function stripManifest(manifest, young) {
  const copy = structuredClone(manifest);
  const stripped = [];
  const hit = (name, spec) => young.some((y) => y.name === name && y.version === spec);
  for (const f of [...DIRECT_FIELDS, "overrides"]) {
    const block = copy[f];
    if (!block || typeof block !== "object") continue;
    for (const [name, spec] of Object.entries(block)) {
      if (typeof spec === "string" && hit(name, spec)) {
        delete block[name];
        stripped.push({ field: f, name, version: spec });
      }
    }
  }
  return { manifest: copy, stripped };
}

// L: the latest registry publish time among the allowlisted versions applied in
// this directory. Not now: the narrowest lift that admits them.
export function computeL(applied, times) {
  if (applied.length === 0) throw new Error("computeL: no allowlisted versions applied");
  let latest = -Infinity;
  for (const { name, version } of applied) {
    const t = Date.parse(times?.[name]?.[version]);
    if (Number.isNaN(t)) throw new Error(`computeL: no publish time for ${name}@${version}`);
    if (t > latest) latest = t;
  }
  return new Date(latest).toISOString();
}

// The allowlist entry an --exception needs: overrule or security-fix, exact version.
export function exceptionEntryFor(entries, name, version) {
  return entries.find((e) => (e.kind === "overrule" || e.kind === "security-fix") && e.name === name && e.version === version) || null;
}

// Allowlisted versions this manifest already requires (direct spec or override).
export function requiredAllowlisted(manifest, entries) {
  const out = [];
  for (const e of entries) {
    if (e.kind !== "overrule" && e.kind !== "security-fix") continue;
    for (const f of [...DIRECT_FIELDS, "overrides"]) {
      if (manifest[f]?.[e.name] === e.version) {
        out.push({ name: e.name, version: e.version });
        break;
      }
    }
  }
  return out;
}

export function loadAllowlist(raw) {
  const v = validateAllowlist(raw);
  if (raw === undefined || raw === null) throw new Error("lock-allowlist.json is missing or unreadable");
  if (v.errors.length) throw new Error(`lock-allowlist.json is malformed:\n  ${v.errors.join("\n  ")}`);
  return v.entries;
}

// ---- CLI -------------------------------------------------------------------

const NO_MATCH = /ETARGET|No matching version found/;

function npm(cwd, args) {
  console.log(`  $ (cd ${cwd} && npm ${args.join(" ")})`);
  const r = spawnSync("npm", args, { cwd, encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  for (const line of out.trimEnd().split("\n")) if (line) console.log(`    ${line}`);
  if (r.error) throw r.error;
  return { status: r.status, out };
}

const writeJson = (file, obj) => fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);

class Stop extends Error {}

// npm runs in a fresh temporary directory holding only the package.json (and,
// for name@version, the current lock), never in the package directory itself.
// With no lock present, `npm install --package-lock-only` in a directory that
// has node_modules seeds its tree from node_modules/.package-lock.json and the
// installed packages: most entries then lose resolved and integrity, and
// other-platform optional packages drop out. Measured 2026-11-16: app/api's
// lock came out with 13 of 192 entries resolved. The temporary directory has
// no node_modules, so every regeneration really starts from scratch. It also
// means a failure writes nothing: the real files are replaced only on success.
async function refreshDir(root, dir, C, entries, opts) {
  const pjFile = path.join(root, manifestPathOf(dir));
  const lockFile = path.join(root, lockPathOf(dir));
  const pjText = fs.readFileSync(pjFile, "utf8");
  const manifest = JSON.parse(pjText);
  const base = ["install", "--package-lock-only", "--ignore-scripts", "--save-exact"];
  const { spec, exception, override } = opts;

  console.log(`\n== ${dir}`);
  if (spec && !directNames(manifest).has(spec.name) && !override) {
    console.log(`  NOTE: ${spec.name} is a new direct dependency in ${manifestPathOf(dir)}. It needs a new-dependency entry in lock-allowlist.json carrying Ethan's words, their date and the vault record that logs them; the age check fails without one.`);
  }

  // Allowlisted versions applied in this directory, and which are still younger than C.
  const applied = requiredAllowlisted(manifest, entries);
  if (exception && !applied.some((a) => a.name === spec.name && a.version === spec.version)) applied.push(spec);
  const times = {};
  for (const a of applied) times[a.name] = (await fetchPackument(a.name)).time || {};
  const young = applied.filter((a) => Date.parse(times[a.name][a.version]) > Date.parse(C));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lock-refresh-"));
  const wPj = path.join(work, "package.json");
  const wLock = path.join(work, "package-lock.json");
  try {
    fs.writeFileSync(wPj, pjText);
    if (young.length === 0) {
      // Normal mode. With no name@version the lock is regenerated from scratch
      // (none is copied in); with one, npm changes that dependency in the current lock.
      if (spec && fs.existsSync(lockFile)) fs.copyFileSync(lockFile, wLock);
      const args = [...base, `--before=${C}`, ...nonExactDirectSpecs(manifest, new Set(spec ? [spec.name] : [])), ...(spec && !override ? [`${spec.name}@${spec.version}`] : [])];
      if (override) writeJson(wPj, { ...manifest, overrides: { ...(manifest.overrides || {}), [spec.name]: spec.version } });
      const r = npm(work, args);
      if (r.status !== 0) {
        if (NO_MATCH.test(r.out)) {
          throw new Stop(`npm found no version at or before ${C} for a requirement in ${dir}. A version younger than 3 days needs an allowlist entry: an overrule entry carries Ethan's words, their date and the vault record; a security-fix entry carries its reason, the advisory and the date. Then re-run with --exception.`);
        }
        throw new Stop(`npm exited ${r.status} in ${dir}`);
      }
    } else {
      // Step A: lock under C with the young allowlisted requirements stripped.
      const { manifest: strippedManifest, stripped } = stripManifest(manifest, young);
      console.log(`  Step A: stripped ${stripped.map((s) => `${s.field}.${s.name}@${s.version}`).join(", ") || "nothing"}; locking under C=${C}`);
      writeJson(wPj, strippedManifest);
      const strippedNames = new Set(stripped.map((s) => s.name));
      if (spec) strippedNames.add(spec.name);
      const a = npm(work, [...base, `--before=${C}`, ...nonExactDirectSpecs(strippedManifest, strippedNames)]);
      if (a.status !== 0) throw new Stop(`Step A: npm exited ${a.status} in ${dir}${NO_MATCH.test(a.out) ? " (no version at or before C)" : ""}`);

      // Step B: restore the real manifest with the requirement written in, lift to L.
      const L = computeL(young, times);
      console.log(`  Step B: restoring ${manifestPathOf(dir)}; lifting the cut-off to L=${L}`);
      fs.writeFileSync(wPj, pjText);
      const extra = [];
      if (spec && override) writeJson(wPj, { ...manifest, overrides: { ...(manifest.overrides || {}), [spec.name]: spec.version } });
      else if (spec) extra.push(`${spec.name}@${spec.version}`);
      const b = npm(work, [...base, `--before=${L}`, ...extra]);
      if (b.status !== 0) throw new Stop(`Step B: npm exited ${b.status} in ${dir}`);
    }
    if (!fs.existsSync(wLock)) throw new Stop(`npm wrote no package-lock.json for ${dir}`);
    fs.copyFileSync(wPj, pjFile);
    fs.copyFileSync(wLock, lockFile);
    console.log(`  wrote ${manifestPathOf(dir)} and ${lockPathOf(dir)}`);
  } catch (err) {
    if (err instanceof Stop) console.log(`  ${manifestPathOf(dir)} and ${lockPathOf(dir)} left as they were; nothing written`);
    throw err;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const pos = argv.filter((a) => !a.startsWith("--"));
  for (const f of flags) {
    if (f !== "--exception" && f !== "--override") {
      console.error(`lock:refresh: unknown flag ${f}`);
      return 2;
    }
  }
  const exception = flags.has("--exception");
  const override = flags.has("--override");
  let dirs = PACKAGE_DIRS;
  let spec = null;
  if (pos.length > 2) {
    console.error("lock:refresh: usage: npm run lock:refresh -- [<dir>] [<name@version>] [--exception] [--override]");
    return 2;
  }
  if (pos[0] !== undefined) {
    if (!PACKAGE_DIRS.includes(pos[0])) {
      console.error(`lock:refresh: ${pos[0]} is not a package directory (${PACKAGE_DIRS.join(", ")})`);
      return 2;
    }
    dirs = [pos[0]];
  }
  if (pos[1] !== undefined) {
    spec = parseSpec(pos[1]);
    if (!spec || !isExact(spec.version)) {
      console.error(`lock:refresh: ${pos[1]} must be name@<one exact version>`);
      return 2;
    }
  }
  if ((exception || override) && !spec) {
    console.error("lock:refresh: --exception and --override need <dir> <name@version>");
    return 2;
  }
  if (override && !exception) {
    console.error("lock:refresh: --override is used with --exception");
    return 2;
  }

  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
  if (!root) {
    console.error("lock:refresh: not inside the git checkout");
    return 1;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, "lock-allowlist.json"), "utf8"));
  } catch {
    raw = undefined;
  }
  let entries;
  try {
    entries = loadAllowlist(raw);
  } catch (err) {
    console.error(`lock:refresh: ${err.message}`);
    return 1;
  }
  if (exception && !exceptionEntryFor(entries, spec.name, spec.version)) {
    console.error(`lock:refresh: --exception refused: lock-allowlist.json has no overrule or security-fix entry for ${spec.name}@${spec.version}. An overrule entry carries Ethan's words, their date and the vault record; a security-fix entry carries its reason, the advisory and the date. Nothing written.`);
    return 1;
  }

  const C = cutoffOf(Date.now());
  console.log(`lock:refresh: C=${C} (now minus 3 days) npm=${spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim()} dirs=${dirs.join(",")}${spec ? ` spec=${spec.name}@${spec.version}` : ""}${exception ? " --exception" : ""}${override ? " --override" : ""}`);
  try {
    for (const dir of dirs) await refreshDir(root, dir, C, entries, { spec, exception, override });
  } catch (err) {
    if (err instanceof Stop) {
      console.error(`\nlock:refresh: STOPPED: ${err.message}`);
      return 1;
    }
    throw err;
  }

  console.log(`\n== age check over ${dirs.join(", ")}`);
  const check = spawnSync(process.execPath, [path.join(root, "scripts/lock-age-check.mjs"), ...dirs.flatMap((d) => ["--only", d])], { cwd: root, stdio: "inherit" });
  return check.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`lock:refresh: FAIL: ${err?.stack || err}`);
      process.exit(1);
    },
  );
}
