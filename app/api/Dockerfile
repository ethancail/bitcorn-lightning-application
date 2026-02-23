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
    
    ENV NODE_ENV=development
    
    RUN mkdir -p /scripts /data
    
    # Copy runtime files
    COPY --from=build /app/package.json ./package.json
    COPY --from=build /app/node_modules ./node_modules
    COPY --from=build /app/dist ./dist
    
    COPY --from=build /app/src/db/migrations ./dist/db/migrations
    
    CMD ["node", "dist/index.js"]
    