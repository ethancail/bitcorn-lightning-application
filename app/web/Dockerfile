# Web frontend Dockerfile
# ---- Build stage (runs on native arch — Vite output is static) ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY vite.config.ts ./
COPY src ./src
COPY index.html ./index.html

RUN npm run build

# ---- Runtime stage (multi-arch: amd64 + arm64) ----
FROM node:20-slim

WORKDIR /app

RUN npm install -g serve

COPY --from=build /app/dist ./dist

EXPOSE 3200

CMD ["serve", "-s", "dist", "-l", "3200"]
