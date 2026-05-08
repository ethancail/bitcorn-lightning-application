# Bitcoin Auto-Buy — Session Handoff

Written 2026-04-24 for a fresh Claude session continuing work on the Coinbase auto-buy feature. The implementation is mostly shipped; this doc captures context the prior session accumulated that isn't obvious from just reading the code.

Read this end-to-end before making any edits. Verify against current code if the date is >1 week old.

---

## TL;DR — where we are right now

- **Auto-buy is fully built and live on the treasury node** (v1.13.7 on main). Scheduler, safety caps, Coinbase client, credential vault, state machine all shipped and tested for compilation.
- **DCA/Valuation surface is live again** (un-hidden in v1.13.9 / PR #130). It was hidden v1.13.0–v1.13.8 while the data-source question was open; once the team committed to the operator-driven manual-entry path as the medium-term answer, the UI came back.
- **Task #73 (real-money smoke test) is the only remaining validation step.** The operator has to walk the Coinbase onboarding flow with a CDP key and verify a live buy moves through the state machine.
- **No one has actually run a real Coinbase buy through our system yet.** That's the next action.

---

## Critical context (what a fresh session might get wrong)

### 1. DCA UI is live — manual valuation-input is the data source

The DCA / valuation surface was hidden in v1.13.0 (Glassnode quoted $13k/yr for the 8 inputs) and un-hidden in v1.13.9 / PR #130 once the team committed to the manual-entry path as the medium-term data source. Today the UI is visible: the gauge, zone definitions, and distribution stats panels render; the Valuation Inputs sidebar link is back; and the Dashboard's "Valuation inputs need attention" banner is live again. There are no `DCA_HIDE` markers in `app/web/src` anymore.

The operator enters the 8 SAGE metrics on the treasury node via `/valuation-input`, signed via HMAC to the Worker; the 3 computed-locally inputs (stockToFlow, ma200w, piCycle) run on the Worker as before. The Glassnode subscription decision is still pending budget approval — the SAGE designer's position is that all 8 SAGE inputs should source from Glassnode for methodology consistency, so any free-data adapter that re-emerges should expect to be reverted on those grounds.

**Backend behavior is unchanged from v1.13.0.** Scheduler fetches `/valuation/current`, multiplies `base_unit × multiplier` from the composite. If KV is empty (no manual inputs entered yet), Worker returns null and scheduler treats it as flat DCA (`multiplier = 1`).

### 2. The v1.11.x saga — do NOT revert these

Four patches in a row fixed the Umbrel lifecycle. If you see any of these regress, you're about to repeat a lot of pain:

- **v1.11.2** — tried `env_file: [.env]` in docker-compose.yml to load operator secrets
- **v1.11.3** — **reverted that** and replaced with `exports.sh` hook. Reason: umbreld invokes compose with its fragment file listed first, so relative `.env` paths resolve against the fragment dir (not the app dir), so compose errored "env file not found". Symptom was "Restarting..." stuck forever in dashboard.
- **v1.11.4** — fixed valuation Worker publishing "Z=0 / Extreme Sell" when no data (engine caught composite failure and persisted NaN → 0 with extreme_sell zone). Now returns early without writing KV if composite can't compute. Also changed `zones.ts` NaN guard to return `fair_value` + multiplier 0 instead of `extreme_sell` + 0.

**Binding rules:**
- Operator secrets load via `bitcorn-lightning-node/exports.sh`, NOT `env_file` in compose
- When composite() throws (no usable inputs), engine returns early and leaves KV untouched
- NaN/Infinity → `fair_value` with multiplier 0 (neutral no-buy), never `extreme_sell`

### 3. Umbrel quirks — they cost hours to find

- **App-store clone path on Umbrel host**: `/home/umbrel/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0/`
- **App data path on Umbrel host**: `/home/umbrel/umbrel/app-data/bitcorn-lightning-node/`
- **Operator `.env` goes in** `app-data/bitcorn-lightning-node/.env` (gitignored, survives app updates, wiped only on uninstall). The `exports.sh` sources it.
- **Umbrel invokes docker compose from OUTSIDE the app dir** — that's why env_file paths can't be relative. The `exports.sh` approach sidesteps this.
- **App-script env vars** that umbreld injects when running `/opt/umbreld/source/modules/apps/legacy-compat/app-script`: `SCRIPT_UMBREL_ROOT`, `SCRIPT_APP_REPO_DIR`, `SCRIPT_DOCKER_FRAGMENTS`, `JWT_SECRET`, `BITCOIN_NETWORK`, `TOR_PROXY_IP` (10.21.21.11), `TOR_PROXY_PORT` (9050), `TOR_PASSWORD` (hardcoded in app-script.ts), `TOR_HASHED_PASSWORD` (hardcoded), `REMOTE_TOR_ACCESS`. The lightning app's `exports.sh` references Tor vars unconditionally — if any of these are missing when you manually invoke app-script, it dies silently with exit 1.
- **Container name format**: newer docker compose uses dashes (`bitcorn-lightning-node-api-1`), older uses underscores (`bitcorn-lightning-node_api_1`). Our current deployment uses dashes.

### 4. The user's terminal mangles long paste commands

Specifically strips spaces adjacent to `$VAR` tokens. Use `${VAR}` with braces to make variable boundaries unambiguous. Heredocs get auto-indented on paste — prefer short single-line commands or have the user use `nano`. If you need to pass a long env assignment, put the `${F}` variable LAST in the list (nothing can stick to it).

Examples that failed during the prior session:
- `export $U SCRIPT_APP_REPO_DIR=$R` → `USCRIPT_APP_REPO_DIR=$R` (space eaten)
- `SCRIPT_DOCKER_FRAGMENTS=$F REMOTE_TOR_ACCESS=false` → `SCRIPT_DOCKER_FRAGMENTS=$FREMOTE_TOR_ACCESS=false`
- Heredoc with `EOF` appeared as `  EOF` (auto-indent), never closed the heredoc

Workaround: build small shell files via `nano /tmp/foo.sh` + paste in, or use `${U}` / `${R}` / `${F}` form.

---

## Architecture quick-ref

### The flow

```
Operator (treasury node)
    │
    │ 1. UI /auto-buy — paste CDP key, whitelist address, enable
    ▼
Node API scheduler (src/autoBuy/scheduler.ts)
    │ 15-min tick, 5-step state machine:
    │   stepEnqueueAndPlaceBuy → stepPollBuyPlaced → stepAssignToSweep
    │   → stepRunSweep → stepPollWithdraws
    ▼
Coinbase Advanced Trade v3 API
    │ 1. Market BUY → wallet balance consumed → BTC in Coinbase BTC wallet
    │ 2. 72h withdraw hold
    │ 3. Weekly sweep: POST /v2/accounts/{btc}/transactions type=send to on-chain address
    ▼
On-chain BTC → operator's LND wallet (via createLndChainAddress)
```

### Key safety rails

| Cap | Default | Env var | Effect |
|---|---|---|---|
| Single buy | $1000 | `AUTOBUY_MAX_SINGLE_BUY_USD` | `skipped_cap_hit` if intended > this |
| Rolling 7d | $2000 | `AUTOBUY_MAX_7D_USD` | sums `filled_usd` across counted states |
| Rolling 30d | $5000 | `AUTOBUY_MAX_30D_USD` | same |
| Base unit config max | $500 | `AUTOBUY_BASE_UNIT_MAX_USD` | UI PATCH /config rejects higher |
| Valuation freshness | 48h | `AUTOBUY_STALE_DATA_MAX_HOURS` | `skipped_stale_data` if older |
| Consecutive failures | 3 | `AUTOBUY_FAILURE_PAUSE_THRESHOLD` | auto-pauses, requires operator re-enable |
| Kill switch | off | `AUTOBUY_ENABLED` | scheduler refuses to schedule if false |

Counted states (for rolling cap SUM): `buy_filled`, `awaiting_withdraw_hold`, `sweep_assigned`, `withdraw_placed`, `withdraw_confirmed`. **`buy_placed` is NOT counted** — known limitation noted in [I3 from the scheduler review](docs/superpowers/plans/2026-04-20-coinbase-autobuy-plan-2a-executor-backend.md), a stranded buy_placed row represents real Coinbase spend that slips past caps.

### State machine states

`scheduled` → `buy_placed` → `buy_filled` → `awaiting_withdraw_hold` → `sweep_assigned` → `withdraw_placed` → `withdraw_confirmed`

Skip states (terminal): `skipped_stale_data`, `skipped_zero_multiplier`, `skipped_cap_hit`, `skipped_insufficient_usd`

Failure states (terminal but countable toward consecutive-failures threshold): `failed_buy`, `failed_withdraw`

---

## Key files map (don't re-explore)

### Backend (Node API)

| File | Purpose |
|---|---|
| `app/api/src/autoBuy/scheduler.ts` | 5-step state machine, 15-min tick, re-entrancy guard, NaN-safe parsing |
| `app/api/src/autoBuy/coinbaseClient.ts` | ES256 JWT signing, 5 ops (listAccounts, placeMarketBuy, pollOrder, placeWithdraw, pollWithdraw), 30s AbortController |
| `app/api/src/autoBuy/credentials.ts` | AES-256-GCM + HKDF from `/data/secrets/master.key` |
| `app/api/src/autoBuy/caps.ts` | 7 exported check functions, CapResult discriminated union, safeCap helper for empty-string env defense |
| `app/api/src/autoBuy/valuationClient.ts` | Proxies Worker /valuation/* with 60-min cache + stale fallback |
| `app/api/src/db/migrations/034_coinbase_autobuy.sql` | `coinbase_credentials`, `autobuy_config`, `autobuy_runs`, `autobuy_sweeps` tables |
| `app/api/src/config/env.ts` | 7 `AUTOBUY_*` env vars declared here (lines ~113-134) |
| `app/api/src/index.ts` | 12 `/api/autobuy/*` + `/api/valuation/*` routes. Search `"/api/autobuy"` to find |

### Frontend (React)

| File | Purpose |
|---|---|
| `app/web/src/pages/AutoBuy.tsx` | Page shell. Tabs: DCA Strategy + Valuation Chart |
| `app/web/src/components/autoBuy/StrategyTab.tsx` | DCA Strategy content — master controls, next-buy banner, StrategyEditor, Zone Multipliers editor, HistoryTable, CoinbaseCard |
| `app/web/src/components/autoBuy/ValuationTab.tsx` | Semicircle gauge, Zone Definitions, Distribution Stats |
| `app/web/src/components/autoBuy/CoinbaseCard.tsx` | 3-state credential onboarding (disconnected, connected-not-whitelisted, ready) |
| `app/web/src/components/autoBuy/HistoryTable.tsx` | Purchase history with pagination + status filter |
| `app/web/src/components/autoBuy/InputsTab.tsx` | Read-only 12-input model inputs table. Referenced from the `/valuation-input` page |
| `app/web/src/pages/ValuationInput.tsx` | Treasury-only manual metric entry, reached via the Valuation Inputs sidebar link |
| `app/web/src/api/client.ts` | All API wrappers + types. Types at bottom (search `export type`) |

### Cloudflare Worker

| File | Purpose |
|---|---|
| `cloudflare-worker/src/index.ts` | Router |
| `cloudflare-worker/src/valuation/engine.ts` | Runs the cron composite. **Returns early on composite failure** (v1.11.4 fix) |
| `cloudflare-worker/src/valuation/zones.ts` | Classifier. NaN → `fair_value`+0 (v1.11.4 fix) |
| `cloudflare-worker/src/valuation/composite.ts` | 12-input weighted sum with renormalization |
| `cloudflare-worker/src/valuation/inputs/*.ts` | 12 adapter files. 3 compute locally (stockToFlow, ma200w, piCycle). 8 read from manualStore. 1 fetches CryptoQuant. |
| `cloudflare-worker/src/valuation/persist.ts` | KV schemas: `valuation_current_v1`, `valuation_history_v1`, `valuation_inputs_v1` |
| `cloudflare-worker/wrangler.toml` | Cron `15 0 * * *`, secrets list documented |

### Umbrel packaging

| File | Purpose |
|---|---|
| `bitcorn-lightning-node/umbrel-app.yml` | Version + release notes. Single source of truth for app version |
| `bitcorn-lightning-node/docker-compose.yml` | Image tags MUST match umbrel-app.yml version. `exports.sh` sibling loaded at service start |
| `bitcorn-lightning-node/exports.sh` | Sources operator `.env` at app start. **Do not remove** (v1.11.3 fix) |
| `bitcorn-lightning-node/.env.example` | Template for operator secrets |

---

## Pending work

### Immediate: Task #73 — real-money smoke test

The one thing not yet validated. Operator has to:

1. **Create Coinbase CDP API key** at `portal.cdp.coinbase.com` with `View + Trade + Transfer` scopes
2. **Fund Coinbase USD wallet** with ~$10 (minimum market order is $2; $10 gives buffer for multiple tests)
3. **Optional safety**: add temporary low caps to `.env`:
   ```
   AUTOBUY_MAX_SINGLE_BUY_USD=3
   AUTOBUY_MAX_7D_USD=10
   AUTOBUY_MAX_30D_USD=30
   ```
   Restart app after edit.

**Walk the UI flow:**
1. `/auto-buy` → paste CDP JSON → "Save & Connect"
2. Card flips to "Connected, not whitelisted". Copy BTC address.
3. Whitelist address on coinbase.com (requires 2FA in Coinbase's own UI).
4. Click "I've whitelisted this in Coinbase" in our UI.
5. In Strategy panel: set base unit = `$2`, frequency = `Daily`, Save.
6. Click Enable in master control.
7. Click Execute Now. Confirm.

**Expected state progression in history table:**
- T+0s: `PLACED`
- T+5-30s: `FILLED` (Coinbase market order fills quickly)
- T+~1min: `AWAITING-WITHDRAW` (72h hold starts)
- T+72h: `SWEEP` → `WITHDRAWING` (only on `sweep_day_of_week`)
- T+~72h+mins: `WITHDRAWN` (on-chain confirmed)

**Operator bash for live-debug:**
```bash
sudo docker logs -f bitcorn-lightning-node-api-1 | grep autobuy
```

**Verify end-to-end:**
- Coinbase.com → Orders → see the market BUY row
- 72h later: `GET /api/autobuy/status` shows `status: "withdraw_confirmed"` and a real on-chain txid

### Next up after smoke test

Queue of likely-next-things in rough priority order:

1. **USD balance runway banner** (proposed, not built). Ships as v1.13.8 after smoke test. Add USD balance to `/api/autobuy/status` response (already fetched in `listAccounts` calls), compute runway = `balance / (base_unit × buys_per_week / 7)`. UI banners at <7 days (amber) / <1 day (red). ~50 lines. Lets operator know when to manually top up.
2. **Known scheduler issue I3**: stranded `buy_placed` rows don't count against rolling caps. Real Coinbase spend slipping past caps. Fix would require polling historical orders by `client_order_id` prefix to reconcile. Not urgent but documented.
3. **Path B — free-data DCA composite**: if the operator's weekly manual-entry burden needs to go away without paying for Glassnode, delete the manual-input pipeline + the 8 stub adapters that read it. Re-weight the 3 computed adapters (stockToFlow 0.12, ma200w 0.10, piCycle 0.07 → renormalized to sum to 1). Net: flat-3-input composite, zero ongoing cost. Trade-off: methodology consistency drops from 8 SAGE inputs to 3, which the SAGE designer is on record against.
4. **Full Glassnode revival**: if/when boss approves $13k/yr, restore the 8 Glassnode adapters (in git history on Plan 1-rev's parent commits, specifically before `38c69e...` deleted them). Revert Plan 1-rev. Budget: ~4 hours work to resurrect.

### Deferred (lower priority)

- Log-price chart with daily zone coloring on Valuation Chart tab — placeholder exists, requires either backfill Worker endpoint or static `power-law-data.json` overlay
- Z-score line chart over time
- Backtest simulator (Plan 2c, was deferred from original spec)
- Weight-tuning UI (Model Inputs weights currently read-only)

---

## Recent decisions log (rationale > just "what")

### 2026-04-24: v1.13.0 — hid DCA surface instead of removing

Glassnode quoted $13k/yr for the 8 metrics we need. User's boss hadn't approved that. Three options considered:
- **A)** Strip DCA entirely → throws away a lot of work, becomes generic auto-buy
- **B)** Free-data composite (3 adapters, no Glassnode) → preserves pitch, zero cost
- **C)** Pay Glassnode → unverified budget

Decision: hide with `DCA_HIDE` markers, keep engine running, re-enable later via B or C. Preserves optionality.

**Follow-up (2026-04-28, v1.13.9, PR #130):** un-hid the DCA surface once the team committed to manual entry as the medium-term data source. The "preserve optionality" bet paid off — Path B (free-data) and Path C (Glassnode) both remain available, since the choice deferred was the data-source decision, not the UI visibility.

### 2026-04-22: v1.12.0 — gauge + stats panels

User's finance guy liked a mockup with semicircle gauge + zone definitions + distribution stats. Built those as v1.12.0. Worker change: engine publishes distribution stats on `valuation_current_v1`. UI change: SVG semicircle gauge in `ValuationTab.tsx`. Currently hidden by v1.13.0 but backend is still publishing stats.

### 2026-04-20 through 22: v1.11.0 through v1.11.4 — multi-day bug hunt

- v1.11.0 shipped the full auto-buy stack
- v1.11.1 was a docs link fix (Coinbase docs URL changed, 404)
- v1.11.2 added `env_file: [.env]` for operator secrets
- v1.11.3 reverted that in favor of `exports.sh` (compose was resolving env_file against the wrong dir under umbreld's invocation)
- v1.11.4 fixed the "Z=0 / Extreme Sell" bogus-state bug (engine.ts + zones.ts)

Lesson: Umbrel's legacy-compat app-script is fragile. Anything that changes how compose is invoked or what env vars reach the container needs careful testing through the actual Umbrel orchestration path, not just local `docker compose up`.

### 2026-04-17: Plan 1-rev — manual input pivot

Original Plan 1 design assumed Glassnode subscription (~$999/yr at the time). User wanted to avoid the recurring cost. Pivot: replace 8 Glassnode adapters with treasury-node manual metric entry. Adds operator weekly burden but eliminates subscription. Those adapters are still in the Worker — they read from `manualStore` KV. The treasury node POSTs signed updates via HMAC to `/valuation/manual`.

### 2026-04-XX: scheduler hardening

Reviewer caught 2 critical + 3 important issues after initial scheduler commit:
- C1: re-entrancy guard on `runTick` (tickInFlight flag)
- I1: NaN-safe `Date.parse` for `filled_at`
- I2: `Number.isFinite` checks on Coinbase string amounts (prevents NaN poisoning SUM caps)
- C2: `awaiting_withdraw_hold` zombie state fixed
- I5: conditional UPDATE in `ensureWithdrawAddress` to avoid race

All landed in commit `2c1bb3d`. If you see a regression on any of these, diff against that commit.

---

## Coinbase API reality check

### What works for us (Advanced Trade v3 with CDP ES256 JWT)

- `GET /api/v3/brokerage/accounts` — list balances, find USD and BTC account UUIDs
- `POST /api/v3/brokerage/orders` — market buy with `quote_size`. **Consumes existing USD wallet balance only.**
- `GET /api/v3/brokerage/orders/historical/{id}` — poll order fill
- `POST /v2/accounts/{id}/transactions` (type=send) — on-chain BTC withdrawal to whitelisted address
- `GET /v2/accounts/{id}/transactions/{id}` — poll withdrawal confirmation

### What does NOT exist (don't try to build)

- **Programmatic recurring ACH deposits** — Coinbase keeps this UI-only (KYC/regulatory).
- **Placing a buy funded by a linked bank/card** — Advanced Trade has no `payment_method_id` param. Must consume wallet balance.
- **Recurring buys via API** — their own "recurring buy" feature is UI-configured.

### Gray area (would need testing if ever needed)

- `GET /v2/payment-methods` — may or may not authorize with modern CDP creds. Historically worked with OAuth v2 tokens.
- `POST /v2/accounts/{id}/deposits` (type=ach) — historical way to trigger one-off ACH deposit. Unknown if CDP creds can invoke it.

Operator's practical answer to "how do I keep USD funded?" → set up recurring ACH deposit on coinbase.com (UI-only, not our concern). Our system consumes the accumulated balance.

---

## Operator environment

Treasury node runs umbrelOS 1.5 on a home server (user is Kevin, node alias BitCorn1, pubkey starts `02b759b155...1bca`).

- Umbrel dashboard: `http://100.126.33.13` (Tailscale IP — plain HTTP, no TLS)
- App dashboard: `http://100.126.33.13:3200`
- SSH: `ssh umbrel@<tailscale-ip>`
- Sudo password: the Umbrel login password

Operator workflow that works:
- PRs merged to `main` → GitHub Actions builds images for `api:X.Y.Z` + `web:X.Y.Z`
- Operator updates app via Umbrel dashboard (v1.11.3 fixed the broken lifecycle, so this just works now)
- If stuck: force-pull the images via `sudo docker pull` + restart via `sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node`
- Operator secrets go in `/home/umbrel/umbrel/app-data/bitcorn-lightning-node/.env` (survives updates, loaded via `exports.sh` at service start)

Existing operator secrets in `.env`:
- `VALUATION_SUBMIT_HMAC` — 64-char hex, matches the value set on the Worker. Used for signing manual valuation submissions.

Potential future additions to `.env`:
- `AUTOBUY_MAX_SINGLE_BUY_USD`, `AUTOBUY_MAX_7D_USD`, `AUTOBUY_MAX_30D_USD` — override defaults for Task #73 safety

---

## Coordination protocols with parallel Claude instances

Another Claude instance has been running UI polish work in parallel (Settings, Wizard, Contacts, Charts pages, all completed as of v1.13.6). The convention:

- **Branch per feature**, named `feature/<short-name>` off `main`
- **Never push to main directly** — always via PR
- **Version bump lives in the final push** of the feature branch, not a separate follow-up push (learned from v1.12.1 PR #116 drift)
- **Treasury instance handles**: auto-buy, Coinbase, valuation, Worker, infrastructure
- **UI polish instance handles**: page-by-page aesthetic work under `docs/UI_CONVENTIONS.md` guidance

If you touch `App.tsx`, `api/client.ts`, or `styles.css`, flag it — those are the shared files where conflicts are most likely.

---

## Decision log for common next-session questions

**Q: Should I revive the Glassnode adapters?**
A: Only if user's boss approves the subscription cost (was $13k/yr at last quote). Until then, manual entry of the 8 SAGE inputs by the operator remains the data source. Path B (3 computed adapters, no Glassnode) is the alternate route — zero ongoing cost, but methodology consistency drops from 8 inputs to 3.

**Q: Should I automate Coinbase funding?**
A: No. Industry standard is operator keeps USD in exchange wallet. We added a "runway banner" proposal to the queue — that gives operators visibility without us building against unstable Coinbase APIs.

**Q: What if the operator's Execute Now fails?**
A: Check in order:
1. `sudo docker logs bitcorn-lightning-node-api-1 --tail 50 | grep autobuy` — see the actual error
2. `sudo docker exec bitcorn-lightning-node-api-1 printenv VALUATION_SUBMIT_HMAC | wc -c` — if 0 or 1, `.env` isn't loading (should be 65)
3. `GET /api/autobuy/status` → `paused_reason` field tells you which safety rail tripped
4. Coinbase.com → Settings → Activity → see if the order went through their side at all

**Q: Can I modify the scheduler?**
A: Yes but tread carefully — it places real-money orders. The spec-and-quality review process that shipped v1.11.0 caught 2 critical + 3 important issues. Any scheduler change should go through the same two-stage review. Invoke `superpowers:subagent-driven-development` if in doubt.

**Q: What's the Worker's deploy process?**
A: `cd cloudflare-worker && npx wrangler deploy`. Independent of the Umbrel app. Use when changing Worker-side code only (engine, zones, adapters). No GHA builds for Worker — ships direct via wrangler.

---

## Key PR history

Most recent work first. All merged to main unless noted.

| PR | Version | Summary |
|---|---|---|
| #125 | v1.13.7 | Hide Dashboard valuation banner (last DCA_HIDE site) |
| #124 | v1.13.6 | Charts ticker strip polish (UI polish instance) |
| — | v1.13.5 | Contacts page polish (UI polish instance) |
| — | v1.13.4 | Wizard polish (UI polish instance) |
| — | v1.13.3 | Settings page Briefing Room aesthetic (UI polish instance) |
| — | v1.13.1 | Wizard split from 5 steps to 4 (UI polish instance) |
| #118 | v1.13.0 | Hide DCA surface while sorting data source (this path) |
| #115 | docs | UI conventions brief for polish instance |
| #114 | v1.12.0 | Semicircle gauge + Zone Defs + Distribution Stats |
| #113 | v1.11.4 | Worker NaN-guard + Model Inputs page split |
| #112 | v1.11.3 | exports.sh replaces env_file (Umbrel lifecycle fix) |
| #111 | v1.11.2 | env_file attempt (later reverted by #112) |
| #110 | v1.11.1 | Coinbase docs link fix (404) |
| #109 | fix | same as #110 but separate fix PR |
| #108 | v1.11.0 | Full auto-buy v1 — combined PR of Plan 2a + 2b |
| #107 | plan 2b | UI (merged into v1.11.0) |
| #106 | plan 1/1-rev/1b | Valuation engine + manual entry |

---

## Starting work — recommended first actions

When you pick up this handoff:

1. **Confirm state**:
   ```bash
   git fetch origin
   git log origin/main --oneline -10
   gh pr list --state=open
   ```
2. **Check if Task #73 (operator smoke test) has run** — ask the user or check for `autobuy_runs` rows on the treasury node (requires their SSH). If user says it's done and passed, close #73 and move to the queue (runway banner is probably next).
3. **Don't start new work without user direction**. Ask what's next before diving in. Current state is "mostly shipped, waiting for operator validation."
4. **Read the relevant docs before touching anything**:
   - This file (`docs/AUTOBUY_HANDOFF.md`)
   - `docs/UI_CONVENTIONS.md` if UI work
   - `docs/superpowers/specs/2026-04-17-coinbase-auto-buy-design.md` if touching backend logic
   - `CLAUDE.md` root for general repo rules

Good luck. Don't break the real-money paths. Real money doesn't apologize.
