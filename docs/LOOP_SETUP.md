# Loop (Submarine Swaps)

Loop moves value between Lightning and on-chain without closing a channel.

- **Loop Out** — sends sats out through a channel off-chain, receives them back
  on-chain. Restores *receive* capacity. Total balance is preserved minus fees.
- **Loop In** — spends on-chain BTC to restore *local* (spendable) balance on a
  channel. The merchant-refill direction.

This document covers how Loop is wired into Bitcorn and the mechanics that bite
in production. Both directions run on the same daemon and share every gotcha
below.

**Who runs which direction** (see `docs/ARCHITECTURE.md` § Liquidity Management
for the full model):

- **Steady state is member-driven.** Each member node runs its own swaps
  locally, on its own loopd, recommended by the Member Liquidity Advisor:
  farmers Loop Out, merchants Loop In. The treasury does not orchestrate this
  and is not in the trust path.
- **Treasury-side Loop Out is an edge-case and external-inbound-maintenance
  tool** — not the steady-state rebalancing mechanism.

## How Loop runs

**There is nothing to install.** loopd ships inside Bitcorn's own Docker stack
as the `loopd` service in `bitcorn-lightning-node/docker-compose.yml`, on every
node, treasury and member alike. Installing or configuring the Umbrel Lightning
Terminal app is **not** part of Loop setup and has not been since v1.8.0.

```
  api container ──gRPC :11010──▶ loopd container ──gRPC :10009──▶ LND
       │                             │                         (10.21.21.9)
       └── reads tls.cert +          └── --loopdir=/litd-data/.loop
           loop.macaroon (:ro)           <loopdir>/<network>/ holds
           from the same directory       tls.cert, tls.key, loop.macaroon,
                                         and the swap database
```

Three things about that wiring are load-bearing and each has its own reason:

- **`--rpclisten=0.0.0.0:11010`.** loopd defaults to `localhost:11010`. Bound to
  loopback the api container cannot reach it over Docker DNS, and Loop is dead
  on every node — while loopd still starts, logs clean and answers `--version`.
- **`--lnd.host=10.21.21.9:10009`.** LND's TLS cert SANs carry that IP and no
  Docker DNS name. A "tidier" service name fails cert verification.
- **The data directory is `${APP_DATA_DIR}/litd`,** not `.../loop`. It is
  litd's old directory, kept deliberately when litd was removed in v1.18.9:
  loopd opens the existing database without migrating it, so swap history,
  in-flight swaps and the L402 token survived the change. Do not "correct" the
  name.

`--restlisten` is bound to `127.0.0.1:8081` on purpose. Bitcorn does not use
loopd's REST surface, and keeping it off the shared Docker network is part of
why the standalone daemon is a smaller attack surface than the litd sidecar it
replaced (litd served a unified UI/session endpoint on `0.0.0.0:8443` behind a
hardcoded password; this is Loop-only gRPC behind a macaroon).

### Why Bitcorn publishes its own loopd image

`ghcr.io/ethancail/bitcorn-lightning-application/loopd`, not
`lightninglabs/loop`. Upstream's arm64 manifest entry ships an amd64
filesystem — `exec format error` on a Raspberry Pi, despite a manifest that
claims arm64. `app/loopd/Dockerfile` repackages upstream's signed release
binaries and reads `e_machine` out of the ELF header of every binary it copies,
refusing to build on a mismatch. Read that file's header before touching the
image; it is the record of the failure and of the guard.

## Verify Loop is working

```bash
curl http://localhost:3101/api/treasury/rebalance/loop-out/status
```

`loop_available: true` means the api container reached loopd, authenticated
with the macaroon, and got real terms back.

Dashboard alerts carry the same fact:

| Alert | Severity | Meaning |
|-------|----------|---------|
| `LOOP_OUT_AVAILABLE` | info | Critical channels exist and Loop is reachable |
| `LOOP_NOT_INSTALLED` | warning | Loop credentials or the daemon aren't reachable |

