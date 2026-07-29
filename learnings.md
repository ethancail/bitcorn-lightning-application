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

**Scar:** Two memory errors from the same root. A commit was recorded as "not pushed" and cited that
way two weeks after it had reached origin. A runbook was cited by the wrong date because the date was
transcribed instead of looked up.

**Lesson:** Before writing a fact down, ask whether it can change without anyone editing the note. If
yes, it is volatile and does not get stored — store the *invocation* that answers it. "Not pushed"
should never have been a note; it should have been `git log origin/main..HEAD`. Durable facts
(decisions, architecture, preferences, why something is the way it is) get stored; volatile ones get
re-queried, or stored as a pointer to their source.

**Disposition:** `[RECORDED]` — no enforcement point exists in this repo. It is a convention in the
insurance vault's `CONVENTIONS.md` §3, which this repo does not carry.

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
