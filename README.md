# Dude-E — Tariff Classification

A web tool for determining the 10-digit HTSUS classification of a product, and
for producing a determination you can defend.

Enter a **part number** or a **product description**. An import-compliance
model works through the General Rules of Interpretation against the active
HTSUS, proposes ranked candidates with the reasoning written out, and asks for
anything that would narrow the call. The analyst picks the code and exports a
PDF determination that records who decided, when, against which tariff edition,
and which alternates were considered and rejected.

> **This repository is public.** Do not commit API keys, customer part numbers,
> or the audit database. `.env*`, `prisma/*.db`, and `data/` are gitignored, and
> nothing in the app writes secrets outside those paths. Consider making the
> repository private before real product data flows through it.

---

## What it produces

An exported determination carries, in this order:

1. **Provenance** — determination ID, analyst name and email, UTC timestamp,
   the HTSUS revision and Schedule B edition used, the model and effort level,
   the app version.
2. **Subject** — the part number or description, any researched product detail,
   and the answers the analyst supplied to clarifying questions.
3. **Determination** — the 10-digit code, its full description path, General /
   Special / Column 2 rates, unit of quantity, Chapter 99 exposure, and the
   Schedule B export code with its own reasoning and rejected siblings.
4. **Basis of classification** — the GRI 1 through 6 walk and the Chapter Notes
   relied on. (Section Notes are not currently ingested — see Known
   limitations.)
5. **Assumptions** — everything taken as given that the analyst did not state.
6. **Alternates considered and rejected** — up to five, each with the specific
   reason it loses.
7. **Authorities** — CBP rulings from CROSS and any product sources.
8. **Disclaimer** — advisory work product, not a binding ruling.

---

## Setup

Requires Node 22+.

```bash
npm install
cp .env.example .env.local          # then fill in the two required values
npm run db:push                     # create the SQLite audit database
npm run sync:htsus                  # download the active HTSUS revision
npm run dev
```

### Required environment variables

| Variable | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | Server-side only; never reaches the browser. |
| `SESSION_SECRET` | Signs the analyst session cookie. `openssl rand -base64 48`. |

Everything else has a working default — see `.env.example`.

---

## The HTSUS snapshot

**`npm run sync:htsus` is not optional.** Without a snapshot the app disables
classification outright, because a code that cannot be verified against a
published edition is worse than no answer at all.

The sync pulls tariff lines chapter by chapter from the USITC REST API, the
General Notes and the Chapter Notes, and the complete Schedule B export
schedule from Census. It writes a snapshot directory and a manifest:

```
data/htsus/2026-hts-revision-14/
  htsus.db          SQLite + FTS5 index
  manifest.json     revision label, publication date, retrieval time,
                    SHA-256 of the raw payloads, counts, warnings
```

A full run takes roughly a minute and a half and produces about 35,800 tariff
lines, near 20,000 of them 10-digit reportable numbers, across 98 chapters,
plus 99 note documents and 9,779 Schedule B export codes. (Chapter 77 is
reserved and correctly returns nothing.)

**Notes arrive as PDF.** USITC serves the note documents as
`application/octet-stream` regardless of their real type, so the sync sniffs
the `%PDF-` magic bytes rather than trusting the content type, extracts the
text with `unpdf`, and trims the tariff table that follows the notes — the
table is already held as structured rows, and keeping it would bury the notes
the agent actually needs. Getting this wrong is not cosmetic: without the sniff
the binary would be decoded as text and stored as if it were the binding notes.

**The sync routes through `HTTPS_PROXY` explicitly.** Node's global `fetch`
ignores the variable, so on a proxied network it bypasses the tunnel and fails
with an opaque 403 that reads like the remote host rejecting you — while `curl`
in the same shell succeeds. The script installs an `undici` `ProxyAgent`
dispatcher when `HTTPS_PROXY` is set, which is the portable fix.

**`manifest.revision` is the single source of the version stamp.** It is read
at render time and written into every analysis, determination, and PDF. Nothing
in the codebase hardcodes a revision number. Schedule B is versioned separately
by Census, on its own annual cycle, so `manifest.scheduleBEdition` is stamped
alongside it — a determination names both editions.

