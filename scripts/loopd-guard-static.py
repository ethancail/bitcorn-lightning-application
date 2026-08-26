#!/usr/bin/env python3
"""
loopd-guard-static.py — STATIC half of the app/loopd/Dockerfile guard control.

Extracts the LITERAL RUN instructions from the Dockerfile with a parser (comment
stripping + backslash-continuation folding, which is what makes "reason over the
actual command" possible at all), asserts properties over the real text of the
checksum-verifying RUN, and emits that RUN's body for the executed half
(loopd-guard-exec.sh) to run VERBATIM.

The failure mode being hunted: a guard whose non-zero exit is swallowed — piped
into something, `|| true`'d, or reached only after the unverified bytes have
already been used.

WHY THIS IS COMMITTED. It was scratch for five months. Recovering it from /tmp
worked by luck; see learnings.md, "A verification artifact that is discarded
takes its own lesson with it." Scratch verification and committed verification
are different artifacts and only the second is still verification next month.

    python3 scripts/loopd-guard-static.py [--dockerfile PATH] [--emit PATH]

Exit 0 = all assertions pass. Exit 1 = an assertion failed. Exit 2 = could not
run (Dockerfile unreadable, or the verifying RUN not found) — a distinct class
from "the guard is wrong", so a broken environment can never read as either
verdict.
"""
import re
import sys

DOCKERFILE = "app/loopd/Dockerfile"
EMIT = None
_args = sys.argv[1:]
while _args:
    a = _args.pop(0)
    if a == "--dockerfile":
        DOCKERFILE = _args.pop(0)
    elif a == "--emit":
        EMIT = _args.pop(0)
    elif not a.startswith("-"):
        DOCKERFILE = a          # positional, for compatibility with the original
    else:
        print(f"unknown flag: {a}", file=sys.stderr)
        sys.exit(2)

try:
    raw = open(DOCKERFILE, encoding="utf-8").read().splitlines()
except OSError as exc:
    print(f"COULD-NOT-RUN: {exc}", file=sys.stderr)
    sys.exit(2)

# ── Parse: fold continuations, drop comments (including comments that appear
# INSIDE a continued instruction, which Docker permits and which a naive
# `\`-join would otherwise splice into the command). ────────────────────────
instructions = []          # list of (start_line_1indexed, folded_text)
cur, start = None, None
for i, line in enumerate(raw, start=1):
    stripped = line.strip()
    if cur is None:
        if not stripped or stripped.startswith("#"):
            continue
        cur, start = line.rstrip(), i
    else:
        if stripped.startswith("#"):
            continue                      # comment inside a continuation
        cur = cur[:-1].rstrip() + " " + stripped if cur.rstrip().endswith("\\") else cur
    if cur.rstrip().endswith("\\"):
        continue
    instructions.append((start, cur))
    cur, start = None, None
if cur is not None:
    instructions.append((start, cur))

runs = [(ln, t) for ln, t in instructions if re.match(r"^\s*RUN\s", t)]
print(f"parser: {len(instructions)} instructions, {len(runs)} RUN")
for ln, t in runs:
    print(f"  RUN at line {ln}: {len(t)} chars")

verify = [(ln, t) for ln, t in runs if "sha256sum -c" in t]
if len(verify) != 1:
    print(f"COULD-NOT-RUN: expected exactly 1 RUN containing 'sha256sum -c', found {len(verify)}")
    sys.exit(2)
VLINE, VTEXT = verify[0]

print()
print("=" * 76)
print(f"LITERAL TEXT OF THE VERIFYING RUN (line {VLINE}), AS THE SHELL WILL SEE IT")
print("=" * 76)
body = re.sub(r"^\s*RUN\s+", "", VTEXT)
for stmt in body.split("; "):
    print("  " + stmt.strip())
print("=" * 76)
print()

fails = []


def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))
    if not ok:
        fails.append(name)


print("STATIC ASSERTIONS OVER THAT TEXT")

# 1. set -eu heads the command, so any non-zero exit aborts.
check("`set -eu` is the first statement (non-zero exit aborts the RUN)",
      body.startswith("set -eu"), body[:12])

# 2. THE CORE ONE. The sha256sum -c statement must not be piped, backgrounded,
#    or short-circuited. Isolate the statement it lives in and inspect it.
idx = body.index("sha256sum -c")
stmt_start = body.rfind("; ", 0, idx)
stmt_start = 0 if stmt_start == -1 else stmt_start + 2
nxt = body.find("; ", idx)
stmt = body[stmt_start: len(body) if nxt == -1 else nxt]
print(f"        statement under test: {stmt!r}")
check("the sha256sum -c statement contains no pipe", "|" not in stmt, stmt)
check("the sha256sum -c statement has no `||` fallback", "||" not in stmt)
check("the sha256sum -c statement has no `&&` chain that could mask it", "&&" not in stmt)
check("the sha256sum -c statement is not `; true`-suffixed", "true" not in stmt)
check("the sha256sum -c statement is not backgrounded", "&" not in stmt)

