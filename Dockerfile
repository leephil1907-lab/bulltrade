# ============================================================================
# Blockchain Bullhorn — production image.
#
# The app itself has exactly one runtime dependency (web-push), but it still
# has to be installed: without `npm ci` the image has no node_modules and push
# notifications silently degrade to the bundled fallback copy.
#
# This is the ALTERNATIVE deploy path. The Render blueprint (render.yaml) uses
# Render's native Node runtime, which ignores this file. Use it if you switch
# the service to `runtime: docker`, or to run the app anywhere else that speaks
# containers (the VPS path in deploy/vps-setup.sh, Fly.io, ECS, a laptop...).
#
# Persistence: this image deliberately does NOT declare a VOLUME. An anonymous
# Docker volume is not durable across deploys and can shadow the mount point a
# platform attaches, which is how data quietly ends up on a throwaway volume.
# The app reads DATA_DIR and creates the directory itself — mount your real
# persistent storage there:
#     Render (runtime: docker)  disk.mountPath = /app/data, DATA_DIR = /app/data
#     docker run                -v bb-data:/app/data
# ============================================================================

# ---- stage 1: install production dependencies against the lockfile ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- stage 2: runtime ----
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000

# Dependencies first (they change rarely), then app source — so editing a page
# or server.js does not re-run npm ci.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json server.js ./
COPY lib ./lib
COPY public ./public

# Run as the unprivileged `node` user that ships with the base image; it needs
# write access to the data directory (db.json, uploads/, market cache, JWT
# secret) and nothing else.
RUN mkdir -p /app/data/uploads && chown -R node:node /app
USER node

EXPOSE 3000

# Liveness probe. /healthz answers as soon as the HTTP server is listening;
# /readyz additionally requires the market feed to have populated.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "server.js"]
