# CLAUDE.md

Guidance for Claude Code working in this repo. Source of truth for *how to work here*; the codebase itself is the source of truth for *what exists*.

## Read First

Before touching a feature or bug, read the relevant doc(s):

| Doc | When to read |
|-----|--------------|
| `docs/ARCHITECTURE.md` | Data flow, node roles, sync loop, rebalance engine, lane model, capabilities |
| `docs/IMPLEMENTATION.md` | File-by-file map (API + web), routing, frontend patterns, layout constraints |
| `docs/API.md` | Complete endpoint reference with access rules |
| `docs/DATABASE.md` | Schema, migrations, key tables |
| `docs/LOOP_SETUP.md` | Loop Out setup + production gotchas (prepay model, min capacity, restart cascade) |
| `docs/COINBASE_INTEGRATION.md` | Cloudflare Worker architecture, secrets, redeploy |

For per-version history: `git log`. This file is not a changelog.

## Mission

Bitcorn Lightning is a **Lightning Treasury Capital Allocation Engine** — not a wallet, not a UI product, not a generic routing node. Net sats is the only number that matters:

```
Net Sats = inbound + forwarding fees − outbound fees − rebalance costs
```

See `docs/ARCHITECTURE.md` for the full mission, roles, and capabilities.

### Non-Negotiables

- Guardrails cannot be bypassed by automation
- Capital reserve floors must always be respected
- Deploy ratio limits must always be enforced
- Rebalance costs must always be accounted for
- Automation must be auditable and deterministic
- Safety > growth
- **Ask before touching networking, auth, Lightning flows, or Umbrel manifests** — this is a production Lightning application

## Project Layout

- `app/api/` — TypeScript API (port 3101)
- `app/web/` — React + Vite UI (port 3200)
- `cloudflare-worker/` — Worker holding CDP credentials + commodity price cache
- `docs/` — architecture and reference
- No automated test suite yet. Migrations run automatically on API startup.

## Build & Dev

```bash
# API
cd app/api && npm run build && npm start

# Web dev server (hot reload)
cd app/web && npm run dev

# Full stack
docker compose up -d --build
```

Frontend deps: `react`, `react-dom`, `react-router-dom`, `recharts`, `date-fns`, `qrcode`.

## Branching & Deployment

- `main` — production; pushes trigger Docker image builds via GitHub Actions
- `develop` — integration branch
- `feature/*` — feature branches off `develop`

Merge path: `feature/*` → `develop` → sideload test on Umbrel → `main`.

### Umbrel Gotchas (read before releasing)

**Version must match in two files.** Bump `umbrel-app.yml` AND `bitcorn-lightning-node/docker-compose.yml` image tags together. Drift → Umbrel pulls stale images.

**If install fails (flips back to "Install" at 0%):** Docker images likely don't exist on ghcr.io yet. Check `gh run list` for a failed build. Common cause: transient npm 403 errors (e.g. `npm install -g serve` rate-limited). Re-run with `gh run rerun <run-id> --failed`. Always verify the build is green after a version bump.

**If install reaches ~50% then resets:** Port conflict. Check `sudo journalctl -u umbreld -n 100` for "already allocated". Remove conflicting container (`sudo docker rm -f <name>`) and retry.

**Half-installed after early user click:** If the user triggers Umbrel update before ghcr.io images finish building, app gets stuck. Fix: `sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/<api|web>:<version>` then `sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node`.

**Hotfix under same tag:** Umbrel won't auto-detect image changes for an unchanged tag. Force-pull + restart with the same commands as above.

**Umbrel restart command (newer Umbrel):**
```bash
sudo umbreld client apps.restart.mutate --appId <appId>
```
The older `sudo ~/umbrel/scripts/app restart <appId>` does not exist on newer Umbrel.

**Docker QEMU ARM64 crashes:** `node:20-alpine` (musl libc) causes `qemu: uncaught target signal 4 (Illegal instruction)` during multi-arch builds on GitHub Actions. Fix: `node:20-slim` (Debian/glibc). Web build stage can use `--platform=$BUILDPLATFORM` (Vite output is platform-independent); API cannot because `better-sqlite3` native bindings must compile for the target arch — install `python3 make g++` in the build stage instead.

