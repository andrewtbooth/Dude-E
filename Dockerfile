# Build and run the classification workbench.
#
# Two things shape this image and neither is optional:
#
#   * better-sqlite3 is a native addon, so the builder needs a toolchain and
#     the module must be compiled for the image's platform — not copied from a
#     developer's machine.
#   * The tariff sync runs from TypeScript source via tsx, on a schedule, in
#     production. `tsx`, `scripts/` and `src/` therefore ship in the runtime
#     image; the sync is an operational dependency, not a dev-time one.

FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production
# python3/make/g++ build better-sqlite3; ca-certificates is needed to reach
# USITC, Census and the Anthropic API over TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- build -----------------------------------------------------------------
FROM base AS build
ENV NODE_ENV=development
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npx prisma generate && npx next build

# --- runtime ---------------------------------------------------------------
FROM base AS runner
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/prisma/generated ./prisma/generated
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY next.config.ts tsconfig.json ./
# Needed at runtime by the sync and import scripts, which run as TypeScript.
COPY src ./src
COPY scripts ./scripts
COPY eval ./eval

# The snapshot and the audit database are the two pieces of durable state.
# Both must sit on a mounted volume or they are lost on every deploy.
ENV HTSUS_DATA_DIR=/data/htsus \
    DATABASE_URL=file:/data/dude-e.db \
    PORT=3000 \
    HOSTNAME=0.0.0.0
VOLUME /data

EXPOSE 3000
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "next", "start"]
