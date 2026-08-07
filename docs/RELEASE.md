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

Two claims here are **not** tree-derived and cannot be: step 4's automatic refresh
and step 6's pending-update behaviour come from observing a live node on 2026-08-03.
Both are labelled with what that observation does and does not cover — the repo
cannot tell you how `umbreld` behaves at runtime.

---

## The nine steps

| # | Step | Who |
|---|---|---|
| 1 | Bump three places in one commit | **MANUAL** |
| 2 | `release/vX.Y.Z` → PR → merge to `main` | **MANUAL** |
| 3 | CI builds and pushes both images | AUTOMATED |
| **3a** | **Verify the images actually reached GHCR** | **MANUAL — do not skip** |
| 4 | Umbrel host's app-store clone refreshes from `main` | AUTOMATED |
| 5 | `umbreld` sees the higher version, offers the update | AUTOMATED |
| 6 | User clicks Update | **MANUAL (the farmer) — ⚠ [the real gap](#updates-reach-nodes-automatically-they-apply-only-when-someone-clicks)** |
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
nothing you didn't intend. **A PR gate runs, but nothing gates the merge** — see
[Scope](#what-this-doc-does-not-cover). `pr-checks.yml` reports on the PR; `main`
is not a protected branch, so no check can block the merge, and nothing re-checks
anything afterwards. A green merge means "merged", not "tests passed".

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

**This is the step that catches `CLAUDE.md`'s "install fails at 0%".** The causal
chain: if a farmer clicks Update before the images exist on ghcr.io, `umbreld`
tries to pull a tag that isn't there, the install flips back to "Install" at 0%,
and the node is left in a broken half-state requiring the recovery in
[Gotchas](#gotchas).

⚠ **This step detects that condition; it no longer prevents it.** It used to be
described as prevention, on the assumption that step 4 was a manual gate you held
shut until the build was green. Step 4 is automated (see below) and fires on its own
within minutes of the merge, so **the update becomes clickable whether or not the
images exist, and you cannot hold it back.** Run this immediately after merging and
be ready to fix forward — a rerun, or the force-pull recovery in
[Gotchas](#half-installed-after-an-early-user-click) — rather than treating a green
check here as having closed the window.

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

Both must print OK. If either does not, you are already in the window where a
farmer can click a broken update — go to step 3a's fix-forward path above, and do
not wait on step 4, which is not waiting on you.

### Step 4 — App-store clone refreshes from `main` · AUTOMATED

The Umbrel host holds a git clone of this repo as a community app store:

```
/home/umbrel/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0/
```

It tracks `main`, and it is a **grafted (shallow) checkout** — `git log` there shows
truncated history, and anything needing full history will not work in it. Refreshing
it is what surfaces the new manifest version to `umbreld`.

**This refresh happens without operator action.** This step used to be documented as
MANUAL with the cadence unknown; that was the largest hole in this doc, because
whether a release reached nodes at all depended on it. It is now observed.

**Observed 2026-08-03:** minutes after PR #242 merged to `main`, the clone on the
treasury node was already at `19a667c`, with
`bitcorn-lightning-node/umbrel-app.yml` reading `1.17.20`, and **no manual
`git pull` had been run** `[RELAYED — Ethan's terminal, 2026-08-03]`.

⚠ **What that observation does and does not establish.** It is one data point, taken
minutes after one merge, on one node — the treasury. Read it for exactly that much:

- **Established:** the clone advances on its own. The manual `git pull` this step
  used to require is **not** required.
- **NOT established — the interval.** "Minutes" is the observed latency of a single
  refresh, not a bound on the next one.
- **NOT established — timer or event-driven.** Nobody has read the mechanism. A
  scheduled fetch, a webhook, and a fetch triggered by opening the app store in the
  UI would all look identical from this one observation.
- **NOT established — that member nodes behave identically.** Only the treasury was
  observed. Members run the same `umbreld`, so the same behaviour is *expected*;
  expected is not observed.

Forcing it is still safe, and is still how you make the refresh immediate rather
than eventual:

```bash
cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0
sudo git pull
```

**Verify the state rather than trusting the paragraph above.** On the node, compare
the clone's HEAD and its advertised version against `main`:

```bash
STORE=~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0

# What the clone is at, and what it is advertising to umbreld
sudo git -C "$STORE" rev-parse HEAD
grep '^version:' "$STORE"/bitcorn-lightning-node/umbrel-app.yml

# What main is actually at. Ask the remote — the clone is shallow, so its own log
# is not a reliable comparison. Uses the URL rather than a remote name, so it also
# runs from your dev machine.
git ls-remote https://github.com/ethancail/bitcorn-lightning-application refs/heads/main
```

HEAD matching the `ls-remote` hash, and the version matching the release you just
merged, means the refresh has landed. If HEAD is behind, either it has not fired yet
or it does not fire on this node — `sudo git pull`, and **record which**, because
that is the observation this step is still missing.

### Step 5 — `umbreld` offers the update · AUTOMATED

`umbreld` compares the manifest version in the store clone against the installed
version and surfaces an Update button. This is version-string comparison only — it
knows nothing about whether the images exist. Hence step 3a.

### Step 6 — Farmer clicks Update · MANUAL (not you)

You do not control the timing. Assume it can happen within minutes of the merge,
because step 4 puts it there on its own.

#### Updates reach nodes automatically. They apply only when someone clicks.

⚠ **This is the real gap in the update path.** It is larger than the step-4 refresh
cadence question it replaced, and it points the opposite way from what that question
assumed. The worry used to be that a release might never reach a node. Releases do
reach nodes, on their own. What they do not do is **install**.

`umbreld` renders a pending-update tile and waits. Indefinitely. Nothing expires,
nothing escalates, nothing forces.

**Observed 2026-08-03:** the treasury node was sitting on a pending update tile for
`1.17.20` that the operator had not clicked. The version `main` offered and the
version the node was running had already diverged, and nothing anywhere reported
that they had.

What follows from that:

- **"Released" is not "running."** The two diverge by however long an operator waits
  before clicking. For the treasury that is one person. For a fleet of member nodes
  it is every farmer, independently, with no coordination between them.
- **A release can sit unapplied indefinitely** — including one carrying a security or
  money-affecting fix. Shipping it is not deploying it.
- **You cannot see the divergence.** There is currently **no way to know what version
  a member node is actually running.** No telemetry, no version report, no check-in.
  The treasury knows its own version and nothing else's, so fleet version state is
  not merely stale — it is unobserved.
- **No mechanism exists to prompt or to verify.** Not "the existing one is
  unreliable" — there is none.

⚠ **Launch consideration, recorded as a gap and nothing more.** Whether to change
any of this, and how, is an unmade design decision. Nothing here proposes or implies
a chosen direction; do not read one out of it.

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

### No test gate runs on the RELEASE path — the PR gate is a different thing
State this plainly to yourself before every merge: **`docker-publish.yml` runs no
tests.** It builds and pushes; it does not invoke `vitest`, `tsc`, or any check
(re-verified 2026-08-04: `grep -niE "vitest|tsc|npm test"` over it returns nothing).
A green merge and a green build mean the images compiled, nothing more.

⚠ **This section used to be titled "No test gate runs in CI." That is no longer
true.** `.github/workflows/pr-checks.yml` exists on both `main` and `develop` and
runs on pull requests. The narrower claim above still holds, and it is the one that
matters here: **a PR gate is not a release gate.** Nothing re-checks anything
between the merge and the image publish.

Do not read the job list off this page — it has been rewritten twice already. Ask
the file:

```bash
grep -nE "^  [a-z-]+:$|    name:|continue-on-error" .github/workflows/pr-checks.yml
```

⚠ **A green check does not mean a merge is blocked.** `main` is not a protected
branch, so none of these jobs is a *required* status check: the gate reports, it
does not prevent. This flips with a settings toggle and nothing in the repo records
it, so re-check rather than trusting this paragraph:

```bash
gh api repos/ethancail/bitcorn-lightning-application/branches/main/protection
# HTTP 404 "Branch not protected" = nothing is required
```

⚠ **The thresholds went fully strict in PR #255 (2026-08-07)** — two ceilings at
zero, two collection floors. They were branch-aware between PRs #244 and #255,
keyed on `github.base_ref`, because the two trees genuinely differed then. v1.18.0
converged the branches and those arms became pure slack — a `main`-based PR was
still being allowed a tree's worth of errors that no longer existed — so they were
collapsed. Read the current values from the file, never from here:

```bash
grep -nE "TSC_CEILING:|MAX_FAILURES:|MIN_TOTAL:" .github/workflows/pr-checks.yml
```

A floor is not a ceiling. `MIN_TOTAL` asserts enough tests were **collected**,
which is the failure a passing exit code cannot catch — see the note below on why
the numbers here kept rotting.

⚠ **Check whether the two branches' copies agree; do not assume either way.** They
have diverged before, which is why this warning exists, and they are identical as
of 2026-08-07. One command settles it:

```bash
git diff origin/main origin/develop -- .github/workflows/pr-checks.yml   # empty = identical
```

Tests exist and are worth running — locally, before you open the PR:
```bash
cd app/api && npx tsc --noEmit && npx vitest run
cd app/web && npx tsc --noEmit && npx vite build && npx vitest run
cd cloudflare-worker && npm run typecheck && npm test
```

⚠ **Distinguish could-not-run from failed.** All of those commands run on both
trees today — `main` gained the web vitest standup (`vitest` devDependency, `test`
script, `vitest.config.ts`) and the Worker `typecheck` script at v1.18.0. Until
then, two of them did not exist on `main` at all, and **a "command not found" is
not a red suite.** The specific instance is gone; keep the habit, because it is
exactly how the tsc discrepancy below went unnoticed for weeks.

#### Derive the numbers. Do not read them off this page.

This section has gone stale three times by recording values — twice as a single
number, once as a per-tree table. It no longer records any. **Get the current
figures:**

```bash
cd cloudflare-worker && npx vitest run 2>&1 | grep -E "Test Files|Tests "
cd app/api          && npx vitest run 2>&1 | grep -E "Test Files|Tests "
cd app/web          && npx vitest run 2>&1 | grep -E "Test Files|Tests "
cd app/web          && npx tsc --noEmit  2>&1 | grep -c "error TS"
```

The instruction is now simply **"must be clean"**. The older "compare against *that
tree's* baseline, never must be zero" was correct only while the two trees differed
and the thresholds tolerated a per-tree backlog; both of those ended at v1.18.0 and
PR #255.

What is worth carrying forward is *why* the numbers here kept rotting, because it
was a different mechanism each time:

- **A recorded count is stale the moment anyone adds a test.** Store the command
  that answers it, not the answer. This is the general rule in CLAUDE.md § STATE.md
  — volatile state is a query, not a fact.
- **A threshold conditioned on a branch does not break when its premise dies — it
  silently becomes slack.** The `main` arms went on allowing a backlog of tsc errors
  and Worker failures after convergence had removed every one of them, and nothing
  went red to say so. If you add a branch-conditional threshold, write its
  retirement condition beside it, as those arms did.
- **`main`'s tsc count was once far higher than what you would measure locally** —
  CI installed from `main`'s own `package.json`, which then carried no `vitest`
  devDependency, while `main` still tracked the test files, so `tsc` added a
  TS2307 per file plus a knock-on TS7006. An audit scoped to what a job *measures*
  can miss what its environment *provides*.

None of it blocks a release, and per the branch-protection note above, none of it
blocks a merge either.

---

## Open questions

| Question | Status | How to resolve |
|---|---|---|
| ~~Is the manual `git pull` of the app-store clone required, or does it refresh on its own?~~ | **CLOSED 2026-08-03 — it refreshes on its own.** Was the largest hole in this doc; the manual pull is not required. See [step 4](#step-4--app-store-clone-refreshes-from-main--automated) | Resolved by observation, not by test — one data point, minutes after PR #242, on the treasury node |
| What is the refresh interval, is it timer- or event-driven, and do member nodes behave the same? | **Unknown** — the residual of the row above. Does not block a release: the refresh is no longer the bottleneck (the [update click](#updates-reach-nodes-automatically-they-apply-only-when-someone-clicks) is) | `systemctl cat umbreld`; `journalctl -u umbreld \| grep -i "app-store\|git"`; and repeat the step-4 HEAD comparison on a **member** node after a release |
| How do you know what version a member node is actually running? | **You cannot.** No telemetry, no version report, no check-in exists. Named as a launch consideration under [step 6](#updates-reach-nodes-automatically-they-apply-only-when-someone-clicks) | Not a question to resolve by investigation — it is an unmade design decision |
| Does `umbreld` overwrite a hand-edited deployed compose file on restart, or only on update? | **Unknown** — blocks any reliable downgrade | Edit a harmless value in the deployed compose, `apps.restart.mutate`, check whether the edit survives |
| Will `umbreld` re-offer an update to a manually downgraded node? | **Unknown** | Falls out of the above |
