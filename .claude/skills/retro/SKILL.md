---
name: retro
description: Use when a significant session is ending and something in it went wrong, was surprising, or passed for a reason nobody checked — invoked deliberately by the operator, not at the end of every session.
allowed-tools: Read, Edit, Write, Grep, Glob, Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git branch:*), Bash(ls:*), Bash(cat:*), Bash(test:*)
---

# Retro

**Focus (optional):** $ARGUMENTS

## The one rule

**Every failure exits as a test, a gate, or a gotcha-line — never as an apology.** A lesson that ends
its life as a sentence in a chat log will be re-learned later at full price.

## Most sessions produce no lesson

Invoked by hand, never by a hook. "Nothing to record" is the expected outcome for routine work — say so
and stop. A forced entry every session is what trains everyone to stop reading the file.

## Ask three questions

1. **What went wrong?** — the concrete failure, not its category.
2. **What was surprising?** — a corrected wrong belief is a scar even when nothing broke.
3. **What did a green result conceal?** — a check that passed for a reason nobody verified is the most
   expensive kind, because on the way in it looks like success.

Answer from what happened this session, not from theory. No candidates → done.

## Decide the disposition BEFORE writing anything

For each candidate, walk the ladder and stop at the first rung that fits:

| Rung | Promote to | When |
|---|---|---|
| 1 | A test | The failure is mechanically detectable. Strongest: it fails loudly, forever, unprompted. |
| 2 | A gate or hook | Detectable, but not as a per-assertion test (a Stop-hook check, a deny rule). |
| 3 | A line in an existing skill | A recurring judgment call inside a workflow that skill already owns. |
| 4 | A CLAUDE.md rule | Repo policy rather than workflow judgment. |
| 5 | A code comment at the site | Only matters to someone reading that specific code. |
| 6 | `learnings.md` alone | Genuinely nowhere to enforce it. The weak form — earn it. |

**A lesson that could have been promoted and was only recorded is a failed retro.** Do the promotion
now — write the test, edit the skill, add the rule — then log an entry pointing at where it lives.

## Earned by repetition

**A pattern that has played out once is an observation, not a convention.** One-offs get a short
`[RECORDED]` entry or get dropped. Only a pattern seen more than once earns an edit to a skill or to
CLAUDE.md — a skill that accumulates every one-off stops being read, and then it enforces nothing.

Tests and code comments (rungs 1, 2, 5) are exempt: they are local and cost nothing to carry, so a
single occurrence is reason enough.

## Write the entry

Newest first in `learnings.md`, matching the entries already there:

- **Scar** — what actually happened, concretely, one or two sentences.
- **Lesson** — generalized, phrased so it is useful *before* the mistake rather than after.
- **Disposition** — `[PROMOTED → <where>]` or `[RECORDED]`.

Then keep the file re-readable: any older entry whose lesson is now fully enforced elsewhere collapses
to a one-line pointer at that enforcement. The target is a file someone will actually re-read while
about to make a mistake — not an archive.

Committing is out of scope (this skill holds no write access to git). Leave the edits in the working
tree for the normal commit path.

## Red flags — the retro is failing

- A mechanically testable lesson with disposition `[RECORDED]`
- A skill or CLAUDE.md edit justified by a single occurrence
- A lesson written as a resolution ("be more careful with…") instead of a rule that fires on its own
- Re-running builds or tests to "confirm" — a retro reflects; verifying was the previous step's job
- `learnings.md` growing while nothing gets pruned