# 3. Order: the tarball is downloaded and the digest file written BEFORE the
#    verify, and extraction happens AFTER it. A `curl | tar` would use the bytes
#    before checking them.
i_curl = body.index("curl ")
i_expect = body.index(".sha256\"")
i_tar = body.index("tar -xzf")
check("download precedes verification", i_curl < idx, f"curl@{i_curl} < verify@{idx}")
check("expected-digest file is written before verification", i_expect < idx)
check("extraction happens AFTER verification (no curl|tar)", i_tar > idx,
      f"tar@{i_tar} > verify@{idx}")
check("curl is never piped into tar", not re.search(r"curl[^;]*\|[^;]*tar", body))
check("curl uses -f so an HTTP error is a non-zero exit",
      re.search(r"curl\s+-[a-zA-Z]*f", body) is not None)

# 4. The arch case must have no surviving default branch.
m = re.search(r"case \"\$TARGETARCH\" in(.*?)esac", body, re.S)
check("a `case` on TARGETARCH exists", m is not None)
if m:
    star = re.search(r"\*\)(.*?);;", m.group(1), re.S)
    check("the `*)` default branch exists and exits non-zero",
          star is not None and "exit 1" in star.group(1))
    for arch in ("amd64", "arm64"):
        check(f"`{arch})` branch present", f"{arch})" in m.group(1))
    check("no armv6/armv7/386 branch could be reached",
          not re.search(r"\b(armv6|armv7|386)\)", m.group(1)))
    # 4b. Both EXPECT_EM literals are hand-written, so they can be wrong
    #     INDEPENDENTLY. Assert each arm carries its own correct value — a
    #     duplication (both arms the same literal) is invisible to a
    #     single-arch executed run. See loopd-guard-exec.sh --mutants.
    check("the amd64 arm expects e_machine '3e 00' (EM_X86_64)",
          "amd64) SHA256=\"$LOOP_SHA256_AMD64\"; EXPECT_EM='3e 00'" in m.group(1))
    check("the arm64 arm expects e_machine 'b7 00' (EM_AARCH64)",
          "arm64) SHA256=\"$LOOP_SHA256_ARM64\"; EXPECT_EM='b7 00'" in m.group(1))

# 5. Every ELF guard body exits non-zero. Two `if [ ... ]` blocks: magic, arch.
#
# ⚠ THE `fi` TERMINATOR MUST BE WORD-ANCHORED. A plain non-greedy `(.*?)fi`
# reported a FALSE FAILURE here on the first run of this control: it matched the
# `fi` inside the word "file" in the e_machine guard's own message ("...this
# FIle exists to prevent"), truncating the captured body before its `exit 1`.
# The checker was reasoning over appearance, which is the exact error this
# control exists to catch — so it is fixed here rather than papered over by
# rewording the Dockerfile's error text. That sentence still contains "file"
# ON PURPOSE: it is the fixture that keeps this anchor honest. If it is ever
# reworded away, this assertion stops testing anything.
ifs = re.findall(
    r"if \[ \"\$(MAGIC|EM)\" != \"([^\"]*)\" \]; then(.*?)(?<![A-Za-z])fi(?![A-Za-z])",
    body, re.S)
check("both ELF guards found (magic + e_machine)", len(ifs) == 2, f"found {len(ifs)}")
for var, expected, guard_body in ifs:
    check(f"the {var} guard exits non-zero on mismatch", "exit 1" in guard_body)
check("the e_machine message still contains the word \"file\" (the fi-anchor fixture)",
      "this file exists to prevent" in body)

# 5b. The `mv` that installs the binaries into /out must come AFTER both ELF
#     guards — nothing gets staged where the final stage COPYs from until it has
#     passed. Added after the executed control showed a wrong-arch abort leaving
#     /out populated.
i_mv = body.index("mv \"${DIR}/loopd\"")
i_em_guard = body.index('if [ "$EM" !=')
i_magic_guard = body.index('if [ "$MAGIC" !=')
check("the mv into /out happens AFTER the magic guard", i_mv > i_magic_guard,
      f"mv@{i_mv} > magic@{i_magic_guard}")
check("the mv into /out happens AFTER the e_machine guard", i_mv > i_em_guard,
      f"mv@{i_mv} > em@{i_em_guard}")
check("the ELF guards inspect the EXTRACTED path, not /out",
      'for BIN in "${DIR}/loopd" "${DIR}/loop"' in body)

# 6. The digest actually compared must come from an ARG, not be inlined blank.
check("SHA256 is assigned from a pinned ARG per arch",
      'SHA256="$LOOP_SHA256_AMD64"' in body and 'SHA256="$LOOP_SHA256_ARM64"' in body)

print()
if fails:
    print(f"STATIC: {len(fails)} FAILED — {fails}")
    sys.exit(1)
print("STATIC: all assertions passed.")

if EMIT:
    with open(EMIT, "w", encoding="utf-8") as fh:
        fh.write(body + "\n")
    print(f"wrote the verbatim RUN body to {EMIT} (unmodified)")
