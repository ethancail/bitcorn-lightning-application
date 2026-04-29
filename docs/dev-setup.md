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
```

`.env.dev.member-a`:
```bash
LND_GRPC_HOST=127.0.0.1:10002
LND_DIR=/home/user/.polar/networks/1/volumes/lnd/farmer
BITCOIN_NETWORK=regtest
TREASURY_PUBKEY=<treasury-pubkey>
PORT=3102
```

`.env.dev.member-b`:
```bash
LND_GRPC_HOST=127.0.0.1:10003
LND_DIR=/home/user/.polar/networks/1/volumes/lnd/merchant
BITCOIN_NETWORK=regtest
TREASURY_PUBKEY=<treasury-pubkey>
PORT=3103
```

A few notes:

`TREASURY_PUBKEY` is the **same value across all three files** — it's the public identifier of the treasury node. The treasury instance recognizes itself because its local LND pubkey matches; the members detect themselves via the channel-to-treasury check.

The Polar gRPC ports (`10001`, `10002`, `10003`) are Polar's defaults for the first three LND nodes in a network. Confirm in each node's Connect tab.

The exact `LND_DIR` paths depend on your Polar install. Verify with `ls ~/.polar/networks/<id>/volumes/lnd/` after Polar has started the network — directories will be named after the LND nodes (treasury, farmer, merchant after renaming).

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
    "dev:webT":      "cd app/web && PORT=5173 npm run dev",
    "dev:webA":      "cd app/web && PORT=5174 npm run dev",
    "dev:webB":      "cd app/web && PORT=5175 npm run dev",
    "dev:all":       "concurrently -n T,A,B,wT,wA,wB \"npm:dev:treasury\" \"npm:dev:memberA\" \"npm:dev:memberB\" \"npm:dev:webT\" \"npm:dev:webA\" \"npm:dev:webB\""
  }
}
```

If the repo doesn't have a root `package.json` yet, create one with `npm init -y` first.

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

**Polar won't launch on Ubuntu 24.04 — "SUID sandbox" error.** Disable the AppArmor unprivileged user namespace restriction. See Prerequisites.

**Polar AppImage won't run — "AppImage requires FUSE".** `sudo apt install libfuse2t64` on Ubuntu 24.04.

**Port already in use.** Either `dev:all` is already running in another terminal, or another process has grabbed 3101–3103 / 5173–5175. `lsof -i :3101` shows what owns the port.

## Resetting state

**Soft reset (preserves channels and balances).** Stop the network in Polar, then start it again. Existing data persists across restarts.

**Hard reset (clean keys, fresh wallets, no channels).** Stop the network in Polar, click the network's three-dot menu and delete it, then create a new network with the same name. You'll need to re-deposit funds and reopen channels.

If you want to script a reset, the network state lives at `~/.polar/networks/<id>/` — Polar reconstructs from this on next start.

## When to use this vs the real test nodes

This local setup is for the bulk of day-to-day work — most code changes can be exercised here in seconds. Use the real test Umbrel nodes (treasury, farmer, merchant) when:

- Reproducing something that only manifests with real network conditions (mainnet/testnet peering, slow channel updates, etc.)
- Testing the actual Umbrel update flow before a release (the manifest version bump → Umbrel detects → user clicks update path)
- Validating cross-machine integration that local Polar can't simulate

The release path itself remains: tag a version, bump the production community app store manifest, farmers see the update.
