# Release history — what actually shipped as each version

**Reconstructed 2026-08-11 from build evidence, not from memory or branch names.**
This file is the source of record for the mapping `version → the commit a fresh
install actually received`. The `v*` git tags created on 2026-08-11 were generated
from the table at the bottom; if the tags and this table ever disagree, re-derive
both (§ How to re-derive) rather than trusting either.

## Why this file exists

Until 2026-08-11 this repo had **zero git tags**. The only per-version record was
~26 `release/*` branches, and that set is both **incomplete** (no branches for
`v1.13.*`, `v1.14.0–1.14.2`, `v1.16.*`, `v1.17.0–1.17.2`, `v1.17.20`, or any
`v1.18.*`) and **wrong in two places** (below). Branch cleanup was blocked on this:
deleting `release/*` would have destroyed the only record.

## The authoritative source, and why

**`docker-publish.yml` run history, cross-validated against GHCR tags.**

For each successful run of `.github/workflows/docker-publish.yml` on `main`, read
`bitcorn-lightning-node/umbrel-app.yml` at that run's `headSha` to get the version
it published. **The last successful run carrying a version is what a fresh install
received.** As of 2026-08-11: 248 runs, 245 success, 3 cancelled, 0 failures,
reaching back to `2026-02-23T17:12Z` — the same day the workflow was added
(`7dc720b`, 17:02Z). Nothing has aged out, so the record is complete.

Why this beats the alternatives:

| Source | Verdict |
|---|---|
| **Run history + GHCR** | ✅ Authoritative. Records what was *built and pushed*, which is what an install receives. |
| `release/*` branch tips | ❌ Incomplete (~26 of 201) **and wrong twice** — see below. |
| `umbrel-app.yml` version history | ⚠️ Necessary but insufficient. Tells you which versions existed, not which commit published each. A version can sit on `main` across many commits, and can be republished. |
| GHCR tags alone | ⚠️ Ground truth for *installability*, but the version tag is mutable — a republish silently moves it, and it carries no source commit. Use as cross-check. |

The workflow tags every image with **both** the version and the short commit SHA
(`docker-publish.yml`: `type=raw,value=<version>` + `type=sha,prefix=,format=short`),
so GHCR independently confirms the source commit of every build. That is what makes
this cross-validation possible at all.

## ⚠ Why `release/*` tips are the wrong source

Not merely incomplete — **actively wrong for two versions**, and right for the other
24, which is what makes them dangerous:

- **`release/v1.17.19`** tip is `12bb6df`. What last shipped as 1.17.19 is
  **`f323faf`**. The tip is an ancestor of the publishing commit, not the published
  tree.
- **`release/v1.12.0`** tip is `9c3159d`. What last shipped as 1.12.0 is
  **`3d8d701`**, whose second parent is `7c79d61` — a different branch entirely.

A tag set built from branch tips would be 24/26 correct, ~175 short, and silently
wrong on the two that matter most.

## ⚠ Two traps that produced wrong answers during this reconstruction

Both are easy to repeat. Recorded so the next person doesn't.

### 1. `git diff-tree -r <merge>` returns the COMBINED diff — usually empty

To decide whether a push would have triggered the build, you must test the changed
paths against `docker-publish.yml`'s `paths:` filter. The first attempt used
`git diff-tree --no-commit-id --name-only -r <sha>`. On a **merge** commit that
emits the combined diff — files differing from *all* parents — which is typically
empty. Every merge scored "touched nothing," so all 11 commits carrying 1.17.19
looked like non-publishers, which is impossible.

GitHub evaluates `paths:` over the **push range**. For a merge to `main` that is the
first-parent diff:

```bash
git diff --name-only <sha>^1 <sha>     # correct
git diff-tree -r <sha>                 # WRONG for merges — silently empty
```

The fix immediately reproduced 1.17.19's three publishes.

### 2. Asking "does this version's LAST manifest commit have a run?"

That question yielded 14 versions with no run, briefly read as "13 versions never
built." Wrong question. A push of several commits fires **one** workflow run, at the
push head — so sibling commits carrying the same version have no run of their own
while the version still built perfectly well.

The right question is **"did any successful run carry this version?"** That gives
**201 of 201 versions built.** Derive from the build side (runs → version), never
from the manifest side (commits → runs).

## Cross-validation results

