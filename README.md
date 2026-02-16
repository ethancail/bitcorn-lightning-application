# Bitcorn Lightning Application

Hub-and-spoke Lightning Service Provider (LSP) app for the Umbrel app store. The treasury node provides liquidity and routing to member nodes; members can send and receive payments via the treasury channel.

**Stack:** Node.js (API), React (web UI), SQLite, LND via [ln-service](https://github.com/alexbosworth/ln-service).

## Quick start

- **API:** `docker compose up -d --build` (see `docker-compose.yml`).
- **Config:** Set env vars (e.g. `TREASURY_PUBKEY`, `BITCOIN_NETWORK`, rate limits). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#configuration).

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](docs/ARCHITECTURE.md) | Components, sync, node roles, and main flows |
| [API reference](docs/API.md) | HTTP endpoints and access rules |
| [Database](docs/DATABASE.md) | Migrations and table overview |
| [Implementation notes](docs/IMPLEMENTATION.md) | What’s implemented and where to find it |

## License

See repository license.
