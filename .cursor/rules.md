# Bitcorn Lightning Application – Cursor Rules

You are assisting with development of the Bitcorn Lightning Umbrel Community Store app.

This is a PRODUCTION Lightning application.
You must follow the architectural, security, and Umbrel-specific constraints below.
If unsure, ASK before making changes.

---

## Core Principles

- This is an Umbrel Community Store app
- Code is public, software is proprietary
- Lightning backend is LND (default)
- Treasury node is the hub
- Member nodes are spokes only
- No member-to-member channels
- Routed-native Lightning only (no custodial shortcuts)

---

## Umbrel Constraints (DO NOT VIOLATE)

### Ports (STRICT)
- 3101 → User / Admin API (JWT, Umbrel-aware)
- 3109 → Node-to-Node API (HMAC only, NEVER proxied)
- 3200 → Web UI

Do NOT:
- Reuse ports 3001 or 3009
- Add new ports without explicit justification
- Expose 3109 via Umbrel app-proxy
- Bind services to host networking

---

### Networking
- All user access goes through Umbrel app-proxy
- Node-to-node traffic is explicit and authenticated
- No browser access to node APIs
- No member → member API calls

---

## Security Rules

### Secrets
- No secrets in GitHub
- No hardcoded keys
- Secrets are generated on first run
- Secrets are stored under `/data/secrets`
- Secrets persist across updates

### Auth
- User/Admin API uses JWT
- Node API uses HMAC + timestamp + nonce
- Node API rejects replayed or stale requests
- Treasury initiates all node-to-node calls

---

## Lightning Rules

### Payments
- Routed-native Lightning only
- Treasury must be the first hop
- Sender-side fee caps enforced
- All payments are auditable

### Liquidity
- Liquidity seeding is admin-initiated only
- Treasury pays invoices to move balance
- Liquidity ≠ routing ≠ BoS

### BoS
- BoS is NOT used for bootstrapping
- BoS only runs after real traffic exists
- BoS must be visible and controllable by admin

---

## Code Structure Rules

- `app/api` = backend only
- `app/web` = frontend only
- No frontend logic in API
- No Lightning logic in UI
- No shared mutable state between services

---

## Database Rules

- Fresh schema (no legacy assumptions)
- Migrations must be idempotent
- Migrations run automatically on startup
- Never mutate schema manually

---

## What You Must NOT Do

- Do not add privileged containers
- Do not mount docker.sock
- Do not assume host filesystem access
- Do not bypass Umbrel auth
- Do not invent new Lightning shortcuts
- Do not weaken auth for convenience

---

## When in Doubt

If a change:
- Touches networking
- Touches Lightning flows
- Touches auth
- Touches Umbrel manifests

STOP and ask for clarification before proceeding.