## Ports (do not change without approval)

| Port | Purpose |
|------|---------|
| 3101 | User/Admin API (JWT, Umbrel-aware) |
| 3109 | Node-to-Node API (HMAC only, never proxied) — **stub only** |
| 3200 | Web UI |

Do not reuse 3001 or 3009. Do not expose 3109 via Umbrel app-proxy. Port 3109 is completely unimplemented (only `ports.ts` / `hmac.ts` / `node-api.ts` stubs exist); no member liquidity coordination uses it.

## Security Constraints

- Secrets generated on first run and stored under `/data/secrets` — never hardcode or commit
- User/Admin API (3101): JWT auth
- Node-to-Node API (3109): HMAC + timestamp + nonce (when implemented)
- No `docker.sock` mounts, no privileged containers, no host networking

## Environment Variables

`app/api/src/config/env.ts` is authoritative. Variables worth knowing by heart:

- `TREASURY_PUBKEY` — hard-coded in `docker-compose.yml` as `02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca`. Identifies the treasury node so all member installs get correct role detection automatically.
- `LND_GRPC_HOST` — default `lightning_lnd_1:10009`
- `REBALANCE_SCHEDULER_ENABLED` — default `false` (treasury-side Loop Out scheduler — edge-case + external-inbound maintenance only; off in steady state)
- `CLUSTER_REBALANCE_ENABLED` — default `false` (cluster engine v1 — legacy; off and not used in steady state)
- `RATE_LIMIT_MAX_SINGLE_PAYMENT` — default `250000` sats
- `REBALANCE_MAX_FEE_PPM` — default `1000` (caps effective fee-to-amount ratio; prevents net-negative micro-rebalances)
- `COINBASE_APP_ID` + `COINBASE_WORKER_URL` — required for Fund Node button (503 if either unset)

## Files to Share When Getting External AI Assistance

Docs describe *what* exists; source code shows *how* it works. When using Claude chat or another AI for brainstorming, paste the relevant source files:

| Area | Files to share |
|------|----------------|
| Channel ROI / peer scoring | `src/api/treasury-channel-metrics.ts`, `src/api/treasury-liquidity-health.ts`, `src/api/treasury.ts` |
| Capital guardrails | `src/utils/capital-guardrails.ts`, migration `013_treasury_capital_policy.sql` |
| Member Liquidity Advisor (steady-state rebalancing) | `src/memberAdvisor/*`, migrations `027`, `028`, `032` |
| Treasury push (provisioning + edge-case) | `src/memberLiquidity/*`, migration `026` |
| Loop Out (treasury, edge-case maintenance) | `src/lightning/loop.ts`, `src/lightning/rebalance-loop.ts`, `src/lightning/rebalance-scheduler.ts`, migrations `014`, `015` |
| Cluster engine v1 (legacy, gated off) | `src/rebalance/*`, migrations `023`–`025` |
| Expansion engine | `src/api/treasury-expansion.ts`, `src/utils/capital-guardrails.ts` |
| Metrics / net yield | `src/api/treasury.ts`, migrations `007`–`009`, `014` |
| All routes | `src/index.ts` |
| Coinbase Onramp | `app/api/src/api/coinbase-onramp.ts`, `cloudflare-worker/src/index.ts` |

Always include `CLAUDE.md` + `docs/IMPLEMENTATION.md` as base context.

## Hard-Won Gotchas

Things that cost hours to find. Read before debugging in that area.

### General

