# scripts/

Operational shell scripts (`healthcheck.sh`, `init-secrets.sh`, `migrate.sh`) and dev tools.

## state-snapshot.mjs — STATE.md generator

Generates `STATE.md` at the repo root from **actual current reality** — git, code,
chain, deployment — to kill "what's implemented/deployed vs. what I remember" drift.
Strictly read-only: the only write is the output file.

```bash
node scripts/state-snapshot.mjs             # full snapshot: writes STATE.md
node scripts/state-snapshot.mjs --fast      # Tier 1 only — fast/local; Tier 2 carried
                                            # over from the last full run with its
                                            # timestamp (--tier1 is an alias)
node scripts/state-snapshot.mjs --selftest  # keccak/selector self-test only
```

A committed SessionStart hook (`.claude/settings.json`) runs `--fast` and surfaces
STATE.md into Claude Code session context on every session start. It never blocks a
session: any failure degrades to a one-line message, and Tier 2 is never fetched at
session start (no network waits) — run a full snapshot to refresh chain/deployment.

**Tier 1 (always populates, pure local):** git state for this repo and (if present)
the sibling `bitcorn-stablecoin-rail` checkout — branch tips, main↔develop
ahead/behind, unmerged/local-only branches; plus a generated features inventory —
API route guards scanned from `app/api/src/index.ts`, web pages/components, DB
migrations and the tables they create.

**Tier 2 (best-effort, config-driven, degrades to "skipped/unavailable"):**

| Section | Config (env var / `state-snapshot.config.json` key) |
|---|---|
| Base chain — SettlementRouter `owner/feeRecipient/feeBps/paused/maxTxAmount/dailyVolumeCap`, Safe `getOwners/getThreshold` | `STATE_RPC_URL` / `rpc_url`, `STATE_ROUTER_ADDRESS` / `router_address`, `STATE_SAFE_ADDRESS` / `safe_address` |
| Deployment — treasury tunnel `/health`, Worker `/treasury-info` (published `api_url`) | `STATE_TREASURY_HEALTH_URL` / `treasury_health_url`, `STATE_WORKER_URL` / `worker_url` |
| Sibling repo path (default `../bitcorn-stablecoin-rail`) | `STATE_SIBLING_REPO` / `sibling_repo_path` |
| Output path (default `STATE.md`) | `STATE_OUTPUT` / `output_path` |

Copy `state-snapshot.config.example.json` → `state-snapshot.config.json` (gitignored)
and fill in what you have; env vars override the file. `STATE.md` is also gitignored
on purpose — a committed snapshot goes stale, which is the exact drift this tool
exists to kill. Regenerate whenever you need ground truth.

Chain reads use raw JSON-RPC `eth_call` with selectors computed by an embedded,
self-tested keccak-256 — no web3 dependency. Requires Node ≥ 18. Getter names are
verified against `bitcorn-stablecoin-rail/src/SettlementRouter.sol`.

## test-hooks.mjs — safety-hook regression tests

Tests the two agent-safety mechanisms so a future edit (or Claude Code update)
that weakens them is caught mechanically:

- **verify-gate.mjs (Stop hook):** 8 behavioral cases from its decision table,
  driven against a throwaway fixture git repo in a temp dir with a stub `npx`
  on `PATH` — no real tsc/vitest runs, so the whole suite takes seconds. Exit
  codes are read from `spawnSync().status` directly (no pipes to mask them).
- **permissions.deny (.claude/settings.json):** parses the deny array and
  pattern-matches it against tables of commands that must be blocked
  (push/PR/broadcast/deploy, incl. compound and `-C`/`-c` bypass forms) and
  commands that must stay allowed (commit/status/build/cast call/etc., incl.
  a commit message containing the word "push"). The matcher reimplements the
  Bash-rule semantics live-verified 2026-07-22 on Claude Code 2.1.217 — it
  catches settings regressions exactly; harness semantic drift still needs a
  live re-check.

```bash
node scripts/test-hooks.mjs                    # exit 0 = all pass, 1 = failures
node scripts/test-hooks.mjs --settings <path>  # alternate settings.json (break-demo)
node scripts/test-hooks.mjs --gate-src <path>  # alternate gate script (break-demo)
```

Read-only toward real state: fixtures live under the OS temp dir and are removed
on exit; the real repo, settings, and git state are never touched.
