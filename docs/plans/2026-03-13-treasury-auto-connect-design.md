# Treasury Auto-Connect via Cloudflare Worker

## Problem

Members installing the app see a "Hub Address (optional)" text field when they need to connect to the treasury. They don't know what address to enter. The treasury's Tor `.onion` address and pubkey are not provided automatically.

## Solution

Use the existing Cloudflare Worker as a rendezvous point. The treasury's connection info (pubkey + socket) is stored as Worker env vars. Members fetch it via a new endpoint and connect with one click.

## Architecture

```
Cloudflare Worker (env: TREASURY_PUBKEY, TREASURY_SOCKET)
        |
        |  GET /treasury-info
        v
  { pubkey: "02b759...", socket: "prao2y...onion:9735" }
        |
        |  proxied through member's API
        v
  GET /api/treasury-info  (member's API container)
        |
        v
  ConnectToHub component — one-click "Connect to Treasury" button
        |
        v
  POST /api/member/open-channel  { capacity_sats, partner_socket }
```

## Worker Changes

New `GET /treasury-info` endpoint. Reads from two new env vars set via `wrangler secret put`:

- `TREASURY_PUBKEY` = `02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca`
- `TREASURY_SOCKET` = `prao2yfb6zmdv4mtc7zumiikla3jah3irrzgs6bilhz2rsp3wgl64cad.onion:9735`

Returns `{ pubkey, socket }`. No KV caching needed — just env var reads.

## API Changes

New `GET /api/treasury-info` public proxy endpoint in `index.ts`. Fetches from Worker's `/treasury-info`. Same pattern as existing `/api/commodity-prices` proxy. Returns 503 if Worker unreachable or env vars not set.

## Frontend Changes

`ConnectToHub` component in `MemberDashboard.tsx`:

- On mount, fetches `GET /api/treasury-info` to get treasury socket
- When not peered and socket is available: shows **"Connect to Treasury"** button (no manual input)
- When not peered and socket unavailable (Worker down): falls back to manual text input
- When already peered (`is_peered_to_hub: true`): shows existing green "Already connected" banner
- Button click calls existing `POST /api/member/open-channel` with `partner_socket` pre-filled

New `api.getTreasuryInfo()` method in `client.ts`.

## Error Handling

- Worker down / secrets not set -> API returns 503 -> frontend falls back to manual socket input
- Tor peering fails -> `openMemberChannel` error -> shown in existing error alert
- Already peered -> skip peering, proceed to channel open

## Files to Modify

| File | Change |
|------|--------|
| `cloudflare-worker/src/index.ts` | Add `GET /treasury-info` handler, add env vars to `Env` interface |
| `app/api/src/index.ts` | Add `GET /api/treasury-info` proxy route |
| `app/web/src/api/client.ts` | Add `api.getTreasuryInfo()` method + type |
| `app/web/src/pages/MemberDashboard.tsx` | Rewrite un-peered UX to auto-fetch socket, one-click connect |
