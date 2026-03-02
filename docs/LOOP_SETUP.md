# Loop Out Rebalancing Setup

Loop Out submarine swaps restore receive capacity on channels by moving sats
off-chain and returning them on-chain (minus swap + miner fees). Total treasury
balance is preserved.

## Prerequisites

- Umbrel node running BitCorn Lightning v1.4.0+
- Lightning Terminal installed from the Umbrel App Store

## How It Works

1. BitCorn identifies **critical** channels (>85% local balance)
2. A Loop Out swap sends sats through the channel off-chain
3. The Loop server returns equivalent sats on-chain
4. Channel receive capacity is restored; on-chain balance increases
5. Cost = swap fee + prepay + miner fee (typically 0.1–0.5% of amount)

## Install Lightning Terminal

1. Open the Umbrel App Store
2. Search for "Lightning Terminal"
3. Click Install — it runs as a subserver alongside LND
4. Wait for it to fully sync (check its web UI at port 8443)

## Verify Connection

After installing Lightning Terminal, BitCorn automatically detects it.
Check the dashboard alerts — you should see:

- **LOOP_OUT_AVAILABLE** (info) when critical channels exist and Loop is reachable
- **LOOP_NOT_INSTALLED** (warning) if Loop credentials aren't found

Or use the API:

```bash
curl http://localhost:3101/api/treasury/rebalance/loop-out/status
```

Returns `loop_available: true` when connected.

## API Endpoints

All endpoints require treasury role.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/treasury/rebalance/loop-out/terms` | Min/max swap amounts |
| GET | `/api/treasury/rebalance/loop-out/quote?amount_sats=N` | Cost breakdown |
| GET | `/api/treasury/rebalance/loop-out/status` | Loop status + in-flight swaps |
| POST | `/api/treasury/rebalance/loop-out` | Manual swap (body: `{ channel_id, amount_sats }`) |
| POST | `/api/treasury/rebalance/loop-out/auto` | Auto-rebalance all critical channels |

## Automated Scheduler

Enable the rebalance scheduler in `docker-compose.yml`:

```yaml
environment:
  REBALANCE_SCHEDULER_ENABLED: "true"
  # Optional: dry-run mode logs decisions without executing
  # REBALANCE_SCHEDULER_DRY_RUN: "true"
```

The scheduler runs every 60 seconds (configurable via `REBALANCE_SCHEDULER_INTERVAL_MS`),
monitors in-flight swaps, and initiates new Loop Outs for critical channels.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOOP_GRPC_HOST` | `lightning-terminal_web_1` | loopd gRPC hostname |
| `LOOP_GRPC_PORT` | `8443` | loopd gRPC port (litd unified) |
| `LOOP_TLS_CERT_PATH` | `/loop-data/.lit/tls.cert` | TLS certificate path |
| `LOOP_MACAROON_PATH` | `/loop-data/.loop/mainnet/loop.macaroon` | Loop macaroon path |
| `LOOP_MAX_SWAP_FEE_PCT` | `0.5` | Max swap fee as % of amount |
| `LOOP_MAX_MINER_FEE_SATS` | `20000` | Max miner fee per swap |
| `LOOP_MIN_REBALANCE_SATS` | `50000` | Minimum swap amount for auto mode |
| `LOOP_CONF_TARGET` | `6` | On-chain confirmation target (blocks) |

## Safety Guardrails

- Daily loss cap applies to Loop Out fees (same as all rebalance operations)
- Never swaps more than 50% of a channel's local balance
- Auto mode skips channels with in-flight swaps
- Fee thresholds reject swaps that are too expensive
- Graceful degradation: app works normally without Lightning Terminal
