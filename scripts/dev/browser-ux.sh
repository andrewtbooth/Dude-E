#!/usr/bin/env bash
#
# Check the mobile-facing behaviours that only show up in a real browser at a
# realistic pace: the page staying put while the progress log streams, the log
# following its own newest entry, and corrections being presented in proportion
# to what they mean.
#
#   ./scripts/dev/browser-ux.sh
#
# Runs against a cassette, so no API spend. Deliberately slower than
# browser-e2e.sh — the scroll defect is invisible when the whole run replays in
# a few hundred milliseconds, which is how it survived an earlier review.
set -euo pipefail

PORT="${PORT:-3112}"
BASE="http://127.0.0.1:${PORT}"
CASSETTE="${CASSETTE:-data/cassettes/water-bottle.json}"
DB="dev-ux.db"

if [ ! -f "$CASSETTE" ]; then
  echo "Missing cassette: $CASSETTE" >&2
  exit 1
fi

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

trap 'stop_servers; rm -f "$DB" /tmp/cassette-no-reporting-number.json' EXIT

stop_servers
rm -f "$DB"
DATABASE_URL="file:./$DB" npx prisma db push >/dev/null

DATABASE_URL="file:./$DB" \
CLASSIFIER_REPLAY="$CASSETTE" \
CLASSIFIER_REPLAY_DELAY_MS="${CLASSIFIER_REPLAY_DELAY_MS:-900}" \
SESSION_SECRET="browser-ux-only-not-a-real-secret-00000000000" \
ANTHROPIC_API_KEY="unused-in-replay" \
  nohup npx next dev -p "$PORT" > "/tmp/browser-ux.log" 2>&1 &

for _ in $(seq 1 40); do
  if curl -s --max-time 2 -o /dev/null "${BASE}/api/health"; then break; fi
  sleep 1
done

echo ""
echo "  touch targets at phone width"
BASE="$BASE" node scripts/dev/audit-touch-targets.mjs

echo ""
echo "  mobile viewport — scroll containment, log follow, correction proportion"
BASE="$BASE" node scripts/dev/browser-ux.mjs

# --- second pass: a code the schedule publishes no reporting number for -------
#
# 9101.11.40 is a real watch provision: the deepest line the schedule publishes,
# eight digits, no unit of quantity. The interface has to say so, and the only
# way to see that it does is to render it. Derived from the cassette above
# rather than recorded, because it is the same run with a different code on it —
# and cassettes are gitignored, so a committed fixture could not be used here.
VARIANT="/tmp/cassette-no-reporting-number.json"
node -e '
  const fs = require("fs");
  const cassette = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const event of cassette.events) {
    if (event.type !== "done") continue;
    const run = event.run;
    run.result.recommended_hts_code = "9101.11.40";
    for (const candidate of run.result.candidates) candidate.hts_code = "9101.11.40";
    run.verification.verifiedCodes = ["9101.11.40"];
    delete run.verification.incompleteReportingNumbers;
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(cassette));
' "$CASSETTE" "$VARIANT"

stop_servers
rm -f "$DB"
DATABASE_URL="file:./$DB" npx prisma db push >/dev/null

DATABASE_URL="file:./$DB" \
CLASSIFIER_REPLAY="$VARIANT" \
CLASSIFIER_REPLAY_DELAY_MS=1 \
SESSION_SECRET="browser-ux-only-not-a-real-secret-00000000000" \
ANTHROPIC_API_KEY="unused-in-replay" \
  nohup npx next dev -p "$PORT" > "/tmp/browser-ux-variant.log" 2>&1 &

for _ in $(seq 1 40); do
  if curl -s --max-time 2 -o /dev/null "${BASE}/api/health"; then break; fi
  sleep 1
done

echo ""
echo "  a code with no published ten-digit reporting number"
BASE="$BASE" node scripts/dev/browser-ux-reporting-number.mjs
