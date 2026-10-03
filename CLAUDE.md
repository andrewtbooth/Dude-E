# Working on Dude-E

An HTSUS tariff-classification workbench. An analyst signs in, submits a part
number or a product description, an agent works the General Rules of
Interpretation against a pinned tariff snapshot, and the analyst selects a code
and exports a signed PDF determination.

**It produces a durable classification for a product, not an entry decision for
a shipment.** That distinction is load-bearing and explains things that
otherwise look like bugs — most visibly why Chapters 98 and 99 can never be the
answer to "what is this product" (see `SECONDARY_CHAPTERS` in
`src/lib/hts/parse.ts`).

The README is the reference; this file is the part you need *before* touching
anything.

---

## Before you run anything

**These cost real money.** Each is a live multi-minute agent run against the
Anthropic API at `max` effort:

- `npm run try` / `scripts/dev/try-classify.ts`
- `npm run eval`

Use replay instead — it drives the identical code path for nothing:

```bash
npm run dev:cassettes                      # build cassettes from the fixture
CLASSIFIER_REPLAY=data/cassettes/water-bottle.json npm run dev
```

**These kill every `next dev` process on the machine**, including one you have
open in another terminal: `scripts/dev/browser-e2e.sh`, `scripts/dev/browser-ux.sh`,
`scripts/dev/shoot.mjs`.

## This repository is public

Never commit an API key, a customer part number, an unreleased product
description, or the audit database. `.env*`, `prisma/*.db`, `data/` and
`eval/*.local.jsonl` are gitignored and must stay that way.

Cassettes contain whatever was classified, so they inherit that input's
sensitivity — that is why they live under `data/` and not beside the fixtures.

## Getting a working checkout

Nothing gitignored is precious except the audit database. In order:

```bash
npm ci
npx prisma generate      # prisma/generated/ is gitignored
npx prisma db push
npm run dev:seed         # 4-chapter fixture index; or `npm run sync:htsus` for real data
npm run dev:cassettes    # cassettes the browser suites replay
```

`npm run dev:seed` writes a fixture labelled as one, so it cannot be mistaken
for a real revision on a determination. It is enough for every test and both
browser suites; it is not enough to classify anything real.

## Two version stamps, both with silent failure modes

**`DERIVATION_VERSION` — `src/lib/hts/parse.ts`.** A snapshot is the USITC
payload *run through that file*, with the results stored as columns
(`is_reportable` is a column, not a query). Change a rule there and it ships
inert until a sync runs again. Bump the constant; the boot check compares it to
the snapshot's stamp and re-syncs in the background on a mismatch. This has
already bitten once: making Chapter 98 declarable was correct, tested, deployed
and had no effect.

Its inputs count too. `reportingNumberSource` is evaluated at read time and
needs no bump — but it reads the stored `footnotes` column, so a change to
`coerceFootnotes` or to how the sync extracts footnotes *does*.

**`DETERMINATION_TEMPLATE_VERSION` — `src/lib/pdf/DeterminationDoc.tsx`.** The
hash on a determination row means "these bytes are the bytes that were signed",
which only holds while the document is fixed. Change what the PDF renders and
bump it, or the next re-export reports **every determination ever recorded** as
drifted. See `src/lib/pdf/driftVerdict.ts`.

## Deliberate, do not "fix"

- **The structured-output downgrade fires on every run.** The schema has never
  fit the API's compiled-grammar limit. The attempt is made anyway (it costs one
  unbilled rejected request and self-heals if the limit moves), then the shape is
  asked for in the prompt and validated with zod on return. It is emitted as a
  `status`, not a `warning`, because a warning that always fires is one people
  learn to scroll past.
- **The older `web_search_20250305` / `web_fetch_20250910`**, not the `_20260209`
  pair. The newer ones filter inside a code-execution sandbox and need a
  container id on every subsequent request, which the SDK's tool runner cannot
  set mid-run — the model then re-sends the same calls until the iteration
  ceiling burns the run.
- **`cache_control` is passed as a top-level parameter**, not applied through
  `setMessagesParams`. That setter marks the runner mutated, which stops it
  appending the assistant turn, which is what caused a 41-iteration spin.
- **A run holds its own `AbortController`** (`src/lib/agent/runRegistry.ts`).
  `request.signal` must never reach `classify()`: Next aborts it the moment the
  browser disconnects, so a closed tab would kill a paid run. Stopping is an
  explicit act via the cancel route.
- **Advisories partition on "is this transcription?", not "is this material?"**
  Runs recorded before `severity` existed carry neither value, and an
  unrecognised correction must stay loud.

## Domain rules that are not negotiable

- **Never fabricate a CBP ruling citation.** A well-formed ruling number is not
  a real one; the screening in `verifyCrossRulings` is structural, and the UI and
  the PDF both say rulings are cited rather than verified.
- **Never manufacture ground truth.** An eval case whose expected code turns on
  essential character is a judgement asserted as a fact. Those come from CROSS or
  from the team's own recorded determinations, never from invention.
- **Never claim the schedule publishes nothing** unless the loaded snapshot
  actually says so. Reconstructing a reporting number from a snapshot that never
  saw the code is how the original Chapter 91 defect worked.
- **Every code the model names must round-trip through the index.** A fabricated
  but well-formed 10-digit number is the highest-consequence failure available
  here.

## Layout

| Path | What lives there |
|---|---|
| `src/lib/hts/` | Snapshot parser, SQLite/FTS5 index, all tariff queries |
| `src/lib/agent/` | Prompt, tools, the classify loop, verification |
| `src/lib/pdf/` | The determination document and its one render path |
| `src/lib/eval/` | Case files, scoring, calibration |
| `src/app/api/` | Routes; `analyze` streams SSE and takes minutes |
| `scripts/dev/` | Replay, browser suites, fixtures — none of it ships |
| `docs/` | `SETUP.md`, `DEPLOY.md` |

## The gate before committing

```bash
npx tsc --noEmit && npm run lint && npx vitest run && npm run build
./scripts/dev/browser-ux.sh      # touch audit + phone-viewport behaviour
./scripts/dev/browser-e2e.sh     # sign-in through PDF re-issue
```

The browser suites are not optional for UI work. Two defects that no unit test
could see were caught only there: a function prop crossing the server/client
boundary (a 500), and the progress log dragging the page under the reader's
thumb, which is invisible unless the replay runs at a realistic pace.
