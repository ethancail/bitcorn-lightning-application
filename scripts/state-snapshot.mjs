#!/usr/bin/env node
// state-snapshot.mjs — generate STATE.md from actual current reality.
//
// Kills "what's implemented/deployed vs. what I remember" drift by reading
// real sources (git, code, chain, deployment) and writing a grounding doc.
//
// USAGE
//   node scripts/state-snapshot.mjs             # full snapshot: writes STATE.md at repo root
//   node scripts/state-snapshot.mjs --fast      # Tier 1 only (fast, local, no network):
//                                               #   regenerates git + inventory sections and
//                                               #   carries Tier 2 over from the last full run,
//                                               #   labeled with that run's timestamp.
//                                               #   (--tier1 is an alias.) Used by the
//                                               #   SessionStart hook in .claude/settings.json.
//   node scripts/state-snapshot.mjs --selftest  # run embedded self-tests only
//
// STRICTLY READ-ONLY: the only thing this script ever writes is the output
// markdown file. No git mutations, no chain transactions, no POSTs other
// than JSON-RPC eth_* read calls.
//
// TIERS
//   Tier 1 (always available, pure local): git state for this repo (and the
//     sibling stablecoin-rail repo if present/configured), plus a generated
//     features inventory (API routes, web pages/components, DB migrations).
//   Tier 2 (best-effort, config-driven): Base chain reads (SettlementRouter
//     getters, Safe owners/threshold) and deployment health (treasury tunnel,
//     Cloudflare Worker). Missing config or unreachable endpoints degrade to
//     a "skipped/unavailable" marker — never an error.
//
// CONFIG — all optional. Env vars override state-snapshot.config.json at the
// repo root (see state-snapshot.config.example.json):
//   STATE_RPC_URL              Base JSON-RPC endpoint (e.g. https://mainnet.base.org)
//   STATE_ROUTER_ADDRESS       SettlementRouter contract address
//   STATE_SAFE_ADDRESS         Gnosis Safe address
//   STATE_TREASURY_HEALTH_URL  e.g. https://treasury.<domain>/health
//   STATE_WORKER_URL           Cloudflare Worker base URL
//   STATE_SIBLING_REPO         path to bitcorn-stablecoin-rail checkout
//                              (default: ../bitcorn-stablecoin-rail, probed silently)
//   STATE_OUTPUT               output path (default: <repo root>/STATE.md)
//
// Requires Node >= 18 (global fetch). No dependencies.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FETCH_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 15_000;

// ─── keccak-256 (for ABI function selectors; no deps) ────────────────────
// Standard Keccak-f[1600] on BigInt lanes, keccak padding (0x01/0x80).
// Self-tested against known vectors at startup — a failure there is a code
// bug and aborts hard (unlike environment failures, which degrade).

const MASK64 = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offsets, indexed [x][y].
const R = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    // θ
    const C = [], D = [];
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D[x];
    // ρ + π
    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], R[x][y]);
    // χ
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & MASK64 & B[((x + 2) % 5) + 5 * y]);
    // ι
    A[0] ^= RC[round];
  }
}

/** keccak256 of a Buffer/Uint8Array, hex string out (no 0x). */
function keccak256(bytes) {
  const rate = 136; // 1088-bit rate for 256-bit output
  const padded = Buffer.concat([Buffer.from(bytes), Buffer.from([0x01])]);
  const total = Math.ceil(padded.length / rate) * rate;
  const msg = Buffer.concat([padded, Buffer.alloc(total - padded.length)]);
  msg[msg.length - 1] |= 0x80;

  const A = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      A[i] ^= msg.readBigUInt64LE(off + i * 8);
    }
    keccakF(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8);
  return out.toString("hex");
}

const selector = (signature) => "0x" + keccak256(Buffer.from(signature, "utf8")).slice(0, 8);

