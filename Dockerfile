# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
RUN npm install -g npm@11.6.1

# Copy manifests first (layer-cache friendly)
COPY package.json package-lock.json ./

# Use ci for reproducible install from package-lock.json
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app
RUN npm install -g npm@11.6.1

# Copy manifests for production install
COPY package.json package-lock.json ./

# Install production deps only, reproducible
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
