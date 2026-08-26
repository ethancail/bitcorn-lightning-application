# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Bitcorn-published loopd — REPACKAGED FROM UPSTREAM'S RELEASE BINARIES.
# Not compiled from source. No Go toolchain, no cross-compile, no QEMU.
#
# WHY THIS FILE EXISTS. lightninglabs/loop's own Dockerfile pins BOTH stages to
# `FROM --platform=${BUILDPLATFORM}` (its Dockerfile:1 and :21) while its
# publish workflow requests `platforms: linux/amd64,linux/arm64`
# (its docker.yml:39). Both stages therefore build on the runner's arch, and the
# arm64 manifest entry ends up carrying an amd64 filesystem. On a Pi 5 that is
# "exec format error". It is why Bitcorn moved to litd in March 2026 (2dc6e8a),
# and litd's price is that it never re-reads LND's TLS cert and never exits — so
# Loop stays dead after a cert rotation until a human restarts Bitcorn.
# Retiring that is the point of this image.
#
# ⚠ VERIFY THE ARTIFACT, NEVER THE MANIFEST. Nothing in this file may treat a
# manifest entry, a `platforms:` line, or a green build as evidence that a binary
# is the right architecture. Upstream's broken image is the proof of why.
# Measured 2026-08-25 against lightninglabs/loop:v0.34.0-beta-v0.8.1-tapd (the
# only tag still published to Docker Hub): its amd64 and arm64 entries share ALL
# FOUR byte-identical layer digests, and the two config blobs differ in exactly
# one string — "architecture": "amd64" vs "arm64". Same filesystem, different
# label. The manifest was a claim; the layers were the fact.
#
# So this build reads e_machine out of the ELF header of every binary it copies
# and refuses on mismatch, and the acceptance test for the published image is
# `loopd --version` on real aarch64 hardware — see DONE-WHEN below.
#
# WHY ONE STAGE IS PINNED AND THE OTHER MUST NOT BE — this is the whole fix.
#   `fetch` IS pinned to $BUILDPLATFORM, deliberately: downloading and
#     checksumming a tarball is architecture-agnostic work, and WHICH tarball it
#     takes is decided by TARGETARCH, which BuildKit sets from the build TARGET
#     in every stage — including a $BUILDPLATFORM one. Running natively also
#     means no arm64 instruction is ever emulated.
#   the final stage is NOT pinned. It resolves per target. That is the line
#     upstream got wrong, and it contains no RUN at all, so the
#     alpine-under-QEMU illegal-instruction class in CLAUDE.md § Umbrel Gotchas
#     cannot bite here.
#
# BASE IS debian:12-slim, AND LINKAGE IS NOT THE REASON. The release binaries
# are CGO_ENABLED=0 (`go version -m loopd`), statically linked, no PT_INTERP —
# alpine, scratch or slim would all run them. Debian is chosen because this
# repo's recorded QEMU scar is musl: node:20-alpine crashed multi-arch builds
# with "illegal instruction" and node:20-slim fixed it
# (app/api/Dockerfile:1-7). Alpine would save ~23MB of a ~190MB image; not
# worth reintroducing musl.
#
# ─── DONE-WHEN — ACCEPTANCE CRITERIA, AS OBSERVABLES ────────────────────────
# A green CI build is NOT any of these. Neither is a manifest that says arm64.
#
# 1. ⚠ THE ONE THAT RETIRES THE MARCH SCAR — A LOCAL NATIVE BUILD ON THE
#    aarch64 MEMBER NODE (Pi 5). Not a pull of a published image: publishing is
#    gated behind a Bitcorn release (docker-publish.yml's get-version asserts
#    the release tag is new), so waiting for GHCR would mean proving the
#    artifact only AFTER shipping it. Run these two commands on the Pi:
#
#        docker build -t bitcorn-loopd:local app/loopd
#        docker run --rm bitcorn-loopd:local loopd --version
#
#    Expected: `loopd version 0.33.0-beta commit= commit_hash=`, exit 0.
#    A native build on aarch64 sets TARGETARCH=arm64 with no --platform flag, so
#    this exercises the real arm64 path end to end.
#    If it instead fails with "unsupported TARGETARCH=''", BuildKit is disabled
#    (TARGETARCH is a BuildKit-only variable) — re-run with DOCKER_BUILDKIT=1.
#    That failure is the guard working, not a bug.
#
# 2. The same two commands on x86_64 (treasury). Proves the arch selection is
#    real rather than accidentally correct on one side.
#
# 3. A build triggered by touching this file appears in Actions. Note the
#    trigger is a push to `main` whose version was bumped — see the TAG SCHEME
#    note in docker-publish.yml's build-loopd job.
#
# 4. FIRST PUBLISH ONLY — the new GHCR package must be PUBLIC. Umbrel nodes pull
#    anonymously; a private package is the flips-back-to-Install-at-0% failure in
#    CLAUDE.md § Umbrel Gotchas. Check it without pulling:
#
#        curl -s "https://ghcr.io/token?service=ghcr.io&scope=repository:ethancail/bitcorn-lightning-application/loopd:pull" \
#          | sed 's/.*"token":"\([^"]*\)".*/\1/' > /tmp/t
#        curl -sI -H "Authorization: Bearer $(cat /tmp/t)" \
#          -H "Accept: application/vnd.oci.image.index.v1+json" \
#          https://ghcr.io/v2/ethancail/bitcorn-lightning-application/loopd/manifests/latest
#
#    200 = public. 401/404 = flip the package to public in its GHCR settings.
#    (api and web both answer 200 today; loopd 404s because it does not exist
#    yet.)
# ─────────────────────────────────────────────────────────────────────────────