function selfTest() {
  const vectors = [
    // keccak256("") — Ethereum's empty-account codeHash constant.
    [keccak256(Buffer.alloc(0)), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    [keccak256(Buffer.from("abc")), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
    [selector("transfer(address,uint256)"), "0xa9059cbb"],
    [selector("owner()"), "0x8da5cb5b"],
  ];
  for (const [got, want] of vectors) {
    if (got !== want) {
      console.error(`keccak self-test FAILED: got ${got}, want ${want}`);
      process.exit(1);
    }
  }
}

// ─── small helpers ────────────────────────────────────────────────────────

function git(args, cwd = REPO_ROOT) {
  // stderr piped (not inherited) so expected probe failures — e.g. rev-parse
  // @{upstream} on a branch with no upstream — don't print git noise.
  return execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(args, cwd = REPO_ROOT) {
  try { return git(args, cwd); } catch { return null; }
}

async function fetchWithTimeout(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

const codeSpan = (s) => "`" + s + "`";

// ─── config ───────────────────────────────────────────────────────────────

function loadConfig() {
  let fileCfg = {};
  const cfgPath = path.join(REPO_ROOT, "state-snapshot.config.json");
  if (fs.existsSync(cfgPath)) {
    try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
    catch (e) { console.error(`warning: could not parse ${cfgPath}: ${e.message}`); }
  }
  const pick = (env, key, dflt = undefined) => process.env[env] ?? fileCfg[key] ?? dflt;
  return {
    rpcUrl: pick("STATE_RPC_URL", "rpc_url"),
    routerAddress: pick("STATE_ROUTER_ADDRESS", "router_address"),
    safeAddress: pick("STATE_SAFE_ADDRESS", "safe_address"),
    treasuryHealthUrl: pick("STATE_TREASURY_HEALTH_URL", "treasury_health_url"),
    workerUrl: pick("STATE_WORKER_URL", "worker_url"),
    siblingRepo: pick("STATE_SIBLING_REPO", "sibling_repo_path",
      path.join(REPO_ROOT, "..", "bitcorn-stablecoin-rail")),
    output: pick("STATE_OUTPUT", "output_path", path.join(REPO_ROOT, "STATE.md")),
  };
}

// ─── Tier 1a: git state ───────────────────────────────────────────────────

function branchTip(ref, cwd) {
  const line = tryGit(["log", "-1", "--format=%h · %s · %ci", ref], cwd);
  return line ?? "(missing)";
}

function aheadBehind(a, b, cwd) {
  // How far `b` is ahead of / behind `a`.
  const counts = tryGit(["rev-list", "--left-right", "--count", `${a}...${b}`], cwd);
  if (counts == null) return null;
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  return { ahead, behind };
}

function repoGitState(cwd, label) {
  const lines = [`### ${label}`, ""];
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    lines.push(`_Not found or not a git repository at ${codeSpan(cwd)} — skipped._`, "");
    return lines;
  }
  const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? "(unknown)";
  const head = branchTip("HEAD", cwd);
  const dirtyList = tryGit(["status", "--porcelain"], cwd);
  const dirty = dirtyList == null ? "(unknown)" : dirtyList === "" ? "clean" : `${dirtyList.split("\n").length} uncommitted change(s)`;

  lines.push(
    `- **Checked out:** ${codeSpan(branch)} @ ${head}`,
    `- **Working tree:** ${dirty}`,
  );

  // Branch tips (local + origin) for the two long-lived branches.
  for (const b of ["main", "develop"]) {
    const local = tryGit(["rev-parse", "--verify", "--quiet", b], cwd) ? branchTip(b, cwd) : null;
    const remote = tryGit(["rev-parse", "--verify", "--quiet", `origin/${b}`], cwd) ? branchTip(`origin/${b}`, cwd) : null;
    if (local == null && remote == null) continue;
    if (local) lines.push(`- **${b}:** ${local}`);
    if (remote && remote !== local) lines.push(`- **origin/${b}:** ${remote}`);
    if (local && remote) {
      const ab = aheadBehind(`origin/${b}`, b, cwd);
      if (ab && (ab.ahead || ab.behind)) {
        lines.push(`  - local ${b} is ${ab.ahead} ahead / ${ab.behind} behind origin/${b}`);
      }
    }
  }

  // develop vs main relationship (prefer origin refs — local may be stale).
  const mainRef = tryGit(["rev-parse", "--verify", "--quiet", "origin/main"], cwd) ? "origin/main"
    : tryGit(["rev-parse", "--verify", "--quiet", "main"], cwd) ? "main" : null;
  const devRef = tryGit(["rev-parse", "--verify", "--quiet", "origin/develop"], cwd) ? "origin/develop"
    : tryGit(["rev-parse", "--verify", "--quiet", "develop"], cwd) ? "develop" : null;
  if (mainRef && devRef) {
    const ab = aheadBehind(mainRef, devRef, cwd);
    if (ab) lines.push(`- **${devRef} vs ${mainRef}:** ${ab.ahead} ahead, ${ab.behind} behind`);
  }

  // Local branches not merged into the integration branch, with upstream drift.
  const noMergedTarget = devRef ?? mainRef;
  if (noMergedTarget) {
    const unmerged = (tryGit(["branch", "--no-merged", noMergedTarget, "--format=%(refname:short)"], cwd) ?? "")
      .split("\n").filter(Boolean);
    if (unmerged.length) {
      lines.push(`- **Local branches not merged into ${noMergedTarget}:**`);
      for (const b of unmerged) {
        const upstream = tryGit(["rev-parse", "--abbrev-ref", `${b}@{upstream}`], cwd);
        const drift = upstream
          ? (() => { const ab = aheadBehind(upstream, b, cwd); return ab ? `${ab.ahead} ahead / ${ab.behind} behind ${upstream}` : ""; })()
          : "NO UPSTREAM (local-only)";
        lines.push(`  - ${codeSpan(b)} @ ${branchTip(b, cwd)} — ${drift}`);
      }
    } else {
      lines.push(`- **Local branches not merged into ${noMergedTarget}:** none`);
    }
  }

  lines.push("");
  return lines;
}

// ─── Tier 1e: features inventory ──────────────────────────────────────────

function apiRoutesInventory() {
  const indexPath = path.join(REPO_ROOT, "app", "api", "src", "index.ts");
  const lines = ["### API routes (scanned from `app/api/src/index.ts` route guards)", ""];
  if (!fs.existsSync(indexPath)) {
    lines.push("_app/api/src/index.ts not found — skipped._", "");
    return lines;
  }
  // The API is a raw http.createServer if/else chain; routes are guarded by
  // `req.method === "X" && req.url === "/path"` (exact) or
  // `req.method === "X" && req.url?.startsWith("/path")` (prefix).
  // Collapse whitespace so multi-line guards match too.
  const src = fs.readFileSync(indexPath, "utf8").replace(/\s+/g, " ");
  const guardRe = /req\.method\s*===\s*"([A-Z]+)"\s*&&\s*req\.url(?:\?\.startsWith\(\s*"([^"]+)"|(?:\?)?\s*===\s*"([^"]+)")/g;
  const totalGuards = (src.match(/req\.method\s*===\s*"/g) ?? []).length;
  const routes = new Map();
  for (const m of src.matchAll(guardRe)) {
    const method = m[1];
    const prefix = m[2] != null;
    const url = m[2] ?? m[3];
    routes.set(`${method} ${url}${prefix ? "*" : ""}`, { method, url, prefix });
  }
  const sorted = [...routes.values()].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
  lines.push(`${sorted.length} distinct route guards parsed (of ${totalGuards} \`req.method ===\` guard sites — remainder are duplicate/compound guards this scan can't attribute to a literal path).`, "");
  for (const r of sorted) {
    lines.push(`- ${codeSpan(`${r.method} ${r.url}${r.prefix ? "…" : ""}`)}`);
  }
  lines.push("");
  return lines;
}

function listDir(rel, filter) {
  const dir = path.join(REPO_ROOT, ...rel);
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).filter(filter).sort();
}

function webInventory() {
  const lines = ["### Web surface", ""];
  const isComponent = (f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !f.includes(".test.");
  const pages = listDir(["app", "web", "src", "pages"], isComponent);
  const components = listDir(["app", "web", "src", "components"], isComponent);
  if (pages) {
    lines.push(`**Pages** (\`app/web/src/pages/\`, ${pages.length}):`, "");
    lines.push(pages.map((p) => codeSpan(p)).join(" · "), "");
  }
  if (components) {
    lines.push(`**Components** (\`app/web/src/components/\`, ${components.length}):`, "");
    lines.push(components.map((c) => codeSpan(c)).join(" · "), "");
  }
  if (!pages && !components) lines.push("_web source directories not found — skipped._", "");
  return lines;
}

function migrationsInventory() {
  const lines = ["### DB migrations & tables (`app/api/src/db/migrations/`)", ""];
  const files = listDir(["app", "api", "src", "db", "migrations"], (f) => f.endsWith(".sql"));
  if (!files) {
    lines.push("_migrations directory not found — skipped._", "");
    return lines;
  }
  const allTables = new Set();
  lines.push(`${files.length} migrations:`, "");
  for (const f of files) {
    const sql = fs.readFileSync(path.join(REPO_ROOT, "app", "api", "src", "db", "migrations", f), "utf8");
    const tables = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-zA-Z0-9_]+)/gi)].map((m) => m[1]);
    tables.forEach((t) => allTables.add(t));
    lines.push(`- ${codeSpan(f)}${tables.length ? ` → ${tables.map(codeSpan).join(", ")}` : ""}`);
  }
  lines.push("", `**All tables defined across migrations (${allTables.size}):** ${[...allTables].sort().map(codeSpan).join(", ")}`, "");
  return lines;
}

// ─── Tier 2b: chain state ─────────────────────────────────────────────────

async function rpc(rpcUrl, method, params) {
  const res = await fetchWithTimeout(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

const ethCall = (rpcUrl, to, data) => rpc(rpcUrl, "eth_call", [{ to, data }, "latest"]);

const word = (hex, i) => hex.slice(2 + 64 * i, 2 + 64 * (i + 1));
const decodeUint = (hex, i = 0) => BigInt("0x" + word(hex, i));
const decodeAddress = (hex, i = 0) => "0x" + word(hex, i).slice(24);
const decodeBool = (hex) => decodeUint(hex) !== 0n;
function decodeAddressArray(hex) {
  const offsetWords = Number(decodeUint(hex, 0)) / 32;
  const len = Number(decodeUint(hex, offsetWords));
  const out = [];
  for (let i = 0; i < len; i++) out.push(decodeAddress(hex, offsetWords + 1 + i));
  return out;
}

const fmtUsdc6 = (v) => `${v} (÷1e6 → ${Number(v) / 1e6} assuming 6-dp USDC)`;

async function chainSection(cfg) {
  const lines = ["## 3. Chain state (Base) — Tier 2", ""];
  if (!cfg.rpcUrl) {
    lines.push("_Skipped: `STATE_RPC_URL` / `rpc_url` not configured._", "");
    return lines;
  }
  try {
    const chainId = await rpc(cfg.rpcUrl, "eth_chainId", []);
    lines.push(`- **RPC:** ${codeSpan(cfg.rpcUrl)} — chainId ${codeSpan(chainId)} (${parseInt(chainId, 16)})`);
  } catch (e) {
    lines.push(`_Unavailable: RPC unreachable (${e.message})._`, "");
    return lines;
  }

  // SettlementRouter — getter names verified against src/SettlementRouter.sol
  // in the stablecoin-rail repo (public vars feeRecipient/feeBps/maxTxAmount/
  // dailyVolumeCap + OZ Ownable.owner + Pausable.paused).
  lines.push("", "**SettlementRouter**", "");
  if (!cfg.routerAddress) {
    lines.push("_Skipped: router address not configured._");
  } else {
    try {
      const code = await rpc(cfg.rpcUrl, "eth_getCode", [cfg.routerAddress, "latest"]);
      if (!code || code === "0x") {
        lines.push(`- ${codeSpan(cfg.routerAddress)}: **NO CONTRACT DEPLOYED** at this address`);
      } else {
        lines.push(`- **Deployed:** yes at ${codeSpan(cfg.routerAddress)} (${(code.length - 2) / 2} bytes of code)`);
        const getters = [
          ["owner()", (r) => decodeAddress(r)],
          ["feeRecipient()", (r) => decodeAddress(r)],
          ["feeBps()", (r) => decodeUint(r).toString()],
          ["paused()", (r) => String(decodeBool(r))],
          ["maxTxAmount()", (r) => fmtUsdc6(decodeUint(r))],
          ["dailyVolumeCap()", (r) => fmtUsdc6(decodeUint(r))],
        ];
        for (const [sig, decode] of getters) {
          try {
            const raw = await ethCall(cfg.rpcUrl, cfg.routerAddress, selector(sig));
            lines.push(`- **${sig}** → ${codeSpan(decode(raw))}`);
          } catch (e) {
            lines.push(`- **${sig}** → unavailable (${e.message})`);
          }
        }
      }
    } catch (e) {
      lines.push(`- router reads unavailable (${e.message})`);
    }
  }

  lines.push("", "**Safe**", "");
  if (!cfg.safeAddress) {
    lines.push("_Skipped: Safe address not configured._");
  } else {
    try {
      const code = await rpc(cfg.rpcUrl, "eth_getCode", [cfg.safeAddress, "latest"]);
      if (!code || code === "0x") {
        lines.push(`- ${codeSpan(cfg.safeAddress)}: **NO CONTRACT DEPLOYED** at this address`);
      } else {
        const owners = decodeAddressArray(await ethCall(cfg.rpcUrl, cfg.safeAddress, selector("getOwners()")));
        const threshold = decodeUint(await ethCall(cfg.rpcUrl, cfg.safeAddress, selector("getThreshold()")));
        lines.push(
          `- **Deployed:** yes at ${codeSpan(cfg.safeAddress)}`,
          `- **getThreshold()** → ${threshold} of ${owners.length}`,
          `- **getOwners()** →`,
          ...owners.map((o) => `  - ${codeSpan(o)}`),
        );
      }
    } catch (e) {
      lines.push(`- Safe reads unavailable (${e.message})`);
    }
  }
  lines.push("");
  return lines;
}

// ─── Tier 2c: deployment health ───────────────────────────────────────────

async function deploymentSection(cfg) {
  const lines = ["## 4. Deployment health — Tier 2", ""];
  if (!cfg.treasuryHealthUrl && !cfg.workerUrl) {
    lines.push("_Skipped: no deployment URLs configured (`STATE_TREASURY_HEALTH_URL`, `STATE_WORKER_URL`)._", "");
    return lines;
  }

  if (cfg.treasuryHealthUrl) {
    try {
      const res = await fetchWithTimeout(cfg.treasuryHealthUrl);
      const body = (await res.text()).slice(0, 120).replace(/\s+/g, " ");
      lines.push(`- **Treasury tunnel** ${codeSpan(cfg.treasuryHealthUrl)}: ${res.status === 200 ? "**UP**" : `**status ${res.status}**`} — ${codeSpan(body)}`);
    } catch (e) {
      lines.push(`- **Treasury tunnel** ${codeSpan(cfg.treasuryHealthUrl)}: **DOWN/unreachable** (${e.name === "AbortError" ? "timeout" : e.message})`);
    }
  } else {
    lines.push("- **Treasury tunnel:** not configured — skipped");
  }

  if (cfg.workerUrl) {
    const url = cfg.workerUrl.replace(/\/+$/, "") + "/treasury-info";
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        lines.push(`- **Worker** ${codeSpan(url)}: **status ${res.status}**`);
      } else {
        const body = await res.json();
        const apiUrl = body?.api_url ?? "(no api_url field)";
        lines.push(`- **Worker** ${codeSpan(url)}: **UP** — published api_url: ${codeSpan(String(apiUrl))} (keys: ${Object.keys(body ?? {}).join(", ")})`);
      }
    } catch (e) {
      lines.push(`- **Worker** ${codeSpan(url)}: **DOWN/unreachable** (${e.name === "AbortError" ? "timeout" : e.message})`);
    }
  } else {
    lines.push("- **Worker:** not configured — skipped");
  }

  lines.push("");
  return lines;
}

// ─── fast mode: carry Tier 2 over from the last full snapshot ─────────────
// Full runs stamp a marker comment before the Tier-2 sections; fast runs
// splice everything from that marker onward out of the prior STATE.md,
// re-labeling it with the full run's timestamp. Idempotent across repeated
// fast runs (the previous carry-note line is stripped before re-inserting).

const TIER2_MARKER_RE = /<!-- tier2-generated: (\S+) -->/;
const CARRY_NOTE_PREFIX = "> _Tier 2 below is carried over";

function carriedTier2(outputPath) {
  try {
    const prior = fs.readFileSync(outputPath, "utf8");
    const m = prior.match(TIER2_MARKER_RE);
    if (m) {
      const rest = prior.slice(prior.indexOf(m[0])).split("\n").slice(1)
        .filter((l) => !l.startsWith(CARRY_NOTE_PREFIX));
      while (rest.length && rest[0].trim() === "") rest.shift();
      return [
        m[0],
        "",
        `${CARRY_NOTE_PREFIX} unchanged from the last FULL snapshot (${m[1]}) — chain/deployment were NOT re-read on this fast run. Refresh with ${codeSpan("node scripts/state-snapshot.mjs")}._`,
        "",
        ...rest,
      ];
    }
  } catch {
    // no prior snapshot readable — fall through to the placeholder
  }
  const placeholder = (title) => [
    `## ${title} — Tier 2`,
    "",
    "_No prior full snapshot to carry over — run `node scripts/state-snapshot.mjs` (full) to populate this section._",
    "",
  ];
  return [...placeholder("3. Chain state (Base)"), ...placeholder("4. Deployment health")];
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
  selfTest();
  if (process.argv.includes("--selftest")) {
    console.log("self-test OK (keccak vectors + selector derivation)");
    return;
  }

  const fast = process.argv.includes("--fast") || process.argv.includes("--tier1");
  const cfg = loadConfig();
  const out = [];

  out.push(
    "<!-- GENERATED by scripts/state-snapshot.mjs — DO NOT HAND-EDIT.",
    "     Regenerate with: node scripts/state-snapshot.mjs -->",
    "",
    "# STATE — generated snapshot of actual current reality",
    "",
    `- **Generated:** ${new Date().toISOString()} on ${os.hostname()}${fast ? " — FAST run (Tier 1 refreshed; Tier 2 carried over from last full run)" : " — full run"}`,
    `- **Tier 1** (git + features inventory) is always local truth. **Tier 2** (chain, deployment) is best-effort — sections marked skipped/unavailable were not reachable or not configured, which says nothing about their real state.`,
    "",
    "## 1. Git state — Tier 1",
    "",
  );
  out.push(...repoGitState(REPO_ROOT, "bitcorn-lightning-application"));
  out.push(...repoGitState(path.resolve(cfg.siblingRepo), `sibling: ${path.basename(cfg.siblingRepo)}`));

  out.push("## 2. Features inventory — Tier 1 (generated, names only)", "");
  out.push(...apiRoutesInventory());
  out.push(...webInventory());
  out.push(...migrationsInventory());

  if (fast) {
    out.push(...carriedTier2(cfg.output));
  } else {
    out.push(`<!-- tier2-generated: ${new Date().toISOString()} -->`, "");
    out.push(...await chainSection(cfg));
    out.push(...await deploymentSection(cfg));
  }

  fs.writeFileSync(cfg.output, out.join("\n"));
  console.log(`wrote ${cfg.output}${fast ? " (fast: Tier 1 refreshed)" : ""}`);
}

main().catch((e) => {
  console.error(`state-snapshot failed: ${e.stack ?? e}`);
  process.exit(1);
});
