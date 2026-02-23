# Web frontend Dockerfile
# TODO: Configure React build and serve setup
# ---- Build stage ----
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY vite.config.ts ./
COPY src ./src
COPY index.html ./index.html

RUN npm run build

# ---- Runtime stage ----
FROM node:20-alpine

WORKDIR /app

RUN npm install -g serve

COPY --from=build /app/dist ./dist

EXPOSE 3200

CMD ["serve", "-s", "dist", "-l", "3200"]
