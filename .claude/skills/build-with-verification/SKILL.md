---
name: build-with-verification
description: Use when implementing any code change — feature, fix, or follow-up — from starting the work through claiming it done; especially before writing "tests pass", "build is green", or "done", and before any git commit.
allowed-tools: Read, Edit, Write, Grep, Glob, Bash(npx tsc:*), Bash(npx vitest:*), Bash(npx vite:*), Bash(npm run:*), Bash(node:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(git branch:*), Bash(git checkout:*), Bash(git stash:*), Bash(grep:*), Bash(ls:*), Bash(pwd:*), Bash(cat:*), Bash(wc:*)
---

# Build with Verification

## Scope: exactly what was asked

No unrequested features, refactors, "improvements," or speculative error handling (CLAUDE.md Working Style). Adjacent work you notice goes in the report as a note, not in the diff.

## Verify for real — evidence, not assertions

A check counts only if the command ACTUALLY RAN, you READ its output, and the report shows it. "Should pass," "looks clean," and green runs from before your latest edit are not verification.

As applicable to what you touched (from repo root):

```bash
cd app/api && npx tsc --noEmit && npx vitest run                    # api
cd app/web && npx tsc --noEmit && npx vite build && npx vitest run  # web
```

- Paste the real tail: pass/fail counts, error lines, exit codes.
- On any failure, split PRE-EXISTING from INTRODUCED: run the same check on clean HEAD (`git stash` around it for uncommitted work; the clean base commit for committed) and diff the two error sets. Identical sets = pre-existing baseline. Report which, and how proven.
- Can't run a check (env down, service missing)? Report `NOT VERIFIED: <check> — <why>`. Never imply verification that didn't happen.

## False-green traps (all real — each has bitten this repo or a sibling)

- **Green ≠ green for the right reason:** a passing test proves the assertion holds, never that it holds *for the reason you believe*. Only a negative control distinguishes those: before trusting any safety test, break the thing it guards, confirm the test fails, **and confirm it fails for the right reason**. A boundary test asserting "opening the identity store throws when the store is absent" passed with the guard removed — the setup had deleted the parent directory, so the constructor threw on that instead. Coarse setups satisfy assertions through paths unrelated to the property under test. Same check applies to a comment claiming what a test proves.
- **A tool failure silently read as a passing result:** a `.gitignore` assertion collapsed git's non-zero exit to `false`. That failed every must-ignore case (the safe direction) but passed all fourteen must-NOT-ignore cases vacuously — a broken `git` would have "proved" the carve-out worked. Distinguish exit 0 / exit 1 / could-not-run, and treat could-not-run as a named failure on **both** sides of the assertion.
- **Pipe exit codes:** capture the exit code of the process you care about, not the pipeline's last stage. `echo … | node hook.mjs | head` read via `PIPESTATUS[0]` gives *echo's* status, which always succeeds — the original false green in this repo's own hook gates. Invoke the subject directly and read its status (`spawnSync().status`); if you must index `PIPESTATUS`, prove the index by making the process fail on purpose.
- **Wrong-directory checks:** a failed `cd &&` chain can leave later commands — or your next tool call — running in the previous directory, producing a "pass" from the wrong package. Prefer absolute paths; if output looks off, confirm cwd (`pwd`, or path prefixes in `git status --short`).
- **Committed conflict markers:** before claiming done, `grep -rn "^<<<<<<<"` across the changed files (line-anchored — real markers start at column 0). Unresolved cherry-pick/merge hunks have been committed here before.
- **Stale caches:** a build that passes suspiciously fast may not contain your change. Rebuild after clearing outputs if in doubt.

## Commit — Ethan owns everything past it

- `git status --short` first: know everything that changed (tools and subagents can leave strays).
- Stage EXPLICIT paths: `git add <file> <file>`. Never `git add -A` or `git add .`.
- Clear message: what + why.
- **Never push, merge, or open PRs.** Ethan reviews and pushes; on-chain and production actions are his alone. Networking, auth, Lightning flows, Umbrel manifests: ask before touching (CLAUDE.md non-negotiables).

## Report shape

1. **What changed** — each file, one line.
2. **Verification evidence** — every command with its real result.
3. **Pre-existing vs introduced** — for any failure, the bucket and the proof.
4. **Not verified** — anything skipped, and why.
5. **Git state** — branch, `git log --oneline -<n>`, `git status --short`: ready for review + push.

## Red flags — stop, you're about to false-green

- "should pass" / "looks fine" with no runner output in hand
- Reporting a green run that predates your latest edit
- Verification output you didn't actually read
- `git add -A` · typing `git push` · "I'll just quickly merge this"