# ── Upstream release to ship ─────────────────────────────────────────────────
# v0.33.0-beta matches the loopd binary the repo's dev layer already exercises
# (root package.json, the `_comment_loop_layer` string and dev:loopd-T/A/B).
# Bump all three of these together. The digests are the published ones for THIS
# version — read from manifest-v0.33.0-beta.txt in the same GitHub release, and
# verified against both downloaded tarballs (`sha256sum -c` → OK) on 2026-08-25:
#
#     gh release download v0.33.0-beta --repo lightninglabs/loop \
#       --pattern 'manifest-v0.33.0-beta.txt' -D .
#
# The digests are pinned HERE rather than fetched at build time on purpose:
# manifest-<v>.txt ships from the same host as the tarball, so fetching it
# proves transit integrity and nothing about authenticity. A digest committed to
# this repo makes the repo the trust anchor and the build reproducible.
# (The release also publishes manifest-<v>.txt.sig, a detached Lightning Labs
# signature. Verifying it against a pinned key would be strictly stronger; it
# needs gpg in the build and a key-rotation story, so it is a separate arc.)
ARG LOOP_VERSION=v0.33.0-beta
ARG LOOP_SHA256_AMD64=cf391bdd923d0ab8edbc89b8e593789bc5aebe936cd5e71ffb83fcd25f6a35a4
ARG LOOP_SHA256_ARM64=ec5b7e207f75275ab2cedcbf7015274b4f2c034f2b0767b8437a2cb8782aa82c

# ── Base image, PINNED BY DIGEST ─────────────────────────────────────────────
# NOT `debian:12-slim`. A Debian tag move would ship different bytes under an
# unchanged Bitcorn image tag — the same-tag hazard from CLAUDE.md § Umbrel
# Gotchas, arriving via the base image instead of via a missed version bump.
# Pinning makes rebuilds byte-identical, so a member re-pull is a no-op and the
# build is reproducible.
#
# ⚠ THIS MUST BE THE **INDEX** DIGEST, NEVER A PER-ARCH MANIFEST DIGEST.
# An index digest still resolves per target platform, which is what keeps the
# final stage multi-arch. Pinning the amd64 manifest digest instead would make
# BOTH platform entries resolve to amd64 — reproducing upstream's exact bug from
# the other direction. Verify before trusting a digest: the reference below is an
# `application/vnd.oci.image.index.v1+json` carrying linux/amd64 and
# linux/arm64/v8 (checked 2026-08-25).
#
# TO BUMP — mechanical, one command:
#     docker buildx imagetools inspect debian:12-slim --format '{{.Manifest.Digest}}'
# Without docker, the same value is the registry's Docker-Content-Digest header,
# which also equals the sha256 of the raw manifest bytes (both agreed when this
# was resolved):
#     TOK=$(curl -s 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/debian:pull' | sed 's/.*"token":"\([^"]*\)".*/\1/')
#     curl -sI -H "Authorization: Bearer $TOK" \
#       -H 'Accept: application/vnd.oci.image.index.v1+json' \
#       https://registry-1.docker.io/v2/library/debian/manifests/12-slim | grep -i docker-content-digest
#
# Overriding BASE_IMAGE via --build-arg unpins the build. Don't, outside of
# deliberate experiments.
ARG BASE_IMAGE=debian:12-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171


