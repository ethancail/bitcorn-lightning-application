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
| `LOOP_MAX_SWAP_FEE_PCT` | `15` | Ceiling on the **swap-fee component**, as a % of swap amount |
| `LOOP_MAX_MINER_FEE_SATS` | `20000` | Ceiling on the on-chain sweep fee |
| `LOOP_MIN_REBALANCE_SATS` | `50000` | Minimum swap amount in auto mode |
| `LOOP_CONF_TARGET` | `6` | On-chain confirmation target, in blocks |
| `LOOP_SERVER_PUBKEYS` | Lightning Labs mainnet Loop server | Comma-separated pubkeys for the Loop In route-probe preflight |

**`LOOP_MAX_SWAP_FEE_PCT` is 15, and 15 is not a typo.** It read `0.5` until
v1.18.9 and the *documentation* read `0.5` long after the code moved — a 30×
error in a fee guardrail. The reason for 15 is the fixed prepay component: Loop
carries a ~30k sat prepay regardless of swap size, so a 250k swap has a ~12%
effective rate before anything is wrong. A 0.5% ceiling rejects every swap near
the 250k minimum. Larger swaps amortise the fixed cost and land far below the
ceiling. The check applies to `quote.swap_fee_sat` alone, not to the total.

## Safety guardrails

- **Daily loss cap** applies to Loop Out, same as every rebalance operation
  (`assertDailyLossCapNotExceeded`, `src/utils/loss-cap.ts`). Auto mode halts
  the whole run when the cap is reached.
- **Never swaps more than 50% of a channel's CAPACITY.** Not 50% of local
  balance — the check is `channel.capacity * 0.5`
  (`src/lightning/rebalance-loop.ts`).
- **Auto mode skips channels with an in-flight swap**, so a slow swap cannot be
  double-issued.
- **Fee ceilings** reject swaps whose swap fee or miner fee exceeds the limits
  above, before any money moves.
- **Graceful degradation:** with loopd unreachable, the app runs normally and
  Loop surfaces report unavailable. Nothing else is blocked.

## Prepay model (important)

The ~30,000 sat prepay is a **temporary hold**, sent during the swap and
returned as part of the on-chain payment. It is **not** an additional fee.

- Real net cost = `swap_fee + miner_fee` (~1–2k sats typical).
- The withdrawal UI shows the prepay on its own row, labelled as returned, so
  what the farmer reads is honest.

⚠ **But `total_cost_sats` / `total_fee_sat` / the stored `quoted_fee_sat` all
INCLUDE the prepay.** So does the value handed to the daily loss cap
(`assertDailyLossCapNotExceeded(quote.total_cost_sats)`), and so does the
`max_fee_sats` recorded on the rebalance execution row. Treat any of those as
"the fee" and you overstate a 250k swap's cost by roughly 30k sats. (This
document previously claimed the opposite — that policy checks and
`quoted_fee_sat` used the net figure. They do not.)

The `max_prepay_amt` sent to loopd differs by path, deliberately:

- **Treasury Loop Out** passes `quote.prepay_amt_sat` — the quoted prepay.
- **Member swaps** pass a flat `50_000` ceiling (`src/swaps/swapService.ts`).

Either way the default is too low to leave unset; the ~30k prepay will not fit.

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
