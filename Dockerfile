# ---------- Base ----------
FROM node:22-alpine AS base
WORKDIR /app
RUN npm install -g bun

# ---------- Dependencies ----------
FROM base AS deps
COPY package.json bun.lock ./
# ⛔ prisma generate will fail if schema not present
# So we disable scripts here
RUN bun install --frozen-lockfile --ignore-scripts

# ---------- Builder ----------
FROM base AS builder
COPY . .
COPY --from=deps /app/node_modules ./node_modules

# Now prisma schema EXISTS → safe to run
RUN bun run prisma generate
RUN bun run build

# ---------- Runner ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000
CMD ["bun", "start"]