Two behaviours worth knowing:

- **The script will not guess the revision label.** If it cannot discover the
  active revision from USITC it aborts with instructions rather than stamping
  determinations with the wrong edition. Override explicitly when needed:
  `npm run sync:htsus -- --revision "2026 HTS Revision 14"`.
- **Per-source failures degrade to warnings.** A snapshot missing Schedule B is
  still useful. Warnings are recorded in the manifest and shown in the masthead
  and on the analyze page, so an analyst can see what is incomplete before
  relying on it.

### The export side

Schedule B comes from Census as one fixed-width file per edition
(`exp-code.txt`), with its record layout published alongside it
(`exp-stru.txt`). That makes it the export analogue of the USITC feed: the
complete schedule, machine-readable, rather than a derived crosswalk.

**There is no authoritative 10-digit crosswalk, and building one by string
equality would be wrong.** Measured against 2026 HTS Revision 14, only **30.1%**
of reportable HTSUS numbers have an identical 10-digit Schedule B code. The
schedules share the 6-digit international HS subheading and then break out
differently below it, because they count different things — imports by what
affects duty, exports by what Census wants to measure.

So the join is at HS-6, which the two share by construction, and it produces
*candidates*:

| | |
|---|---|
| Reportable HTSUS lines reaching ≥1 export code at HS-6 | **99.4%** |
| …resolving to exactly one candidate | 45% |
| …needing a description-level choice | 55% |

Heading 9617 is the clean illustration. HTSUS splits `9617.00` by capacity
(over or under one litre); Schedule B splits the same subheading by whether the
article is complete or a part. `9617.00.10.00` therefore reaches
`9617.00.20.00` and `9617.00.60.00`, and shares all ten digits with neither.
`6109.10.00.12` ("Men's (338)") reaches ten export candidates, including
women's garments — picking by number would be silently wrong.

Choosing among them is GRI 6 reasoning applied to the export schedule, so the
model does it explicitly and records the codes it rejected and why. Export
units of quantity come from Schedule B, not carried across from the import
line — they differ often enough to matter (`6109.10.00.12` is `DOZ, KG` on
export). Export codes get the same anti-fabrication treatment as HTS codes:
verified against the snapshot, description and units overwritten from the
schedule, and dropped if they do not exist.

Revisions ship every few weeks. Run the sync on a schedule — weekly is
reasonable — and again whenever USITC publishes.

```bash
npm run sync:htsus -- --chapters 84,85,96   # partial pull, for dev
npm run sync:htsus -- --probe               # diagnose sources, write nothing
```

**A partial pull cannot pass as the published edition.** `--chapters` tags the
revision label itself — `2026 HTS Revision 14 (PARTIAL — chapters 84-85, 96)` —
which is what makes it safe: `manifest.revision` is the single source of the
version stamp, so the tag reaches the masthead, every analysis and
determination, and the PDF header without any of them needing to know the flag
exists. It also changes the directory slug, so a partial pull writes alongside a
complete snapshot rather than over it, and it records a warning explaining that
most of the tariff is absent. Delete the partial directory to make the full
snapshot active again.

### Diagnosing a sync

`--probe` hits every source once and reports what actually came back — status,
content type, size, row count, and the first 300 bytes — without writing
anything. A failed sync tells you a source "could not be retrieved"; the probe
tells you what the server sent, which is what you need to fix it. Run it first
whenever a sync misbehaves.

The sync reads `.env.local`, so `CENSUS_SCHEDULE_B_BASE`, `HTSUS_DATA_DIR` and
`USITC_BASE_URL` overrides apply to it as well as to the app.

Schedule B has its own flags. The edition year is discovered by probing next
year, this year, then last year — Census publishes an edition late in the
preceding year, so "the current year" is not reliably the newest available:

```bash
npm run sync:htsus -- --schedule-b-year 2026   # pin the edition
npm run sync:htsus -- --no-schedule-b          # tariff only
```

### If you cannot reach hts.usitc.gov

