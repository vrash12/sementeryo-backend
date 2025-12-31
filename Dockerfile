# backend/Dockerfile
# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Needed for native deps like bcrypt (node-gyp fallback)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy workspace manifests first (better caching)
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json

# Install all workspace deps
RUN npm ci

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY backend ./backend

# Cloud Run sends traffic to $PORT (usually 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "start", "--workspace=backend"]