`LOOP_NOT_INSTALLED` is a historical identifier, kept because renaming it would
break the alert-type API contract. It no longer means "the operator did not
install something" — nothing is optional any more — it means loopd is not
answering.

## API endpoints

Treasury-side (all require treasury role):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/treasury/rebalance/loop-out/terms` | Min/max swap amounts |
| GET | `/api/treasury/rebalance/loop-out/quote?amount_sats=N` | Cost breakdown |
| GET | `/api/treasury/rebalance/loop-out/status` | Loop status + in-flight swaps |
| POST | `/api/treasury/rebalance/loop-out` | Manual swap (`{ channel_id, amount_sats }`) |
| POST | `/api/treasury/rebalance/loop-out/auto` | Auto-rebalance all critical channels |

Member-side swaps are a separate family under `/api/swaps/loop-out` and
`/api/swaps/loop-in` (quote + execute for each), served by `src/swaps/`. See
`docs/API.md` for access rules. Treasury-initiated Loop In is deliberately not
implemented — `/api/admin/swaps/loop-in` returns an explanation rather than a
swap.

## Automated scheduler (operator opt-in)

Off by default, and not part of routine network operation. Steady-state
rebalancing is member-driven; this scheduler exists for the treasury operator
who wants to automate external-inbound maintenance (keeping the treasury
reachable so member Loop In flows can succeed) or one-off edge-case recovery.

```yaml
environment:
  REBALANCE_SCHEDULER_ENABLED: "true"
  # Optional: log decisions without executing
  # REBALANCE_SCHEDULER_DRY_RUN: "true"
