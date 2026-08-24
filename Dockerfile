# syntax=docker/dockerfile:1

# ---- client -----------------------------------------------------------------
# Built first and separately so a server-only change does not reinstall the
# React toolchain, and so the client's dev dependencies never reach the runtime.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
# Vite is configured to emit ../dist/public, which lands at /dist/public here.
RUN npm run build

# ---- server -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# better-sqlite3 is native. The toolchain is needed to compile it against this
# image's musl libc — a copy built on a glibc host does not load here — and is
# deliberately absent from the runtime image.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:server && npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine

# tzdata, so a TZ set in the compose file actually resolves. Alpine ships no
# zoneinfo and the failure is SILENT — TZ with no tzdata leaves the process on
# UTC, ten hours out from the host and every other service beside it.
RUN apk add --no-cache tzdata
WORKDIR /app
ENV NODE_ENV=production
# chromaprint provides fpcalc, which fingerprints uploaded audio LOCALLY for
# the optional AcoustID identification step. The audio never leaves the box;
# only the fingerprint hash is looked up, and only when a key is configured.
#
# p7zip provides 7z, which opens the RAR sets scene music releases arrive in.
# One binary covers rar, zip, 7z and tar, and it reads both RAR4 and RAR5 —
# unrar is non-free and not in Alpine's repositories at all.
#
# ffmpeg decodes audio for the local BPM/energy analyzer (lib/analysis.ts). The
# analysis never leaves the box; the results are two numbers per track.
RUN apk add --no-cache chromaprint p7zip ffmpeg
LABEL org.opencontainers.image.title="crate" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.description="Music discovery and request front end for Lidarr"
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /dist/public ./dist/public
COPY package.json ./
# The database lives on a volume; the image itself stays read-only in practice.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
