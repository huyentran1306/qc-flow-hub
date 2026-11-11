# QA Flow Hub — server image for the whole team (Postgres via DATABASE_URL).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx next build && node scripts/prepare-standalone.mjs .next /out

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 UPLOAD_DIR=/data/uploads PGLITE_DIR=/data/pglite
COPY --from=build --chown=node:node /out ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