Plenty of corporate networks and sandboxed environments block it. Import a
file you downloaded yourself instead — the data is identical, so code
verification, duty rates and the version stamp all work exactly as they do
after a network sync.

1. Open **https://hts.usitc.gov/export** in a browser.
2. Set the range **0101** to **9999**, format **JSON** (CSV also works).
3. Save the file into `data/raw/`, then:

```bash
npm run import:htsus -- --file ./data/raw/hts.json --revision "2026 HTS Revision 14"
```

`--revision` is required and must match what USITC calls the edition — it is
stamped onto every determination, so the import will not guess it.

Schedule B can be imported the same way. Download the edition's `exp-code.txt`
from **https://www.census.gov/foreign-trade/schedules/b** and pass it with its
year — the year is not recorded inside the file, and guessing it would put a
wrong edition stamp on every export code:

```bash
npm run import:htsus -- --file ./data/raw/hts.json \
  --revision "2026 HTS Revision 14" \
  --schedule-b ./data/raw/exp-code.txt --schedule-b-year 2026
```

**One real gap:** a file export carries tariff lines only. Section and Chapter
Notes and the GRIs are published as PDF and are not included. The manifest
records this, the UI surfaces it, and `hts_notes` reports the notes as *not
retrieved* rather than *nonexistent* — the agent is told to try `web_fetch`
against hts.usitc.gov and, failing that, to say in its justification that it
could not consult the binding notes and lower its confidence. Since GRI 1 makes
those notes binding, prefer a full `sync:htsus` for production work.

### Working with no network at all

`npm run dev:seed` builds a four-chapter fixture index so the UI can be
exercised offline. It is labelled `FIXTURE — not a real HTSUS revision` in the
manifest, and that label appears in the masthead and on any determination
produced against it, so it cannot be mistaken for real data. Use it to click
through the interface, never to produce a determination anyone will read.

---

## How the analysis works

`src/lib/agent/` runs Claude Opus 5 with adaptive thinking and a tool loop over
the local tariff index. The system prompt (`prompt.ts`) does the heavy lifting:
apply the GRIs in order and stop at the first rule that resolves the question,
read the Section and Chapter Notes rather than assuming them, and never name a
code that has not been verified.

| Tool | Purpose |
|---|---|
| `hts_search` | Full-text search over the snapshot |
| `hts_lookup` | Verify one code; returns ancestry, rates, units, footnotes |
| `hts_subtree` | Sibling breakouts, indented as the schedule reads — for GRI 6 |
| `hts_notes` | Section and Chapter Notes — binding under GRI 1 |
| `hts_gri` | The rule text verbatim |
| `chapter99_lookup` | Section 301 / 232 duties referenced by footnote |
| `schedule_b_lookup` | Export candidates under the shared HS-6 subheading |
| `schedule_b_search` | The export schedule by description, when HS-6 finds nothing |
| `web_search`, `web_fetch` | Part research and CROSS rulings |

### Two guardrails

**Nothing is accepted on the model's word.** After the run, every returned code
is re-checked against the snapshot (`verifyAgainstTariff` in `classify.ts`).
Codes that do not exist, or that resolve to a non-declarable 8-digit line, are
dropped and the candidates re-ranked; if everything fails, the analysis fails
rather than presenting something unverifiable. A fluent, well-formed,
nonexistent 10-digit code is the highest-consequence failure mode in this
domain, and the one a language model is most prone to.

**Facts come from the tariff, not the transcription.** Duty rates, units, and
description paths are lookups rather than judgements, so the index overwrites
whatever the model wrote, and any disagreement is surfaced in the UI.

The selected code is verified a second time when the analyst records their
decision, in case the snapshot was re-synced in between.

---

## Tuning cost vs. depth

`CLASSIFIER_EFFORT` defaults to `max` because classification is a
correctness-over-cost task. It is genuinely expensive and slow — a thorough run
takes minutes.

