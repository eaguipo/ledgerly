# syntax=docker/dockerfile:1

# ── Ledgerly web (Next.js 16) — production image ─────────────────────────────
# Multi-stage build that produces a tiny runtime image from Next's `standalone`
# output. Node 20 to match .nvmrc.
#
# NOTE: NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time,
# so they must arrive as --build-arg, not runtime env. The Supabase anon key is
# safe to expose (Row Level Security is the real boundary). Server-only secrets
# (e.g. SUPABASE_SERVICE_ROLE_KEY) are injected at RUNTIME via the K8s Secret.

ARG NODE_VERSION=20-alpine

# ── deps: install production+dev deps once, cached on the lockfile ───────────
FROM node:${NODE_VERSION} AS deps
# libc6-compat: some Next/native deps expect glibc symbols on Alpine (musl).
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── builder: compile the Next app into .next/standalone ──────────────────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Public (client-visible) build-time config. Passed via --build-arg / Tilt.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── runner: minimal image, runs the standalone server as non-root ────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run as the built-in unprivileged `node` user.
# standalone/ contains server.js + traced node_modules; static/ and public/ are
# NOT copied by standalone automatically, so we add them explicitly.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000

# Simple TCP-less HTTP healthcheck for `docker run` testing; K8s uses its own probes.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
