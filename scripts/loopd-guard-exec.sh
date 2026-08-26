#!/usr/bin/env bash
# loopd-guard-exec.sh — EXECUTED half of the app/loopd/Dockerfile guard control.
#
# Runs the VERBATIM RUN body emitted by loopd-guard-static.py inside a
# bubblewrap sandbox, under scenarios that vary ONLY the environment. The
# command text is never edited (except in --mutants mode, which builds clearly
# labelled weakened COPIES and leaves the real body untouched).
#
#   A  correct digest, correct arch              must SUCCEED
#   B  wrong pinned digest                       must ABORT (checksum)
#   C  valid digest, WRONG ARCHITECTURE inside   must ABORT (e_machine)
#
# A is not optional. Without it, B and C prove nothing: a body that always
# failed would "fail closed" vacuously and look identical to a working guard.
#
# ── RUN BOTH ARCHES. ────────────────────────────────────────────────────────
# EXPECT_EM is a hand-written literal in BOTH case arms, so the arms can be
# wrong INDEPENDENTLY. A single-arch run is a guard tested at one entry point:
#   * transpose (3e <-> b7)      — caught from EITHER side
#   * dup-b7 (BOTH arms 'b7 00') — caught ONLY from amd64; from arm64 it aborts
#     exactly as a correct guard would, so that side cannot see it at all
#   * dup-3e (BOTH arms '3e 00') — the mirror: caught ONLY from arm64
# Each duplication is therefore visible from exactly one side, which is the
# whole argument for running both. `--mutants` re-runs scenario C against all
# three weakened copies and prints which side sees which. A "MISSED" line is the
# EVIDENCE, not a failure — it is that blind spot being demonstrated.
#
# ⚠ The duplications are FIXED mutations, deliberately not relative to the arch
# under test. An earlier version defined them as "the arch under test takes the
# other arm's literal", which always mutates the arm being exercised — so every
# mutant was trivially caught and the control silently stopped demonstrating the
# asymmetry this comment claims. A mutation test proves only what its mutants
# can distinguish.
#
# ── ⚠ COULD-NOT-RUN IS NOT A VERDICT. ──────────────────────────────────────
# A real finding from building this: passing RELATIVE payload paths made the
# curl shim fail before the guard was ever reached. Every run then reported
# `rc=99, /out empty` — non-zero exit and an empty /out, which is exactly what
# a clean abort looks like. A dead harness presenting as a passing one.
# So classification here is by OUTPUT, not by exit code: a run whose shim never
# served, or that reached no recognisable verdict line, is COULD-NOT-RUN and
# exits 2, never 0 and never 1. Payload paths are asserted absolute up front,
# and exit code 99 is reserved for the shim so it can never read as an abort.
#
# ⚠ AND THE MIRROR OF THAT, found by running this file: the first version of
# the classifier recognised only `FATAL:` as an abort. Scenario B aborts through
# `sha256sum -c` failing under `set -eu` — it prints "FAILED" and "did NOT
# match" and NEVER prints FATAL — so a perfectly correct checksum abort was
# reported as COULD-NOT-RUN. Guarding against one misclassification introduced
# its opposite. Hence: each scenario now also pins the REASON it must abort for
# (`reason_re`). A scenario that aborts for the wrong reason is a DEVIATION, not
# a pass — otherwise scenario C could "pass" by failing its checksum and never
# reaching the ELF guard it exists to exercise.
#
# Exit: 0 = all scenarios as expected · 1 = a scenario deviated (guard is wrong)
#       2 = could not run (environment/harness) — deliberately distinct from 1.
#
# Needs: bwrap, tar, python3, gh (first run only, to populate the cache), and
# both release tarballs for the pinned LOOP_VERSION — the wrong-arch payload is
# built from the OTHER arch's binaries. Tarballs are cached and digest-checked
# against the Dockerfile's own pins.
#
#   scripts/loopd-guard-exec.sh                      # both arches, A/B/C
#   scripts/loopd-guard-exec.sh --arch amd64          # one arch
#   scripts/loopd-guard-exec.sh --mutants             # + discrimination matrix
#   scripts/loopd-guard-exec.sh --cache DIR --keep
set -uo pipefail

