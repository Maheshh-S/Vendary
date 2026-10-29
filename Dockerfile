# ---------- Base ----------
FROM node:22-alpine AS base
WORKDIR /app
RUN npm install -g bun

# ---------- Dependencies ----------
FROM base AS deps
COPY package.json bun.lock ./
# Prisma generate needs the schema, so install without lifecycle scripts…
RUN bun install --frozen-lockfile --ignore-scripts

# ---------- Builder ----------
FROM base AS builder
COPY . .
COPY --from=deps /app/node_modules ./node_modules

# …then the schema exists and generate is safe to run.
RUN bun run prisma generate
# Placeholder DATABASE_URL/AUTH_SECRET: the build instantiates the Prisma
# client but never queries a real database (dynamic pages degrade gracefully).
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    AUTH_SECRET=build-placeholder \
    bun run build

# ---------- Runner ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Non-root user; standalone output ships only what the server needs.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Schema + engines so `prisma migrate deploy` can run against the container.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/status || exit 1

CMD ["node", "server.js"]
