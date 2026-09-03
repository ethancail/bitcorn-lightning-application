# RELEASE — how a version reaches farmers' nodes

The procedure below has been identical across every release. It has never been
written down until now. **How many releases that is, and which commit published
each, is recorded in `docs/release-history.md`** — reconstructed from build
evidence rather than from memory or branch names. Read the count there; do not
record one here, because a number written on this page is stale the next time
anything ships.

**Releases now carry a git tag, created by CI.** That is new, and it reverses what
this page used to say: until 2026-08-11 the repo had no tags at all, and this
paragraph asserted a count of zero. Tags were then backfilled by hand for every
historical version, and step 2.5 below makes the pipeline create them going
forward. Ask the remote for the count rather than trusting a number here:

```bash
git ls-remote --tags origin | grep -v '\^{}' | wc -l
```

Provenance of the backfilled set, and the version → publishing-commit mapping:
`docs/release-history.md`.

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

## The steps

| # | Step | Who |
|---|---|---|
| 1 | Bump the version everywhere it is pinned, in one commit | **MANUAL** |
| 2 | `release/vX.Y.Z` → PR → merge to `main` | **MANUAL** |
| **2.5** | **CI tags the release — before any image is pushed** | AUTOMATED |
| 3 | CI builds and pushes the images | AUTOMATED |
| **3a** | **Verify the images and the tag actually landed** | **MANUAL — do not skip** |
| 4 | Umbrel host's app-store clone refreshes from `main` | AUTOMATED |
| 5 | `umbreld` sees the higher version, offers the update | AUTOMATED |
| 6 | User clicks Update | **MANUAL (the farmer) — ⚠ [the real gap](#updates-reach-nodes-automatically-they-apply-only-when-someone-clicks)** |
| 7 | `umbreld` re-serializes compose, pulls the pinned tags | AUTOMATED |
| 8 | `exports.sh` sources the operator `.env`; compose starts | AUTOMATED |
| 9 | API boots; migrations run | AUTOMATED |

---

### Step 1 — Bump the version everywhere it is pinned, in ONE commit · MANUAL

**The set, not a count:** the `version:` in `umbrel-app.yml`, plus **every Bitcorn
image tag in `docker-compose.yml`** — that is, every `image: ghcr.io/…` line. All of
them must read the same `X.Y.Z`, in the same commit.

Do not memorise how many that is. It was three strings until v1.18.9 and is four
since, because the compose file gained a `loopd` pin — and the next component to
join the set will falsify any number written here too. Enumerate it instead:

```bash
grep -c 'image: ghcr.io' bitcorn-lightning-node/docker-compose.yml   # how many compose pins exist
```

⚠ `cloudflare/cloudflared:latest` is deliberately **not** in that set — it is
unpinned on purpose ([gotcha](#cloudflared-floats-on-latest)), which is why the
command greps `ghcr.io` rather than `image:`.

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
**PASS:** every tag the second command prints is identical to the version the first
prints. Count the lines it actually returns — do not stop after a remembered
number, which is how a stale `loopd` pin ships unnoticed (nothing downstream
catches that one: see [step 5](#step-5--umbreld-offers-the-update--automated)'s
version-string-only comparison). Then confirm they're in the same commit:
```bash
git show --stat HEAD
```

### Step 2 — `release/vX.Y.Z` branch → PR → merge to `main` · MANUAL

Branch, push, open a PR, merge. Merging is what fires everything downstream.

**Which branch to cut from:** in practice, straight from the feature branch or
from `main`. See [Releasing from `develop`](#releasing-from-develop) before doing
the `develop` variant — it has a footgun the normal path doesn't.

**Verify before moving on:** the PR's diff contains every version string from
[step 1](#step-1--bump-the-version-everywhere-it-is-pinned-in-one-commit--manual)
and nothing you didn't intend. **`pr-checks.yml`'s jobs are required status checks, so
the gate now blocks the merge** — which it did not always do. Do not take that from
this page, and do not take the list of what is required from here either; both are
settings that change without touching the repo. Ask, per
[Scope](#what-this-doc-does-not-cover):

```bash
gh api repos/ethancail/bitcorn-lightning-application/rulesets
gh api repos/ethancail/bitcorn-lightning-application/branches/main/protection
```

**⚠ A green merge still does not mean the release is verified.** Nothing re-checks
anything between the merge and the image publish — a PR gate is not a release gate,
and `docker-publish.yml` runs no tests. See
[No test gate runs on the RELEASE path](#no-test-gate-runs-on-the-release-path--the-pr-gate-is-a-different-thing).

### Step 2.5 — CI tags the release, BEFORE any image is pushed · AUTOMATED

The push to `main` fires `docker-publish.yml`, and the **first** thing it does — in
`get-version`, before any `build-*` job starts — is assert that
`v<version>` does not already exist, then create and push it.

**The ordering is the mechanism, not a detail.** `get-version` is the sole common
ancestor of every build job (each declares `needs: get-version`), so a failure there
leaves **all of them un-started and nothing published**. That is what makes a duplicate
version stop the release instead of being discovered afterwards. Placing the same
check inside a build job would fail *open*: the `VITE_BASE_CHAIN_ID` guard lives in
`build-web`, and when it trips, `build-api` is concurrently pushing its image and
re-pointing `latest`, because the build jobs do not depend on each other.

What the tag step will refuse:

- **A version whose tag already exists** — the republish incident this repo has
  already had twice. It prints two remedies: bump the version everywhere
  [step 1](#step-1--bump-the-version-everywhere-it-is-pinned-in-one-commit--manual)
  pins it, or (for the deliberate same-tag hotfix) delete the tag and re-run.
  ⚠ **The `allow-same-tag-republish` PR label does NOT reach this assert** — it
  skips `pr-checks.yml`'s `version-bump` job and nothing else. This step is
  label-agnostic by design (a push event carries no PR labels), so a deliberate
  republish still requires deleting the tag. Verified by execution, not by
  reading: the assert reads only the version and the tag, and refuses with the
  label supplied every way GitHub could supply it.
- **A manifest it cannot read.** An unreadable `umbrel-app.yml` used to yield an
  empty version string and publish images tagged with the empty string. It is now a
  hard failure. Could-not-determine is a failure, not a pass.
- **A checkout with no tags at all**, which would make the duplicate check blind
  and pass on everything. The step verifies it can see tags before concluding
  anything from their absence.

⚠ **THE TAG-FIRST RESIDUAL — the accepted cost of this ordering.** Because the tag
is pushed *before* the builds, a build that fails afterwards leaves a tag pointing
at a commit whose images never published. The tag then names a version that is not
installable.

The remedy is the same delete-and-re-run the failure text prints for a deliberate
republish — **one mechanism covers both cases**:

```bash
git push origin :refs/tags/vX.Y.Z
git tag -d vX.Y.Z
gh run rerun <run-id>
```

This is deliberate. Tagging *last* would avoid the dangling tag and fail **open**:
the images would already be published by the time anything noticed the version was
a duplicate, which is the failure that matters. A tag that over-promises is
recoverable in three commands; an overwritten image tag is not recoverable at all.

**Note the tag prefix.** Image tags are bare (`1.18.3`); git tags are `v`-prefixed
(`v1.18.3`). The workflow adds the `v` in one place and nowhere else.

### Step 3 — CI builds and pushes the images · AUTOMATED

`.github/workflows/docker-publish.yml` fires on push to `main`, but **only** when
the changed files match one of its `paths:` entries. **Print the filter rather than
trusting a list on this page** — this block has been wrong before, and a path
missing from a copy here reads as "that change publishes nothing", which is the
most expensive way to be wrong about this file:

```bash
python3 -c 'import yaml,sys; d=yaml.safe_load(open(".github/workflows/docker-publish.yml")); print("\n".join((d.get(True) or d["on"])["push"]["paths"]))'
```

Or, without a YAML parser:

```bash
sed -n '/^    paths:/,/^[a-z]/p' .github/workflows/docker-publish.yml | grep -E '^      - '
```

⚠ **`bitcorn-lightning-node/docker-compose.yml` is deliberately NOT in that
filter** — a compose-only bump therefore triggers no build at all. That is by
design, and the reason is
[step 1's one-commit rule](#step-1--bump-the-version-everywhere-it-is-pinned-in-one-commit--manual);
the consequence is spelled out at
[Bumping only the compose file triggers no build](#bumping-only-the-compose-file-triggers-no-build).
Do not "fix" the filter without reading both.

A `get-version` job greps the version out of the manifest —
`grep '^version:' bitcorn-lightning-node/umbrel-app.yml` — and every build job
consumes it. Each image gets **three tags** (a closed set — the workflow's
`metadata-action` emits exactly these):

- `latest`
- `X.Y.Z` ← the only one that matters; it's what compose pins
- `<short-sha>`

Every image builds for `linux/amd64,linux/arm64`. The web build additionally bakes
`VITE_BASE_CHAIN_ID` into the bundle at build time, defaulting to `84532`
(Base Sepolia) — a guard fails the build if the repo variable is unset or
unsupported on a `main` build.

### Step 3a — VERIFY THE IMAGES AND THE TAG LANDED · MANUAL — do not skip

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
Every build job must be `completed / success`. If a job failed:
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
docker manifest inspect ghcr.io/ethancail/bitcorn-lightning-application/loopd:X.Y.Z >/dev/null && echo LOOPD OK
```

**Check one line per image the compose file pins** — derive that set from
[step 1](#step-1--bump-the-version-everywhere-it-is-pinned-in-one-commit--manual)
rather than from the number of lines above. `loopd` was absent from this check for
its first release, which is the omission that matters most here: a missing `loopd`
tag produces exactly the flips-back-to-Install-at-0% failure this step exists to
catch, and nothing else in the pipeline looks for it.

Every one must print OK. If any does not, you are already in the window where a
farmer can click a broken update — go to step 3a's fix-forward path above, and do
not wait on step 4, which is not waiting on you.

**Then confirm the tag reached `origin` and points where you think it does.** The
images and the tag can disagree: [step 2.5](#step-25--ci-tags-the-release-before-any-image-is-pushed--automated)
pushes the tag first, so a failed build leaves the tag present and the images
absent. Checking only the images would miss that, and checking only the tag would
miss the reverse.

```bash
git ls-remote --tags origin "refs/tags/vX.Y.Z"     # the tag exists on origin
git fetch origin --tags && git rev-list -n1 vX.Y.Z # ...and points at the merge commit
```

If the tag is present but a build failed, use the delete-and-re-run in step 2.5
rather than leaving a tag that names an uninstallable version.

### Step 4 — App-store clone refreshes from `main` · AUTOMATED

The Umbrel host holds a git clone of this repo as a community app store, under
`~/umbrel/app-stores/`. **The directory name carries a per-node suffix — derive it,
never paste one:**

```bash
ls ~/umbrel/app-stores/
STORE=$(echo ~/umbrel/app-stores/*bitcorn-lightning-application*)
echo "$STORE"
```

On the treasury node in 2026-08 that resolved to
`…/ethancail-bitcorn-lightning-application-github-020f9ee0/`, but the suffix is
assigned per install. The farmer is the operator here and there is no second
machine to normalise against, so a pasted path is wrong on every node but one.

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
cd "$(echo ~/umbrel/app-stores/*bitcorn-lightning-application*)"
sudo git pull
```

**Verify the state rather than trusting the paragraph above.** On the node, compare
the clone's HEAD and its advertised version against `main`:

```bash
STORE=$(echo ~/umbrel/app-stores/*bitcorn-lightning-application*)

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
sudo docker ps --format '{{.Names}}\t{{.Image}}' | grep bitcorn   # every Bitcorn image at X.Y.Z
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

`develop` normally carries the **same** version string as `main`, because a bump
only happens as part of a release commit. Check rather than assume — the two can
also differ, and which it is changes what happens next:

```bash
git show origin/main:bitcorn-lightning-node/umbrel-app.yml    | grep '^version:'
git show origin/develop:bitcorn-lightning-node/umbrel-app.yml | grep '^version:'
```

When they match, merging `develop` → `main` as-is **fires the build on the existing
version string** `X.Y.Z` and overwrites its image tags with entirely different
content. The damage is quiet:

- Nodes already on `X.Y.Z` see **no update** — the version didn't change, so
  `umbreld` has nothing to offer. They keep running the old code.
- Any **fresh install** or any **re-pull** (force-pull recovery, container
  recreate, a new farmer onboarding) gets the *new* code under the *old* tag.
- The fleet silently splits into two populations both reporting `X.Y.Z`.

There is no way to distinguish them afterwards from the version string alone, and
the overwritten tag cannot be recovered — the previous `X.Y.Z` images are gone
from that tag.

**Two gates now catch this, and neither existed when it happened.**
[Step 2.5](#step-25--ci-tags-the-release-before-any-image-is-pushed--automated)
refuses to publish when `vX.Y.Z` already exists, and `pr-checks.yml`'s
`Version bumped` job fails a PR to `main` that changes `app/api`/`app/web` without
a bump. Note the residual gap rather than trusting them completely: that PR check
diffs `app/api` and `app/web` **only**, so a merge touching just `app/loopd/**`,
`umbrel-app.yml`, or `docker-publish.yml` fires the workflow without that check
objecting — those paths are in the publish filter but outside the check's diff.
Step 2.5 is what covers all three: with the version unchanged its tag already
exists, so the assert refuses and **nothing is published**. The two gates
genuinely disagree about what counts as a release, and Step 2.5 is the one that
decides whether anything ships.

### THE FIX — required ordering, not a suggestion

**Put the version-bump commit on `develop` BEFORE merging to `main`.**

```
1. On develop: commit the step-1 bump — every pinned version string → push
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

### Every pinned version string must agree
`umbrel-app.yml`'s `version:`, and every `image: ghcr.io/…` tag in
`docker-compose.yml` — enumerate them per
[step 1](#step-1--bump-the-version-everywhere-it-is-pinned-in-one-commit--manual)
rather than counting from memory.
**Drift causes:** `umbreld` offers version X.Y.Z but compose pins the old tags, so
farmers "update" to a new version number running the previous code. Nothing errors.
⚠ **CI checks only the `api` and `web` tags.** A stale `loopd` pin passes every
gate and ships silently — that one is on this step alone.

### Bumping only the compose file triggers no build
`bitcorn-lightning-node/docker-compose.yml` is **not** in CI's `paths:` filter.
**Prevents:** a release where you bumped the pins, saw no image published, and
concluded the build was broken — when in fact the workflow correctly never fired.
`umbrel-app.yml` must be in the same commit to trigger the build. Note the PR gate
still runs on such a PR, so green checks are **not** evidence that a build fired —
only GHCR is (step 3a).

### `latest` is not a pointer to the current release
`latest` is re-pointed by **any** push to `main` whose changed files match one of
CI's `paths:` entries — not only releases; print that filter per
[step 3](#step-3--ci-builds-and-pushes-the-images--automated). A `main` merge
touching only `docs/` or `bitcorn-lightning-node/docker-compose.yml` doesn't fire
the workflow at all, so `latest` is unchanged by those. But a non-release code
merge to a filtered path — `app/api/**`, `app/web/**`, `app/loopd/**` — does move it.

The workflow also carries `workflow_dispatch:`, which adds a second way in:
**a manual dispatch re-points `latest` from whatever ref it is dispatched on.**
No `paths:` filter applies to a dispatch, and no build job pins `ref:` on
checkout, so the ref chosen in the Run-workflow UI is what gets built and
tagged — it need not be `main`.

Nothing consumes `latest` — compose pins exact versions — so this is currently
harmless. **Prevents:** someone using `latest` to identify or deploy "the current
release". It is "the most recent published build, from whichever ref
produced it", which is a different thing.

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
sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/loopd:X.Y.Z
sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node
```

Three images since v1.18.9, not two. Miss the `loopd` pull and the node comes
back running the previous release's Loop daemon against the current release's
api — with nothing on the node reporting the mismatch.

### Hotfix under the same tag
`umbreld` won't detect image changes for an unchanged tag. Force-pull **every**
Bitcorn image, then restart — the same commands as
[Half-installed](#half-installed-after-an-early-user-click) above, one pull per
image the compose file pins. **Prefer a version bump** — a same-tag hotfix leaves
the fleet split across two different builds of one version, with no way to tell them
apart. (This is the same damage as the `develop` footgun, arrived at deliberately.)

### `cloudflared` floats on `:latest`
Every other image is pinned (`api:X.Y.Z`, `web:X.Y.Z`, and since v1.18.9
`loopd:X.Y.Z`). `cloudflare/cloudflared:latest` is not, so its
content can change under a node on any container recreate — including during an
unrelated release. **Prevents:** attributing a tunnel regression to your release
when the tunnel image changed underneath it.

### `scripts/init-secrets.sh` does nothing — do not add it to a checklist
It generates `db.key`, `jwt.key`, `hmac.key` under `/data/secrets`. **All three are
read nowhere in the repo**, and the script is **invoked nowhere** — not by compose,
by any Dockerfile, by CI, or by any npm script. It also carries a `TODO` at the top
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
  every `image: ghcr.io/…` line of its deployed compose file plus a restart — not a
  rebuild. Edit them all: leaving one behind mixes releases on one node.
- **The operator `.env` lives in `app-data/` and survives**, so a downgrade does not
  lose operator config.

### The forward fix, which IS exercised

**Prefer this.** Ship `X.Y.Z+1` containing the revert. It uses the tested path
end to end, farmers get a normal update prompt, and the fleet converges on one
known build. Slower, but it is the only route with every past release behind it —
`docs/release-history.md` has the run tally and the version → commit mapping.

### The untested downgrade, if you cannot wait

Sketch only. Read every line before running any of it.

```bash
# On the Umbrel host
cd /home/umbrel/umbrel/app-data/bitcorn-lightning-node
sudo cp docker-compose.yml docker-compose.yml.bak     # you will want this
sudo sed -i 's|/api:X.Y.Z|/api:X.Y.Z-PREV|' docker-compose.yml
sudo sed -i 's|/web:X.Y.Z|/web:X.Y.Z-PREV|' docker-compose.yml
sudo sed -i 's|/loopd:X.Y.Z|/loopd:X.Y.Z-PREV|' docker-compose.yml
sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/api:X.Y.Z-PREV
sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/web:X.Y.Z-PREV
sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/loopd:X.Y.Z-PREV
sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node
```

⚠ **One `sed` per `image: ghcr.io/…` line the file actually has** — check with
`grep -c 'image: ghcr.io' docker-compose.yml` before assuming the three above are
all of them.

⚠ **The `loopd` line only swaps cleanly back to v1.18.9 or later.** Earlier
releases ran Lightning Terminal in that service slot — same service *name*, a
completely different command list and a required `LIT_PASSWORD` — so a target
below v1.18.9 is **not** an image-tag swap at all; it is a whole-service-block
restore. The identical service name makes two incompatible configurations look
interchangeable. Do not `sed` your way across that boundary.

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
`cloudflare-worker/` is deployed by hand with `wrangler deploy`. It has **no deploy
CI, no version number, and no coupling to the app release cycle.**

"No *deploy* CI" is the precise claim, and the qualifier is load-bearing: Worker
code **is** test-gated on pull requests. This line read "no CI" until 2026-08-11,
which was true of publishing and false of testing — the same conflation that
retitled § No test gate runs on the RELEASE path below. Take the gate list from
that section's query, not from here.

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

⚠ **These jobs ARE required status checks on `main` — the gate now prevents, not
just reports.** That is a reversal: this paragraph used to say the opposite, and it
was correct when written.

**Do not read the answer off this page, and do not read the list of required jobs
off it either.** This flips with a settings toggle and nothing in the repo records
it — which is exactly how the previous version of this paragraph went wrong, and it
will happen again to whatever is written here. Ask both endpoints:

```bash
gh api repos/ethancail/bitcorn-lightning-application/rulesets
gh api repos/ethancail/bitcorn-lightning-application/branches/main/protection
```

**Both, not either.** A repo can carry legacy branch protection and rulesets at the
same time, and they are served separately — so a `404 Branch not protected` from the
second command means only that *legacy* protection is absent. Reading that 404 as
"nothing is required" is the specific mistake this section used to make, while
required checks were in force via a ruleset the command never consulted. Either
endpoint returning enforcement means checks are required.

⚠ **The thresholds went fully strict in PR #255 (2026-08-07)** — the ceilings went
to zero and every *test* suite gained a collection floor. (The count of each is
itself a moving number — the grep below is the answer, not this sentence. A third
floor was added after this paragraph was written, and it went on saying "two" for
both until 2026-09.) They were branch-aware between PRs #244 and #255,
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

None of it blocks a release — `docker-publish.yml` runs no tests, and nothing
re-checks between the merge and the publish. It does now block a *merge*, per the
branch-protection note above; confirm with the two `gh api` commands there rather
than from this sentence.

---

## Open questions

| Question | Status | How to resolve |
|---|---|---|
| ~~Is the manual `git pull` of the app-store clone required, or does it refresh on its own?~~ | **CLOSED 2026-08-03 — it refreshes on its own.** Was the largest hole in this doc; the manual pull is not required. See [step 4](#step-4--app-store-clone-refreshes-from-main--automated) | Resolved by observation, not by test — one data point, minutes after PR #242, on the treasury node |
| What is the refresh interval, is it timer- or event-driven, and do member nodes behave the same? | **Unknown** — the residual of the row above. Does not block a release: the refresh is no longer the bottleneck (the [update click](#updates-reach-nodes-automatically-they-apply-only-when-someone-clicks) is) | `systemctl cat umbreld`; `journalctl -u umbreld \| grep -i "app-store\|git"`; and repeat the step-4 HEAD comparison on a **member** node after a release |
| How do you know what version a member node is actually running? | **You cannot.** No telemetry, no version report, no check-in exists. Named as a launch consideration under [step 6](#updates-reach-nodes-automatically-they-apply-only-when-someone-clicks) | Not a question to resolve by investigation — it is an unmade design decision |
| Does `umbreld` overwrite a hand-edited deployed compose file on restart, or only on update? | **Unknown** — blocks any reliable downgrade | Edit a harmless value in the deployed compose, `apps.restart.mutate`, check whether the edit survives |
| Will `umbreld` re-offer an update to a manually downgraded node? | **Unknown** | Falls out of the above |
