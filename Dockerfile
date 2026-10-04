# Bunny Publisher dashboard as a container.
#
# There is no build step: the server runs TypeScript directly through tsx, so
# the image only needs the runtime dependencies (express + tsx).
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# Listen on every interface so the platform can route to the container, and
# keep all mutable state (db.json, the AES key, temp uploads) on one volume.
ENV HOST=0.0.0.0 \
    PORT=4747 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 4747

# Runs as root so an externally mounted volume at /data is writable on every
# platform. The dashboard has no login of its own — keep its URL private.
CMD ["npm", "start"]
