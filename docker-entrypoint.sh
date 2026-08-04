#!/bin/sh
# Bring the durable state up to date, then serve.
#
# Applying the schema on every boot is safe and idempotent, so a fresh volume
# produces a working deployment with no manual step.
#
# The tariff snapshot is seeded the same way, but *in the background*. Two
# constraints pull against each other here: the download takes about ninety
# seconds, and the platform expects the port to be listening within its health
# check grace period. Running the sync in the foreground would fail the deploy;
# skipping it entirely would require an operator with shell access, which a
# scoped deploy token may not grant.
#
# Backgrounding it satisfies both. The app starts immediately, /api/health
# reports "degraded" with an explanation while the download runs, and flips to
# "ok" once the snapshot lands. Classification is refused in the meantime,
# which is the behaviour the app already had for a missing snapshot.
set -e

echo "==> applying database schema"
npx prisma db push --skip-generate --accept-data-loss

if [ -z "$(ls -A "${HTSUS_DATA_DIR}" 2>/dev/null)" ]; then
  echo "==> no tariff snapshot found at ${HTSUS_DATA_DIR}"
  echo "    Downloading in the background — roughly ninety seconds."
  echo "    The app is serving now and will refuse to classify until it lands."
  (
    if npm run sync:htsus; then
      echo "==> tariff snapshot ready"
    else
      echo "==> tariff sync FAILED. The app will keep refusing to classify."
      echo "    Re-run the Deploy workflow, or check egress to hts.usitc.gov."
    fi
  ) &
else
  echo "==> tariff snapshot present"
fi

exec "$@"
