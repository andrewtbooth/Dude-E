#!/bin/bash
#
# Bring a fresh checkout up to where tests, linters and the browser suites can
# actually run.
#
# Four of the five steps below produce something gitignored, which is why a
# clean clone cannot run its own test suite until they have happened:
# prisma/generated (the client tsc needs), the SQLite audit database, the
# tariff snapshot the app refuses to classify without, and the replay cassettes
# the browser suites drive from.
#
# Two guards matter more than they look:
#
#   * The tariff snapshot is only seeded when there is none. `dev:seed` writes
#     a four-chapter fixture stamped with the current time, and the store
#     resolves the *newest* snapshot — so seeding over a real `sync:htsus`
#     would silently demote a full tariff edition behind a fixture, which is
#     the failure `eval:check` had to grow a refusal for.
#
#   * Cassettes are only built when missing. A recorded cassette is a real
#     multi-minute agent run that cost real money; regenerating over one to
#     save a second would be a bad trade.
#
# Deliberately synchronous. The alternative races the agent: a session that
# starts before `prisma generate` finishes reports type errors across the whole
# repository, which is a confusing first impression and sends someone chasing a
# problem that is about to fix itself.
set -euo pipefail

# Local machines have their own working setup and their own .env.local; this is
# for the ephemeral remote container.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

echo "==> installing dependencies"
# `install` rather than `ci`: the container image is cached after this hook
# completes, so a warm node_modules is worth more than a clean one.
npm install --no-audit --no-fund

echo "==> generating the Prisma client"
# prisma/generated is gitignored, and `tsc --noEmit` fails across the whole
# repository without it.
npm run db:generate

echo "==> applying the schema to the audit database"
# No --accept-data-loss. This is the one project where a schema push that
# quietly drops a column is the documented nightmare (docs/DECISIONS.md, #8),
# and a hook that fails loudly is the right direction even in a throwaway
# container.
npm run db:push

if ls data/htsus/*/manifest.json >/dev/null 2>&1; then
  echo "==> tariff snapshot already present, leaving it alone"
else
  echo "==> seeding the offline fixture tariff index"
  npm run dev:seed
fi

cassettes_ready=yes
if [ -f data/cassettes/water-bottle.json ]; then
  echo "==> replay cassettes already present, leaving them alone"
elif node -e "process.exit(require('./package.json').scripts['dev:cassettes'] ? 0 : 1)" 2>/dev/null; then
  echo "==> building replay cassettes from the fixture"
  npm run dev:cassettes
else
  cassettes_ready=no
  echo "==> no dev:cassettes script on this branch and no cassette on disk"
fi

# Session-scoped, never written to disk in the repository.
#
# Not a secret and must never be one: it signs a session cookie in a container
# that is discarded when the session ends. It exists so `npm run dev` starts
# instead of throwing on a required variable. A deployment reads this from Fly
# secrets — see docs/SETUP.md.
# Appended once, not once per event. SessionStart also fires on resume, clear
# and compact, so an unguarded `>>` grows this file for the life of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ] &&
   ! grep -q "^export SESSION_SECRET=" "$CLAUDE_ENV_FILE" 2>/dev/null; then
  echo 'export SESSION_SECRET="ephemeral-web-session-not-a-real-secret-000000"' >> "$CLAUDE_ENV_FILE"
fi

# ANTHROPIC_API_KEY is deliberately not set. Nothing here needs it: the tests
# use fixtures and the browser suites replay recorded runs. A live analysis
# needs a real key, and the honest failure is the config error naming it.
if [ "$cassettes_ready" = yes ]; then
  echo "==> ready — tests, lint, build and both browser suites can run"
else
  # Said plainly rather than glossed. The browser suites replay a cassette and
  # will refuse without one; on a branch that predates `dev:cassettes` the only
  # other route is `try-classify.ts --record`, which spends real money.
  echo "==> ready — tests, lint and build can run; the browser suites need a cassette"
fi
