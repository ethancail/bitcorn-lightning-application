# ---- Build stage ----
# Use node:24.22.3-slim (Debian bookworm, glibc) instead of Alpine (musl) to
# avoid "qemu: uncaught target signal 4 (Illegal instruction)" during
# multi-arch builds on GitHub Actions. better-sqlite3's native binding must
# match the target arch, so --platform=$BUILDPLATFORM is NOT used here
# (unlike the web Dockerfile).
#
# Both stages pin the same multi-arch index digest (amd64 + arm64), in the
# form app/loopd/Dockerfile uses; 24.22.3-slim and 24.22.3-bookworm-slim
# resolve to this one index. The tag must agree with .nvmrc. TO BUMP, read the
# new tag's index digest from the registry without pulling, and use it in
# both FROM lines:
#     docker buildx imagetools inspect node:<version>-slim --format '{{.Manifest.Digest}}'
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build

WORKDIR /app

# better-sqlite3 needs python3, make, g++ for native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install exactly the committed lock. npm ci never resolves or writes a lock,
# and fails if package.json and package-lock.json disagree.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --omit=dev

# ---- Runtime stage ----
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

WORKDIR /app

ENV NODE_ENV=production

RUN mkdir -p /scripts /data

# Copy runtime files
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

COPY --from=build /app/src/db/migrations ./dist/db/migrations

# Loop Out proto files (loaded at runtime by @grpc/proto-loader)
COPY proto ./proto

CMD ["node", "dist/index.js"]
    