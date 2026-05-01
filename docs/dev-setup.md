# Local Development Setup

A guide to setting up the Bitcorn Lightning app for local development against a regtest Lightning network using Polar. Following this end-to-end gets you a working three-instance stack — treasury, member-A, and member-B — running on your machine with hot reload and no involvement of farmers' real Umbrel nodes.

## Why this exists

Historically, testing changes required merging to `main` so Umbrel would detect a manifest version bump and prompt for an update on a real node. That conflated "code complete" with "released to users" and made the iteration loop measured in minutes per cycle. The setup below moves day-to-day testing onto your local machine, where each change-to-see-effect cycle is measured in seconds. Real Umbrel test nodes still get used for integration testing and release rehearsal, but they're no longer the first place you exercise new code.

## Prerequisites

Before starting, you should have:

- **Docker** installed and running. On Ubuntu 24.04, install via the official Ubuntu instructions (https://docs.docker.com/engine/install/ubuntu/) — do **not** follow the Debian instructions; the repos differ.
- **Polar** v4.0.0 or later (https://github.com/jamaljsr/polar/releases). On Ubuntu 24.04, the AppImage works but requires `libfuse2t64` (`sudo apt install libfuse2t64`) and disabling the AppArmor unprivileged user namespace restriction (`echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-namespace.conf && sudo sysctl --system`).
- **Node.js** matching the version the project uses (check the `.nvmrc` or `engines` field in `app/api/package.json`).
- Your user added to the `docker` group (`sudo usermod -aG docker $USER`, then log out / back in).

## Step 1: Set up the local Lightning network in Polar

Launch Polar and click **Create a Lightning Network**. Configure as follows:

| Field | Value |
|---|---|
| Network Name | `bitcorn-dev` |
| LND Nodes | `3` |
| Core Lightning Nodes | `0` |
| Eclair Nodes | `0` |
| Bitcoin Core Nodes | `1` |
| Taproot Assets | `0` |
| Terminal | `0` |

Submit. You'll land on the network view with three LND nodes (`alice`, `bob`, `carol`) wired up to one Bitcoin Core node, all in `Stopped` state.

**Rename the nodes** to match your role naming. Click each LND node, then click the pencil icon next to its name in the right-hand panel:
- `alice` → `treasury`
- `bob` → `farmer`
- `carol` → `merchant`

(The "farmer" vs "merchant" distinction here is for your benefit when configuring channels — at the app config level, both are just "member" instances. The distinction in the running app comes from per-channel settings users configure in the UI.)

**Click the orange Start button** at the top right. The first start pulls Docker images for `polarlightning/bitcoind` and `polarlightning/lnd`, which can take a few minutes. Wait until all four nodes show green status indicators.

**Fund each LND wallet.** Click each LND node → Actions tab → Deposit. Deposit `100000000` sats (1 BTC) per node.

**Open channels** matching your prod topology. Drag from one node onto another in the diagram and a channel-creation dialog appears. Set capacity to `1000000` sats per channel. Recommended topology (hub-and-spoke):
- treasury ↔ farmer
- treasury ↔ merchant

After opening channels, click the Bitcoin Core node → Actions tab → **Mine 6 Blocks** to confirm the channel openings.

**Capture the treasury pubkey.** Click the `treasury` LND node → Connect tab → copy the **Pubkey** field. Save this — you'll set it as `TREASURY_PUBKEY` in every .env file in Step 3.

## Step 2: Required code changes

Two small changes to `app/api` unlock local dev. Both should land on `main` rather than living as a local-only patch.

### 2a. Make `LND_DIR` env-configurable

In `app/api/src/lightning/lnd.ts` (around line 28):

```ts
// Before
const LND_DIR = "/lnd";

// After
const LND_DIR = process.env.LND_DIR ?? "/lnd";
```

The default value is unchanged, so production behavior on Umbrel (where the volume mount provides `/lnd`) is unaffected. Local instances can now point at any LND data directory by setting the env var.

### 2b. Add a `dev` script to `app/api`

In `app/api/package.json`, add to `scripts`:

```json
"dev": "tsx watch src/index.ts"
```

And add `tsx` to `devDependencies` (`npm install --save-dev tsx` from `app/api/`). `tsx` provides instant restart on file changes without the rebuild-then-run friction of the production build path.

## Step 3: Configure environment files

Create three `.env.dev.*` files at the repo root. Replace `<treasury-pubkey>` with the value you captured from Polar in Step 1, and adjust the `LND_DIR` paths to match your actual Polar network ID (find it with `ls ~/.polar/networks/`).

`.env.dev.treasury`:
```bash
LND_GRPC_HOST=127.0.0.1:10001
LND_DIR=/home/user/.polar/networks/1/volumes/lnd/treasury
BITCOIN_NETWORK=regtest
TREASURY_PUBKEY=<treasury-pubkey>
PORT=3101
DB_DIR=/home/user/.bitcorn-dev/treasury/db
SECRETS_DIR=/home/user/.bitcorn-dev/treasury/secrets
```

`.env.dev.member-a`:
```bash
LND_GRPC_HOST=127.0.0.1:10002
LND_DIR=/home/user/.polar/networks/1/volumes/lnd/farmer
BITCOIN_NETWORK=regtest
TREASURY_PUBKEY=<treasury-pubkey>
PORT=3102
DB_DIR=/home/user/.bitcorn-dev/member-a/db
SECRETS_DIR=/home/user/.bitcorn-dev/member-a/secrets
```

`.env.dev.member-b`:
```bash
LND_GRPC_HOST=127.0.0.1:10003
LND_DIR=/home/user/.polar/networks/1/volumes/lnd/merchant
BITCOIN_NETWORK=regtest
TREASURY_PUBKEY=<treasury-pubkey>
PORT=3103
DB_DIR=/home/user/.bitcorn-dev/member-b/db
SECRETS_DIR=/home/user/.bitcorn-dev/member-b/secrets
```

A few notes:

`TREASURY_PUBKEY` is the **same value across all three files** — it's the public identifier of the treasury node. The treasury instance recognizes itself because its local LND pubkey matches; the members detect themselves via the channel-to-treasury check.

The Polar gRPC ports (`10001`, `10002`, `10003`) are Polar's defaults for the first three LND nodes in a network. Confirm in each node's Connect tab.

The exact `LND_DIR` paths depend on your Polar install. Verify with `ls ~/.polar/networks/<id>/volumes/lnd/` after Polar has started the network — directories will be named after the LND nodes (treasury, farmer, merchant after renaming).

`DB_DIR` is the per-instance SQLite directory. Production on Umbrel uses `/data/db` (provided by a volume mount); locally you need a writable path. Use a per-role subdirectory so the three instances don't collide on shared state — the example above uses `~/.bitcorn-dev/<role>/db`. The directory is auto-created on startup (mode 0o700), so you don't need to `mkdir` it yourself.

`SECRETS_DIR` is the per-instance directory for the master encryption key (used to encrypt the autobuy CDP credentials and to sign JWTs). Production on Umbrel uses `/data/secrets` via volume mount; locally use a per-role writable path so the three instances each get their own master key. The directory is created lazily on first encrypt/decrypt call (mode 0o700 dir, 0o600 file). If you only exercise routes that don't touch autobuy credentials, the secrets file may never get created — that's fine.

`.env.dev.*` files contain only test data and pubkeys, but they belong in `.gitignore` anyway — both for hygiene and because the per-machine paths won't generalize.

## Step 4: Add root-level dev orchestration

At the repo root:

```bash
npm install --save-dev concurrently dotenv-cli
```

In the root `package.json`, add:

```json
{
  "scripts": {
    "dev:treasury":  "cd app/api && dotenv -e ../../.env.dev.treasury -- npm run dev",
    "dev:memberA":   "cd app/api && dotenv -e ../../.env.dev.member-a  -- npm run dev",
    "dev:memberB":   "cd app/api && dotenv -e ../../.env.dev.member-b  -- npm run dev",
    "dev:webT":      "cd app/web && VITE_API_BASE=http://localhost:3101 npm run dev -- --port 5173 --strictPort",
    "dev:webA":      "cd app/web && VITE_API_BASE=http://localhost:3102 npm run dev -- --port 5174 --strictPort",
    "dev:webB":      "cd app/web && VITE_API_BASE=http://localhost:3103 npm run dev -- --port 5175 --strictPort",
    "dev:all":       "concurrently -n T,A,B,wT,wA,wB \"npm:dev:treasury\" \"npm:dev:memberA\" \"npm:dev:memberB\" \"npm:dev:webT\" \"npm:dev:webA\" \"npm:dev:webB\""
  }
}
```

If the repo doesn't have a root `package.json` yet, create one with `npm init -y` first.

A note on `VITE_API_BASE`: each web instance is pinned to a specific API port via this env var. Without it, all three web tabs would default to `localhost:3101` (treasury API) regardless of which Vite instance they came from, because `app/web/src/config/api.ts` falls back to port 3101 when no override is provided. Setting `VITE_API_BASE` per role tells Vite to expose `import.meta.env.VITE_API_BASE` to the client bundle, which `api.ts` reads as the second-priority resolution branch.

## Step 5: Run and validate

From the repo root:

```bash
npm run dev:all
```

This brings up six processes: three API instances on ports 3101/3102/3103, and three web instances on ports 5173/5174/5175. Output is interleaved with role prefixes (T, A, B, wT, etc.).

Open three browser tabs:

- `http://localhost:5173` — treasury perspective
- `http://localhost:5174` — member-A (farmer) perspective
- `http://localhost:5175` — member-B (merchant) perspective

The treasury tab should show treasury-only features; the member tabs should show the member view. If either tab shows the "external/degraded" view, see the troubleshooting section.

To stop everything: `Ctrl+C` in the terminal running `dev:all`.

## Troubleshooting

**"External/degraded" view in a member tab.** The member instance can't see a channel to `TREASURY_PUBKEY`. Check that (a) the pubkey in `.env.dev.member-*` matches the actual treasury Polar node pubkey exactly, (b) channels are open between treasury and that member node in Polar, and (c) you've mined 6 blocks since opening the channel so it's confirmed.

**Channels stuck in "Pending" forever.** Polar's regtest doesn't auto-mine. Click the Bitcoin Core node → Actions → Mine 6 Blocks.

**API can't read the macaroon — "ENOENT: no such file"**. The `LND_DIR` path in your .env file is wrong. Run `ls ~/.polar/networks/<id>/volumes/lnd/<node>/` and confirm `tls.cert` and `data/chain/bitcoin/regtest/admin.macaroon` exist. Make sure `BITCOIN_NETWORK=regtest` in the env file (otherwise the macaroon path looks for the wrong subdirectory).

**EACCES on database init** — e.g. `Error: EACCES: permission denied, mkdir '/data/db'`. The API is falling back to the production `/data/db` path because `DB_DIR` isn't set in the env file (or wasn't loaded). Set `DB_DIR` in `.env.dev.<role>` to a writable path on your machine — e.g. `/home/<you>/.bitcorn-dev/<role>/db` — and re-run `npm run dev:all`. The directory will be auto-created with mode 0o700 on startup.

**EACCES on master key init** — e.g. `Error: EACCES: permission denied, mkdir '/data/secrets'` triggered the first time you exercise an autobuy credential flow. Same shape as the DB_DIR case: `SECRETS_DIR` isn't set, so the API is falling back to the production `/data/secrets` path. Set `SECRETS_DIR` in `.env.dev.<role>` to a per-role writable path (e.g. `/home/<you>/.bitcorn-dev/<role>/secrets`) and restart the affected instance. The directory will be created lazily on the next encrypt/decrypt call.

**Polar won't launch on Ubuntu 24.04 — "SUID sandbox" error.** Disable the AppArmor unprivileged user namespace restriction. See Prerequisites.

**Polar AppImage won't run — "AppImage requires FUSE".** `sudo apt install libfuse2t64` on Ubuntu 24.04.

**Port already in use.** Either `dev:all` is already running in another terminal, or another process has grabbed 3101–3103 / 5173–5175. The most common cause is orphan API processes from a prior `dev:all` that didn't shut down cleanly when you `Ctrl+C`'d the parent — `concurrently → npm → tsx → node` is enough indirection that SIGINT sometimes doesn't reach the leaf `node` processes. Run `npm run dev:kill` to force-clear all six dev ports, then re-run `dev:all`. `lsof -i :3101` shows what specifically owns a single port if you want to investigate before killing.

## Resetting state

**Soft reset (preserves channels and balances).** Stop the network in Polar, then start it again. Existing data persists across restarts.

**Hard reset (clean keys, fresh wallets, no channels).** Stop the network in Polar, click the network's three-dot menu and delete it, then create a new network with the same name. You'll need to re-deposit funds and reopen channels.

If you want to script a reset, the network state lives at `~/.polar/networks/<id>/` — Polar reconstructs from this on next start.

## Optional: Loop Fidelity Layer

Skip this entire section unless your work touches the Loop subsystem (`src/swaps/`, the rebalance cost ledger, the autobuy Loop Out path, the Member Liquidity Advisor's Loop In/Out recommendation flow). The base setup above is sufficient for everything else — UI work, channel management, contacts, payments, dashboard polish, valuation entry, the calendar, etc. all exercise their main code paths without ever calling `loopd`.

When you do need real swap fidelity in regtest, this layer adds:

- **A fourth LND node in Polar** (`External-Peer-1`) — the routing peer + `loopserver` anchor. Mirrors the role ACINQ plays in production.
- **A `loopserver` process** running outside Polar's container management, anchored to External-Peer-1's LND. Speaks the same gRPC interface that Lightning Labs' production Loop servers expose.
- **Per-role `loopd` processes** (one each for treasury, member-A, member-B). Polar's pure-LND nodes don't have litd embedded, so loopd has to run as a separate host process per role — see `bitcorn-research/specs/2026-04-29-local-loop-fidelity-via-loopserver.md` §3 for the design rationale.

After this layer is up, Member Liquidity Advisor recommendations on Farmer1 and Merchant1 trigger actual end-to-end Loop swaps against the local `loopserver`. Channel state transitions, the rebalance cost ledger, and every line of `src/swaps/` exercise their real code paths.

> **⚠ DRAFT STATUS:** Spec §3 assumed `loopserver` was buildable from the `lightninglabs/loop` repo at `./cmd/loopserver`. **It isn't** — that path doesn't exist in any release of the repo (verified across v0.5.1-beta through v0.33.0-beta). Lightning Labs publishes `loopserver` only as a Docker image at `lightninglabs/loopserver:latest`, documented in the loop repo's own `regtest/README.md`. The walkthrough below uses Docker for `loopserver` and a native Go binary (built from the same repo's `cmd/loopd`) for the per-role `loopd` clients. The npm scripts have been filled in with verified `loopd v0.33.0-beta` flags. The §6 smoke tests still need to run end-to-end before this PR is ready for review.

### Step A: Add External-Peer-1 to Polar

In the Polar UI:

1. Stop the `bitcorn-dev` network (orange Stop button).
2. Click the **+** in the network sidebar to add a new node. Choose **LND** (NOT Terminal/litd — Polar's pure LND nodes are what we use; matches the production role's image).
3. Name it `External-Peer-1`.
4. Restart the network. Wait for green status on all five nodes (the existing four plus the new one).
5. Click `External-Peer-1` → Connect tab. Capture:
   - **Pubkey** (66-char hex) → goes into `EXTERNAL_PEER_PUBKEY`
   - **gRPC** port (e.g. `127.0.0.1:10007`) → goes into `EXTERNAL_PEER_LND_GRPC`

Polar appends a numeric suffix and creates the LND data directory at `~/.polar/networks/<id>/volumes/lnd/External-Peer-1/` — that path goes into `EXTERNAL_PEER_LND_DIR`.

### Step B: Open and fund the Treasury↔External-Peer-1 channel

In the Polar UI:

1. Drag from the Treasury node onto External-Peer-1 to create a channel. Set capacity to **5,000,000 sats**, with most of the balance pushed to External-Peer-1's side (so `loopserver` has off-chain liquidity to fulfill Loop Out swaps).
2. Click the Bitcoin Core node → Actions → **Mine 6 Blocks**.
3. Click External-Peer-1 → Actions → **Deposit**. Deposit **500,000,000 sats (5 BTC)** so `loopserver` has on-chain liquidity for Loop In settlements.

Treasury and External-Peer-1 now form the regtest stand-in for the production Treasury↔ACINQ channel.

### Step C: Tag External-Peer-1 in contacts

On the Treasury web tab (`http://localhost:5173`):

1. Open the Contacts page.
2. Add (or edit) a contact for External-Peer-1's pubkey.
3. Set the tag to **`external-peer`** (or `external` — both work as of this PR; the lane-purpose alias was added so the doc's vocabulary matches the runtime classifier).

Refresh the Channels page. The Treasury↔External-Peer-1 channel should now surface under the **External Peers** section, not Unclassified.

### Step D: Pull `loopserver` (Docker) and build `loopd` (native)

Two binaries with different distribution methods:

- **`loopserver`** is published as a Docker image only — `lightninglabs/loopserver:latest`. There is no Go source for it in the public `lightninglabs/loop` repo. Documented in the loop repo's `regtest/README.md`.
- **`loopd`** is the swap client; we build it from source against a pinned tag of `lightninglabs/loop`.

```bash
# Pull the loopserver Docker image — pinned to v0.9.221-beta (Nov 2024).
# `latest` (v0.11.33-beta as of writing) and any v0.10+ tag have a buggy
# Postgres migration in the static-address feature path that fails at
# startup with "migration requires timezone to be UTC, got: UTC". The
# error is self-contradictory (the runtime timezone IS 'UTC' but the
# comparison fails) and has been present since the static-address
# tables were introduced in late 2024. v0.9.221-beta predates the
# feature, doesn't have those tables, so the broken migration can't
# run. Loop In and Loop Out work fine on this version (the only thing
# missing is the static-address Loop In variant, which we don't use).
docker pull lightninglabs/loopserver:v0.9.221-beta

# Build loopd from source (pinned tag — master is volatile)
LOOP_TAG=v0.33.0-beta
git clone --depth 1 --branch ${LOOP_TAG} https://github.com/lightninglabs/loop ~/.bitcorn-dev/loop-src
cd ~/.bitcorn-dev/loop-src
go build -o ~/.bitcorn-dev/loopserver/loopd ./cmd/loopd
```

Verify: `~/.bitcorn-dev/loopserver/loopd --version` should print `loopd version 0.33.0-beta`. `docker image inspect lightninglabs/loopserver:latest --format '{{.Id}}'` should print a sha256.

You also need to be in the `docker` group to run the loopserver container — `sudo usermod -aG docker $USER && newgrp docker` (one-time, then either `newgrp docker` in your current shell or log out / log back in).

### Step E: Configure `.env.dev.*` with the Loop layer vars

Add the new env vars to each of the three `.env.dev.*` files. Per-role values:

```bash
# In .env.dev.treasury / .env.dev.member-a / .env.dev.member-b — same in all three:
LOOPSERVER_HOST=localhost:11009
EXTERNAL_PEER_PUBKEY=<from-Step-A>
EXTERNAL_PEER_LND_GRPC=127.0.0.1:<port-from-Step-A>
EXTERNAL_PEER_LND_DIR=/home/<you>/.polar/networks/<id>/volumes/lnd/External-Peer-1

# Per-role (different value in each .env.dev.*):
LOOPD_DIR_TREASURY=/home/<you>/.bitcorn-dev/treasury/loopd
LOOPD_DIR_MEMBER_A=/home/<you>/.bitcorn-dev/member-a/loopd
LOOPD_DIR_MEMBER_B=/home/<you>/.bitcorn-dev/member-b/loopd

LOOPD_RPC_TREASURY=11010
LOOPD_RPC_MEMBER_A=11020
LOOPD_RPC_MEMBER_B=11030
```

Create the three loopd data directories: `mkdir -p ~/.bitcorn-dev/{treasury,member-a,member-b}/loopd`.

You also need to wire each role's API process to its corresponding loopd. Add these to each `.env.dev.*` file with role-specific values:

`.env.dev.treasury`:
```bash
LOOP_GRPC_HOST=127.0.0.1
LOOP_GRPC_PORT=11010
LOOP_TLS_CERT_PATH=/home/<you>/.bitcorn-dev/treasury/loopd/tls.cert
LOOP_MACAROON_PATH=/home/<you>/.bitcorn-dev/treasury/loopd/regtest/loop.macaroon
```

`.env.dev.member-a`:
```bash
LOOP_GRPC_HOST=127.0.0.1
LOOP_GRPC_PORT=11020
LOOP_TLS_CERT_PATH=/home/<you>/.bitcorn-dev/member-a/loopd/tls.cert
LOOP_MACAROON_PATH=/home/<you>/.bitcorn-dev/member-a/loopd/regtest/loop.macaroon
```

`.env.dev.member-b`:
```bash
LOOP_GRPC_HOST=127.0.0.1
LOOP_GRPC_PORT=11030
LOOP_TLS_CERT_PATH=/home/<you>/.bitcorn-dev/member-b/loopd/tls.cert
LOOP_MACAROON_PATH=/home/<you>/.bitcorn-dev/member-b/loopd/regtest/loop.macaroon
```

These tell the API where to find its loopd over gRPC. Without them, the API falls back to the production-Umbrel defaults (`bitcorn-lightning-node_loopd_1:8443`) which don't exist locally — Loop UI surfaces will report "loop unavailable" and the §6 smoke tests will fail before reaching the swap server.

### Step F: Start the Loop layer

In a separate terminal from the one running `npm run dev:all`:

```bash
# Start loopserver (Docker container, anchored to External-Peer-1)
npm run dev:loopserver

# Wait ~3s for it to log "listening on" — `docker logs bitcorn-loopserver`

# Start the three per-role loopd clients (in three more terminals or as background jobs)
npm run dev:loopd-T &
npm run dev:loopd-A &
npm run dev:loopd-B &
```

What the scripts run:

- **`dev:loopserver`** runs the official `lightninglabs/loopserver:latest` Docker image with `--network host` so the container can reach Polar's LND + bitcoind on `127.0.0.1`. Flags wired in:
  - `--lnd.host=127.0.0.1:10007 --lnd.macaroondir=/lnd/data/chain/bitcoin/regtest --lnd.tlspath=/lnd/tls.cert` — anchor to External-Peer-1's LND (read-only volume mounted at `/lnd`, NOT `/root/.lnd` — the loopserver image runs as `uid=100(loopserver)` which can't traverse the container's `/root/` directory; mounting at `/lnd` puts the data under a world-traversable path)
  - `--bitcoin.host=127.0.0.1:18444 --bitcoin.user=polaruser --bitcoin.password=polarpass` — Polar's bitcoind RPC (default Polar credentials)
  - `--bitcoin.zmqpubrawblock=tcp://127.0.0.1:28335 --bitcoin.zmqpubrawtx=tcp://127.0.0.1:29336` — Polar's bitcoind ZMQ ports for raw block/tx notifications. **Required** — loopserver crashes at startup with `invalid config: zmqpubrawblock must be set` if these aren't passed.
  - `--maxamt=5000000` — caps any single swap at 5M sats (matches the channel capacity)
  - `docker rm -f bitcorn-loopserver` runs first to wipe any prior container by name. The container is NOT auto-removed on crash (no `--rm`), so `docker logs bitcorn-loopserver` is available for post-mortem if it dies.
- **`dev:loopd-{T,A,B}`** runs `loopd --network=regtest --loopdir=<per-role dir> --rpclisten=localhost:<role port> --lnd.host=127.0.0.1:<that role's LND gRPC> --lnd.macaroonpath=<...> --lnd.tlspath=<...> --server.host=localhost:11009 --server.notls`. The `--server.notls` flag is required because the regtest loopserver doesn't run TLS.

Verify reachability:

```bash
nc -z localhost 11009 && echo "loopserver OK"
nc -z localhost 11010 && echo "loopd-T OK"
nc -z localhost 11020 && echo "loopd-A OK"
nc -z localhost 11030 && echo "loopd-B OK"
docker logs bitcorn-loopserver --tail 20    # should show 'listening on ...'
```

To stop just the loopserver container without killing other things: `npm run dev:loopserver-stop`.

Stopping the whole Loop layer: `npm run dev:kill` (now also kills 11009/11010/11020/11030) plus `npm run dev:loopserver-stop` for the Docker container.

> **⚠ Channel-direction caveat for Loop In:** The current Treasury↔External-Peer-1 channel was opened by Treasury with all funds on Treasury's side (cap=10M, External-Peer-1 local=0). Loop Out from Farmer1 (the §6 first smoke test) works fine because Treasury → External-Peer-1 has full forward capacity. **Loop In from Merchant1 will fail until External-Peer-1 has some outbound capacity.** Two options: (a) run the Loop Out smoke test first, which moves sats to External-Peer-1's side via the off-chain HTLC, then attempt Loop In; (b) open a second channel from External-Peer-1 → Treasury funded from External-Peer-1's 5 BTC on-chain so the asymmetric provisioning the spec called for is in place. Option (a) matches the spec's §6 ordering and is simpler if you only need to validate end-to-end once.

### Step G: Smoke tests

Per spec §6. Two scenarios — both should complete cleanly without manual intervention beyond the trigger:

**Loop Out from Farmer1.** Pre-state: Farmer1's channel to Treasury has > 2,000,000 sats on Farmer1's side. Trigger from `localhost:5174` → Liquidity → Loop Out. Should route Farmer1 → Treasury → External-Peer-1, settle on-chain, and update Farmer1's UI + the rebalance cost ledger.

**Loop In from Merchant1.** Pre-state: Merchant1's channel to Treasury has < 500,000 sats on Merchant1's side, plus 1,000,000+ sats on-chain. Trigger from `localhost:5175` → Liquidity → Loop In. Should pay on-chain to `loopserver`'s swap address, refill Merchant1's outbound capacity, and update the cost ledger.

If either fails, the failure mode (which step, what error) is the input for a debug session before declaring the layer ready.

### Resetting / cleanup

`npm run dev:kill` clears all dev-stack ports, including the Loop layer's (11009, 11010, 11020, 11030). If you also want to wipe loopd state: `rm -rf ~/.bitcorn-dev/{treasury,member-a,member-b}/loopd && mkdir -p ...` (rerun the per-role mkdir from Step E).

To remove External-Peer-1: stop the network in Polar, delete the node, restart. The Treasury↔External-Peer-1 channel is lost; you'll need to redo Step B.

## When to use this vs the real test nodes

This local setup is for the bulk of day-to-day work — most code changes can be exercised here in seconds. Use the real test Umbrel nodes (treasury, farmer, merchant) when:

- Reproducing something that only manifests with real network conditions (mainnet/testnet peering, slow channel updates, etc.)
- Testing the actual Umbrel update flow before a release (the manifest version bump → Umbrel detects → user clicks update path)
- Validating cross-machine integration that local Polar can't simulate

The release path itself remains: tag a version, bump the production community app store manifest, farmers see the update.
