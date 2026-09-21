# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# deps — install once, cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# builder
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined at build time, so they must be present here.
# These are the publishable Supabase values only — the service-role key and the
# token encryption key are runtime-only and never enter the image.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_AGENCY_NAME
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_AGENCY_NAME=$NEXT_PUBLIC_AGENCY_NAME \
    NEXT_TELEMETRY_DISABLED=1

# env.ts validates server-side config lazily, but `next build` still evaluates
# module scope during prerender. Placeholders satisfy the schema at build time
# and are replaced by the real values from the environment at runtime.
ENV SUPABASE_SERVICE_ROLE_KEY=build-time-placeholder-value \
    TOKEN_ENCRYPTION_KEY=YnVpbGQtdGltZS1wbGFjZWhvbGRlci0zMmJ5dGVzIQ==

RUN npm run build

# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3050 \
    HOSTNAME=0.0.0.0

# Node's bundled ICU already resolves Asia/Kolkata, so the app renders IST
# without this. tzdata is here so shell tools inside the container (`date`,
# log timestamps) agree — a container that reports UTC while the app shows IST
# is a trap when debugging.
RUN apk add --no-cache tzdata

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3050

# Liveness only — a 200 from the login page means the server is up. It
# deliberately does not touch Upwork; a health check must never spend API budget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3050/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
