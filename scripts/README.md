# scripts/

Operational shell scripts (`healthcheck.sh`, `init-secrets.sh`, `migrate.sh`) and dev tools.

## state-snapshot.mjs — STATE.md generator

Generates `STATE.md` at the repo root from **actual current reality** — git, code,
chain, deployment — to kill "what's implemented/deployed vs. what I remember" drift.
Strictly read-only: the only write is the output file.

```bash
node scripts/state-snapshot.mjs             # writes STATE.md
node scripts/state-snapshot.mjs --selftest  # keccak/selector self-test only
```

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
