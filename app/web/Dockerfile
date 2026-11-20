# Web frontend Dockerfile
# ---- Build stage (runs on native arch — Vite output is static) ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

# Install exactly the committed lock. npm ci never resolves or writes a lock,
# and fails if package.json and package-lock.json disagree.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY vite.config.ts ./
COPY src ./src
COPY index.html ./index.html

# Chain the built bundle signs member wallets onto (wagmi default chain +
# Stablecoin page chainId). Vite bakes this in at build time. Default: Base
# Sepolia (84532) — mainnet builds override via --build-arg at deploy day;
# never change this default (mainnet-preflight runbook §B1b).
ARG VITE_BASE_CHAIN_ID=84532
ENV VITE_BASE_CHAIN_ID=$VITE_BASE_CHAIN_ID

RUN npm run build

# ---- Runtime stage (multi-arch: amd64 + arm64) ----
FROM node:20-slim

WORKDIR /app

# serve comes from its own locked manifest (runtime/), installed with npm ci,
# not a floating global install. Change it with
# npm run lock:refresh -- app/web/runtime serve@<version>.
COPY runtime/package.json runtime/package-lock.json ./runtime/
RUN cd runtime && npm ci

COPY --from=build /app/dist ./dist

EXPOSE 3200

CMD ["/app/runtime/node_modules/.bin/serve", "-s", "dist", "-l", "3200"]
