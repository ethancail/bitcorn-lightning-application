# RELEASE — how a version reaches farmers' nodes

The procedure below has been identical across all 26 releases. It has never been
written down until now, and the one doc that described it was wrong (it claimed
releases are cut by tagging; there are **zero** git tags in this repo — `git tag |
wc -l` → `0`).

**Read this end to end before your first release.** Steps 1–2 are reversible.
From step 3 onward you are publishing immutable-by-convention image tags and
offering an update to real nodes running real money. There is **no tested rollback
path** — see [Rollback](#rollback-untested).

Facts verified against the tree at `18f99b3` (2026-08-03). Line numbers move;
the file paths don't.

---

## The nine steps

| # | Step | Who |
|---|---|---|
| 1 | Bump three places in one commit | **MANUAL** |
| 2 | `release/vX.Y.Z` → PR → merge to `main` | **MANUAL** |
| 3 | CI builds and pushes both images | AUTOMATED |
| **3a** | **Verify the images actually reached GHCR** | **MANUAL — do not skip** |
| 4 | Umbrel host's app-store clone pulls `main` | **MANUAL** |
| 5 | `umbreld` sees the higher version, offers the update | AUTOMATED |
| 6 | User clicks Update | **MANUAL (the farmer)** |
| 7 | `umbreld` re-serializes compose, pulls the pinned tags | AUTOMATED |
| 8 | `exports.sh` sources the operator `.env`; compose starts | AUTOMATED |
| 9 | API boots; migrations run | AUTOMATED |

---

### Step 1 — Bump three places in ONE commit · MANUAL

Three version strings must agree. All three, same commit:

| File | What |
|---|---|
| `bitcorn-lightning-node/umbrel-app.yml` | `version: "X.Y.Z"` |
| `bitcorn-lightning-node/docker-compose.yml` | `image: …/api:X.Y.Z` |
| `bitcorn-lightning-node/docker-compose.yml` | `image: …/web:X.Y.Z` |

Also add the release notes to `umbrel-app.yml`'s `releaseNotes:` field in the same
commit — farmers read it in the Umbrel update prompt, and there is no later chance
to edit it for a version that has shipped.

**Why one commit, not two:** `umbrel-app.yml` is in CI's `paths:` filter and the
compose file is **not**. Bumping only the compose file triggers no build at all.
Bumping only `umbrel-app.yml` triggers a build but leaves compose pointing at the
previous tags, so `umbreld` pulls stale images and the "new" version runs old code.

**Verify before moving on:**
```bash
grep -n '^version:' bitcorn-lightning-node/umbrel-app.yml
grep -n 'image: ghcr.io' bitcorn-lightning-node/docker-compose.yml
```
All three strings identical. Then confirm they're in the same commit:
```bash
git show --stat HEAD
```

### Step 2 — `release/vX.Y.Z` branch → PR → merge to `main` · MANUAL

Branch, push, open a PR, merge. Merging is what fires everything downstream.

**Which branch to cut from:** in practice, straight from the feature branch or
from `main`. See [Releasing from `develop`](#releasing-from-develop) before doing
the `develop` variant — it has a footgun the normal path doesn't.

**Verify before moving on:** the PR's diff contains the three version strings and
nothing you didn't intend. **No test gate runs in CI** — see [Scope](#what-this-doc-does-not-cover).
A green merge means "merged", not "tests passed".

### Step 3 — CI builds and pushes both images · AUTOMATED

`.github/workflows/docker-publish.yml` fires on push to `main`, but **only** when
the changed files match one of its four `paths:` entries:

```
app/api/**
app/web/**
bitcorn-lightning-node/umbrel-app.yml
.github/workflows/docker-publish.yml
```

A `get-version` job greps the version out of the manifest —
`grep '^version:' bitcorn-lightning-node/umbrel-app.yml` — and both build jobs
consume it. Each image gets **three tags**:

- `latest`
- `X.Y.Z` ← the only one that matters; it's what compose pins
- `<short-sha>`

Both images build for `linux/amd64,linux/arm64`. The web build additionally bakes
`VITE_BASE_CHAIN_ID` into the bundle at build time, defaulting to `84532`
(Base Sepolia) — a guard fails the build if the repo variable is unset or
unsupported on a `main` build.

### Step 3a — VERIFY THE IMAGES REACHED GHCR · MANUAL — do not skip

**This is the step that prevents `CLAUDE.md`'s "install fails at 0%".** The causal
chain: if a farmer clicks Update before the images exist on ghcr.io, `umbreld`
tries to pull a tag that isn't there, the install flips back to "Install" at 0%,
and the node is left in a broken half-state requiring the recovery in
[Gotchas](#gotchas). Confirming the build is green **before** anyone can click is
the whole mitigation.

```bash
gh run list --branch main --limit 5
```
Both build jobs must be `completed / success`. If a job failed:
```bash
gh run rerun <run-id> --failed
```
The common cause is a transient npm 403 (e.g. `npm install -g serve` rate-limited)
— a rerun usually clears it.

Then confirm the tags are actually pullable, which is the real check rather than a
proxy for it:
```bash
docker manifest inspect ghcr.io/ethancail/bitcorn-lightning-application/api:X.Y.Z >/dev/null && echo API OK
docker manifest inspect ghcr.io/ethancail/bitcorn-lightning-application/web:X.Y.Z >/dev/null && echo WEB OK
```

**Do not proceed to step 4 until both print OK.** Step 4 is what makes the update
visible to farmers; until then, nobody can click it, and that ordering is the only
thing standing between a failed build and a broken node.

### Step 4 — App-store clone pulls `main` · MANUAL

The Umbrel host holds a git clone of this repo as a community app store:

```
/home/umbrel/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0/
```

It tracks `main`. Refreshing it is what surfaces the new manifest version to
`umbreld`:

```bash
cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0
sudo git pull
```

> **OPEN QUESTION — refresh cadence.** The clone tracks `main` (confirmed). Whether
> `umbreld` also pulls it automatically on a timer, or whether the manual `git pull`
> above is strictly required, is **unconfirmed**. Treat the manual pull as required
> until resolved — doing it when it wasn't needed is harmless; skipping it when it
> was needed means farmers never see the update.
>
> To resolve: on the Umbrel host, note `git -C <clone> rev-parse HEAD`, push a
> commit to `main`, and poll that same command without pulling to see whether it
> advances on its own. `systemctl cat umbreld` and `sudo journalctl -u umbreld |
> grep -i "app-store\|git"` would show a scheduled fetch if one exists.

**Verify before moving on:**
```bash
grep '^version:' ~/umbrel/app-stores/ethancail-.../bitcorn-lightning-node/umbrel-app.yml
```
Shows the new version.

### Step 5 — `umbreld` offers the update · AUTOMATED

`umbreld` compares the manifest version in the store clone against the installed
version and surfaces an Update button. This is version-string comparison only — it
knows nothing about whether the images exist. Hence step 3a.

### Step 6 — Farmer clicks Update · MANUAL (not you)

You do not control the timing. Assume it can happen the instant step 4 completes,
which is why step 3a comes first.

### Step 7 — `umbreld` re-serializes compose and pulls · AUTOMATED

`umbreld` regenerates the deployed compose file from the store clone's copy,
merging its own fragment, then pulls the image tags **written in that file** — the
`X.Y.Z` pins from step 1, not `latest`.

The deployed copy lands at:
```
/home/umbrel/umbrel/app-data/bitcorn-lightning-node/docker-compose.yml
```

### Step 8 — `exports.sh` sources the operator `.env` · AUTOMATED

Umbrel's legacy-compat `source_app` runs `bitcorn-lightning-node/exports.sh` before
invoking compose. It sources
`${UMBREL_ROOT}/app-data/bitcorn-lightning-node/.env` inside `set -a` / `set +a`
so every assignment auto-exports and compose's `${VAR:-}` interpolation picks it up.

This exists because compose's `env_file:` directive **does not work here**: under
`umbreld`'s multi-`--file` invocation, a relative `.env` resolves against
umbreld's fragment directory rather than the app's, so the file isn't found.

⚠ **`exports.sh` fails silently.** This is the most dangerous behaviour in the
release path — see the dedicated [gotcha](#exportssh-fails-silently-and-there-is-no-built-in-detection).

The operator `.env` lives in `app-data/` and **survives updates** — it is not part
of the release and you do not need to recreate it per release.

### Step 9 — API boots; migrations run · AUTOMATED

`runMigrations()` is called at **module scope** in `app/api/src/index.ts`,
immediately after `initDb()` — so it runs on every container start, before the HTTP
server is listening. No manual migration step exists in the release procedure, and
none should be added.

The runner is **filename-keyed**: it reads applied filenames from a `migrations`
table and skips any file already recorded. Files are sorted, but because the key is
the filename string, the runner is **order-tolerant** — a numbering gap or an
out-of-order addition still runs each file exactly once, ever. It also tolerates
re-application of `ALTER TABLE … ADD COLUMN` by catching "duplicate column" /
"already exists", logging, and marking the file applied.

Migrations must still be idempotent. Never mutate schema by hand.

**Verify the release landed:**
```bash
sudo docker ps --format '{{.Names}}\t{{.Image}}' | grep bitcorn   # both images at X.Y.Z
```
That also gives you the API container's **actual** name, which you need below.

> ⚠ **The API container's name is not consistent across this repo's docs.**
> `docs/operator-runbook.md:69` uses `bitcorn-lightning-node_api_1` (underscores,
> Compose v1) and `docs/AUTOBUY_OPERATOR_GUIDE.md:85` uses
> `bitcorn-lightning-node-api-1` (hyphens, Compose v2). Which one is live depends on
> the Compose version `umbreld` invokes on that host, and I could not determine it
> from the repo. **Read the name off `docker ps` rather than typing either form.**
> Below, `$API` stands for whichever it is:
> ```bash
> API=$(sudo docker ps --format '{{.Names}}' | grep -E 'bitcorn.*api')
> ```

```bash
sudo docker logs "$API" 2>&1 | grep '\[db\] applied migration'
```

---

## Releasing from `develop`

**This is a variant, not the norm.** Practice since 2026-03-06 has been
feature-branch-straight-to-`main`; nothing has shipped through `develop` in roughly
five months, despite `CLAUDE.md` declaring `feature/*` → `develop` → `main`. If you
are doing a `develop` release, you are doing something the pipeline has not
exercised recently.

### ⚠ THE FOOTGUN: merging `develop` → `main` without a version bump

`main` currently sits at `1.17.19`. `develop` carries the same version string,
because a bump only happens as part of a release commit.

So merging `develop` → `main` as-is **fires the build on the existing version
string** and overwrites the `1.17.19` image tags with entirely different content.
The damage is quiet:

- Nodes already on `1.17.19` see **no update** — the version didn't change, so
  `umbreld` has nothing to offer. They keep running the old code.
- Any **fresh install** or any **re-pull** (force-pull recovery, container
  recreate, a new farmer onboarding) gets the *new* code under the *old* tag.
- The fleet silently splits into two populations both reporting `1.17.19`.

There is no way to distinguish them afterwards from the version string alone, and
the overwritten tag cannot be recovered — the previous `1.17.19` images are gone
from that tag.

### THE FIX — required ordering, not a suggestion

**Put the version-bump commit on `develop` BEFORE merging to `main`.**

```
1. On develop: commit the three-place bump (step 1 above) → push
2. Open develop → main PR
3. Merge
```

The merge then arrives already bumped. CI fires once, on the new version string,
publishing new tags and overwriting nothing. `umbreld` sees a higher version and
offers the update normally.

Doing it the other way — merge first, bump second — means **two** builds: one that
overwrites the current release's tags, and one that publishes the new version.
The first build is the damage, and it happens before you have a chance to fix it.

### `develop` also carries Worker source

As of today `develop` contains `cloudflare-worker/**` changes. That path is **not**
in CI's `paths:` filter, so a `develop` → `main` release carries Worker source into
`main` **without deploying it**. Meanwhile the deployed Worker is already ahead of
`main` independently, because it is deployed by hand.

Do not read "Worker code merged to main" as "Worker change shipped". See
[Scope](#what-this-doc-does-not-cover).

---

## Gotchas

### The three version strings must agree
`umbrel-app.yml` version, `docker-compose.yml` api tag, `docker-compose.yml` web tag.
**Drift causes:** `umbreld` offers version X.Y.Z but compose pins the old tags, so
farmers "update" to a new version number running the previous code. Nothing errors.

### Bumping only the compose file triggers no build
`bitcorn-lightning-node/docker-compose.yml` is **not** in CI's `paths:` filter.
**Prevents:** a release where you bumped the pins, saw no CI run, and concluded CI
was broken — when in fact the workflow correctly never fired. `umbrel-app.yml` must
be in the same commit to trigger the build.

### `latest` is not a pointer to the current release
`latest` is re-pointed by **any** push to `main` whose changed files match one of
CI's four `paths:` entries — not only releases. A `main` merge touching only
`docs/` or `bitcorn-lightning-node/docker-compose.yml` doesn't fire the workflow at
all, so `latest` is unchanged by those. But a non-release code merge to `app/api/**`
or `app/web/**` does move it.

Nothing consumes `latest` — compose pins exact versions — so this is currently
harmless. **Prevents:** someone using `latest` to identify or deploy "the current
release". It is "the most recent `main` build of a watched path", which is a
different thing.

### `exports.sh` fails silently, and there is no built-in detection

The entire body of `bitcorn-lightning-node/exports.sh` sits inside:

```bash
if [[ -f "${APP_ENV_FILE}" ]]; then
```

A missing `.env`, a wrong `UMBREL_ROOT`, or a typo'd path is therefore a **no-op
that exits 0 and prints nothing**. Compose then interpolates every `${VAR:-}` to
empty and services start with silently-blank operator config.

**Note the shape of the failure:** because compose uses `${VAR:-}`, the variable is
always *defined* in the container — just empty. So checking whether the key exists
tells you nothing; you must check the **value**.

**How to detect it after a release.** There is no aggregate check.
`GET /api/node/preflight` sounds like it would cover this and does **not** — it
tests exactly one thing, whether keysend is enabled, and nothing about operator
config. That absence is itself worth knowing.

The only reliable check is to read the container's environment directly:

```bash
API=$(sudo docker ps --format '{{.Names}}' | grep -E 'bitcorn.*api')   # see step 9 note
sudo docker exec "$API" sh -c \
  'for v in VALUATION_SUBMIT_HMAC VALUATION_WORKER_URL BASE_CHAIN_ID BASE_RPC_URL TUNNEL_TOKEN; do
     eval "val=\$$v"; [ -n "$val" ] && echo "$v: SET" || echo "$v: EMPTY"; done'
```

Any `EMPTY` for a var the operator set in `.env` means `exports.sh` didn't load.

Per-variable symptoms, ordered loudest to quietest — the quiet end is why the
direct check matters:

| Variable | Symptom when blank |
|---|---|
| `TUNNEL_TOKEN` | **Loud** — `cloudflared` can't connect; visible in `docker logs` |
| `BASE_RPC_URL` | Noticeable — SIWE smart-wallet verification throws "BASE_RPC_URL is not configured" |
| `VALUATION_SUBMIT_HMAC` | Quiet — treasury→Worker manual valuation submissions rejected on HMAC |
| `BASE_CHAIN_ID` | **Silent and dangerous** — `config/env.ts` falls back to `84532` (Sepolia) for empty/garbage. On a mainnet node this is wrong-chain SIWE with no error at all |
| `BITCOIN_NETWORK` | None — compose supplies a `mainnet` default |

So: **no good aggregate detection exists**, and the most dangerous variable is the
one with no symptom. Run the direct check as part of post-release verification
rather than waiting for a report.

### Install fails, flipping back to "Install" at 0%
Images don't exist on ghcr.io yet. Prevented by step 3a.
```bash
gh run list                      # find the failed build
gh run rerun <run-id> --failed
```

### Install reaches ~50% then resets
Port conflict.
```bash
sudo journalctl -u umbreld -n 100 | grep -i "already allocated"
sudo docker rm -f <conflicting-container>
```
Then retry the install.

### Half-installed after an early user click
The farmer clicked Update before the images finished building.
```bash
sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/api:X.Y.Z
sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/web:X.Y.Z
sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node
```

### Hotfix under the same tag
`umbreld` won't detect image changes for an unchanged tag. Force-pull + restart with
the same two commands as above. **Prefer a version bump** — a same-tag hotfix leaves
the fleet split across two different builds of one version, with no way to tell them
apart. (This is the same damage as the `develop` footgun, arrived at deliberately.)

### `cloudflared` floats on `:latest`
Every other image is pinned (`api:X.Y.Z`, `web:X.Y.Z`,
`lightning-terminal:v0.16.1-alpha`). `cloudflare/cloudflared:latest` is not, so its
content can change under a node on any container recreate — including during an
unrelated release. **Prevents:** attributing a tunnel regression to your release
when the tunnel image changed underneath it.

### `scripts/init-secrets.sh` does nothing — do not add it to a checklist
It generates `db.key`, `jwt.key`, `hmac.key` under `/data/secrets`. **All three are
read nowhere in the repo**, and the script is **invoked nowhere** — not by compose,
either Dockerfile, CI, or any npm script. It also carries a `TODO` at the top
("Generate and store required secrets"), which makes it read like pending work
rather than dead code. It is dead code.

Secrets that actually exist at runtime are written lazily by the API, on first need,
mode `0600` under a `0700` directory:
- `app/api/src/subscription/treasuryKeypair.ts` — Ed25519 signing key
- `app/api/src/autoBuy/credentials.ts` — auto-buy master key

**Prevents:** adding a "run init-secrets" step to a release or recovery checklist
and believing the node is provisioned because it printed success.

### `scripts/migrate.sh` is never invoked
It exists; the only reference anywhere is prose in `scripts/README.md`. Migrations
run via `runMigrations()` at API module scope (step 9). **Prevents:** a manual
migration step in a release checklist that does nothing, or worse, is expected to
have done something.

---

## Rollback (UNTESTED)

**Be honest with yourself reading this at 2am: no rollback has ever been performed
or tested in this repo, and no rollback procedure is documented anywhere else.**
Every recovery mechanism that does exist pushes *forward* — force-pull, restart,
rebuild, bump-and-rerelease. That is a real gap, not an oversight in this doc.

### What the mechanisms make possible

These are facts about the pipeline, from which a rollback *should* follow. None of
it has been exercised.

- **Prior images still exist in GHCR.** Every release published `X.Y.Z` tags, and
  nothing prunes them. Older versions should still be pullable:
  ```bash
  docker manifest inspect ghcr.io/ethancail/bitcorn-lightning-application/api:1.17.18
  ```
  Confirm this before relying on it.
- **Compose pins exact tags**, so pointing a node at an older version is an edit to
  two lines of its deployed compose file plus a restart — not a rebuild.
- **The operator `.env` lives in `app-data/` and survives**, so a downgrade does not
  lose operator config.

### The forward fix, which IS exercised

**Prefer this.** Ship `X.Y.Z+1` containing the revert. It uses the tested path
end to end, farmers get a normal update prompt, and the fleet converges on one
known build. Slower, but it is the only route with 26 successful runs behind it.

### The untested downgrade, if you cannot wait

Sketch only. Read every line before running any of it.

```bash
# On the Umbrel host
cd /home/umbrel/umbrel/app-data/bitcorn-lightning-node
sudo cp docker-compose.yml docker-compose.yml.bak     # you will want this
sudo sed -i 's|/api:X.Y.Z|/api:X.Y.Z-PREV|' docker-compose.yml
sudo sed -i 's|/web:X.Y.Z|/web:X.Y.Z-PREV|' docker-compose.yml
sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/api:X.Y.Z-PREV
sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/web:X.Y.Z-PREV
sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node
```

### ⚠ Genuinely unknown — do not guess at these

1. **Whether `umbreld` overwrites your hand-edited compose file.** Step 7 says
   `umbreld` *re-serializes* the deployed compose from the store clone. If it does
   that on restart — not only on update — your edit is reverted and the node comes
   back on the new version. **Unknown. This is the single biggest risk in the
   procedure above.**
2. **Whether `umbreld` will then re-offer the update**, since the store clone still
   advertises the newer version. It probably will, meaning the downgrade is
   unstable and a farmer could re-update at any time. To hold a node down you would
   likely also need to roll back the store clone, which affects **every** node.
3. **Migrations do not roll back.** There is no down-migration mechanism — none of
   the 53 migrations has one, and the runner has no concept of reversing. A newer
   version's schema changes **persist** across a downgrade. Whether the older code
   tolerates the newer schema is per-migration and unknown. Additive changes
   (`ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`) are likely fine; anything that
   rewrote or reinterpreted existing data is not. **Check what the release's
   migrations did before downgrading.**
4. **A rolled-back node is a fleet fork.** It reports an older version while the
   store advertises a newer one.

### If you do attempt a downgrade

Write down what happened and update this section. It is the only way this stops
being untested.

---

## What this doc does NOT cover

### The Cloudflare Worker is a separate artifact — decoupled in BOTH directions
`cloudflare-worker/` is deployed by hand with `wrangler deploy`. It has **no CI, no
version number, and no coupling to the app release cycle.**

- **A Worker change does not reach nodes via an app release.** Merging
  `cloudflare-worker/**` to `main` ships nothing — that path is not in CI's `paths:`
  filter, so no build even runs. Someone must run `wrangler deploy`.
- **And the reverse:** the deployed Worker can be — and currently is — *ahead of*
  `main`, because hand-deploys don't wait for merges. `main` is not a record of what
  the Worker is running.

⚠ `wrangler deploy` ships the **working tree**, not a committed ref. Check
`git status` before running it. That mechanism is how unreleased code reached
production on 2026-07-16. Worker *configuration* is set with `wrangler secret put`,
which needs no deploy — keep it that way so deploy day never requires one.

Worker specifics: `docs/COINBASE_INTEGRATION.md`.

### Mainnet stablecoin-rail cutover
Worker rail configuration, per-node `base_sync_cursor` reset, clearing
`base_settlement_event`, and the fee-activation Safe transaction are **one-off
launch steps, not release steps.** They live in
`bitcorn-research/runbooks/2026-07-01-mainnet-deploy-preflight.md` and are
deliberately not duplicated here — a launch runbook and a release procedure have
different lifetimes, and copying the former into the latter guarantees it goes
stale.

### No test gate runs in CI
State this plainly to yourself before every merge: **the release pipeline runs no
tests.** `docker-publish.yml` builds and pushes; it does not invoke `vitest`, `tsc`,
or any check. A green merge and a green build mean the images compiled, nothing
more.

Tests exist and are worth running — locally, before you open the PR:
```bash
cd app/api && npx tsc --noEmit && npx vitest run
cd app/web && npx tsc --noEmit && npx vite build && npx vitest run
cd cloudflare-worker && npm run typecheck && npm test
```
Known baseline: the Worker suite has 9 pre-existing failures (`/valuation/*` tests
sending no Bearer and expecting 200). The web `tsc` has 4 pre-existing recharts
errors. Neither blocks a release; both mean "compare to baseline", not "must be
zero".

---

## Open questions

| Question | Status | How to resolve |
|---|---|---|
| Does the Umbrel app-store clone auto-pull on a timer, or is the manual `git pull` required? | Clone tracks `main` — **confirmed**. Refresh cadence — **unconfirmed** | Note `git -C <clone> rev-parse HEAD`, push to `main`, poll without pulling. Also `systemctl cat umbreld` and `journalctl -u umbreld \| grep -i "app-store\|git"` |
| Does `umbreld` overwrite a hand-edited deployed compose file on restart, or only on update? | **Unknown** — blocks any reliable downgrade | Edit a harmless value in the deployed compose, `apps.restart.mutate`, check whether the edit survives |
| Will `umbreld` re-offer an update to a manually downgraded node? | **Unknown** | Falls out of the above |
