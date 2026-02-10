# API service Dockerfile
# TODO: Configure Node.js/TypeScript build and runtime
# ---- Build stage ----
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- Runtime stage ----
FROM node:20-alpine

WORKDIR /app

# Explicit dev mode (removed in Umbrel / production)
ENV NODE_ENV=development

# Ensure mount targets exist
RUN mkdir -p /scripts /data

# Copy only what we need to run
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

CMD ["node", "dist/index.js"]