# Coinbase Integration — Future Feature

**Status: NOT IMPLEMENTED — parked for future development**

This document captures the intended design for connecting a Coinbase account so operators can purchase bitcoin and fund their treasury node's on-chain wallet without leaving the app.

---

## Intended Flow

1. **Operator initiates connection** — clicks "Connect Coinbase" in the treasury UI settings.

2. **OAuth2 authorization** — the app redirects the operator to Coinbase's OAuth2 authorization endpoint. Scopes required:
   - `wallet:accounts:read` — list BTC accounts
   - `wallet:transactions:send` — send BTC to an external address
   - `wallet:buys:create` — initiate a purchase

3. **Token storage** — after the operator grants access, Coinbase redirects back with an authorization code. The API exchanges this for an access token + refresh token. Both are stored in `/data/secrets/coinbase_tokens.json` (never committed, never logged).

4. **On-chain funding flow**:
   a. App fetches the treasury node's on-chain deposit address via LND (`newAddress`).
   b. Operator selects an amount to buy/send.
   c. App places a market buy on Coinbase (if the operator's account balance is insufficient).
   d. App sends the purchased BTC to the node's deposit address.
   e. Transaction ID is stored and shown in the UI.

5. **Token refresh** — access tokens expire; the app must refresh using the stored refresh token before each API call.

---

## API Endpoints (to be designed)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/treasury/coinbase/status` | OAuth connection status |
| `GET` | `/api/treasury/coinbase/auth-url` | Returns OAuth2 redirect URL |
| `POST` | `/api/treasury/coinbase/callback` | Exchange auth code for tokens |
| `DELETE` | `/api/treasury/coinbase/disconnect` | Revoke tokens |
| `GET` | `/api/treasury/coinbase/accounts` | List BTC account balances |
| `POST` | `/api/treasury/coinbase/fund` | Buy + send to node wallet |

---

## Implementation Notes

- Use Coinbase Advanced Trade API (v3) — the legacy v2 API is deprecated.
- OAuth2 client credentials should be stored as env vars: `COINBASE_CLIENT_ID`, `COINBASE_CLIENT_SECRET`, `COINBASE_REDIRECT_URI`.
- The `/api/treasury/coinbase/*` endpoints must require treasury-role JWT auth.
- Never log access tokens or refresh tokens.
- All buy/send amounts must pass through the capital guardrail checks before execution.
- This feature touches both the API (`src/api/treasury-coinbase.ts`) and a new UI flow in the web app.

---

## Dependencies

- Coinbase Advanced Trade API docs: https://docs.cdp.coinbase.com/advanced-trade/docs/welcome
- OAuth2 flow: https://docs.cdp.coinbase.com/coinbase-app/docs/coinbase-app-integration

---

*Do not implement until the core treasury engine is production-stable and the operator onboarding UX is designed.*
