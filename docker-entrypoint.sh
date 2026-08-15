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

# What `db push --accept-data-loss` is about to do, before it does it.
#
# The flag says out loud that it will not stop for data loss, and until now
# nothing else stopped either: a rename reaches Prisma as a drop and an add, so
# renaming a column on a signed determination would have destroyed its contents
# on the next boot, printed "applying database schema", and served — with the
# health check reporting ok. Additive changes still apply unattended, which is
# every change this repository has made so far.
if ! npx tsx scripts/deploy/check-schema-additive.ts; then
  echo "==> FATAL: the pending schema change is not purely additive."
  echo "    Refusing to apply it unattended against the audit database."
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

# Sync in the background when the snapshot is missing *or* when it was built by
# older derivation rules.
#
# The staleness half is new and it closes a hole that cost a release. The
# snapshot is not a copy of the USITC payload — it is that payload run through
# the parser, with the results stored as columns. `is_reportable` is a column.
# So making Chapter 98 declarable shipped green and did nothing: the volume held
# data built by the previous rule, this check tested only for an *empty*
# directory, and nothing compared the data to the code that derived it.
sync_reason=""
if [ -z "$(ls -A "${HTSUS_DATA_DIR}" 2>/dev/null)" ]; then
  sync_reason="no tariff snapshot found at ${HTSUS_DATA_DIR}"
elif ! npx tsx scripts/deploy/check-snapshot-derivation.ts; then
  sync_reason="snapshot predates this build's derivation rules"
fi

if [ -n "$sync_reason" ]; then
  echo "==> ${sync_reason}"
  echo "    Syncing in the background — roughly ninety seconds."
  echo "    The app is serving now; it keeps using the snapshot it has, if any,"
  echo "    until the new one lands."
  (
    if npm run sync:htsus; then
      echo "==> tariff snapshot ready"
    else
      echo "==> tariff sync FAILED."
      echo "    Re-run the Deploy workflow, or check egress to hts.usitc.gov."
    fi
  ) &
else
  echo "==> tariff snapshot present and current"
fi

exec "$@"
