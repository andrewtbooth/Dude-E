#!/usr/bin/env bash
#
# Drive the whole application in a real browser, against recorded runs.
#
# Everything below the model — sign-in, the analysis stream, candidate
# selection, determination recording, the duplicate guard, the saved-analysis
# route, PDF export and its reproducibility — is exercised end to end for no
# API spend and in about a minute. Two cassettes are needed because the two
# interesting states are mutually exclusive: a run that concluded, and a run
# the model declined to conclude.
#
#   ./scripts/dev/browser-e2e.sh
#
# Requires cassettes (see README, "The three levers"). Playwright is installed
# on demand and not added to package.json — this is a development check, not a
# dependency of the app.
set -euo pipefail

PORT="${PORT:-3111}"
BASE="http://127.0.0.1:${PORT}"
COMPLETE_CASSETTE="${COMPLETE_CASSETTE:-data/cassettes/water-bottle.json}"
DECLINED_CASSETTE="${DECLINED_CASSETTE:-data/cassettes/vague-plastic-housing.json}"

for cassette in "$COMPLETE_CASSETTE" "$DECLINED_CASSETTE"; do
  if [ ! -f "$cassette" ]; then
    echo "Missing cassette: $cassette" >&2
    echo "Record one:" >&2
    echo "  npx tsx scripts/dev/try-classify.ts --record $cassette \"<product>\"" >&2
    exit 1
  fi
done

if ! node -e "require.resolve('playwright')" 2>/dev/null; then
  echo "==> installing playwright (not saved to package.json)"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i --no-save playwright >/dev/null
fi

stop_servers() {
  # `next dev` attaches to an already-running dev server rather than starting a
  # second one, so each pass needs the previous one gone.
  for pid in $(ps -eo pid,args | grep -E "next-server|next dev" | grep -v grep | awk '{print $1}'); do
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 2
}

run_pass() {
  local db="$1" cassette="$2" script="$3" label="$4"

  stop_servers
  rm -f "$db"
  DATABASE_URL="file:./$db" npx prisma db push >/dev/null

  DATABASE_URL="file:./$db" \
  CLASSIFIER_REPLAY="$cassette" \
  CLASSIFIER_REPLAY_DELAY_MS=1 \
  SESSION_SECRET="browser-e2e-only-not-a-real-secret-0000000000" \
  ANTHROPIC_API_KEY="unused-in-replay" \
    nohup npx next dev -p "$PORT" > "/tmp/browser-e2e-${db}.log" 2>&1 &

  for _ in $(seq 1 40); do
    if curl -s --max-time 2 -o /dev/null "${BASE}/api/health"; then break; fi
    sleep 1
  done

  echo ""
  echo "  ${label}"
  BASE="$BASE" node "$script"
}

trap 'stop_servers; rm -f dev-e2e.db dev-e2e-declined.db verify-e2e.pdf' EXIT

run_pass dev-e2e.db "$COMPLETE_CASSETTE" scripts/dev/browser-e2e.mjs \
  "complete run — selection, recording, duplicate guard, saved route, PDF"
run_pass dev-e2e-declined.db "$DECLINED_CASSETTE" scripts/dev/browser-e2e-declined.mjs \
  "declined run — no pick badge, export refused with a reason"

echo ""
echo "browser end-to-end passed"