# ── fetch — runs on the BUILD platform; picks its payload by TARGETARCH ──────
FROM --platform=${BUILDPLATFORM} ${BASE_IMAGE} AS fetch

ARG LOOP_VERSION
ARG LOOP_SHA256_AMD64
ARG LOOP_SHA256_ARM64
# Supplied by BuildKit. Describes the build TARGET, not this stage's platform —
# which is precisely why a $BUILDPLATFORM stage can still select correctly.
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /fetch

# ⚠ FAIL-CLOSED, AND THE ORDER IS LOAD-BEARING.
#   set -eu       any failing command aborts the build; an unset ARG aborts
#                 rather than silently comparing against "".
#   NO PIPES      around the guards. A `curl | tar` would extract UNVERIFIED
#                 bytes AND hide curl's exit status behind tar's. Download,
#                 verify, THEN extract — never the other way round. (The od|tr|sed
#                 substitutions below are value-producing; the guard is the `if`
#                 that follows them, and it exits 1 itself.)
#   curl -f       a 404 is an error, not an empty file that "fails" the checksum
#                 by luck.
#   sha256sum -c  a bare statement. Not `|| warn`, not piped into anything, so
#                 its non-zero exit reaches set -e.
#   e_machine     the checksum proves you got the bytes upstream published; it
#                 canNOT catch the March failure, because upstream's broken
#                 image had perfectly consistent digests too. Only the ELF
#                 header can. EM_X86_64 = 0x3e, EM_AARCH64 = 0xb7, little-endian
#                 uint16 at offset 18.
#   ORDER         the ELF guards run on the EXTRACTED path and the `mv` into
#                 /out is the LAST thing that happens — same rule as
#                 download-verify-extract, one level down: never stage an
#                 artifact where the next stage will COPY it until it has
#                 passed. A failing RUN discards its layer anyway, so this is
#                 belt-and-braces; it was reordered after the negative control
#                 showed a wrong-arch abort leaving /out populated.
#   unknown arch  exits 1. There is deliberately NO default branch: this release
#                 also ships linux-armv6 and linux-armv7, which are the WRONG
#                 artifacts for an aarch64 node, and 386/ppc64le besides.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) SHA256="$LOOP_SHA256_AMD64"; EXPECT_EM='3e 00' ;; \
      arm64) SHA256="$LOOP_SHA256_ARM64"; EXPECT_EM='b7 00' ;; \
      *) echo "FATAL: unsupported TARGETARCH='${TARGETARCH}'. This image ships linux/amd64 and linux/arm64 only." >&2; exit 1 ;; \
    esac; \
    DIR="loop-linux-${TARGETARCH}-${LOOP_VERSION}"; \
    TARBALL="${DIR}.tar.gz"; \
    URL="https://github.com/lightninglabs/loop/releases/download/${LOOP_VERSION}/${TARBALL}"; \
    echo "Fetching ${URL}"; \
    curl -fsSL --retry 3 --retry-delay 2 -o "$TARBALL" "$URL"; \
    printf '%s  %s\n' "$SHA256" "$TARBALL" > "${TARBALL}.sha256"; \
    sha256sum -c "${TARBALL}.sha256"; \
    tar -xzf "$TARBALL"; \
    for BIN in "${DIR}/loopd" "${DIR}/loop"; do \
      MAGIC="$(od -An -tx1 -N4 "$BIN" | tr -s ' ' | sed 's/^ //;s/ $//')"; \
      if [ "$MAGIC" != "7f 45 4c 46" ]; then \
        echo "FATAL: ${BIN} is not an ELF binary (magic='${MAGIC}')." >&2; \
        exit 1; \
      fi; \
      EM="$(od -An -tx1 -j18 -N2 "$BIN" | tr -s ' ' | sed 's/^ //;s/ $//')"; \
      if [ "$EM" != "$EXPECT_EM" ]; then \
        echo "FATAL: ${BIN} has e_machine='${EM}', expected '${EXPECT_EM}' for TARGETARCH=${TARGETARCH}." >&2; \
        echo "Wrong-architecture binaries must never reach a published image. The manifest entry would still claim ${TARGETARCH}, and the failure would surface only at exec time on the target node. That class of defect, in either direction, is what this file exists to prevent. Refusing to publish." >&2; \
        exit 1; \
      fi; \
      chmod 0755 "$BIN"; \
    done; \
    mkdir -p /out; \
    mv "${DIR}/loopd" "${DIR}/loop" /out/; \
    echo "OK: /out/loopd and /out/loop are ${TARGETARCH} ELF binaries (e_machine=${EXPECT_EM})."


