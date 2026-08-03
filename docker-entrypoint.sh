#!/bin/sh
# Bring the durable state up to date before serving.
#
# Applying the schema on every boot is safe and idempotent, and it means a
# fresh volume produces a working deployment without a manual step. The tariff
# snapshot is NOT downloaded here: it takes about ninety seconds and would make
# every restart a cold start. It is seeded once and refreshed on a schedule —
# see docs/DEPLOY.md.
set -e

echo "==> applying database schema"
npx prisma db push --skip-generate --accept-data-loss

if [ ! -d "${HTSUS_DATA_DIR}" ] || [ -z "$(ls -A "${HTSUS_DATA_DIR}" 2>/dev/null)" ]; then
  echo "==> no tariff snapshot found at ${HTSUS_DATA_DIR}"
  echo "    The app will start and refuse to classify until one exists."
  echo "    Seed it with:  npm run sync:htsus"
fi

exec "$@"