- **201** distinct versions on `main`'s first-parent history; **201** built.
- **200** version tags in GHCR. The single difference is `1.0.0` — see anomalies.
- **0** GHCR version tags with no manifest counterpart.
- **245** successful-run SHAs; **all 245** have a matching GHCR short-SHA tag.
- **0** successful runs at a SHA off `main`'s first-parent line — the whole release
  history is `main`-anchored.
- **All 201** tag targets are reachable from `main`.

## Known anomalies

**30 versions were built more than once** — the same version string published from
different trees, each overwriting the previous image tag. The tag points at the
**last** build; earlier builds are listed in each tag's annotation and in the
`Builds` column below. Worst: `v1.4.0` ×7, `v1.5.3` ×4, `v1.5.0` ×4, `v1.13.12` ×4.
**`v1.17.19` ×3** is the documented incident (`887d814` → `34c20c2` → `f323faf`);
it is the best-known case, not a special one.

**`v1.0.0` was never installable by version.** It built at `195dcd0`
(2026-02-23 17:12) and its images exist in GHCR under the SHA tag `195dcd0`, but no
`1.0.0` version tag was ever created: the original workflow tagged only
`type=raw,value=latest` + `type=sha`. Version-based tagging arrived at **`47273ee`**
(2026-02-23 18:26, "ci: version-pin Docker images and auto-tag from
umbrel-app.yml"), which is itself the first `v1.0.1` build. `v1.0.0` is tagged for
source completeness only — it is not a release claim.

**Two version strings never existed:** `1.9.14` (1.9.13 → 1.9.15) and `1.14.2`
(1.14.1 → 1.14.3). Gaps in the tag sequence at those two points are correct.

**Three runs were cancelled**, and two of them still pushed images:
`fb77fd1` (v1.3.1) and `16d8756` (v1.4.0) left SHA tags in GHCR, meaning the api
image pushed before cancellation — so api and web can diverge mid-run. `7f50ed3`
left nothing. All three versions were later rebuilt successfully, so last-wins is
clean, but the partial-publish failure mode is real.

**The manifest moved, and it was a copy, not a rename.** At `4e2f341`
(2026-02-23 17:01) `umbrel-app.yml` was copied from the repo root to
`bitcorn-lightning-node/`, with both files coexisting until the root copy was
deleted at `0d8a6ea` (19:00). `git log --diff-filter=R` therefore finds nothing, and
a naive pathspec on the new path loses the earliest history — use `--follow`, or read
both paths. The two files never disagreed on version during the ~2h overlap.

## How to re-derive

Read the version at every successful publish run and take the last per version:

```bash
gh run list --workflow=docker-publish.yml --branch main --limit 400 \
  --json headSha,conclusion,createdAt \
  | jq -r '.[] | select(.conclusion=="success") | "\(.createdAt) \(.headSha)"' \
  | sort | while read -r date sha; do
      v=$(git show "$sha:bitcorn-lightning-node/umbrel-app.yml" 2>/dev/null \
          | sed -n 's/^version:[[:space:]]*"\?\([^"]*\)"\?/\1/p' | head -1)
      echo "$v $sha ${date%%T*}"
    done   # last line per version wins
```

Cross-check against GHCR (anonymous, public package):

```bash
TOK=$(curl -s "https://ghcr.io/token?scope=repository:ethancail/bitcorn-lightning-application/api:pull&service=ghcr.io" | jq -r .token)
curl -s -H "Authorization: Bearer $TOK" \
  "https://ghcr.io/v2/ethancail/bitcorn-lightning-application/api/tags/list?n=1000" | jq -r '.tags[]'
```

Confirm every target is still on `main`:

```bash
git tag -l 'v*' | while read -r t; do
  git merge-base --is-ancestor "$t" main || echo "NOT ON MAIN: $t"
done
```

To regenerate the tags from this file, parse the table below — columns are
pipe-delimited, so `awk -F'|'` on lines starting with `| v` gives version and target.

## The table

`Version` — the manifest string. `Target` — the commit of the **last** successful
publish carrying it; this is what the `v*` tag points at. `Date` — that build's date.
`Builds` — how many times the version was published (>1 means the image tag was
overwritten). `Earlier builds` — the superseded ones, oldest first.

| Version | Target | Date | Builds | Earlier builds |
|---|---|---|---|---|
| v1.0.0 | `195dcd0` | 2026-02-23 | 1 | — |
| v1.0.1 | `0d8a6ea` | 2026-02-23 | 2 | `47273ee`@2026-02-23 |
| v1.0.2 | `e0205d3` | 2026-02-23 | 1 | — |
| v1.0.3 | `8d8fbc3` | 2026-02-23 | 1 | — |
| v1.0.4 | `fb7f132` | 2026-02-23 | 1 | — |
| v1.0.5 | `fc28b06` | 2026-02-23 | 1 | — |
| v1.0.6 | `1aa84f3` | 2026-02-25 | 2 | `b625366`@2026-02-23 |
| v1.1.0 | `922d74d` | 2026-02-25 | 2 | `6d80a46`@2026-02-25 |
| v1.1.1 | `772e67a` | 2026-02-25 | 1 | — |
| v1.1.2 | `0b798fc` | 2026-02-25 | 1 | — |
| v1.2.0 | `ca2f965` | 2026-02-25 | 2 | `12d423e`@2026-02-25 |
| v1.2.1 | `a0d5522` | 2026-02-25 | 1 | — |
| v1.2.2 | `f221f8a` | 2026-02-25 | 2 | `58cfcf4`@2026-02-25 |
| v1.2.3 | `0810c99` | 2026-02-26 | 2 | `65c85eb`@2026-02-25 |
| v1.2.4 | `d39cc56` | 2026-02-26 | 2 | `9258c92`@2026-02-26 |
| v1.2.5 | `9924ce7` | 2026-02-26 | 2 | `f489379`@2026-02-26 |
| v1.2.6 | `b02838d` | 2026-02-26 | 2 | `a7969ba`@2026-02-26 |
| v1.2.7 | `2945f0a` | 2026-02-26 | 2 | `ab910f1`@2026-02-26 |
| v1.2.8 | `d584620` | 2026-02-26 | 1 | — |
| v1.2.9 | `9d63c60` | 2026-02-27 | 3 | `53bb57a`@2026-02-26, `8797c4c`@2026-02-27 |
| v1.3.0 | `48c4fb3` | 2026-02-27 | 1 | — |
| v1.3.1 | `fd198c6` | 2026-03-02 | 2 | `50cbebb`@2026-02-27 |
| v1.3.2 | `e65f81b` | 2026-03-02 | 1 | — |
| v1.3.3 | `ed4783c` | 2026-03-02 | 1 | — |
| v1.3.4 | `1091df9` | 2026-03-02 | 1 | — |
| v1.3.5 | `4dbed65` | 2026-03-02 | 1 | — |
| v1.4.0 | `5106ad5` | 2026-03-06 | 7 | `3bd192c`@2026-03-02, `e471cc8`@2026-03-04, `96954f9`@2026-03-04, `f80f278`@2026-03-04, `4be5b3c`@2026-03-04, `bd1d126`@2026-03-06 |
| v1.5.0 | `2b70f38` | 2026-03-06 | 4 | `4f32e3e`@2026-03-06, `08728ba`@2026-03-06, `1eaa558`@2026-03-06 |
| v1.5.1 | `71b91e7` | 2026-03-06 | 3 | `fbf40c6`@2026-03-06, `cd199a1`@2026-03-06 |
| v1.5.2 | `7cb13de` | 2026-03-06 | 2 | `210a010`@2026-03-06 |
| v1.5.3 | `014f0cf` | 2026-03-11 | 4 | `b8390ad`@2026-03-06, `03ad165`@2026-03-09, `aba544e`@2026-03-11 |
| v1.5.4 | `862a794` | 2026-03-13 | 2 | `2404f22`@2026-03-13 |
| v1.5.5 | `f76874c` | 2026-03-13 | 1 | — |
| v1.5.6 | `474c6df` | 2026-03-13 | 1 | — |
| v1.6.0 | `ddef2b1` | 2026-03-16 | 1 | — |
| v1.6.1 | `ae1c013` | 2026-03-16 | 1 | — |
| v1.6.2 | `5021615` | 2026-03-17 | 1 | — |
| v1.6.3 | `e7f2702` | 2026-03-17 | 2 | `d3e649e`@2026-03-17 |
| v1.6.4 | `b4e7af4` | 2026-03-17 | 2 | `7879540`@2026-03-17 |
| v1.6.5 | `712d58a` | 2026-03-17 | 1 | — |
| v1.6.6 | `64d73bd` | 2026-03-17 | 1 | — |
| v1.6.7 | `6bbb572` | 2026-03-17 | 1 | — |
| v1.6.8 | `f2b1e96` | 2026-03-17 | 1 | — |
| v1.6.9 | `a681d48` | 2026-03-17 | 1 | — |
| v1.6.10 | `40e45ed` | 2026-03-18 | 1 | — |
| v1.6.11 | `f8ade25` | 2026-03-18 | 1 | — |
| v1.6.12 | `55e211b` | 2026-03-19 | 1 | — |
| v1.6.13 | `b2e0437` | 2026-03-19 | 1 | — |
| v1.6.14 | `5f636c7` | 2026-03-19 | 1 | — |
| v1.6.15 | `1a51382` | 2026-03-20 | 1 | — |
| v1.6.16 | `60d17f6` | 2026-03-20 | 1 | — |
| v1.7.0 | `e6e2e8b` | 2026-03-23 | 1 | — |
| v1.7.1 | `d8f73c8` | 2026-03-23 | 1 | — |
| v1.7.2 | `a6240fb` | 2026-03-24 | 1 | — |
| v1.7.3 | `615be8c` | 2026-03-24 | 1 | — |
| v1.7.4 | `934bdca` | 2026-03-25 | 1 | — |
| v1.7.5 | `dc1c12f` | 2026-03-25 | 2 | `2632acc`@2026-03-25 |
| v1.7.6 | `7920aff` | 2026-03-25 | 2 | `b6618bf`@2026-03-25 |
| v1.7.7 | `8394245` | 2026-03-25 | 1 | — |
| v1.7.8 | `8f43bfd` | 2026-03-25 | 1 | — |
| v1.7.9 | `97c96fc` | 2026-03-25 | 1 | — |
| v1.7.10 | `55ac2d5` | 2026-03-25 | 1 | — |
| v1.7.11 | `c687c84` | 2026-03-25 | 1 | — |
| v1.7.12 | `6361a8f` | 2026-03-25 | 1 | — |
| v1.7.13 | `96dc7c2` | 2026-03-25 | 1 | — |
| v1.7.14 | `319bee7` | 2026-03-26 | 1 | — |
| v1.7.15 | `d450d52` | 2026-03-26 | 1 | — |
| v1.7.16 | `8d7a006` | 2026-03-26 | 1 | — |
| v1.8.0 | `c64ba36` | 2026-03-27 | 1 | — |
| v1.8.1 | `6c9e6d2` | 2026-03-27 | 1 | — |
| v1.8.2 | `579ef2b` | 2026-03-27 | 1 | — |
| v1.8.3 | `2c5f252` | 2026-03-27 | 1 | — |
| v1.8.4 | `110bceb` | 2026-03-27 | 1 | — |
| v1.8.5 | `33514a9` | 2026-03-27 | 1 | — |
| v1.8.6 | `42a23ba` | 2026-03-27 | 1 | — |
| v1.8.7 | `fef4ac5` | 2026-03-27 | 1 | — |
| v1.8.8 | `e1a4eff` | 2026-03-27 | 1 | — |
| v1.8.9 | `ba38280` | 2026-03-30 | 1 | — |
| v1.9.0 | `e0cdf14` | 2026-03-30 | 1 | — |
| v1.9.1 | `896cdbe` | 2026-03-30 | 1 | — |
| v1.9.2 | `f156a24` | 2026-03-30 | 1 | — |
| v1.9.3 | `e04e088` | 2026-03-30 | 1 | — |
| v1.9.4 | `9723cec` | 2026-03-31 | 1 | — |
| v1.9.5 | `9ce7afd` | 2026-04-01 | 1 | — |
| v1.9.6 | `fc22e2d` | 2026-04-01 | 1 | — |
| v1.9.7 | `45c0e29` | 2026-04-01 | 1 | — |
| v1.9.8 | `8b0ecaa` | 2026-04-01 | 1 | — |
| v1.9.9 | `8d71169` | 2026-04-01 | 1 | — |
| v1.9.10 | `dbba5a9` | 2026-04-01 | 1 | — |
| v1.9.11 | `1b68abe` | 2026-04-01 | 1 | — |
| v1.9.12 | `85ac82f` | 2026-04-02 | 1 | — |
| v1.9.13 | `13ec697` | 2026-04-02 | 1 | — |
| v1.9.15 | `6a92066` | 2026-04-02 | 1 | — |
| v1.9.16 | `c082b1e` | 2026-04-02 | 1 | — |
| v1.9.17 | `4357c00` | 2026-04-03 | 1 | — |
| v1.9.18 | `751e660` | 2026-04-03 | 1 | — |
| v1.9.19 | `41fc253` | 2026-04-03 | 1 | — |
| v1.9.20 | `f0fc324` | 2026-04-03 | 1 | — |
| v1.9.21 | `badfa49` | 2026-04-03 | 1 | — |
| v1.9.22 | `bf09a11` | 2026-04-03 | 1 | — |
| v1.9.23 | `c8c639c` | 2026-04-03 | 1 | — |
| v1.9.24 | `5805cd4` | 2026-04-03 | 1 | — |
| v1.9.25 | `1288f14` | 2026-04-06 | 1 | — |
| v1.9.26 | `c87dbbd` | 2026-04-06 | 1 | — |
| v1.9.27 | `dec12f9` | 2026-04-06 | 1 | — |
| v1.9.28 | `8abe154` | 2026-04-06 | 1 | — |
| v1.9.29 | `9f89110` | 2026-04-06 | 1 | — |
| v1.9.30 | `282b150` | 2026-04-06 | 1 | — |
| v1.9.31 | `82711a8` | 2026-04-08 | 1 | — |
| v1.9.32 | `df2d02f` | 2026-04-08 | 1 | — |
| v1.9.33 | `7727d60` | 2026-04-08 | 1 | — |
| v1.9.34 | `2ed0bfb` | 2026-04-09 | 1 | — |
| v1.9.35 | `1f6e469` | 2026-04-09 | 1 | — |
| v1.9.36 | `d07bb63` | 2026-04-09 | 1 | — |
| v1.9.37 | `969027b` | 2026-04-09 | 1 | — |
| v1.9.38 | `d970199` | 2026-04-10 | 1 | — |
| v1.9.39 | `cb9f808` | 2026-04-10 | 1 | — |
| v1.9.40 | `a404b24` | 2026-04-10 | 1 | — |
| v1.9.41 | `40f821d` | 2026-04-10 | 1 | — |
| v1.9.42 | `128c5f0` | 2026-04-10 | 1 | — |
| v1.9.43 | `e1e8806` | 2026-04-10 | 1 | — |
| v1.9.44 | `306ae28` | 2026-04-10 | 1 | — |
| v1.9.45 | `f1c9137` | 2026-04-10 | 1 | — |
| v1.9.46 | `cd94b3b` | 2026-04-10 | 1 | — |
| v1.9.47 | `d43b2c5` | 2026-04-10 | 1 | — |
| v1.9.48 | `0451e57` | 2026-04-10 | 1 | — |
| v1.9.49 | `9c90943` | 2026-04-10 | 1 | — |
| v1.9.50 | `dd0a9ff` | 2026-04-10 | 1 | — |
| v1.9.51 | `2bb88fa` | 2026-04-13 | 1 | — |
| v1.9.52 | `3d6df0a` | 2026-04-13 | 1 | — |
| v1.9.53 | `195da6b` | 2026-04-13 | 1 | — |
| v1.9.54 | `20951ee` | 2026-04-13 | 2 | `71614f0`@2026-04-13 |
| v1.10.0 | `f6c1730` | 2026-04-14 | 2 | `5e34d2a`@2026-04-14 |
| v1.10.1 | `261217f` | 2026-04-14 | 1 | — |
| v1.10.2 | `d54c738` | 2026-04-15 | 1 | — |
| v1.10.3 | `f4c062a` | 2026-04-15 | 1 | — |
| v1.10.4 | `b9abd34` | 2026-04-15 | 1 | — |
| v1.10.5 | `d94e4a9` | 2026-04-15 | 1 | — |
| v1.10.6 | `5358257` | 2026-04-16 | 1 | — |
| v1.10.7 | `cae8f8c` | 2026-04-16 | 1 | — |
| v1.10.8 | `30f96cf` | 2026-04-16 | 1 | — |
| v1.11.0 | `7dcd5d0` | 2026-04-21 | 1 | — |
| v1.11.1 | `5b6170e` | 2026-04-21 | 1 | — |
| v1.11.2 | `73788c8` | 2026-04-21 | 1 | — |
| v1.11.3 | `9c0518b` | 2026-04-21 | 1 | — |
| v1.11.4 | `629ca21` | 2026-04-21 | 1 | — |
| v1.12.0 | `3d8d701` | 2026-04-22 | 2 | `76bf841`@2026-04-22 |
| v1.12.1 | `831f729` | 2026-04-22 | 1 | — |
| v1.13.0 | `5d5ed2a` | 2026-04-23 | 1 | — |
| v1.13.1 | `b34fd2e` | 2026-04-23 | 1 | — |
| v1.13.2 | `f47ecb3` | 2026-04-24 | 1 | — |
| v1.13.3 | `31b8aaf` | 2026-04-24 | 1 | — |
| v1.13.4 | `1f64a1b` | 2026-04-24 | 1 | — |
| v1.13.5 | `e568c92` | 2026-04-24 | 1 | — |
| v1.13.6 | `03b4146` | 2026-04-24 | 1 | — |
| v1.13.7 | `afb3356` | 2026-04-24 | 1 | — |
| v1.13.8 | `30ac7bd` | 2026-04-27 | 2 | `913972c`@2026-04-27 |
| v1.13.9 | `1a607bb` | 2026-04-27 | 1 | — |
| v1.13.10 | `babd633` | 2026-04-28 | 1 | — |
| v1.13.11 | `0ddcff4` | 2026-04-28 | 2 | `33287ba`@2026-04-28 |
| v1.13.12 | `1078163` | 2026-04-30 | 4 | `2c9dde6`@2026-04-28, `6ded941`@2026-04-29, `78e39db`@2026-04-29 |
| v1.13.13 | `7be3d56` | 2026-05-04 | 1 | — |
| v1.13.14 | `f3ac3d6` | 2026-05-04 | 1 | — |
| v1.13.15 | `b274ce5` | 2026-05-04 | 2 | `28e3f58`@2026-05-04 |
| v1.13.16 | `f33301e` | 2026-05-06 | 1 | — |
| v1.13.17 | `67e0b70` | 2026-05-06 | 1 | — |
| v1.13.18 | `15a6a10` | 2026-05-06 | 1 | — |
| v1.13.19 | `c56b8a5` | 2026-05-07 | 1 | — |
| v1.13.20 | `d0175cc` | 2026-05-07 | 1 | — |
| v1.13.21 | `dc2d1bb` | 2026-05-07 | 1 | — |
| v1.14.0 | `433067e` | 2026-05-11 | 1 | — |
| v1.14.1 | `b0ad39b` | 2026-05-11 | 1 | — |
| v1.14.3 | `0b4b294` | 2026-05-13 | 1 | — |
| v1.15.0 | `0bec82e` | 2026-05-13 | 1 | — |
| v1.15.1 | `14d9aab` | 2026-05-13 | 1 | — |
| v1.15.2 | `296cb6c` | 2026-05-13 | 1 | — |
| v1.16.0 | `335c5ed` | 2026-05-14 | 1 | — |
| v1.17.0 | `0d5a52e` | 2026-05-14 | 1 | — |
| v1.17.1 | `d2aca25` | 2026-05-14 | 1 | — |
| v1.17.2 | `4aeb22b` | 2026-05-21 | 1 | — |
| v1.17.3 | `51aa69c` | 2026-05-21 | 1 | — |
| v1.17.4 | `a922eae` | 2026-05-22 | 1 | — |
| v1.17.5 | `a3efbea` | 2026-06-03 | 1 | — |
| v1.17.6 | `49bc9e6` | 2026-06-03 | 1 | — |
| v1.17.7 | `263785b` | 2026-06-03 | 1 | — |
| v1.17.8 | `76937d7` | 2026-06-05 | 1 | — |
| v1.17.9 | `d6f4486` | 2026-06-08 | 1 | — |
| v1.17.10 | `fb6dbf7` | 2026-06-09 | 1 | — |
| v1.17.11 | `6d7cd94` | 2026-06-11 | 1 | — |
| v1.17.12 | `ad342f1` | 2026-06-11 | 1 | — |
| v1.17.13 | `abd21aa` | 2026-06-11 | 1 | — |
| v1.17.14 | `823d9ea` | 2026-06-11 | 1 | — |
| v1.17.15 | `48855f4` | 2026-06-12 | 1 | — |
| v1.17.16 | `48c64e4` | 2026-06-16 | 1 | — |
| v1.17.17 | `d9a149c` | 2026-06-17 | 1 | — |
| v1.17.18 | `8b727ea` | 2026-06-18 | 1 | — |
| v1.17.19 | `f323faf` | 2026-07-21 | 3 | `887d814`@2026-06-18, `34c20c2`@2026-07-21 |
| v1.17.20 | `19a667c` | 2026-08-03 | 1 | — |
| v1.18.0 | `77ea1d6` | 2026-08-05 | 1 | — |
| v1.18.1 | `8fb5bf1` | 2026-08-05 | 1 | — |
| v1.18.2 | `8fce322` | 2026-08-10 | 1 | — |
