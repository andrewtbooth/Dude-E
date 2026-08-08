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

# Checked before the push, not after it fails. Adding a unique index over data
# that already violates it is the one schema change here that can break an
# existing volume, and `db push` reports it as an index error rather than as
# the data problem it is. See the script for why nothing is deleted.
if ! npx tsx scripts/deploy/check-determination-uniqueness.ts; then
  exit 1
fi

echo "==> applying database schema"
# No --skip-generate: Prisma 7 removed the flag, because `db push` no longer
# triggers a client generation for it to skip. Passing it exits 1, and under
# `set -e` that kills the container before it ever serves — which looks like a
# machine that boots and dies rather than a configuration error. See the flag
# regression test in src/lib/deploy/entrypoint.test.ts.
if ! npx prisma db push --accept-data-loss; then
  echo "==> FATAL: could not apply the database schema."
  echo "    Refusing to serve: /api/health does not touch the database, so a"
  echo "    schema-less app would report healthy while failing every request."
  exit 1
fi

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
