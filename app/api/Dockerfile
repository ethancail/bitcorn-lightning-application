# ---- Build stage ----
# Use node:20-slim (Debian/glibc) instead of Alpine (musl) to avoid
# "qemu: uncaught target signal 4 (Illegal instruction)" during
# multi-arch builds on GitHub Actions. better-sqlite3 native bindings
# must compile for the target arch, so --platform=$BUILDPLATFORM is
# NOT used here (unlike the web Dockerfile).
FROM node:20-slim AS build

WORKDIR /app

# better-sqlite3 needs python3, make, g++ for native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=development

RUN mkdir -p /scripts /data

# Copy runtime files
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

COPY --from=build /app/src/db/migrations ./dist/db/migrations

# Loop Out proto files (loaded at runtime by @grpc/proto-loader)
COPY proto ./proto

CMD ["node", "dist/index.js"]
    