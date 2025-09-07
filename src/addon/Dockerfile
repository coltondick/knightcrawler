# --- Build Stage ---
FROM node:lts-alpine AS builder

# Keep npm cache away from /root and clean it later
ENV NPM_CONFIG_CACHE=/tmp/.npm-cache

RUN apk add --no-cache git

WORKDIR /app

# Faster, reproducible installs
COPY package*.json ./
RUN npm ci

# App source
COPY . .

# Build (no-op if not defined)
RUN npm run build || echo "no build step"

# Prune dev deps in builder (so runtime copy is small)
RUN npm prune --omit=dev

# Dockle cleanups in builder (so runtime never gets these files)
# 1) Strip stray .env files in dependencies (e.g., bottleneck/.env)
# 2) Remove docker-compose samples under swagger-stats (and anywhere in node_modules)
# 3) Ensure no root npm cache leftovers
RUN find node_modules -type f -name ".env" -delete \
 && find node_modules -type f -name "docker-compose.yml" -delete \
 && rm -rf node_modules/swagger-stats/scripts || true \
 && rm -rf /root/.npm "$NPM_CONFIG_CACHE"

# --- Runtime Stage ---
FROM node:lts-alpine

# Install pm2 (root needed for global install)
RUN npm install -g pm2

# Create non-root user early and use it
RUN addgroup -S addon && adduser -S -G addon addon
USER addon

WORKDIR /app
ENV NODE_ENV=production

# Copy only what we need from builder
# If your app runs from dist/, ensure dist exists in the copy below.
COPY --from=builder --chown=addon:addon /app/package*.json ./
COPY --from=builder --chown=addon:addon /app/node_modules ./node_modules
COPY --from=builder --chown=addon:addon /app/dist ./dist
COPY --from=builder --chown=addon:addon /app/src ./src
# If you use an ecosystem file, copy it too:
COPY --from=builder --chown=addon:addon /app/ecosystem.config.cjs ./ecosystem.config.cjs

# Not needed anymore (already pruned in builder), but harmless if kept:
# RUN npm prune --omit=dev

EXPOSE 7000

# Prefer an HTTP healthcheck to verify the addon is actually serving
# (pm2 can be "up" even if the app crashed after boot).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:7000/manifest.json" >/dev/null || exit 1

ENTRYPOINT ["pm2-runtime", "start", "ecosystem.config.cjs"]
