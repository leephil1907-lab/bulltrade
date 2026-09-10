# Blockchain Bullhorn — production image (zero npm dependencies)
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# app source only — data/ is a runtime volume (see .dockerignore)
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

# user-data volume (db.json, uploads) — mount a persistent volume here
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server.js"]