ARCHES="both"; MUTANTS=0; KEEP=0
CACHE="${LOOPD_GUARD_CACHE:-/tmp/loopd-guard-cache}"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
DOCKERFILE="$ROOT/app/loopd/Dockerfile"
while [ $# -gt 0 ]; do
  case "$1" in
    --arch)       ARCHES="$2"; shift 2 ;;
    --mutants)    MUTANTS=1; shift ;;
    --cache)      CACHE="$2"; shift 2 ;;
    --dockerfile) DOCKERFILE="$2"; shift 2 ;;
    --keep)       KEEP=1; shift ;;
    -h|--help)    sed -n '2,48p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
[ "$ARCHES" = "both" ] && ARCHES="amd64 arm64"

die2 () { echo; echo "COULD NOT RUN: $*" >&2; exit 2; }

command -v bwrap   >/dev/null || die2 "bwrap not installed (apt install bubblewrap)"
command -v python3 >/dev/null || die2 "python3 not installed"
[ -r "$DOCKERFILE" ] || die2 "unreadable Dockerfile: $DOCKERFILE"

WORK="$(mktemp -d /tmp/loopd-guard.XXXXXX)"
cleanup () { if [ "$KEEP" = 1 ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi; }
trap cleanup EXIT

# ── the body under test, extracted from the Dockerfile (never transcribed) ──
BODY="$WORK/body.sh"
python3 "$ROOT/scripts/loopd-guard-static.py" --dockerfile "$DOCKERFILE" --emit "$BODY" \
  > "$WORK/static.log" 2>&1
rc=$?
if [ $rc -eq 2 ]; then cat "$WORK/static.log"; die2 "static half could not run"; fi
if [ $rc -ne 0 ]; then
  cat "$WORK/static.log"
  echo "STATIC ASSERTIONS FAILED — not running scenarios" >&2; exit 1
fi
[ -s "$BODY" ] || die2 "static half emitted an empty body"
echo "body under test : $(sha256sum "$BODY" | cut -d' ' -f1)"

# ── pinned values, read out of the Dockerfile rather than transcribed here ──
argval () { sed -n "s/^ARG $1=\(.*\)$/\1/p" "$DOCKERFILE" | head -1; }
LOOP_VERSION="$(argval LOOP_VERSION)"
SHA_AMD64="$(argval LOOP_SHA256_AMD64)"
SHA_ARM64="$(argval LOOP_SHA256_ARM64)"
[ -n "$LOOP_VERSION" ] && [ -n "$SHA_AMD64" ] && [ -n "$SHA_ARM64" ] \
  || die2 "could not read LOOP_VERSION / LOOP_SHA256_* out of $DOCKERFILE"
ZERO=0000000000000000000000000000000000000000000000000000000000000000
echo "pinned version  : $LOOP_VERSION"

# e_machine literals, asserted against the body so a Dockerfile change cannot
# silently desync this harness from the thing it is supposed to test.
em_for () { case "$1" in amd64) echo '3e 00' ;; arm64) echo 'b7 00' ;; esac; }
for a in amd64 arm64; do
  A_UP="$(echo "$a" | tr 'a-z' 'A-Z')"
  grep -qF "$a) SHA256=\"\$LOOP_SHA256_${A_UP}\"; EXPECT_EM='$(em_for "$a")'" "$BODY" \
    || die2 "the $a arm does not carry EXPECT_EM='$(em_for "$a")' — harness and Dockerfile disagree"
done

# ── the curl shim. Serves an already-downloaded tarball from disk, honouring
# the real invocation's -o so the body's own download statement is what runs.
# No network. Exit 99 is RESERVED for shim failure and read as could-not-run.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'SHIM'
#!/bin/sh
dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    *)  shift ;;
  esac
