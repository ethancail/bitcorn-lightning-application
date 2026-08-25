# learnings.md

Scars, newest first. One failure per entry: what happened, what it generalizes to, and where the
enforcement actually lives.

**The rule this file exists to serve:** every failure exits as a test, a gate, or a gotcha-line —
never as an apology. Add entries with `/retro` at the end of a session that produced one.

**Disposition tags:**

- `[PROMOTED → <where>]` — the lesson is enforced somewhere real: a test, a gate/hook, a skill line, a
  CLAUDE.md rule, a code comment. **That place is the source of truth; the entry here is an index card
  pointing at it, not the enforcement.**
- `[RECORDED]` — there was nowhere to promote it. This file *is* the enforcement, which is the weak
  form and should feel like it.

Some entries were promoted in a sibling repo (the insurance platform, or its vault's `CONVENTIONS.md`),
which this repo does not carry. The index spans the workflow, not just this codebase — a lesson earned
here is worth reading even when the fix landed elsewhere.

**This is not an archive.** It is a file someone re-reads while about to make a mistake. Newest first;
anything fully enforced elsewhere gets pruned to a one-line pointer. If it stops being re-readable, it
has stopped working.

---

## 2026-08-25

### A Docker manifest claiming an architecture is not evidence the binary inside it is that architecture

**Scar:** `2dc6e8a` (2026-03-27) reverted the standalone loopd sidecar back to litd because
`lightninglabs/loop`'s arm64 image died with "exec format error" on aarch64 — "despite manifest claiming
arm64 support," in its own commit message. The cause went unfound for five months and the image was
written off as upstream breakage. Root cause, 2026-08-25: upstream's Dockerfile pins BOTH stages to
`--platform=${BUILDPLATFORM}` while its publish workflow requests both platforms, so both manifest
entries carry the same amd64 filesystem [RELAYED — recon read at `lightninglabs/loop` v0.31.8-beta and
master `341d844`, 2026-08-25; not read from this repo]. Proven without downloading anything: the two
per-arch entries share byte-identical layer digests and their config blobs differ in exactly one
string, `"architecture"`. Identical layers means identical bytes, so at most one of the two labels can
be true. The repo-side facts are checkable here — `git show -s 2dc6e8a`, `sed -n '69p'
app/api/src/config/env.ts` — and that pair was the entire written record: `grep -rn -i 'exec format'`
over tracked files returns nothing, this file had zero hits for arm64/manifest/loopd, and
`docs/LOOP_SETUP.md` none either.

**Lesson:** A multi-arch index is a set of *claims*, and it is **falsifiable with two small HTTP reads**
— no pull, no emulator, no target hardware. Compare the per-arch entries: shared layer digests mean one
filesystem wearing two labels. The check is on the artifact, never on the claim. This generalizes well
past Docker: a declared platform, target triple, or ABI is metadata, and metadata is exactly the layer
that can be wrong while everything downstream keeps agreeing with it. Note what made the gap feel
covered — the repo *did* carry an ARM64 gotcha (`CLAUDE.md:145`, QEMU/musl `signal 4`) for an unrelated
cause. An adjacent record of a *different* failure is what lets an unwritten one pass for known.

**Disposition:** `[PROMOTED → app/loopd/Dockerfile header + its ELF e_machine check (2ef2130)]` — the
header's standing rule is "⚠ VERIFY THE ARTIFACT, NEVER THE MANIFEST," and the ELF read enforces it
mechanically at build time. ⚠ That file exists only on `feature/loopd-image` — check with
`git branch -a --contains 2ef2130`. Until it merges, this entry is the only record on `develop`, which
is the weak form.

### When digest-pinning a base image, pin the index digest — never a per-arch manifest digest

**Scar:** Hardening `app/loopd/Dockerfile` against the same-tag hazard (CLAUDE.md § Umbrel Gotchas)
meant pinning `debian:12-slim` by digest. A registry exposes two different digests at that reference
and they are indistinguishable by shape — both are `sha256:` plus 64 hex. Pinning the amd64 *manifest*
digest rather than the *index* digest would make every platform entry of the resulting image resolve to
amd64: the scar above, reproduced from the opposite direction, in the act of hardening against it.

**Lesson:** A digest pin buys reproducibility and silently spends the tag's platform dispatch if you
pin the wrong level. An index digest still resolves per target platform; a per-arch manifest digest is
a platform decision wearing the costume of a version pin. Because the two are shape-identical, the pin
must record *which kind it is* and how that was checked — a bare digest is unverifiable by the next
reader, who has no way to see the mistake. General form: when one identifier can name either a set or a
member of that set, the pin has to say which, because nothing downstream will complain.

**Disposition:** `[PROMOTED → inline ⚠ beside the BASE_IMAGE pin in app/loopd/Dockerfile (2ef2130)]` —
records the media type it was verified as, the date, and a one-command bump. Same branch caveat as
above.

### `--help` proves a flag was declared, never that it is read

**Scar:** Bitcorn's March standalone-loopd compose passed `--tlsautorefresh` to loopd in good faith
(introduced `d874a72`, 2026-03-26; carried through `df71d92` and `baf01f8`; removed by the litd revert
`2dc6e8a` — `git log --all -S'tlsautorefresh'`). The flag does nothing: declared at
`loopd/config.go:167` and read nowhere, while its siblings `TLSExtraIPs`, `TLSExtraDomains`,
`TLSDisableAutofill` are consumed at `config.go:479-480` [RELAYED — same recon; upstream line numbers
not read from this repo]. It still appears in `loopd --help`, so a CLI-existence test passes it and a
reviewer checking the help output has the flag confirmed back to them.

**Lesson:** `--help` is generated from the flag *declaration*, so it proves registration and says
nothing about consumption. The sound test greps for **reads** of the field the flag binds to; a flag
with a declaration and no reader is inert forever, and the config passing it looks correct forever.
Same class as the manifest scar above — `--help` output, a manifest entry, and a green build are all
cheap checks on *claims*, and each one is fully satisfied by a system that does not do the thing.
Whenever a check is cheap, ask what it reads: if it reads a declaration, it cannot see a missing
implementation.

**Disposition:** `[PROMOTED → inline ⚠ at app/loopd/Dockerfile:263 (2ef2130)]` — names the three March
commits that passed the flag, so the next person wiring compose does not re-add it. Same branch caveat.
Re-verify the upstream line numbers before relying on them; they are relayed, not read here.

## 2026-08-11

### A scar recorded in one instruction surface is invisible to every session that doesn't load it

**Scar:** Unresolved merge and cherry-pick hunks have been committed in this repo before. That fact
lived in exactly one place — `.claude/skills/build-with-verification/SKILL.md:34` — and nowhere else:
`grep -in "conflict\|marker\|cherry-pick" learnings.md` returned zero hits, and no CI job checked for
one. Meanwhile the failure it describes is fleet-wide: migrations are filename-keyed and run at API
startup on every member node, and `app/api/src/db/migrate.ts:46-57` swallows only "duplicate column" /
"already exists", so a marker's SQLite syntax error rethrows and crashes the boot — and because the
applied-insert runs only *after* `db.exec` succeeds, it rethrows again on every restart. It does not
self-heal.

**Lesson:** A scar is only as reachable as the surface holding it. A skill file is loaded by sessions
that invoke that skill and by no others, so a lesson parked there alone enforces nothing everywhere
else. Finding a known failure recorded in exactly one surface *is* the finding: it is evidence that
nobody ever asked what would make it fire mechanically. Ask that first, and treat the lone record as an
unfinished promotion rather than as coverage.

**Disposition:** `[PROMOTED → .github/workflows/pr-checks.yml, conflict-markers job (5ccb1fb)]` ·
behavioural proofs in `scripts/test-hooks.mjs` § C (aa5e957)

### A verification artifact that is discarded takes its own lesson with it

**Scar:** PR #255 flipped four CI thresholds to strict and proved each could FAIL — a harness extracted
the real `run:` text out of the YAML and executed it under `bash -e` against stubbed violating counts,
19/19 cases. That harness was never committed: `git show 100374f --stat` is one file, the workflow
itself, and no test file exists in any ref. Its result survives only as prose in `217e08f`'s message.
So the lesson it established — that a green CI run cannot prove a threshold change, because green is
exactly what a vacuous gate looks like — became the one thing that could not be re-checked, and the
next arc rebuilt the mechanism from nothing.

**Lesson:** Scratch verification and committed verification are different artifacts, and only the
second is still verification a month later. A negative control that existed once, in a session, is an
anecdote about the past; the same control committed is a claim that stays true or goes red on its own.
If proving a gate can fail was worth doing, it was worth committing — and if it feels too rough to
commit, that roughness is what the next person inherits either way.

**Disposition:** `[PROMOTED → scripts/test-hooks.mjs § C (aa5e957)]` — 20 cases, extraction-from-source
rather than transcription, plus a `--workflow` override so the suite can be pointed at a deliberately
weakened copy and shown to go red.

### Verification code fails like code — and when it fails it must report, not abort

**Scar:** Two in one arc. (1) Running the new suite against a tree where the gate does not yet exist
crashed it: the variant builder's locator returned `runIdx -1`, indexing threw a `TypeError`, and the
run died before printing its summary — so "the gate is absent" surfaced as a stack trace instead of as
failing cases. (2) The proof scripts shipped two bugs of their own, both caught only by running them: a
bash-syntax-error contrast that exited **0** and therefore contrasted nothing, and a "is this a bash
diagnostic" regex that matched the gate's own explanatory prose about a SQLite *syntax error*.

**Lesson:** The harness is not a privileged observer — it is more code, with the same defect rate and
no test of its own. Two consequences worth holding separately. A suite must FAIL on a broken subject,
never crash on one: an abort skips the summary, which is could-not-run wearing a different mask and
reads as "something went wrong over there" rather than "this is red." And a proof must itself be run
against a case it is supposed to reject before its green means anything, because an assertion written
to demonstrate something is exactly as likely to be wrong as the code it examines.

**Disposition:** `[PROMOTED → scripts/test-hooks.mjs (aa5e957)]` — the locator now throws a sentence,
and `mustThrow` takes a thunk so variant-build failures surface as failed cases instead of killing the
run.

### A discriminating fixture has to sit ON the boundary being mutated

**Scar:** The sabotage that weakens the gate's comparison from `-gt 0` to `-gt 1` can only flip a case
whose count is exactly 1. The `.sql` fixture was nearly written as a realistic full conflict hunk —
three marker lines — which stays red under that mutation (`3 -gt 1` is still true), passes, and proves
nothing about the boundary it was meant to test. It carries exactly one marker on purpose.

**Lesson:** A mutation test proves only what its fixtures can distinguish, and a fixture sitting
comfortably past the boundary survives the mutation and reports green — which reads identically to "the
mutation was caught." Pick the fixture from the mutation you intend to apply, not from realism. Then
keep a stronger fixture beside it deliberately, so a *total* break can be told apart from a *partial*
one: here the three-marker case staying red is the only thing showing the sabotaged copy was not simply
broken everywhere.

**Disposition:** `[PROMOTED → code comment at the C2 fixture in scripts/test-hooks.mjs (aa5e957)]`

## 2026-07-29

### A green test proves the assertion holds — never that it holds for the stated reason

**Scar:** Three in one stretch. (1) A boundary test asserting "opening the identity store throws when
the store is absent" passed with the guard under test *removed* — the setup deleted the parent
directory, so the constructor threw on that instead. (2) A `.gitignore` assertion collapsed git's
non-zero exit to `false`, so all fourteen must-NOT-ignore cases passed vacuously. (3) Two hook-test
gates carried comments claiming to prove behavior the pathspec made unreachable.

**Lesson:** An assertion is satisfied by *any* path that produces the asserted outcome, and a coarse
setup supplies several. Before trusting a safety test, break the thing it guards, confirm the test
fails, **and confirm it fails for the right reason** — the negative control, not the green run, is what
ties the test to the property. A comment asserting what a test proves is a claim requiring the same
check.

**Disposition:** `[PROMOTED → /build-with-verification, false-green traps]`

### Volatile facts must be stored as a query, not as an answer

**Scar:** Three errors from the same root. A commit was recorded as "not pushed" and cited that way two
weeks after it had reached origin. A runbook was cited by the wrong date because the date was
transcribed instead of looked up. And — one layer up, while writing this very file — a trap was stated
confidently to be already documented in `/build-with-verification`; a grep found zero hits, and it had
to be added rather than generalized.

**Lesson:** Before writing a fact down, ask whether it can change without anyone editing the note. If
yes, it is volatile and does not get stored — store the *invocation* that answers it. "Not pushed"
should never have been a note; it should have been `git log origin/main..HEAD`. This covers beliefs
about file contents too: what a doc, skill, or config *says* is volatile, and confidence about it is
not evidence — grep it. Durable facts (decisions, architecture, preferences, why something is the way
it is) get stored; volatile ones get re-queried, or stored as a pointer to their source.

**Disposition:** `[PROMOTED → CLAUDE.md § STATE.md — Generated Ground Truth]` — as "volatile state is a
query, not a fact — cite the invocation, never the value," beside the existing rule to trust STATE.md
over memory. The insurance vault's `CONVENTIONS.md` §3 carries the fuller convention; this repo does
not carry that file.

### Capture the exit code of the process you care about, not the pipeline's last stage

**Scar:** This repo's own hook tests ran `echo … | node hook.mjs | head` and read `PIPESTATUS[0]` —
which is `echo`'s exit code. `echo` always succeeds, so every gate reported green regardless of what
the hook did.

**Lesson:** In a pipeline, the shell's `$?` is the *last* stage and `PIPESTATUS[n]` is positional — both
are easy to point at a process that cannot fail. Invoke the thing under test directly and read its
status (`spawnSync().status`), or index `PIPESTATUS` deliberately and prove the index by making the
process fail on purpose.

**Disposition:** `[PROMOTED → /build-with-verification, false-green traps]` · fix in
`scripts/test-hooks.mjs` (see its header note on `spawnSync`)

### A broad safety rule can fail in the direction nobody tested

**Scar:** A PII control proposed ignoring `identifying/` at any depth. It would have done its job —
and also silently swallowed any source file under a `src/**/identifying/` path. No error, no warning;
code simply never commits.

**Lesson:** Ignore rules, filters, and denylists have two failure directions, and the harmless-looking
one is usually the untested one. Enumerate what the rule catches that it should not, not just what it
misses. Resolution here: **reserve the name** — forbid the directory name project-wide — rather than
narrowing the safety rule and weakening it.

**Disposition:** `[PROMOTED → decision record in the insurance vault]`

### Printed precision is a property of the document, not of the number

**Scar:** A tolerance check inferred a source's precision from the parsed value. `111.0` parses to
`111`, so a figure stated to one decimal was indistinguishable from a whole-number one and silently
received a 10× looser tolerance.

**Lesson:** Parsing discards precision — trailing zeros, decimal places, significant figures all
vanish into the same float. If downstream logic depends on how precisely a value was *stated*, carry
that from the raw input alongside the number. Never re-derive it from the parsed result.

**Disposition:** `[PROMOTED → code + test in the insurance platform]`

### With a checksummed migration runner, fix the original migration — don't append a correction

**Scar:** A column that should never have been nullable. The reflex fix was an `002` ALTER; that
carries the mistake forward permanently in the ledger and in every future reader's mental model.

**Lesson:** When the runner checksums migrations, editing `001` and dropping the local database is the
honest fix and leaves no scar in the schema history. **Only safe while no real data exists anywhere** —
once any deployed database has run the migration, editing it is off the table and the ALTER is correct.
Decide which regime you are in before reaching for either.

**Disposition:** `[RECORDED]` — insurance-platform-specific; this repo's runner and deployed member
databases put it in the opposite regime.

### React Testing Library does not auto-clean when its functions are imported explicitly

**Scar:** Queries began failing with "found multiple elements," at counts of exactly N × tests-run-so-
far. RTL's automatic cleanup only registers when its test functions are injected as globals; the suite
imported them explicitly, so renders accumulated across tests in the file.

**Lesson:** Test-framework auto-cleanup is conditional on how the framework was wired, not guaranteed
by installing it. A failure count that scales with test-execution order is leaked state, not a broken
assertion — read the count before debugging the query.

**Disposition:** `[PROMOTED → test-setup.ts in the insurance platform]`
