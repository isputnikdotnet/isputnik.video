# ── Stage 1: install all deps (with native-module build tools) ────
# better-sqlite3 compiles from source where no prebuilt binary matches the
# image's Node; without these the deps stage fails at `npm ci` (node-gyp).
FROM node:26-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: build the server ─────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 3: runtime-only node_modules ────────────────────────────
FROM deps AS prod-deps
RUN npm ci --omit=dev

# ── Stage 4: production image ─────────────────────────────────────
FROM node:26-slim
WORKDIR /app

# Unraid draws the container's icon from this label when its saved template
# has none, so a template edit or an update cannot leave the tile blank.
LABEL net.unraid.docker.icon="https://raw.githubusercontent.com/isputnikdotnet/isputnik.video/main/Assets/icon.png"

# gosu drops the entrypoint from root to the runtime user (scripts/docker-entrypoint.sh);
# ffmpeg converts what a browser can't play as it is (src/delivery.ts, src/hls.ts).
RUN apt-get update && apt-get install -y --no-install-recommends gosu ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
# Carries "type": "module", and config.ts reads the version from it (one level
# above dist/).
COPY package.json ./

# ffmpeg is there, with the encoders the conversion uses.
RUN ffmpeg -hide_banner -encoders | grep -q libx264 && ffmpeg -hide_banner -encoders | grep -q " aac " && ffprobe -version > /dev/null

# Import smoke test: every production dependency must load from this tree, so a
# missing package fails THIS build instead of the container at startup.
RUN node -e 'const deps=Object.keys(require("./package.json").dependencies);(async()=>{for(const d of deps){try{await import(d)}catch(e){console.error("runtime dep failed to load:",d,"-",e.message);process.exit(1)}}console.log(deps.length+" runtime deps load OK")})()'

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4300
# The catalog lives here — mount /config as a volume.
ENV DB_PATH=/config/video.sqlite
# The video folders — mount them read-only; every library is a folder under it.
ENV MEDIA_ROOT=/media
# Segments made while someone watches; mount RAM or a fast disk here if you like.
ENV TRANSCODE_PATH=/transcode
# GATEWAY_SECRET must be set at run time; the server refuses to start without it.
# Who the server runs as; the entrypoint takes ownership of /config for them.
ENV PUID=1000
ENV PGID=1000

EXPOSE 4300

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4300)+'/video/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD ["node", "dist/index.js"]