Once you have real analyses to compare against, sweep `high` and `xhigh`
against your own accuracy bar before deciding. `max` can also overthink routine
goods. It is one config value; nothing else changes.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Unit tests — no network or API key needed |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run sync:htsus` | Download the active HTSUS revision |
| `npm run db:push` | Apply the Prisma schema |
| `npm run import:htsus` | Build the index from a downloaded HTS export |
| `npm run dev:seed` | Build the offline fixture tariff index |
| `npm run dev:pdf` | Render the sample determination to `data/pdf/` |

---

## Layout

```
src/
  app/            routes: splash (/), /analyze, /history, API handlers
  components/     UI — analysis client, candidate cards, masthead, theme
  lib/
    agent/        system prompt, tools, run loop, output schema, verification
    hts/          USITC parsing, SQLite index, query layer
    pdf/          determination document and view assembly
    auth/         session signing and validation
  test/           shared fixtures
scripts/
  sync-htsus.ts   the tariff sync
  dev/            offline seed, sample PDF render
```

---

## Known limitations

- **This is an advisory tool.** It produces a well-reasoned recommendation with
  its work shown; it does not produce a legally binding classification. A
  second-analyst review before anything drives an actual entry filing is worth
  the time.
- **Chapter 99 currency.** Section 301 and 232 actions change faster than the
  HTSUS is revised. The snapshot captures Chapter 99 as published at sync time;
  the UI shows the sync date alongside those duties rather than implying they
  are live.
- **Section Notes are not ingested, and that is a real analytical gap.** The
  sync fetches "General Notes" and "Chapter N" documents only; the live
  snapshot holds 98 chapter notes and 1 general note and **zero** section
  notes. Section XVI Note 2 (the parts rule) and Section XV Note 2 (parts of
  general use) decide a large share of machinery, electrical and metal-article
  classifications, so their absence is substantive. `hts_notes` still advertises
  `kind: "section"` and reports honestly that they could not be retrieved
  rather than that none exist — but every such call fails, and the prompt's
  fallback sends the model to the live web for text the snapshot was supposed
  to pin. Fix the ingestion before trusting a parts classification.
- **The General Notes are truncated at General Note 2.** The stored body is
  ~8,955 characters: the GRIs, the Additional U.S. Rules, and General Notes 1
  and 2. `notesSectionOf` cuts at the first "Rates of Duty" marker, which falls
  inside General Note 3's rate-column table. Everything after — GN 3 (rate
  columns), GN 4 (GSP), GN 11 (USMCA) and GN 12–35 (every FTA's rules of
  origin) — is absent. The GRIs, which are what the analysis actually turns on,
  are complete. FTA preference eligibility is not analysed and must not be
  inferred from the Special column the determination prints.
- **Chapter 99 linkage is footnote-based and therefore mostly blind.**
  `chapter99_lookup` finds provisions by matching `99xx.` references in a
  line's footnotes and its ancestors'. Only 771 of 35,789 lines carry such a
  footnote, and the Section 301 coverage lists live in the Chapter 99
  subchapter U.S. Notes, which are not ingested. Staple 301-exposed goods —
  `9403.20.00.50`, `7318.15.20.95`, `6109.10.00.12`, `8471.30.01.00` — all
  return no footnotes and therefore no Chapter 99 finding. Treat "none found"
  as "not detected", never as "none apply".
- **Chapter Notes are truncated at 12,000 characters when handed to the model.**
  That is under half the notes for the chapters where they matter most —
  Chapter 84 is 31,749 characters, Chapter 72 is 29,968, Chapter 85 is 29,428.
- **Schedule B needs an analyst's eye, not just a lookup.** The export code is
  reached through the shared HS-6 subheading and then chosen by description —
  see "The export side" above. Roughly 0.6% of tariff numbers sit under a
  subheading Schedule B does not use at all; for those the model falls back to
  searching the export schedule by description, and returns nothing rather than
  guessing if that fails too.
- **The USITC API has changed shape without notice before.** The parsers
  tolerate drift and fail loudly with the raw payload rather than silently
  producing a partial snapshot. Live output currently ships the additional-duty
  column under both `additionalDuties` and the misspelled `addiitionalDuties`,
  inconsistently, so the parser reads whichever is populated.
- **Sign-in is attribution, not access control.** Anyone who can reach the app
  can name themselves. If determinations may be shown outside the team, move to
  SSO before that happens.