```

Default interval is 60s (`REBALANCE_SCHEDULER_INTERVAL_MS`, default `60000`).
It monitors in-flight swaps and initiates new Loop Outs for critical treasury
channels.

## Environment variables

Every row below was read from `app/api/src/config/env.ts` rather than carried
forward. That file is authoritative; this table is a copy and can drift.

| Variable | Default | Description |
|----------|---------|-------------|
| `LOOP_GRPC_HOST` | `bitcorn-lightning-node_loopd_1` | loopd container name (not a service alias — aliases collide on Umbrel's shared network) |
| `LOOP_GRPC_PORT` | `11010` | loopd gRPC port |
| `LOOP_TLS_CERT_PATH` | `/loop-data/.loop/mainnet/tls.cert` | loopd's self-generated TLS cert, under `loopdir/<network>/` |
| `LOOP_MACAROON_PATH` | `/loop-data/.loop/mainnet/loop.macaroon` | Loop macaroon, same directory as the cert |
| `LOOP_MAX_SWAP_FEE_PCT` | `15` | Sanity check on a quote's **swap-fee component**, as a % of swap amount. Not a ceiling sent to loopd: `max_swap_fee` is the quoted swap fee |
| `LOOP_ROUTING_FEE_CAP_PPM` | `10000` | Routing-fee cap (1%), applied separately to the swap payment and the prepay; sent as both routing ceilings, and the pre-initiation route probe refuses a route over it |
| `LOOP_MINER_FEE_MARGIN_PCT` | `50` | Before initiation, a fresh quote's miner fee above the quoted one plus this % refuses the swap |
| `LOOP_MIN_REBALANCE_SATS` | `50000` | Minimum swap amount in auto mode |
| `LOOP_CONF_TARGET` | `6` | On-chain confirmation target, in blocks |
| `LOOP_SERVER_PUBKEYS` | Lightning Labs mainnet Loop server | Comma-separated pubkeys for the Loop In route-probe preflight, and the Loop Out route probe's fallback when the quote's `swap_payment_dest` finds no route |

**`LOOP_MAX_SWAP_FEE_PCT` is 15, and since loop-fee-ceilings it is only a
sanity check.** It applies to `quote.swap_fee_sat` alone, not to the total,
and it is never sent to loopd: `max_swap_fee` is the quoted swap fee itself.
(It read `0.5` until v1.18.9 and the documentation read `0.5` long after the
code moved. The old rationale for 15 — the ~30k prepay making a 250k swap look
like ~12% — never applied to this check, which does not include the prepay.)

## Fee ceilings, as built

Every Loop call that moves money sends loopd ceilings from the quote, with no
margin and no fixed defaults (loop-fee-ceilings spec F1–F3, bitcorn-research):

| Ceiling | Loop Out (member, admin, treasury rebalance) | Loop In (member) |
|---|---|---|
| `max_swap_fee` | quoted swap fee | quoted swap fee alone (not the HTLC fee) |
| `max_prepay_amt` | quoted prepay | — |
| `max_miner_fee` | quoted sweep fee | quoted HTLC fee |
| `max_swap_routing_fee` | `LOOP_ROUTING_FEE_CAP_PPM` × swap amount (default 1%) | — |
| `max_prepay_routing_fee` | `LOOP_ROUTING_FEE_CAP_PPM` × prepay | — |

The member and admin paths store the quote's components on the
`swap_requests` row (migrations 060–062); the member sees them as `ceilings`
on the quote, echoes them, and the confirmation hash covers them. A row quoted
before those migrations is refused and requoted. The treasury rebalance path
takes them from its own in-call quote and accepts no body overrides.

**Before initiation**, each path refuses with its own code:
- **fee rate** — a fresh quote's miner fee above the quoted one plus
  `LOOP_MINER_FEE_MARGIN_PCT` (50%). On the treasury path this is close to
  vacuous: its quote is seconds old, so the probe is its real protection.
- **route probe (Loop Out)** — the quote's `swap_payment_dest` is probed for
  the swap amount and the prepay; if that finds no route, the
  `LOOP_SERVER_PUBKEYS` are probed instead. A route over the cap, or no route
  at all, refuses. ⚠ On the fallback branch the final hop (Loop server →
  destination) is Loop's own channel and is not probed.
- **unknown HTLC fee (Loop In)** — loopd's failed estimate (−1, clamped to 0)
  or a zero estimate is refused at the quote and before initiation.

**What stays unbounded once a swap has started:** the Loop Out sweep follows
the market, capped by loopd at 20% of the amount; the Loop In HTLC is
published at the wallet's estimate with no cap. Both are disclosed in the
confirmation; neither is bounded by Bitcorn. `max_miner_fee` does not bind at
loopd v0.33 and is sent because it is harmless now and correct if a later
loopd enforces it.

**Autoloop is switched off.** On the first successful loopd call after start,
and after any unavailable → available transition, Bitcorn reads the liquidity
parameters and, if `autoloop` is on, writes the same set back with only
`autoloop=false` (logged). A failure is logged, never blocks swaps, and is
retried at the next of those points — and also on the next successful loopd
call at least 10 minutes after the failure, at most once per 10 minutes. Two accepted side effects: the sweep fee
rate round-trips in whole sat/vB, and an autoloop swap already dispatched
keeps its retries.

## Safety guardrails

- **Daily loss cap** applies to Loop Out, same as every rebalance operation
  (`assertDailyLossCapNotExceeded`, `src/utils/loss-cap.ts`). Auto mode halts
  the whole run when the cap is reached.
- **Never swaps more than 50% of a channel's CAPACITY.** Not 50% of local
  balance — the check is `channel.capacity * 0.5`
  (`src/lightning/rebalance-loop.ts`).
- **Auto mode skips channels with an in-flight swap**, so a slow swap cannot be
  double-issued.
- **Fee ceilings** are bound to the quote, and the pre-initiation checks
  (fee rate, route probe) refuse before any loopd call that moves money — see
  "Fee ceilings, as built" above. They do not bound the on-chain fee once a
  swap has started.
- **Graceful degradation:** with loopd unreachable, the app runs normally and
  Loop surfaces report unavailable. Nothing else is blocked.

## Prepay model (important)

⚠ **UNVERIFIED, pending P1.** This section has long said the ~30,000 sat
prepay is a **temporary hold**, sent during the swap and returned as part of
the on-chain payment, and **not** an additional fee. The loop-fee-ceilings
arc does not treat that as established: prediction P1 is that the prepay sits
inside the server's swap fee, and Polar gate 1 (L3) measures it from the
amounts actually paid; the post-deploy real Loop Out measures it on mainnet.
Until then the "most you authorize" figure in the confirmation counts the
prepay as additive (it can overstate, never understate), while the
withdrawal panel's prepay row still reads "returned" — that label changes
only once P1 is settled.

- Net cost if P1 holds = `swap_fee + miner_fee` (~1–2k sats typical).

⚠ **`total_cost_sats` / `total_fee_sat` INCLUDE the prepay.** So does the value
handed to the daily loss cap
(`assertDailyLossCapNotExceeded(quote.total_cost_sats)`), and so does the
`max_fee_sats` recorded on the rebalance execution row. The stored
`quoted_fee_sat` does **not** for Loop Out — it is `swap_fee + miner_fee`
(`src/swaps/swapService.ts`) — and for Loop In it is swap fee + HTLC fee.
(This document previously said `quoted_fee_sat` included the prepay; for Loop
Out it does not.)

`max_prepay_amt` is the quoted prepay on every path (it used to be a flat
`50_000` on member swaps). The loopd default is too low to leave unset; the
~30k prepay will not fit.

## Minimum channel capacity

Routing peers such as ACINQ cap `max_value_in_flight_msat` at ~45% of channel
capacity. A 500k channel therefore only permits 225k in flight — under Loop's
250k minimum.

**You need ≥556k capacity to the routing peer** for a 250k swap to clear.

## Production gotchas

**Restart cascade — restart Bitcorn, not Lightning Terminal.** After LND
restarts (which is how its TLS cert is renewed), loopd is holding a connection
against the old cert. loopd lives in *Bitcorn's* compose, so only a Bitcorn
restart reaches it:

```bash
sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node
```

The older `sudo ~/umbrel/scripts/app restart <appId>` does not exist on newer
Umbrel. Restarting the `lightning-terminal` app does nothing for Loop — that
app is not part of this stack.

**gRPC target name override.** loopd's auto-generated cert carries
`DNS:localhost` (plus the container hostname and IP) but no Docker DNS name, so
the client sets `grpc.ssl_target_name_override: "localhost"`
(`src/lightning/loop.ts`). Because the cert already contains that SAN, **no TLS
flags belong in the compose** — in particular `--tlsdisableautofill` would
remove the SAN the override depends on.

**Never pass `--tlsautorefresh`.** It is declared in loopd's config and read
nowhere upstream, so it appears in `loopd --help` and does nothing. Bitcorn's
March 2026 compose passed it in good faith for a month. A `--help` check
confirms a flag exists; it cannot tell you anything is reading it.

**`max_prepay_amt` must be explicit.** The default is below the ~30k prepay.
See the prepay section above for which value each path sends.

**`htlc_sweep_fee_sat`, not `miner_fee_sat`.** `OutQuoteResponse` names the
miner fee `htlc_sweep_fee_sat`; reading the other field yields undefined.

**Channel ID conversion.** ln-service's short format (`NxNxN`) must become a
uint64 for loopd's proto via `(block << 40) | (tx << 16) | output`, **using
BigInt** — the value exceeds JS's safe integer range. proto-loader needs
`longs: String` to preserve it across the boundary.

**LND `chan_id` changed format.** Newer LND shows `chan_id` as hex (the funding
txid) in `lncli listchannels`, with `scid` (uint64 string) and `scid_str`
(short format) as separate fields.

## Verification history

- **2026-03-11, mainnet:** 250k Loop Out through ACINQ succeeded end to end.
  Total cost 31,437 sats (1.26% — prepay included in that figure).
- **2026-08-31, both architectures:** loopd 0.33.0-beta from the Bitcorn image
  verified on an aarch64 Pi 5 and the x86_64 treasury ahead of the v1.18.9
  swap. Reaches listening state 120ms from process start, dials LND, serves
  real `terms` and `quote` (250k out → 249,544 on-chain, 456 sats total fee),
  and answered a second container on `umbrel_main_network` at `:11010` using
  the macaroon mounted read-only. It opened litd's existing database three
  times without applying a migration.