done
[ -n "$dest" ] || { echo "shim: no -o given" >&2; exit 99; }
[ -f "$NC_SRC" ] || { echo "shim: NC_SRC missing or not absolute: $NC_SRC" >&2; exit 99; }
cp "$NC_SRC" "$dest"
echo "  [curl shim] served $(basename "$NC_SRC") -> $dest" >&2
SHIM
chmod +x "$WORK/bin/curl"

# ── tarball acquisition: cached, then digest-checked against the Dockerfile ──
mkdir -p "$CACHE"
fetch () { # arch -> echoes absolute tarball path
  local a="$1" want tb name got
  case "$a" in amd64) want="$SHA_AMD64" ;; arm64) want="$SHA_ARM64" ;; esac
  name="loop-linux-$a-$LOOP_VERSION.tar.gz"
  tb="$CACHE/$name"
  if [ ! -f "$tb" ]; then
    command -v gh >/dev/null || { echo "gh CLI needed to populate the cache" >&2; return 2; }
    echo "  fetching $name via gh release download ..." >&2
    gh release download "$LOOP_VERSION" --repo lightninglabs/loop \
       --pattern "$name" --dir "$CACHE" \
      || { rm -f "$tb"; echo "gh release download failed" >&2; return 2; }
  fi
  got="$(sha256sum "$tb" | cut -d' ' -f1)"
  [ "$got" = "$want" ] \
    || { echo "cached $a tarball digest $got != pinned $want" >&2; return 2; }
  # extract once — the wrong-arch payload is built from these binaries
  if [ ! -d "$CACHE/loop-linux-$a-$LOOP_VERSION" ]; then
    tar -xzf "$tb" -C "$CACHE" || return 2
  fi
  echo "$tb"
}

# ── wrong-arch payload: the OTHER arch's binaries under THIS arch's dirname,
# pinned to its own digest so the checksum PASSES and only the ELF guard can
# catch it. Upstream's March failure, reproducible in either direction.
badarch_payload () { # arch -> echoes "abs_path sha"
  local a="$1" other dir bad
  case "$a" in amd64) other=arm64 ;; arm64) other=amd64 ;; esac
  dir="loop-linux-$a-$LOOP_VERSION"
  bad="$WORK/bad-$a"; rm -rf "$bad"; mkdir -p "$bad/$dir"
  cp "$CACHE/loop-linux-$other-$LOOP_VERSION/loopd" \
     "$CACHE/loop-linux-$other-$LOOP_VERSION/loop" "$bad/$dir/" || return 2
  tar -czf "$WORK/bad-$a.tar.gz" -C "$bad" "$dir" || return 2
  echo "$WORK/bad-$a.tar.gz $(sha256sum "$WORK/bad-$a.tar.gz" | cut -d' ' -f1)"
}