- **Raw HTTP server, not Express:** `src/index.ts` uses `http.createServer` with an if/else chain. More specific routes (`/api/contacts/sync-peers`) must come before general ones (`/api/contacts`). CORS must list every method used (PATCH/DELETE).
- **`lnd_node_info` is local-only:** It's a singleton storing the local node. For remote peer aliases, use `getNode` from ln-service (gossip graph).
- **Formatting helpers need null guards:** `fmtSats`, `truncPubkey`, `resolveContactName` receive data from API/SQLite that may be undefined. Crashed historically on `pubkey.slice()` without a guard. Always handle falsy inputs. Reuse existing helpers — don't duplicate truncation logic.
- **Sync loop must DELETE stale rows, not just upsert:** `persistChannels()` and `persistPeers()` previously used `INSERT OR REPLACE` only — closed channels stayed `active=1` forever. Now they `DELETE WHERE channel_id NOT IN (current IDs)` after upserting.
- **Umbrel DB requires sudo:** `data/db/` is owned by root. All `sqlite3` commands need `sudo`. Without it, `ls` shows an empty directory.

### Payments

- **Members with direct channels bypass treasury:** LND pathfinding picks cheapest route — a direct member-to-member channel = 0 fees, 1 hop, no forwarding through hub. Treasury earns nothing. Fixed by forcing `outgoing_channel` to the treasury channel in `payInvoice()`. Works because treasury node has no channel to itself → lookup returns null → routes normally.
- **`decodePaymentRequest` is ASYNC and requires `lnd`:** Old type declaration had it sync with only `{request}`. Reading `.tokens` off a Promise gave undefined → "— sats" and `$NaN`. All call sites must use `await decodePaymentRequest({lnd, request})`.
- **`navigator.clipboard.writeText` requires HTTPS or localhost:** Fails silently on plain HTTP (Tailscale IPs). Use `document.execCommand('copy')` fallback with a temporary textarea.
- **`lncli fwdinghistory` defaults to last 24h:** Use `--start_time 0` for full history.
- **`lncli updatechanpolicy` requires `--time_lock_delta`:** Missing this flag errors. Use `--time_lock_delta 40` as default.

### Loop Out

See `docs/LOOP_SETUP.md` for the full gotcha list. Highlights that bite regularly:
- **Prepay is a HOLD not a fee:** ~30k sats returned in the on-chain payment. Net fee = swap + miner only.
- **ACINQ caps in-flight at 45% of capacity:** Need ≥556k channel for 250k minimum swap.
- **Restart cascade:** Restarting LND requires restarting litd (`apps.restart.mutate --appId lightning-terminal`).
- **Channel ID uint64 conversion:** `(block<<40)|(tx<<16)|output` via BigInt; `longs: String` in proto-loader.

### Rebalancing

- **Steady-state rebalancing is member-driven, not treasury-coordinated:** the Member Liquidity Advisor on each member node recommends Loop In (merchant) or Loop Out (farmer) locally; the treasury does not orchestrate steady-state rebalancing. Treasury push and treasury-side Loop Out are reserved for provisioning and edge cases. See `docs/ARCHITECTURE.md` § Liquidity Management.
- **Keysend push ≠ rebalance:** In hub-and-spoke topology with no external peers for circular routes, keysend push permanently transfers sats — it is *not* a rebalancing tool, and is disabled as such. Keysend remains the execution path for *treasury push* (provisioning + edge cases). Keysend enforcement (preflight + 24h skip on rejection) is retained for that path.
- **Role matters:** `channel_role` (merchant/farmer/unknown) is set by the user and controls whether the advisor recommends Loop In, Loop Out, or a channel upgrade. Never auto-classify by balance heuristics.

### Cloudflare Worker

- **Clear KV cache after changing API keys:**
  ```bash
  npx wrangler kv key delete commodity_prices --namespace-id=62c68c41830141cc8b0b6e7cdb193461
  ```
- **Secret format:** paste the raw key / raw PEM from the CDP JSON — do NOT wrap in quotes when piping to `wrangler secret put`.

## Working Style

- Read the relevant doc before making changes — `docs/` is current as of this CLAUDE.md rewrite
- Don't add features, refactor, or "improve" code beyond what was asked
- Don't add speculative error handling for scenarios that can't happen
- When docs drift from code, **update the doc in the same PR** — the reason this file used to be 500 lines was that nobody updated `docs/` and it all piled up here