# ── final — resolves PER TARGET PLATFORM. Not pinned. Contains no RUN. ───────
FROM ${BASE_IMAGE}

ARG LOOP_VERSION

# The loop version lives in a LABEL, not in the image tag: this image is tagged
# with the Bitcorn app version, mirroring api and web (docker-publish.yml's
# build-loopd). So the label is the only place the shipped loopd version is
# recorded on the artifact — read it with:
#     docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' <image>
LABEL org.opencontainers.image.title="bitcorn loopd" \
      org.opencontainers.image.description="Lightning Labs loopd, repackaged from upstream release binaries so the arm64 image actually contains an arm64 binary." \
      org.opencontainers.image.source="https://github.com/ethancail/bitcorn-lightning-application" \
      org.opencontainers.image.version="${LOOP_VERSION}" \
      biz.bitcorn.loop.upstream="https://github.com/lightninglabs/loop/releases/tag/${LOOP_VERSION}"

# CA roots, COPIED rather than apt-installed, because a PEM bundle is
# architecture-independent — which keeps this stage free of any RUN.
# loopd needs them: CGO_ENABLED=0 means Go's pure x509 loader reads
# /etc/ssl/certs/ca-certificates.crt (confirmed present in the binary's string
# table) to reach the Loop server over TLS. Without it, swaps fail at connect
# time while `loopd --version` still passes — a reminder that --version is an
# ARCHITECTURE test, not a health check.
COPY --from=fetch /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

COPY --from=fetch /out/loopd /usr/local/bin/loopd
COPY --from=fetch /out/loop  /usr/local/bin/loop

# loopd gRPC (11010) and REST (8081) — upstream defaults, and the ports the
# March standalone-loopd branch bound (d874a72, df71d92). Documentation only;
# EXPOSE publishes nothing by itself.
#
# NOTE FOR THE COMPOSE SWAP (next arc, not this one): the API currently expects
# litd's unified endpoint, LOOP_GRPC_PORT=8443 (app/api/src/config/env.ts:72),
# along with /loop-data/.lit/tls.cert and /loop-data/.loop/mainnet/loop.macaroon.
# Standalone loopd serves gRPC on 11010, so the port and both paths move
# together or Loop stays down.
EXPOSE 11010 8081

# NO ENTRYPOINT, ON PURPOSE. compose's `command:` replaces CMD wholesale, so
# leaving loopd as CMD keeps the March compose block a near-drop-in (its command
# list already begins with `loopd`) and keeps `docker run --rm <image> loopd
# --version` — the acceptance test above — working.
#
# Runs as root, matching the litd container it replaces, which mounts root-owned
# Umbrel data dirs. Adding a USER here invites EACCES on ${APP_DATA_DIR}.
#
# ⚠ Do NOT add --tlsautorefresh when wiring compose. The March branch passed it
# (d874a72, df71d92, baf01f8) and it is a DEAD FLAG upstream: declared at
# loopd/config.go:167, read nowhere, while its siblings TLSExtraIPs /
# TLSExtraDomains / TLSDisableAutofill are read at config.go:479-480. It still
# appears in `loopd --help`, so a CLI-existence check passes it — which is why
# this note names the grep instead.
CMD ["loopd"]