# ── one scenario. Classification is by OUTPUT; see the COULD-NOT-RUN note.
# NOTE: in --mutants mode this runs inside a command substitution, so PASSES /
# DEVIATIONS increments there stay in that subshell and cannot pollute the real
# summary — a mutant "deviating" is the desired result, not a failure.
PASSES=0; DEVIATIONS=0
run_scenario () { # label arch payload(ABS) sha_amd64 sha_arm64 expect reason_re [bodyfile]
  local label="$1" ta="$2" src="$3" sa="$4" sr="$5" expect="$6" reason_re="$7" body="${8:-$BODY}"
  case "$src" in
    /*) ;;
    *) die2 "payload path is not absolute: $src — this is the rc=99 trap" ;;
  esac
  [ -f "$src" ] || die2 "payload missing: $src"
  local box; box="$(mktemp -d "$WORK/box.XXXXXX")"; mkdir -p "$box/out" "$box/fetch"
  echo "════════════════════════════════════════════════════════════════════"
  echo "SCENARIO: $label"
  echo "  TARGETARCH   : $ta   payload: $(basename "$src")   expect: $expect"
  echo "════════════════════════════════════════════════════════════════════"
  local out rc n verdict
  out="$(bwrap \
    --ro-bind /usr /usr --ro-bind /etc /etc \
    --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
    --ro-bind "$WORK/bin" /shim --ro-bind "$src" "$src" \
    --bind "$box/out" /out --bind "$box/fetch" /fetch \
    --proc /proc --dev /dev --chdir /fetch \
    --setenv PATH /shim:/usr/bin:/bin --setenv NC_SRC "$src" \
    --setenv TARGETARCH "$ta" --setenv LOOP_VERSION "$LOOP_VERSION" \
    --setenv LOOP_SHA256_AMD64 "$sa" --setenv LOOP_SHA256_ARM64 "$sr" \
    /usr/bin/sh -c "$(cat "$body")" 2>&1)"
  rc=$?
  echo "$out"
  n="$(ls -A "$box/out" 2>/dev/null | wc -l)"
  echo
  echo "  EXIT CODE: $rc"
  echo "  /out contents: [$(ls -A "$box/out" 2>/dev/null | tr '\n' ' ')]"
  [ "$n" -eq 0 ] && echo "  /out is EMPTY — nothing was installed."

  # Classify by OUTPUT: rc alone cannot tell an abort from a dead harness.
  # NOTE the checksum path prints no FATAL — it dies on sha256sum's exit status
  # under `set -eu`. Omitting its signature here misread a correct abort as
  # could-not-run; see the header.
  if [ "$rc" -eq 99 ] || ! echo "$out" | grep -q '\[curl shim\] served'; then
    verdict="couldnotrun"
  elif echo "$out" | grep -q '^OK:'; then
    verdict="succeed"
  elif echo "$out" | grep -qE 'FATAL:|did NOT match|\.tar\.gz: FAILED'; then
    verdict="abort"
  else
    verdict="couldnotrun"
  fi
  rm -rf "$box"

  if [ "$verdict" = "couldnotrun" ]; then
    echo "  ⚠ COULD-NOT-RUN — reached neither FATAL nor OK. NOT a verdict."
    exit 2
  fi
  if [ "$verdict" != "$expect" ]; then
    echo "  ✗ DEVIATION — expected $expect, got $verdict"; DEVIATIONS=$((DEVIATIONS+1))
  elif ! echo "$out" | grep -qE "$reason_re"; then
    # right outcome, wrong cause — the scenario never exercised its target
    echo "  ✗ DEVIATION — $expect, but not for the expected reason (want /$reason_re/)"
    DEVIATIONS=$((DEVIATIONS+1))
  elif [ "$expect" = "abort" ] && [ "$n" -ne 0 ]; then
    # an abort must also have installed nothing
    echo "  ✗ DEVIATION — aborted but left /out populated"; DEVIATIONS=$((DEVIATIONS+1))
  else
    echo "  ✓ as expected ($expect)"; PASSES=$((PASSES+1))
  fi
  echo
}

for ARCH in $ARCHES; do
  case "$ARCH" in amd64|arm64) ;; *) die2 "unsupported --arch: $ARCH" ;; esac
  OTHER=amd64; [ "$ARCH" = amd64 ] && OTHER=arm64
  echo; echo "###########################  ARCH=$ARCH  ###########################"
  GOOD="$(fetch "$ARCH")" || die2 "could not obtain the $ARCH tarball"
  fetch "$OTHER" >/dev/null \
    || die2 "could not obtain the $OTHER tarball (needed for the wrong-arch payload)"
  BADOUT="$(badarch_payload "$ARCH")" || die2 "could not build the wrong-arch payload"
  read -r BAD BADSHA <<<"$BADOUT"
  echo "wrong-arch payload: $OTHER binaries as loop-linux-$ARCH-$LOOP_VERSION/ (e_machine $(em_for "$OTHER")), sha=$BADSHA"
  echo

  # Only the arch under test needs its digest varied; the other stays pinned.
  case "$ARCH" in
    amd64) B_SA="$ZERO";      B_SR="$SHA_ARM64"; C_SA="$BADSHA";    C_SR="$SHA_ARM64" ;;
    arm64) B_SA="$SHA_AMD64"; B_SR="$ZERO";      C_SA="$SHA_AMD64"; C_SR="$BADSHA" ;;
  esac

  run_scenario "A · POSITIVE CONTROL — correct digest, correct arch" \
               "$ARCH" "$GOOD" "$SHA_AMD64" "$SHA_ARM64" succeed '^OK:'
  run_scenario "B · MUTATED CHECKSUM — wrong pinned digest" \
               "$ARCH" "$GOOD" "$B_SA" "$B_SR" abort 'did NOT match|\.tar\.gz: FAILED'
  run_scenario "C · WRONG ARCHITECTURE, VALID CHECKSUM" \
               "$ARCH" "$BAD" "$C_SA" "$C_SR" abort 'has e_machine='

  if [ "$MUTANTS" = 1 ]; then
    echo "── MUTATION CONTROL, ARCH=$ARCH — can scenario C see a broken literal? ──"
    for MUT in transpose dup-b7 dup-3e; do
      python3 - "$BODY" "$WORK/mut-$MUT-$ARCH.sh" "$MUT" "$ARCH" <<'PY'
import sys
src, dst, kind, _arch = sys.argv[1:5]
b = open(src).read()
AM = 'amd64) SHA256="$LOOP_SHA256_AMD64"; EXPECT_EM='
AR = 'arm64) SHA256="$LOOP_SHA256_ARM64"; EXPECT_EM='
# All three are FIXED weakenings — never relative to the arch under test, or the
# mutant would always land on the arm being exercised and always be caught.
if kind == "transpose":
    b = (b.replace(AM + "'3e 00'", AM + "'@@'")
          .replace(AR + "'b7 00'", AR + "'3e 00'")
          .replace(AM + "'@@'", AM + "'b7 00'"))
elif kind == "dup-b7":     # both arms expect EM_AARCH64
    b = b.replace(AM + "'3e 00'", AM + "'b7 00'")
elif kind == "dup-3e":     # both arms expect EM_X86_64
    b = b.replace(AR + "'b7 00'", AR + "'3e 00'")
else:
    raise SystemExit(f"unknown mutant: {kind}")
if b == open(src).read():
    raise SystemExit(f"mutant {kind} changed nothing — literals moved?")
open(dst, "w").write(b)
PY
      # A mutant that FAILS to abort is one scenario C would have caught.
      MOUT="$(run_scenario "MUTANT[$MUT] under scenario C" "$ARCH" "$BAD" \
                           "$C_SA" "$C_SR" abort 'has e_machine=' \
                           "$WORK/mut-$MUT-$ARCH.sh" 2>&1)"
      echo "$MOUT" | sed 's/^/    /'
      if echo "$MOUT" | grep -qE 'COULD-NOT-RUN|COULD NOT RUN'; then
        die2 "mutant [$MUT] on $ARCH could not run — its result is unknown, not MISSED"
      elif echo "$MOUT" | grep -q 'DEVIATION'; then
        echo "    => $MUT is CAUGHT from $ARCH (scenario C goes red)"
      else
        echo "    => $MUT is MISSED from $ARCH (aborts exactly like a correct guard)"
      fi
      echo
    done
    echo "  real body unchanged: $(sha256sum "$BODY" | cut -d' ' -f1)"
  fi
done

echo "════════════════════════════════════════════════════════════════════"
echo "SUMMARY: $PASSES as-expected, $DEVIATIONS deviation(s)"
if [ "$DEVIATIONS" -gt 0 ]; then
  echo "RESULT: THE GUARD DEVIATED — exit 1"; exit 1
fi
echo "RESULT: all scenarios behaved as required — exit 0"
exit 0
