# Local Development Setup

A guide to setting up the Bitcorn Lightning app for local development against a regtest Lightning network using Polar. Following this end-to-end gets you a working three-instance stack — treasury, member-A, and member-B — running on your machine with hot reload and no involvement of farmers' real Umbrel nodes. The optional [Loop Fidelity Layer](#optional-loop-fidelity-layer) adds a fourth Polar node, External-Peer-1, which is a routing peer, not an app instance.

## Why this exists

Historically, testing changes required merging to `main` so Umbrel would detect a manifest version bump and prompt for an update on a real node. That conflated "code complete" with "released to users" and made the iteration loop measured in minutes per cycle. The setup below moves day-to-day testing onto your local machine, where each change-to-see-effect cycle is measured in seconds. Real Umbrel test nodes still get used for integration testing and release rehearsal, but they're no longer the first place you exercise new code.

## Prerequisites

Before starting, you should have:

- **Docker** installed and running. On Ubuntu 24.04, install via the official Ubuntu instructions (https://docs.docker.com/engine/install/ubuntu/) — do **not** follow the Debian instructions; the repos differ.
- **Polar** v4.0.0 or later (https://github.com/jamaljsr/polar/releases). On Ubuntu 24.04, the AppImage works but requires `libfuse2t64` (`sudo apt install libfuse2t64`) and one of two sandbox fixes: either disable the AppArmor unprivileged user namespace restriction machine-wide (`echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-namespace.conf && sudo sysctl --system`), or launch Polar with `--no-sandbox` (`<the AppImage> --no-sandbox`), which changes nothing system-wide. The OptiPlex runs Polar with `--no-sandbox`; ubuntu-pc has the AppArmor setting (`/etc/sysctl.d/60-apparmor-namespace.conf`, read 2026-11-12).
- **Node.js** matching the version the project uses (check the `.nvmrc` or `engines` field in `app/api/package.json`).
- Your user added to the `docker` group (`sudo usermod -aG docker $USER`, then log out / back in).

### Harness hosts

The harness hosts today are **ubuntu-pc** and **the OptiPlex**; more are planned. Where this page reports something observed on one of them, it names the machine.

**The OptiPlex** has its own specifics — reaching it, its users, its lock use and its gotchas — in the vault: `bitcorn-research/runbooks/2026-11-11-optiplex-harness-host.md`. Read it before working there. One of them: the OptiPlex sets Docker's `default-network-opts` so that Polar's ports bind `127.0.0.1` (the runbook, §6.9).

**ubuntu-pc** does not: it has no `/etc/docker/daemon.json` (read 2026-11-12). There, Docker-published ports, Polar's included, bypass ufw. That is an open item in the vault's `BACKLOG.md`.

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
- `alice` → `Treasury`
- `bob` → `Farmer1`
- `carol` → `Merchant1`

These are the names the dev machine's `bitcorn-dev` network uses, and the rest of this doc assumes them — Polar names each node's data directory and container after it.

(The "farmer" vs "merchant" distinction here is for your benefit when configuring channels — at the app config level, both are just "member" instances. The distinction in the running app comes from per-channel settings users configure in the UI.)

**Click the orange Start button** at the top right. The first start pulls Docker images for `polarlightning/bitcoind` and `polarlightning/lnd`, which can take a few minutes. Wait until all four nodes show green status indicators.

**Fund each LND wallet.** Click each LND node → Actions tab → Deposit. Deposit `100000000` sats (1 BTC) per node.

**Open channels** matching your prod topology. Drag from one node onto another in the diagram and a channel-creation dialog appears. Set capacity to `10000000` sats per channel. Recommended topology (hub-and-spoke):
- Treasury ↔ Farmer1
- Treasury ↔ Merchant1

After opening channels, click the Bitcoin Core node → Actions tab → **Mine 6 Blocks** to confirm the channel openings.

**Capture the treasury pubkey.** Click the `Treasury` LND node → Connect tab → copy the **Pubkey** field. Save this — you'll set it as `TREASURY_PUBKEY` in every .env file in Step 3.

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
LND_GRPC_HOST=127.0.0.1:10005
LND_DIR=/home/user/.polar/networks/1/volumes/lnd/Treasury
BITCOIN_NETWORK=regtest
TREASURY_PUBKEY=<treasury-pubkey>
PORT=3101
DB_DIR=/home/user/.bitcorn-dev/treasury/db
SECRETS_DIR=/home/user/.bitcorn-dev/treasury/secrets
```

`.env.dev.member-a`:
```bash
LND_GRPC_HOST=127.0.0.1:10004
LND_DIR=/home/user/.polar/networks/1/volumes/lnd/Farmer1
BITCOIN_NETWORK=regtest
TREASURY_PUBKEY=<treasury-pubkey>
PORT=3102
DB_DIR=/home/user/.bitcorn-dev/member-a/db
SECRETS_DIR=/home/user/.bitcorn-dev/member-a/secrets
```

`.env.dev.member-b`:
```bash
LND_GRPC_HOST=127.0.0.1:10006
LND_DIR=/home/user/.polar/networks/1/volumes/lnd/Merchant1
BITCOIN_NETWORK=regtest
TREASURY_PUBKEY=<treasury-pubkey>
PORT=3103
DB_DIR=/home/user/.bitcorn-dev/member-b/db
SECRETS_DIR=/home/user/.bitcorn-dev/member-b/secrets
```

A few notes:

`TREASURY_PUBKEY` is the **same value across all three files** — it's the public identifier of the treasury node. The treasury instance recognizes itself because its local LND pubkey matches; the members detect themselves via the channel-to-treasury check.

The Polar gRPC ports are assigned per node by Polar — don't assume `10001`–`10003`. On the dev machine's `bitcorn-dev` network (id 1) the host gRPC ports are Farmer1 `10004`, Treasury `10005`, Merchant1 `10006` (External-Peer-1 `10007`), which is what the examples above use. Confirm in each node's Connect tab, or in the `ports:` mappings (`<host port>:10009`) of `~/.polar/networks/<id>/docker-compose.yml`.

The exact `LND_DIR` paths depend on your Polar install. Verify with `ls ~/.polar/networks/<id>/volumes/lnd/` after Polar has started the network — directories will be named after the LND nodes (`Treasury`, `Farmer1`, `Merchant1` after renaming; the names are case-sensitive).

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
    "dev:treasury":  "node scripts/harness-slot.mjs run dev:treasury",
    "dev:memberA":   "node scripts/harness-slot.mjs run dev:memberA",
    "dev:memberB":   "node scripts/harness-slot.mjs run dev:memberB",
    "dev:webT":      "node scripts/harness-slot.mjs run dev:webT",
    "dev:webA":      "node scripts/harness-slot.mjs run dev:webA",
    "dev:webB":      "node scripts/harness-slot.mjs run dev:webB",
    "dev:all":       "concurrently -n T,A,B,wT,wA,wB \"npm:dev:treasury\" \"npm:dev:memberA\" \"npm:dev:memberB\" \"npm:dev:webT\" \"npm:dev:webA\" \"npm:dev:webB\""
  }
}
```

`scripts/harness-slot.mjs` builds each command line for the harness slot (see [Slots](#slots-a-second-harness-on-the-same-host)); slot 1, the default, is the setup this page describes. To see what a script runs: `node scripts/harness-slot.mjs command dev:webT` prints `cd app/web && VITE_API_BASE=http://localhost:3101 npm run dev -- --port 5173 --strictPort`.

If the repo doesn't have a root `package.json` yet, create one with `npm init -y` first.

A note on `VITE_API_BASE`: each web instance is pinned to a specific API port via this env var. Without it, all three web tabs would default to `localhost:3101` (treasury API) regardless of which Vite instance they came from, because `app/web/src/config/api.ts` falls back to port 3101 when no override is provided. Setting `VITE_API_BASE` per role tells Vite to expose `import.meta.env.VITE_API_BASE` to the client bundle, which `api.ts` reads as the second-priority resolution branch.

## Step 5: Run and validate

**After a fresh `app/web` `npm ci`, warm Vite's cache once before the first `dev:all`.** In `app/web`:

```bash
npx --no-install vite optimize --force
```

`--no-install` runs the vite already installed and fetches nothing. Measured on the OptiPlex (7.6 GiB RAM) with `dev:all` running: on a cold cache the three Vite servers pre-bundled their dependencies at once and available memory (`free -h`'s available column) fell to 1.4–1.7 GiB; with the cache warmed this way it stayed at 4.6–4.7 GiB.

From the repo root, with the go to use the harness, take slot 1's lock first (see [The harness lock](#the-harness-lock)); every script that starts, stops or kills refuses without it:

```bash
node scripts/harness-slot.mjs lock acquire --slot 1 --holder <arc> --go "<who gave the go, where, when>"
export HARNESS_HOLDER=<arc>
npm run dev:all
```

This brings up six processes: three API instances on ports 3101/3102/3103, and three web instances on ports 5173/5174/5175. Output is interleaved with role prefixes (T, A, B, wT, etc.).

**The APIs listen on `127.0.0.1` only**, not on every interface: the scripts inject `API_LISTEN_HOST=127.0.0.1` into every slot's API, slot 1 included, so a dev API cannot be reached from another machine. The API reads `API_LISTEN_HOST` in `app/api/src/config/ports.ts`: unset (as in production) it keeps its default bind; set, it must be an IP address, and an empty or non-IP value (`localhost`, say) stops it at boot. Do not set it in the `.env.dev.*` files; the injection is its one setting.

Open three browser tabs:

- `http://localhost:5173` — treasury perspective
- `http://localhost:5174` — member-A (farmer) perspective
- `http://localhost:5175` — member-B (merchant) perspective

The treasury tab should show treasury-only features; the member tabs should show the member view. If either tab shows the "external/degraded" view, see the troubleshooting section.

To stop everything: `Ctrl+C` in the terminal running `dev:all`. Then release the lock and paste its report (below).

## The harness lock

The dev harness on a host is shared by every arc that gates on it, so the rule is Ethan's: **one user per slot, a go before use, release reported.** `scripts/harness-slot.mjs` enforces it with a lock per slot and one host-wide lock for Polar setup windows, both in `~/.bitcorn-dev/locks/`.

**The procedure.**

1. **Get the go**: the orchestrator's, or Ethan's when the orchestrator is not in the loop.
2. **Acquire the slot's lock**, recording who gave the go:
   ```bash
   node scripts/harness-slot.mjs lock acquire --slot 1 --holder <arc> --go "<who gave the go, where, when>"
   ```
   It writes `~/.bitcorn-dev/locks/slot-1.lock` with an exclusive create, holding `holder`, `go`, `acquired_at` (UTC), `host` and `slot`. A second acquire is refused and names the holder. The go is a claim: the lock records what was typed and cannot check it.
3. **Set `HARNESS_HOLDER=<arc>`** in every terminal that runs a `dev:*` script or the pre-flight (`export HARNESS_HOLDER=<arc>`).
4. **Run.** Each `dev:*` script that starts, stops or kills anything, and `node scripts/polar-preflight.mjs`, refuses with exit 2 unless the slot's lock exists and its holder equals `HARNESS_HOLDER`, naming the holder, or "no lock". Read-only commands need no lock: `lock status`, `npm run dev:kill -- --print`, and `node scripts/harness-slot.mjs command <script>`.
5. **Release, and paste the report to the orchestrator**:
   ```bash
   node scripts/harness-slot.mjs lock release --slot 1 --holder <arc>
   ```
   It prints one line, `harness lock released: slot 1, holder <arc>, held <from> to <to> (<h>h<mm>m) on <host>; go "<go>"`. A release by anyone but the holder is refused and leaves the lock.

**How a lock is removed.** A release, a forced release and an acquire backing out of a lock it has just written never delete a lock they have not checked. Each renames the lock file to a tombstone private to it (`slot-N.lock.release.<pid>.<random>` in `locks/`), checks the tombstone, and only then deletes it; if the check fails it links the tombstone back into place and refuses. A release checks the holder; a forced release checks that the lock is byte for byte the one it read, so a lock released and re-acquired in between is put back, not freed; a back-out checks that the lock is still the one it wrote. Of several commands removing the same lock at once, exactly one wins the rename; the others find no lock. **The residual:** POSIX has no compare-and-delete, so on the refusal path the lock is absent from the rename until it is linked back. If another acquire takes the slot in that moment, the link back fails: the command says so loudly, names the newcomer, and keeps the lock it took out as its tombstone file, for you to inspect.

**An unreadable lock file** (one that does not parse as a lock) is refused by every `dev:*` script, by the pre-flight and by a plain release, whatever `HARNESS_HOLDER` or `--holder` says, naming the file; it is freed only with `--force --reason`. An acquire against it is refused as `already locked by "(unreadable lock file)"`.

`node scripts/harness-slot.mjs lock status` lists what is held. Every acquire, release and forced release appends a line to `~/.bitcorn-dev/locks/history.log`, which nothing rewrites. Status flags a lock **SUSPECT**, giving the reasons, when it was acquired over 24 hours ago, when its `host` is not this machine's hostname, or, for a slot lock, when nothing listens on any of the slot's ports (the ones `dev:kill` clears: API, web, loopd RPC and loopd REST; checked with `lsof`, which sees only your own user's processes; if `lsof` cannot answer, the line says the listener check could not run). SUSPECT frees nothing and is not a verdict: the holder is an arc, not a process, and an arc holds its lock across stretches when nothing of it runs. Check with the holder, then free it, if at all, with `--force --reason`.

**A Polar setup window** (creating or changing a Polar network) takes the host-wide lock instead: `lock acquire --setup --holder <arc> --go "<text>"`, released with `lock release --setup --holder <arc>`. It is refused while any slot lock is held, and while it is held no slot lock can be taken and every slot's scripts refuse.

**A stale lock** (its holder gone) is cleared only with a written reason, which the history keeps: `lock release --slot N --force --reason "<why>"`.

For slot N, use `--slot N` and the same `HARNESS_SLOT` as the scripts: slot 1's lock does not cover slot 2.

## Troubleshooting

**"External/degraded" view in a member tab.** The member instance can't see a channel to `TREASURY_PUBKEY`. Check that (a) the pubkey in `.env.dev.member-*` matches the actual treasury Polar node pubkey exactly, (b) channels are open between treasury and that member node in Polar, and (c) you've mined 6 blocks since opening the channel so it's confirmed.

**Channels stuck in "Pending" forever.** Polar's regtest doesn't auto-mine. Click the Bitcoin Core node → Actions → Mine 6 Blocks.

**API can't read the macaroon — "ENOENT: no such file"**. The `LND_DIR` path in your .env file is wrong. Run `ls ~/.polar/networks/<id>/volumes/lnd/<node>/` and confirm `tls.cert` and `data/chain/bitcoin/regtest/admin.macaroon` exist. Make sure `BITCOIN_NETWORK=regtest` in the env file (otherwise the macaroon path looks for the wrong subdirectory).

**EACCES on database init** — e.g. `Error: EACCES: permission denied, mkdir '/data/db'`. The API is falling back to the production `/data/db` path because `DB_DIR` isn't set in the env file (or wasn't loaded). Set `DB_DIR` in `.env.dev.<role>` to a writable path on your machine — e.g. `/home/<you>/.bitcorn-dev/<role>/db` — and re-run `npm run dev:all`. The directory will be auto-created with mode 0o700 on startup.

**EACCES on master key init** — e.g. `Error: EACCES: permission denied, mkdir '/data/secrets'` triggered the first time you exercise an autobuy credential flow. Same shape as the DB_DIR case: `SECRETS_DIR` isn't set, so the API is falling back to the production `/data/secrets` path. Set `SECRETS_DIR` in `.env.dev.<role>` to a per-role writable path (e.g. `/home/<you>/.bitcorn-dev/<role>/secrets`) and restart the affected instance. The directory will be created lazily on the next encrypt/decrypt call.

**Polar won't launch on Ubuntu 24.04 — "SUID sandbox" error.** Disable the AppArmor unprivileged user namespace restriction. See Prerequisites.

**Polar AppImage won't run — "AppImage requires FUSE".** `sudo apt install libfuse2t64` on Ubuntu 24.04.

**Port already in use.** Either `dev:all` is already running in another terminal, or another process has grabbed 3101–3103 / 5173–5175. The most common cause is orphan API processes from a prior `dev:all` that didn't shut down cleanly when you `Ctrl+C`'d the parent — `concurrently → npm → tsx → node` is enough indirection that SIGINT sometimes doesn't reach the leaf `node` processes. Run `npm run dev:kill` (with the slot's lock held, see [The harness lock](#the-harness-lock)) to force-clear all six dev ports, then re-run `dev:all`. `lsof -i :3101` shows what specifically owns a single port if you want to investigate before killing.

**Polar regtest recovery — symptom → action.**
Container names embed the Polar network id: `polar-n<id>-<Node>`, so `polar-n1-*` is network 1 (`ls ~/.polar/networks/`). The commands below use network 1 and the compose hostnames `Treasury`, `Farmer1`, `Merchant1`, `External-Peer-1`, `backend1` — substitute yours. Each symptom is something you observe directly; match on it, not on a similar-looking error.
- *All LND containers crash-loop (`Restarting (1)`) and log `lookup polar-n1-backend1 … server misbehaving`* → bitcoind is down. `docker start polar-n1-backend1`. Details in the next entry.
- *LNDs are up, `lncli getinfo` shows `synced_to_chain: false` even though `block_height` matches bitcoind, and the log shows `Syncing to block chain … best_block_time=<days ago> is_synced=false`* → the tip is stale. The stale tip was seen after the harness sat idle on both ubuntu-pc and the OptiPlex; the peer loss that comes with it, Treasury's peers dropping, was observed on the OptiPlex only, where one block fixed both. See [Polar regtest gate: stale tip](#stale-tip).
- *`-8: Block height out of range` after an unclean host stop* → bitcoind lost a block the LND wallet had already saved, so the wallet is ahead of bitcoind. Mine one block at a time (the command is in [Polar regtest gate: stale tip](#stale-tip)) and after each, re-check `docker logs --tail 50 polar-n1-<Node>`, until the `-8` lines stop and LND logs `Chain backend is fully synced!`. Don't use the `start_height=` value in LND's log as a target: it is bitcoind's height, not the wallet's. Extra regtest blocks are harmless. Precedent: 2026-10-09, when six blocks mined at once cleared it and the wallet rolled back the orphaned block.
- *After **any** Docker daemon restart* → Treasury can be missing peers, so check every time. See [Polar regtest gate: stale-IP peer drop](#stale-ip-peer-drop).
- *Checking any of the above in logs* → always `docker logs --tail N <container>`. A full read (no `--tail`, or `--since`) can stop silently at a corrupt json-file log entry; on the dev machine it stops at 2026-09-29, so a grep over it misses everything since and looks like "nothing logged".

**Polar bitcoind container exited; LND containers in restart loop.**
*Symptom:* `docker ps` shows all four `polar-n1-*` LND containers in `Restarting (1) X seconds ago`. `docker ps -a` shows `polar-n1-backend1` as `Exited (0)` rather than `Up`. LND logs (`docker logs polar-n1-Treasury --tail 20`) show repeated lines like `unable to create partial chain control: lookup polar-n1-backend1 on 127.0.0.11:53: server misbehaving`.
*Diagnosis:* A Docker daemon restart — routine `apt` upgrades of `docker-ce`/`containerd` trigger one — brings back only containers that have a restart policy; any container without one stays stopped. The LND containers have `restart: always`; bitcoind (`backend1`) had no policy, so it stayed `Exited (0)` and the LNDs crash-looped without a backend, unable to resolve it via Docker's internal DNS. On the dev machine this left bitcoind down from 2026-10-19 until 2026-10-28.
*Workaround:* `docker start polar-n1-backend1`. The LND containers recover on their next restart attempt (about once a minute) once bitcoind's DNS resolves. If they then sit at `synced_to_chain: false`, the tip is stale — mine one block (see [Polar regtest gate: stale tip](#stale-tip)). Confirm with `docker ps --format "{{.Names}} {{.Status}}" | grep polar`. Polar Desktop may briefly show the network as "stopped" in its UI until you click into it; the containers are running regardless.
*Restart policy:* see [Polar regtest gate: restart policy](#restart-policy).

**`lncli` inside a Polar LND container fails to find its files.** Run it as the `lnd` user: with `docker exec -u lnd polar-n1-<Node> lncli --network regtest …`, `--lnddir` isn't needed (observed 2026-10-28). Whether running as root needs `--lnddir=/home/lnd/.lnd` — the earlier advice, on the grounds that root's default `/root/.lnd` doesn't exist in the container — is unverified.

**`npm run dev:loopserver` fails or crash-loops.** It runs on Polar's bridge network (`polar-network-1_default`), so the Polar network must be up first; otherwise `docker run` fails with `network polar-network-1_default not found`. It reaches External-Peer-1 and backend1 by container name (`polar-n1-External-Peer-1:10009`, `polar-n1-backend1:18443`), and `docker logs bitcorn-loopserver --tail 20` shows which one it could not reach. Its embedded Postgres stays inside the container, so a Postgres on the host's 5432 no longer collides with it.

**No `sqlite3` CLI on the host (or installed version too old).**
*Symptom:* `sqlite3 ~/.bitcorn-dev/treasury/db/bitcorn.sqlite` returns `command not found`, or the installed CLI is older than the schema expects and some PRAGMA queries fail.
*Diagnosis:* The Bitcorn API uses `better-sqlite3` (Node) as its SQLite driver, so there's no project requirement on a host `sqlite3` binary. Most dev environments don't have one installed.
*Workaround:* Use `better-sqlite3` directly via `node -e` — it's already a project dependency under `app/api/node_modules`:
```bash
cd app/api
node -e "
const Database = require('better-sqlite3');
const db = new Database('/home/<you>/.bitcorn-dev/treasury/db/bitcorn.sqlite', { readonly: true });
console.log(db.prepare('SELECT * FROM subscription_policy').get());
"
```
Same pattern works for inspecting an Umbrel API container's DB when SSH is your only access:
```bash
sudo docker exec bitcorn-lightning-node_api_1 node -e "
const Database = require('better-sqlite3');
const db = new Database('/data/db/bitcorn.sqlite', { readonly: true });
console.log(db.prepare('SELECT scope, expires_at FROM subscription_local_token').get());
"
```
Note Umbrel containers using the older docker-compose underscore naming convention (`bitcorn-lightning-node_api_1`) vs the newer dash convention (`bitcorn-lightning-node-api-1`) — check `docker ps` if commands fail with "No such object."

**`gh pr edit <n> --base <branch>` silently fails to retarget the PR.**
*Symptom:* You run `gh pr edit 161 --base develop` to retarget a stacked PR after its parent merged. The command outputs a GraphQL deprecation warning about Projects (classic) and exits 0 with no further confirmation. `gh pr view 161 --json baseRefName` afterward still shows the OLD base. If you proceed to `gh pr merge 161 --merge`, the merge lands in the wrong base branch, stranding the work on a defunct intermediate branch.
*Diagnosis:* Observed in `gh` CLI version 3.114.x. The `--base` retargeting is implemented as a GraphQL mutation, and the (unrelated) Projects-classic deprecation warning short-circuits the actual mutation while still returning a success exit code. The REST endpoint for the same operation isn't affected.
*Workaround:* Bypass `gh pr edit` and call the REST endpoint directly:
```bash
gh api -X PATCH /repos/<owner>/<repo>/pulls/<n> -f base=<new-base-branch>
```
Returns the full updated PR object as JSON. `.base.ref` confirms the new base immediately.
*Verification (run after either retargeting method):*
```bash
gh pr view <n> --json baseRefName -q '.baseRefName'
```
Should print the NEW base. **Never trust the absence of an error message** — `gh pr edit --base` has shipped this silent-failure mode in at least one production gh CLI version, so verify the retarget took before proceeding to merge.
*Historical incident:* during the v1.14.0 release flow on 2026-05-11, PR #161's retarget from `feature/subscription-detection` to `develop` silently failed via this bug. The subsequent merge landed Stage 3's code on `feature/subscription-detection` (already a defunct branch since `feature/subscription-detection` itself had just merged to develop), so the Stage 3 commit was stranded one branch deep. Recovery required opening a fresh PR (#163) from the same head branch to develop. The lesson: verify with `gh pr view --json baseRefName` after every retarget, regardless of whether the retarget command appeared to succeed.

## Resetting state

**Soft reset (preserves channels and balances).** Stop the network in Polar, then start it again. Existing data persists across restarts.

**Hard reset (clean keys, fresh wallets, no channels).** Stop the network in Polar, click the network's three-dot menu and delete it, then create a new network with the same name. You'll need to re-deposit funds and reopen channels.

If you want to script a reset, the network state lives at `~/.polar/networks/<id>/` — Polar reconstructs from this on next start.

**Closing Polar may take the network down with it.** The two harness hosts have behaved differently:

- **On the OptiPlex** (Polar v4.0.0), quitting the GUI with SIGTERM did a full `docker compose down` of the network it was running: containers and the compose network removed, node data kept. A stopped network was left alone.
- **On ubuntu-pc**, Polar is not running, yet its network's containers have existed since 2026-09-24 (`backend1` since 2026-08-18) and were `Up 10 days` on 2026-11-12. There, the network has stayed up with Polar closed.

Why the two differ is not established, and neither machine's Polar settings mention stopping or shutdown. **So after closing Polar, check `docker ps`.** If the network is down, bring it up without the GUI, from `~/.polar/networks/<id>`:

```bash
USERID=$(id -u) GROUPID=$(id -g) docker compose up -d --pull never
```

This is the command run on the OptiPlex. `--pull never` uses the images already on the host. Then check Treasury's peers and reconnect any that are missing ([Stale-IP peer drop](#stale-ip-peer-drop)): on the OptiPlex, after one compose up Treasury had no peers until they were reconnected by name, and after another they returned on their own.

**Locks:** bringing a network up or down with `docker compose` takes the lock of the slot whose network it is; opening Polar's GUI takes the setup lock ([The harness lock](#the-harness-lock)).

## Polar regtest gate

This section is the single statement of the gate procedure. `docs/RELEASE.md` only points here.

**When it applies.** Changes to money, subscription, rail or tier state.

**What it runs against.** The PR's own head, before merge. A Claude Code session carries it out.

**Where its conditions come from.** The arc's spec writes the pass and fail conditions before the run. The gate session never writes its own, and never adds, drops or softens one.

**The harness it expects.** Polar network 1 with the Step 1 nodes plus `External-Peer-1` and its Treasury channel (Steps A and B of the Loop Fidelity Layer below). That is five containers (`polar-n1-backend1`, `polar-n1-Treasury`, `polar-n1-Merchant1`, `polar-n1-Farmer1`, `polar-n1-External-Peer-1`) and three active Treasury channels, one to each other node, plus External-Peer-1's contact row on Treasury, tagged `external-peer` (Step C). The pre-flight does not check the contact row. Polar itself stays closed, because a running Polar can rewrite the compose file. Closing Polar has taken the network down on the OptiPlex, so after a setup window check `docker ps`, and bring the network back up without the GUI if it is down ([Resetting state](#resetting-state)).

**The lock.** The whole gate runs with the slot's lock held by the gate's arc ([The harness lock](#the-harness-lock)): acquired with the go before the first pre-flight, released after the last, its one-line report pasted to the orchestrator and kept with the evidence.

**The phases, in this order.**

1. Pre-flight.
2. DB backup.
3. The spec's checks.
4. Teardown with a sha256 restore, then the deposit sweep ([Teardown: sweep the deposit addresses](#teardown-sweep-the-deposit-addresses)).
5. Post-run harness state.
6. Pre-flight again.

### The pre-flight

```bash
node scripts/polar-preflight.mjs
```

It refuses unless the slot's lock is held by `HARNESS_HOLDER` (see [The harness lock](#the-harness-lock)). Run it immediately before each gate, not once per session, because a stale tip can arise while the nodes are up. It takes about 30 seconds, the window for comparing restart counts. It prints one timestamped line per check, then a summary, and writes nothing.

**After an idle stretch, expect it to fail.** With no new block for roughly 2 hours, the regtest tip is stale (see [Stale tip](#stale-tip)), so the first pre-flight after the harness sits idle fails on sync. The stale tip has been seen on both ubuntu-pc and the OptiPlex, and is expected, not a fault. The peer loss that comes with it, Treasury's peers dropping, was observed on the OptiPlex only; there, one block fixed both. It is still a non-zero exit, so in a gate the prompt's `--repair` line and its stop-and-report rule still decide what happens next.

| Exit | Meaning |
|---|---|
| 0 | Every check passed, or passed apart from a WARN (only `deposit-utxos-unledgered` prints one; it never sets the exit code) |
| 1 | At least one check failed |
| 2 | It could not look: docker unreachable, a container missing, or a command errored or printed output that does not parse. Wins over 1. Also: refused by the lock, before any check, with the refusal on stderr and nothing on stdout |

It checks the five containers against the pinned set, that Polar is not running, that the compose file still gives `backend1` `restart: unless-stopped`, that restart counts hold steady across the window, that bitcoind answers with `blocks` equal to `headers`, that all four LNDs report `synced_to_chain: true`, and that Treasury's peers and active channels are exactly the three other nodes. Those last two compare sets as well as counts, so a right count made of the wrong members fails. It uses the active docker context or `DOCKER_HOST`.

It also reads the slot's treasury DB (`~/.bitcorn-dev/treasury/db/bitcorn.sqlite`; slot N, `~/.bitcorn-dev/slot-N/treasury/db/bitcorn.sqlite`), read-only, with the `sqlite3` CLI, and Treasury's `listunspent`. Its `deposit-utxos-unledgered` line lists every UTXO at a subscription deposit address whose outpoint is in neither `subscription_payment` nor `subscription_pending_attribution`: one the API's next scan would credit. It is non-blocking: any is a WARN, with the count and the outpoints, and does not change the exit code. The WARN is expected in a gate that deliberately reproduces a restore replay; otherwise it means the teardown sweep was skipped ([Teardown: sweep the deposit addresses](#teardown-sweep-the-deposit-addresses)). A DB or wallet it cannot read is still CANNOT-LOOK, which fails the run, never a zero. It writes nothing, `--repair` included.

The check needs the `sqlite3` CLI on the host; without it, the check reports CANNOT-LOOK. ubuntu-pc has `3.45.1-1ubuntu2.8`. The OptiPlex had none: `3.45.1-1ubuntu2.9` was installed there on 2026-11-13 under the outside-code adoption rule, pinned to that host's own `libsqlite3-0` version. Check a host with `dpkg-query -W sqlite3 libsqlite3-0`.

`--repair` is opt-in and makes exactly two writes, re-checking after each. It mines one block, only when every LND was read and every unsynced LND matches bitcoind's best height and hash; one mismatch and it mines nothing. It runs `lncli connect` by hostname, only for an expected peer missing from Treasury. An unexpected peer stays a FAIL. It never restarts or stops a container or the daemon, never edits the compose file, and never opens or closes a channel. A mined block advances the regtest chain, and the teardown does not undo it.

### Stale tip

*Symptom:* LNDs are up, `lncli getinfo` shows `synced_to_chain: false` even though `block_height` matches bitcoind, and the log shows `Syncing to block chain … best_block_time=<days ago> is_synced=false`.

`synced_to_chain` isn't only about height: LND also requires the tip's wall-clock timestamp to be recent (roughly 2 hours), and regtest only mines when you tell it to, so an idle network goes stale with every node on the same block. In the app, the `lnd_node_info.synced_to_chain` column shows the same flag, the API logs `membership_status: unsynced` for the local node, and code that gates on sync status (e.g. the autobuy scheduler, the rate-limited payment endpoint) treats the node as not ready.

Mine one block to an unspendable output, with `--repair` or by hand: `docker exec -u bitcoin polar-n1-backend1 bitcoin-cli -regtest generatetodescriptor 1 "raw(6a)"`. `-u bitcoin` because cookie auth only works as that user, and `raw(6a)` is a bare OP_RETURN, so no wallet is needed and nothing spendable is created. All LNDs flip to synced within seconds.

**The peers can go with it**, observed on the OptiPlex only. There, on 2026-11-11, with the newest block about 2h27m old, all four LNDs were unsynced, Treasury had no peers, and `lncli connect` failed with `server is still in the process of starting`. One block mined by hand with the command above fixed both: the LNDs synced, and peers and channels returned on their own, with no reconnect. That `--repair` clears both in one run is not verified.

### Stale-IP peer drop

After any Docker daemon restart, Treasury can be missing peers. Container IPs change on restart and LND redials the IPs it cached, so the spokes reconnect on their own only sometimes (on 2026-10-28 it happened once; after the next daemon restart two peers needed a manual reconnect). The redials show in the log as `connection refused`, `EOF`, or `chacha20poly1305: message authentication failed` — the last means the old IP now belongs to a different node.

Reconnect with `--repair` or by hand. Check with `docker exec -u lnd polar-n1-Treasury lncli --network regtest listpeers` (Farmer1, Merchant1 and External-Peer-1 on the gate's harness; a network without the Loop layer has only the first two). For each missing peer, take its pubkey from `docker exec -u lnd polar-n1-<Node> lncli --network regtest getinfo` (`identity_pubkey`), then `docker exec -u lnd polar-n1-Treasury lncli --network regtest connect <pubkey>@<Node>:9735` — the hostname resolves to the container's current IP. This treats the symptom on each run; it does not prevent it.

### Restart policy

As of 2026-10-28, `backend1` has `restart: unless-stopped` on the dev machine — in `~/.polar/networks/1/docker-compose.yml` and on the live container (`docker update --restart unless-stopped polar-n1-backend1`) — and came back by itself through a daemon restart the same day. A Polar rewrite of the compose file drops that line, so the pre-flight checks the file. To check the live container, `docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' polar-n1-backend1`.

### Teardown: sweep the deposit addresses

The sha256 restore puts back the app DBs, not Treasury's LND wallet. A payment made to a deposit address since the snapshot stays in the wallet as a UTXO, while the restored DB has no ledger row for it, so the API's first scan after the restore would credit it again. The teardown therefore spends every UTXO at a deposit address to a Treasury address that is not one (dev-safety R6). Do it after the restore is verified and before any API starts, with the slot's lock still held:

```bash
# 1. The deposit addresses, from the restored treasury DB. immutable=1, so the read creates no
#    -wal or -shm beside the files the restore just verified. (Slot N: ~/.bitcorn-dev/slot-N/treasury/db.)
sqlite3 -readonly "file:$HOME/.bitcorn-dev/treasury/db/bitcorn.sqlite?immutable=1" "SELECT deposit_address FROM subscription"

# 2. Treasury's UTXOs. Note the outpoint of each one whose address is in that list.
docker exec -u lnd polar-n1-Treasury lncli --network regtest listunspent

# 3. The target: a taproot address. Deposit addresses are p2wpkh (createLndChainAddress in
#    app/api/src/lightning/lnd.ts), so this can never be one.
docker exec -u lnd polar-n1-Treasury lncli --network regtest newaddress p2tr

# 4. The sweep: every outpoint from step 2, one --utxo each, all of it to the step-3 address.
docker exec -u lnd polar-n1-Treasury lncli --network regtest sendcoins --sweepall --addr <p2tr address> --utxo <txid:vout> --utxo <txid:vout> --label "gate teardown: deposit sweep"

# 5. Confirm it.
docker exec -u bitcoin polar-n1-backend1 bitcoin-cli -regtest generatetodescriptor 1 "raw(6a)"
```

`sendcoins` spends only outpoints with at least one confirmation, so if step 2 shows one with 0, mine the step-5 block first. With no UTXO at a deposit address, skip steps 3 to 5. In a slot other than 1, the containers are `polar-n<id>-Treasury` and `polar-n<id>-backend1`. Phase 6's pre-flight checks the result: `deposit-utxos-unledgered` should PASS with `unledgered=0`. A WARN there, outside a gate that reproduces a restore replay on purpose, names the outpoints the sweep missed.

### Evidence

The gate session saves the pre-flight's full output to a dated file outside the repo. The gate record is a vault `investigations/` record. It holds that output verbatim, the DB backup path, its sha256 values and the session transcript id. If a run allocated (gate 1 advanced Treasury's regtest wallet address index by one) or mined a block under `--repair`, its record says the run is not fully restorable.

**What a restore cannot put back: the wallets.** After a restore, wallet payments made since the snapshot are re-processed at the first scan. How those credits are dated is governed by the vault's `decisions/2026-11-13-recredit-check-ruling-b-credit-from-confirmation-time.md`, which is changing it. The [deposit sweep](#teardown-sweep-the-deposit-addresses) leaves that scan nothing to re-process, and the pre-flight's `deposit-utxos-unledgered` line reports any it missed. So a brief that tests tier behaviour seeds the tier state it needs after that first scan, not before it: the scan can move it.

### Gate prompt template

Fill in the blanks and give it to a Claude Code session in this repo.

```text
Polar regtest gate for PR #<number>, head <sha>. Work against that head, before merge.

Procedure: docs/dev-setup.md, section "Polar regtest gate". The phases are fixed:
pre-flight; DB backup; the spec's checks; teardown with a sha256 restore, then the
deposit sweep; post-run harness state; pre-flight again.

Arc spec: <path>
Pass and fail conditions, quoted from the spec, not paraphrased:
<conditions>

Do not add, drop or soften a condition, and do not write your own.

Slot lock: acquire slot <N> as <arc> with the go before the first pre-flight; release
after the last; paste the release report (docs/dev-setup.md, "The harness lock").
Backup target: <path>
Evidence file, outside the repo: <path>
Vault gate record: <investigations/ path>
--repair allowed on this run: <yes or no>

If a pre-flight exits non-zero, stop and report it before going on.
```

## Optional: Loop Fidelity Layer

Skip this entire section unless your work touches the Loop subsystem (`src/swaps/`, the rebalance cost ledger, the autobuy Loop Out path, the Member Liquidity Advisor's Loop In/Out recommendation flow). The base setup above is sufficient for everything else — UI work, channel management, contacts, payments, dashboard polish, valuation entry, the calendar, etc. all exercise their main code paths without ever calling `loopd`.

When you do need real swap fidelity in regtest, this layer adds:

- **A fourth LND node in Polar** (`External-Peer-1`) — the routing peer + `loopserver` anchor. Mirrors the role ACINQ plays in production.
- **A `loopserver` process** running outside Polar's container management, anchored to External-Peer-1's LND. Speaks the same gRPC interface that Lightning Labs' production Loop servers expose.
- **Per-role `loopd` processes** (one each for treasury, member-A, member-B). Polar's pure-LND nodes don't have litd embedded, so loopd has to run as a separate host process per role — see `bitcorn-research/specs/2026-04-29-local-loop-fidelity-via-loopserver.md` §3 for the design rationale.

After this layer is up, Member Liquidity Advisor recommendations on Farmer1 and Merchant1 trigger actual end-to-end Loop swaps against the local `loopserver`. Channel state transitions, the rebalance cost ledger, and every line of `src/swaps/` exercise their real code paths.

> **Note:** Spec §3 assumed `loopserver` was buildable from the `lightninglabs/loop` repo at `./cmd/loopserver`. **It isn't** — that path doesn't exist in any release of the repo (verified across v0.5.1-beta through v0.33.0-beta). `loopserver` was published only as a Docker image, `lightninglabs/loopserver`, documented in the loop repo's own `regtest/README.md`, and that image is now gone from Docker Hub; this harness pins `v0.9.221-beta` (Step D). The walkthrough below uses Docker for `loopserver` and a native Go binary (built from the same repo's `cmd/loopd`) for the per-role `loopd` clients, with verified `loopd v0.33.0-beta` flags. Step G records the Loop Out smoke test running end-to-end to `Success` on 2026-11-10; this page records no dated Loop In run.

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

1. Drag from the Treasury node onto External-Peer-1 to create a channel. Set capacity to **10,000,000 sats**, with **no push**: the whole balance starts on Treasury's side. This is the channel ubuntu-pc's harness had when read on 2026-11-11, and the OptiPlex's was built to match it; the Loop In caveat in Step F covers its one consequence.
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

- **`loopserver`** was published only as a Docker image, `lightninglabs/loopserver`, now gone from Docker Hub; this harness pins `v0.9.221-beta` (below). There is no Go source for it in the public `lightninglabs/loop` repo. Documented in the loop repo's `regtest/README.md`.
- **`loopd`** is the swap client; we build it from source against a pinned tag of `lightninglabs/loop`.

```bash
# The loopserver Docker image — pinned to v0.9.221-beta (Nov 2024).
# `latest` (v0.11.33-beta as of writing) and any v0.10+ tag have a buggy
# Postgres migration in the static-address feature path that fails at
# startup with "migration requires timezone to be UTC, got: UTC". The
# error is self-contradictory (the runtime timezone IS 'UTC' but the
# comparison fails) and has been present since the static-address
# tables were introduced in late 2024. v0.9.221-beta predates the
# feature, doesn't have those tables, so the broken migration can't
# run. Loop In and Loop Out work fine on this version (the only thing
# missing is the static-address Loop In variant, which we don't use).
#
# lightninglabs/loopserver is no longer on Docker Hub: a `docker pull` on the
# OptiPlex on 2026-11-11 failed. The OptiPlex's image was copied from ubuntu-pc
# with docker save into docker load, and the image IDs matched. Copy the pinned
# image from a machine that has it, running this on that machine. This assumes
# that machine can SSH to the new one:
docker save lightninglabs/loopserver:v0.9.221-beta | ssh <new-host> docker load
# Keep the image on every host that has it: there is no public source left.

# Build loopd, and the loop CLI that talks to it, from source (pinned tag — master is volatile)
LOOP_TAG=v0.33.0-beta
git clone --depth 1 --branch ${LOOP_TAG} https://github.com/lightninglabs/loop ~/.bitcorn-dev/loop-src
cd ~/.bitcorn-dev/loop-src
go build -o ~/.bitcorn-dev/loopserver/loopd ./cmd/loopd
go build -o ~/.bitcorn-dev/loopserver/loop ./cmd/loop
```

Verify: `~/.bitcorn-dev/loopserver/loopd --version` should print `loopd version 0.33.0-beta`. `docker image inspect lightninglabs/loopserver:v0.9.221-beta --format '{{.Id}}'`, run on the machine you copied from and on the new one, should print the same image ID. The `loop` CLI is what Step F's `getinfo` check uses; given `--loopdir` and `--network`, it finds that loopd's `tls.cert` and `loop.macaroon` under `<loopdir>/<network>/`. Neither ubuntu-pc nor the OptiPlex has the `loop` CLI built today (on ubuntu-pc, read 2026-11-12: not in `~/.bitcorn-dev/loopserver/`, not on `PATH`). There, read each loopd's own log instead, at `<loopdir>/logs/regtest/loopd.log`. That path was read on the OptiPlex for slots 1 and 2, and on ubuntu-pc for slot 1 (2026-11-12). Slot 1's are at `~/.bitcorn-dev/<role>/loopd/logs/regtest/loopd.log` for `treasury`, `member-a` and `member-b`.

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
LOOP_TLS_CERT_PATH=/home/<you>/.bitcorn-dev/treasury/loopd/regtest/tls.cert
LOOP_MACAROON_PATH=/home/<you>/.bitcorn-dev/treasury/loopd/regtest/loop.macaroon
```

`.env.dev.member-a`:
```bash
LOOP_GRPC_HOST=127.0.0.1
LOOP_GRPC_PORT=11020
LOOP_TLS_CERT_PATH=/home/<you>/.bitcorn-dev/member-a/loopd/regtest/tls.cert
LOOP_MACAROON_PATH=/home/<you>/.bitcorn-dev/member-a/loopd/regtest/loop.macaroon
```

`.env.dev.member-b`:
```bash
LOOP_GRPC_HOST=127.0.0.1
LOOP_GRPC_PORT=11030
LOOP_TLS_CERT_PATH=/home/<you>/.bitcorn-dev/member-b/loopd/regtest/tls.cert
LOOP_MACAROON_PATH=/home/<you>/.bitcorn-dev/member-b/loopd/regtest/loop.macaroon
```

These tell the API where to find its loopd over gRPC. Both `tls.cert` and `loop.macaroon` live under the `regtest/` subdirectory loopd creates — the loopdir root only holds `logs/` and `macaroons.db`. Without them, the API falls back to the production-Umbrel defaults (`bitcorn-lightning-node_loopd_1:11010`) which don't exist locally — Loop UI surfaces will report "loop unavailable" and the §6 smoke tests will fail before reaching the swap server.

#### Loop In route preflight (one extra var per role)

The Loop In flow has a preflight that probes whether a Lightning route exists *from the Loop server back to the merchant's node*. In production that's Lightning Labs' Loop server pubkey; locally it must be **External-Peer-1's pubkey** because that's the LND node loopserver is anchored to. Without this override, the probe never finds a route and the UI surfaces `route_unavailable` ("Treasury has no inbound capacity…") even though loopd itself is healthy.

Add the same line to all three `.env.dev.*` files (capture the pubkey from External-Peer-1's Connect tab in Polar, or `lncli getinfo` inside the External-Peer-1 container):

```bash
LOOP_SERVER_PUBKEYS=<External-Peer-1 pubkey>
```

This is only used for the route preflight — it doesn't change which loopd or loopserver the API talks to.

### Step F: Start the Loop layer

In a separate terminal from the one running `npm run dev:all`:

```bash
# Start loopserver (Docker container, anchored to External-Peer-1)
npm run dev:loopserver

# Wait for loopserver's own log line, up to 60 s. Not `nc -z` on its port: Docker's proxy
# accepts on the host port before loopserver listens, so a port check passes early, and a
# loopd started then exits ("connection reset by peer"). On an empty Postgres, loopserver has
# taken from about 10 to 35 s to start listening; the wait allows 60.
LS=bitcorn-loopserver; [ "${HARNESS_SLOT:-1}" = 1 ] || LS="bitcorn-loopserver-$HARNESS_SLOT"
ready=; for i in $(seq 60); do
  if docker logs "$LS" 2>&1 | grep -q 'RPC server listening on'; then ready=1; break; fi
  sleep 1
done
if [ -n "$ready" ]; then echo "loopserver ($LS) is listening"
else echo "FAILED: $LS has not logged 'RPC server listening on' after 60 s; loopd not started. Read: docker logs $LS --tail 30"; fi

# Start the three per-role loopd clients, only once loopserver is listening (as background jobs)
if [ -n "$ready" ]; then
  npm run dev:loopd-T &
  npm run dev:loopd-A &
  npm run dev:loopd-B &
fi
```

What the scripts run:

- **`dev:loopserver`** runs the official `lightninglabs/loopserver:v0.9.221-beta` Docker image (pinned, see Step D) on Polar's bridge network, `--network polar-network-1_default`, with its RPC port published only on loopback: `-p 127.0.0.1:11009:11009`. Docker-published ports bypass ufw, hence `127.0.0.1` (for Polar's own ports, see [Harness hosts](#harness-hosts)); the status port (`1100`) is not published. On the bridge the container reaches LND and bitcoind by container name, at the **container's** ports, not the host ports Polar maps. Flags wired in:
  - `--lnd.host=polar-n1-External-Peer-1:10009 --lnd.macaroondir=/lnd/data/chain/bitcoin/regtest --lnd.tlspath=/lnd/tls.cert` — anchor to External-Peer-1's LND (read-only volume mounted at `/lnd`, NOT `/root/.lnd` — the loopserver image runs as `uid=100(loopserver)` which can't traverse the container's `/root/` directory; mounting at `/lnd` puts the data under a world-traversable path). External-Peer-1's TLS certificate names `polar-n1-External-Peer-1`, so dialing by container name verifies.
    **The host side needs loosening too, regtest only.** On the OptiPlex, LND had created External-Peer-1's `data`, `chain`, `bitcoin` and `regtest` directories `0700`, and loopserver (uid 100 in its image) could not read the macaroons until they were loosened. The end state read on both ubuntu-pc and the OptiPlex: those four directories at `o+rx` (`0705`), and every `regtest/*.macaroon` readable by others; of the macaroons, only `admin.macaroon` needed the change. To reach it, from External-Peer-1's LND directory (`~/.polar/networks/<id>/volumes/lnd/External-Peer-1`):
    ```bash
    chmod o+rx data data/chain data/chain/bitcoin data/chain/bitcoin/regtest
    chmod o+r data/chain/bitcoin/regtest/*.macaroon
    ```
    This makes External-Peer-1's admin macaroon readable by every local account: accepted for Polar's regtest harness only, never for a node with real funds.
  - `--bitcoin.host=polar-n1-backend1:18443 --bitcoin.user=polaruser --bitcoin.password=polarpass` — Polar's bitcoind RPC (default Polar credentials)
  - `--bitcoin.zmqpubrawblock=tcp://polar-n1-backend1:28334 --bitcoin.zmqpubrawtx=tcp://polar-n1-backend1:28335` — Polar's bitcoind ZMQ ports for raw block/tx notifications. **Required** — loopserver crashes at startup with `invalid config: zmqpubrawblock must be set` if these aren't passed. Inside the container rawblock is `28334` and rawtx `28335`; on the host they are `28335` and `29336`, so the host numbers must not be carried over.
  - `--maxamt=5000000` — caps any single swap at 5M sats, half of Step B's 10,000,000-sat channel
  - `docker rm -f bitcorn-loopserver` runs first to wipe any prior container by name. The container is NOT auto-removed on crash (no `--rm`), so `docker logs bitcorn-loopserver` is available for post-mortem if it dies.
- **`dev:loopd-{T,A,B}`** runs `loopd --network=regtest --loopdir=<per-role dir> --rpclisten=localhost:<role port> --lnd.host=127.0.0.1:<that role's LND gRPC> --lnd.macaroonpath=<...> --lnd.tlspath=<...> --server.host=localhost:11009 --server.notls`. The `--server.notls` flag is required because the regtest loopserver doesn't run TLS.

Verify reachability:

```bash
# loopserver: its own log line, not nc -z on 11009 (Docker's proxy answers that port first)
LS=bitcorn-loopserver; [ "${HARNESS_SLOT:-1}" = 1 ] || LS="bitcorn-loopserver-$HARNESS_SLOT"
docker logs "$LS" 2>&1 | grep -q 'RPC server listening on' && echo "loopserver OK" || echo "loopserver NOT listening: docker logs $LS --tail 30"
nc -z localhost 11010 && echo "loopd-T OK"
nc -z localhost 11020 && echo "loopd-A OK"
nc -z localhost 11030 && echo "loopd-B OK"
docker logs "$LS" --tail 20    # should show 'RPC server listening on [::]:11009'
# loopd-T's getinfo, through the loop CLI from Step D (member-a: 11020, member-b: 11030):
~/.bitcorn-dev/loopserver/loop --rpcserver=localhost:11010 --network=regtest --loopdir=$HOME/.bitcorn-dev/treasury/loopd getinfo
# No loop CLI (neither ubuntu-pc nor the OptiPlex has one built)? Read that loopd's own log
# instead; slot 1's treasury log (path read on the OptiPlex and ubuntu-pc):
tail -n 20 ~/.bitcorn-dev/treasury/loopd/logs/regtest/loopd.log
```

To stop just the loopserver container without killing other things: `npm run dev:loopserver-stop`.

Stopping the whole Loop layer: `npm run dev:kill` (kills the processes listening on the loopd ports 11010/11020/11030 and 8801–8803) plus `npm run dev:loopserver-stop` for the Docker container. `dev:kill` does not touch 11009: loopserver is a container, and `dev:loopserver-stop` stops it.

> **⚠ Channel-direction caveat for Loop In:** The current Treasury↔External-Peer-1 channel was opened by Treasury with all funds on Treasury's side (cap=10M, External-Peer-1 local=0). Loop Out from Farmer1 (the §6 first smoke test) works fine because Treasury → External-Peer-1 has full forward capacity. **Loop In from Merchant1 will fail until External-Peer-1 has some outbound capacity.** Two options: (a) run the Loop Out smoke test first, which moves sats to External-Peer-1's side via the off-chain HTLC, then attempt Loop In; (b) open a second channel from External-Peer-1 → Treasury funded from External-Peer-1's 5 BTC on-chain so the asymmetric provisioning the spec called for is in place. Option (a) matches the spec's §6 ordering and is simpler if you only need to validate end-to-end once.

### Step G: Smoke tests

Per spec §6. Two scenarios. Beyond the trigger, each needs **blocks mined by hand**: nothing mines on this regtest network by itself, and a swap waits for its on-chain transactions to confirm. Mine one block at a time, with the command from [Stale tip](#stale-tip), and read loopd's log between blocks:

```bash
docker exec -u bitcoin polar-n1-backend1 bitcoin-cli -regtest generatetodescriptor 1 "raw(6a)"
```

**Loop Out from Farmer1.** Pre-state: Farmer1's channel to Treasury has > 2,000,000 sats on Farmer1's side. Trigger from `localhost:5174` → **Withdraw** (`/cashout`): **Get Quote**, then **Confirm Withdrawal**, which opens a confirm modal; type the amount there and press **Withdraw**. Should route Farmer1 → Treasury → External-Peer-1, settle on-chain, and update Farmer1's UI + the rebalance cost ledger. It took two blocks in the 2026-11-10 run: one once loopserver published its HTLC (loopd logs `Waiting for either htlc on-chain confirmation`), and one once loopd published its sweep (`published sweep`); the swap then logs `Loop out swap state: Success`.

**Loop In from Merchant1.** Pre-state: Merchant1's channel to Treasury has < 500,000 sats on Merchant1's side, plus 1,000,000+ sats on-chain. Trigger from `localhost:5175` → **Top Up** (`/refill`), behind the same confirm modal. The member nav shows Top Up to a member whose channel role is merchant and Withdraw to the others. Should pay on-chain to `loopserver`'s swap address, refill Merchant1's outbound capacity, and update the cost ledger. Mine blocks as above until the swap reports success.

If either fails, the failure mode (which step, what error) is the input for a debug session before declaring the layer ready.

### Resetting / cleanup

`npm run dev:kill` clears all dev-stack ports, including loopd's (11010, 11020, 11030, 8801–8803), by killing the processes **listening** on them: a process that only holds a connection to one of those ports, such as a browser talking to another host's 3101, is not touched. It needs the slot's lock. `npm run dev:kill -- --print` lists exactly those listener PIDs, kills nothing, and needs no lock. loopserver stops with `npm run dev:loopserver-stop`. If you also want to wipe loopd state: `rm -rf ~/.bitcorn-dev/{treasury,member-a,member-b}/loopd && mkdir -p ...` (rerun the per-role mkdir from Step E).

To remove External-Peer-1: stop the network in Polar, delete the node, restart. The Treasury↔External-Peer-1 channel is lost; you'll need to redo Step B.

## Slots: a second harness on the same host

Everything above is **slot 1**, the default. A slot is one complete harness (three APIs, three web servers, loopserver, three loopd, one Polar network) whose ports, directories and names are computed from a slot number by `scripts/harness-slot.mjs`. The `dev:*` scripts and the pre-flight take the slot from `HARNESS_SLOT`; unset means 1, and slot 1's values are the ones this page uses.

| | Slot 1 | Slot N | Slot 2 |
|---|---|---|---|
| API ports | 3101–3103 | each + 10(N−1) | 3111–3113 |
| Web ports | 5173–5175 | each + 10(N−1) | 5183–5185 |
| loopserver (host side, `127.0.0.1`) | 11009 | + 100(N−1) | 11109 |
| loopd RPC | 11010, 11020, 11030 | each + 100(N−1) | 11110, 11120, 11130 |
| loopd REST | 8801–8803 | each + 100(N−1) | 8901–8903 |
| Data directories | `~/.bitcorn-dev/<role>` | `~/.bitcorn-dev/slot-N/<role>` | `~/.bitcorn-dev/slot-2/<role>` |
| loopserver container | `bitcorn-loopserver` | `bitcorn-loopserver-N` | `bitcorn-loopserver-2` |
| Polar network | id 1 (`bitcorn-dev`) | the one named `bitcorn-dev-N` | `bitcorn-dev-2` |
| API env files | `.env.dev.<role>` | `.env.dev.slot-N.<role>` | `.env.dev.slot-2.<role>` |

Polar's own node ports are not computed: they are read from `~/.polar/networks/networks.json`. A slot is refused, with a message, when any computed port would be 3109 (the app's reserved port) or 13009 (lnagent's tunnel), which rules out slot 21; when no Polar network is named `bitcorn-dev-N` (there is no fallback to network 1); or when its network's nodes are not exactly `Treasury`, `Merchant1`, `Farmer1`, `External-Peer-1` and `backend1`.

**Setting up slot N, once, in a setup window.** The Polar GUI is opened only when no slot is mid-gate, because a running Polar can rewrite any network's compose file.

1. Start the other slots' networks first, and keep them running while you create and first start network N. On the OptiPlex, Polar v4.0.0 assigned a network's host ports when it started the network, choosing ones that were free then: `bitcorn-dev-2`, created while network 1 was stopped, got network 1's ports, and the two could not run at once. In Polar, create a network named `bitcorn-dev-N` with the five nodes above, named exactly so, and open and fund the same channels as slot 1 (Step 1 and Loop Steps A and B). Add `restart: unless-stopped` to its `backend1` service in `~/.polar/networks/<id>/docker-compose.yml` (see [Restart policy](#restart-policy)). Close Polar, then check `docker ps`. If network N is down (on the OptiPlex, closing the GUI tore down the network it was running), bring it back up without the GUI under slot N's lock, once the setup lock is released ([Resetting state](#resetting-state)).
2. Write the three env files `.env.dev.slot-N.treasury`, `.env.dev.slot-N.member-a` and `.env.dev.slot-N.member-b` at the repo root (gitignored by the `.env.dev.*` rule). They hold slot N's identity only:
   - `TREASURY_PUBKEY` — slot N's Treasury node pubkey, in all three;
   - `LOOP_SERVER_PUBKEYS` — slot N's External-Peer-1 pubkey, in all three;
   - `TREASURY_API_URL` — in the two member files, `http://localhost:<slot N's treasury API port>` (3111 for slot 2).

   Optional, in any of the three: `COINBASE_WORKER_URL` and `BASE_RPC_URL`. Without `COINBASE_WORKER_URL` the onramp answers `coinbase_not_configured`; without `BASE_RPC_URL`, wallet binding uses the BASE chain's public RPC.

   The scripts inject the rest for slot N, and the injected values win over the file: the computed `PORT`, `DB_DIR`, `SECRETS_DIR`, `LND_GRPC_HOST`, `LND_DIR`, `LOOP_GRPC_PORT`, `LOOP_TLS_CERT_PATH` and `LOOP_MACAROON_PATH`, plus `BITCOIN_NETWORK=regtest` and `LOOP_GRPC_HOST=127.0.0.1`, whose API defaults are production values. Every slot, slot 1 included, also gets `API_LISTEN_HOST=127.0.0.1` (the loopback bind, above); apart from that, slot 1 injects nothing: its `.env.dev.<role>` files stay authoritative.
3. Create the loopd directories: `mkdir -p ~/.bitcorn-dev/slot-N/{treasury,member-a,member-b}/loopd`.

**Running slot N.** Take slot N's own lock ([The harness lock](#the-harness-lock)), then set the slot on each command:

```bash
node scripts/harness-slot.mjs lock acquire --slot 2 --holder <arc> --go "<who gave the go>"
export HARNESS_HOLDER=<arc>
HARNESS_SLOT=2 npm run dev:all
HARNESS_SLOT=2 npm run dev:loopserver
HARNESS_SLOT=2 npm run dev:loopd-T     # and -A, -B
HARNESS_SLOT=2 node scripts/polar-preflight.mjs
HARNESS_SLOT=2 npm run dev:kill -- --print   # list the PIDs listening on the slot's ports; drop --print to kill them
HARNESS_SLOT=2 npm run dev:loopserver-stop
node scripts/harness-slot.mjs lock release --slot 2 --holder <arc>
```

`HARNESS_SLOT=2 node scripts/harness-slot.mjs command <script>` prints what any script would run. `dev:kill` acts only on its slot's ports and never on loopserver's. The pre-flight prints a `slot` line first for slot N, and its Polar-GUI check stays host-wide in every slot. On the OptiPlex (7.6 GiB RAM) on 2026-11-12, two complete slots ran in parallel and both pre-flights passed; available memory (`free -h`'s available column) bottomed out at 3.0 GiB. That is the stop line, the 3 GiB available-memory stop rule in the app repo's `CLAUDE.md`, applied on both machines, so it works there with no margin. Running two slots at once on ubuntu-pc has not been tried.

The module's tests run by hand, nothing runs them automatically: `~/.nvm/versions/node/v20.20.2/bin/node --test scripts/harness-slot.test.mjs`.

## When to use this vs the real test nodes

This local setup is for the bulk of day-to-day work — most code changes can be exercised here in seconds. Use the real test Umbrel nodes (treasury, farmer, merchant) when:

- Reproducing something that only manifests with real network conditions (mainnet/testnet peering, slow channel updates, etc.)
- Testing the actual Umbrel update flow before a release (the manifest version bump → Umbrel detects → user clicks update path)
- Validating cross-machine integration that local Polar can't simulate

The release path itself is unchanged by any of this. **Releases DO carry git tags** — CI creates `vX.Y.Z` as the first thing it does on a push to `main`, before any image is pushed, and every historical version was backfilled; this sentence used to claim the repo had zero tags, which was true only until 2026-08-11. A release is: bump the version everywhere it is pinned, in one commit (`umbrel-app.yml`'s `version:` plus **every** `image: ghcr.io/…` tag in `bitcorn-lightning-node/docker-compose.yml` — enumerate them, don't count from memory), merge to `main`, CI builds and pushes the images, then refresh the Umbrel host's app-store clone so farmers see the update. Full procedure, with the verification step that prevents a half-installed node: **[docs/RELEASE.md](RELEASE.md)**.
