---
name: recon
description: Use when you need to know what exists, how something works, or whether something is implemented — before building, planning, or deciding. Also when checking an assumption ("I think X is implemented"). Read-only investigation; reports findings, changes nothing.
allowed-tools: Read, Grep, Glob, Bash(git status:*), Bash(git branch:*), Bash(git log:*), Bash(git show:*), Bash(git diff:*), Bash(ls:*), Bash(cat:*), Bash(test:*)
---

# Recon

**Subject:** $ARGUMENTS

## Live repo state (injected at invocation)

- Branch + working tree: !`git status --short --branch`
- STATE.md (generated ground truth): !`test -f STATE.md && cat STATE.md || echo "(no STATE.md at repo root — full regen: node scripts/state-snapshot.mjs)"`

If the two lines above show literal commands instead of output, run them yourself before investigating — both are read-only.

## The one rule

**READ-ONLY, REPORT-ONLY.** Investigate and report; never create, edit, or delete anything; no commits, no builds, no side-effectful commands. An obvious fix found mid-recon goes in the report as a recommendation — applying it is a different task nobody asked for yet.

## Procedure

1. **Ground first.** Read the injected state above before forming any theory — branch, dirty files, and STATE.md say where things actually are; memory and docs say where they used to be.
2. **Locate, then read.** Grep/glob to find the surfaces, then read the actual code. The codebase is the source of truth: docs drift, git log explains, code decides.
3. **Attack the premise.** If the subject asserts something ("X is implemented", "Y uses Z"), verify it directly against the code. The premise is a hypothesis, not a fact.

## Report shape

Lead with the verdict — the direct answer to the subject. Then:

- **Premise check** (when the subject carried one): open it with `Confirmed:` or `Actually:` — never silently adopt a wrong premise.
- **What exists** — the pieces already there to build on. Every claim cites `path/file.ts:123` and quotes the relevant line(s).
- **What's missing** — what the question assumed or needs that is not in the code.
- **The gap** — the concrete delta between the two, stated as facts about the code, not a plan.
- Mark each finding **✓ verified** (read the code at that location) or **~ inferred** (deduced, not directly confirmed). An inferred finding that matters gets a note on how to verify it.

## Red flags — stop and reread the rule

- An Edit/Write call mid-recon ("while I'm here…")
- A claim with no file:line behind it
- Reporting from STATE.md/docs/memory something the code could contradict
- A findings list that is just file paths — the synthesis is the deliverable
