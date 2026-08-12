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
4. **Basis of classification** — the GRI 1 through 6 walk and the Section and
   Chapter Notes relied on.
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
General Notes and every Section and Chapter Note, and the complete Schedule B
export schedule from Census. It writes a snapshot directory and a manifest:

```
data/htsus/2026-hts-revision-15/
  htsus.db          SQLite + FTS5 index
  manifest.json     revision label, publication date, retrieval time,
                    SHA-256 of the raw payloads, counts, warnings
```

A full run takes roughly a minute and a half and produces about 35,800 tariff
lines, about 20,000 of them declarable classifications, across 98 chapters,
plus 121 note documents — 98 chapter, 22 section, 1 general — and 9,779
Schedule B export codes. (Chapter 77 is reserved and correctly returns
nothing.)

**Section notes are recovered, not fetched.** USITC publishes no section-notes
document; the notes are printed at the head of each section's *first* chapter,
so Chapter 84's PDF opens with Section XVI's. The sync splits that block out and
stores it under its Roman numeral, which is what makes Section XVI Note 2 — the
parts rule that decides most machinery classifications — retrievable when
classifying in Chapter 85, whose own document does not contain it. The split is
case-sensitive on purpose: headings are capitalised while the notes refer to
other chapters in lower case, and matching case-insensitively truncated Section
XVI to its 331-character title. Twelve sections genuinely have no notes; those
are recorded as saying so rather than storing a title page that would read as
authority.

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
  `npm run sync:htsus -- --revision "2026 HTS Revision 15"`.
- **Per-source failures degrade to warnings.** A snapshot missing Schedule B is
  still useful. Warnings are recorded in the manifest and shown in the masthead
  and on the analyze page, so an analyst can see what is incomplete before
  relying on it.
- **Which lines are declarable is decided at sync time**, not at query time, so
  a change to that rule only reaches a deployment when the tariff is re-synced.
  An existing snapshot keeps whatever the parser decided when it was built —
  and `DERIVATION_VERSION` is how a deployment finds that out for itself.

### The snapshot is derived data, and it knows which rules derived it

A snapshot is not a copy of the USITC payload. It is that payload run through
`src/lib/hts/parse.ts`, with the results **stored**: `is_reportable` is a
column, description paths are a column, inherited rates are a column. Change a
rule and nothing moves until a sync runs again.

The gap is silent, which is what makes it dangerous. Excluding Chapter 98 as a
classification is written, tested and reviewed, and on its own it would have
deployed green and done nothing: the volume holds data built by the previous
rule, the entrypoint re-synced only when the data directory was *empty*, and
nothing compared the data against the code that derived it. A release where the
tests pass, the deploy succeeds, and the behaviour does not move is the kind
that gets debugged in the wrong place.

So `DERIVATION_VERSION` in `parse.ts` is stamped into every manifest, and
`scripts/deploy/check-snapshot-derivation.ts` runs on boot. A snapshot built by
older rules — or by rules old enough to predate the stamp — triggers a
background re-sync, exactly as an empty directory does. **Bump it whenever a
rule in `parse.ts` changes what gets stored.**

Practical effect: re-deriving the tariff is a redeploy, not a shell session.
Run the **Deploy** workflow in GitHub; the machine boots, notices the mismatch,
serves the old snapshot while the new one downloads (~90s), and swaps it in.
Nothing needs `flyctl`, which matters because the snapshot lives on the Fly
volume and cannot be refreshed from a GitHub runner's disk.

### What counts as declarable

Two separate questions, and conflating them was the original bug.

**Is this the deepest line the schedule publishes?** That, not "does it have ten
digits", is what makes a line declarable. The ten-digit rule is right across most
of the schedule and wrong where it costs most: **3,564 subheadings terminate at
eight digits**, and the 95 watch provisions of Chapter 91 were being rejected
outright with a message denying they could be entered at all.

**Is this a classification at all?** Chapters 98 and 99 are not. Both are claimed
*alongside* a Chapter 1–97 classification, never instead of one:

| | |
|---|---|
| 3,095 in Chapter 99 | Section 301 and 232 — additional duties on top of a classification |
| 374 in Chapter 98 | 9823 USMCA (200), 9822 FTA temporary admission (60), 9820 preference apparel (25), 9804 personal exemptions (18), 9813 TIB (13), and others |

Chapter 98 is excluded for a reason particular to what this app is for. It
produces a **durable classification** — the code an analyst attaches to a
product in a library and reuses across every shipment of it. A Chapter 98
provision is not a property of the product: 9801 turns on the goods having been
exported and returned, 9813 on their being imported temporarily under bond, 9823
on their originating under USMCA. Those are facts about one importation, and the
same product can arrive under a different provision, or none, next month.

So "what is this thing" can never be answered with `9813.00.20`, any more than
with `9903.88.03`.

**And the app does not raise Chapter 98 at all.** An earlier version surfaced
provisions the facts pointed at, beside the classification. That was dropped on
the same reasoning that excluded them: Chapter 98 eligibility is decided per
entry, by whoever files it, from facts about that shipment. A provision named
on a product record would be read as settled when nothing about it has been
established — and for the transactional provisions, which are most of the
chapter, it is true of nearly every product and therefore says nothing.

Chapter 99 is different and stays: an additional duty is a consequence of the
classification and the origin, so it belongs with the code.

### The classification is not always the reporting number

With Chapters 98 and 99 excluded as classifications, **95 lines** remain that
have nothing beneath them in the tariff tree and are still not the ten-digit
number an entry is keyed against. All of them are Chapter 91 watch and clock
provisions, and all 95 carry the same footnote:

> See statistical note 1 to this chapter.

That note publishes their reporting numbers. It requires the article to be
**constructively separated** into its components — movement, case, strap or band
or bracelet, battery — each separately valued and reported on its own line, as
the eight-digit subheading with a suffix from the note appended. A
battery-powered watch classified in 9101.11.40 is reported as `9101.11.4010`,
`.4020`, `.4030` and `.4040`; the component values sum to the value of the
article; and a named component that is not in the shipment still gets a line, at
zero quantity and value.

**This was wrong here, and shipped.** An earlier version counted digits, found
these 95 short, and concluded the schedule published no reporting number for
them — stating so on the verdict card, on the candidate card and in every
exported determination. It offered the missing unit of quantity as corroboration
(0 of 95, against 19,831 of 19,831 elsewhere). The unit is missing *because* of
the scheme: there is no single quantity for the article, there is one per
component. The strongest-looking evidence was a consequence of the thing it was
taken to disprove.

So the question the code asks is now *where* the number is published, not
whether it exists, and it reads the answer from the line's own footnote rather
than from its length: `reportingNumberSource` in `src/lib/hts/parse.ts` returns
`on_the_line`, `chapter_statistical_note`, or `unpublished`. The result is
recorded on the run as `verification.reportingNumberNotes`, keeping the footnote
verbatim, and the three surfaces describe the reporting scheme instead of
warning about a gap. Runs stored before the field existed are re-examined
against the index when they are read back, so re-issuing an old watch
determination corrects it.

Nothing today lands on `unpublished` — every short leaf in Chapters 1–97 cites
the note. It exists so that a line which genuinely carries no suffix scheme is
reported as unknown rather than silently absorbed into the Chapter 91 story.

### Chapter 99 exposure

Section 301 and 232 duties routinely exceed the base rate, and the app was
close to blind to them. The only linkage it used was a `See 9903.xx.xx.`
footnote published on a base line — which covers 771 of 35,789 lines. Staple
exposed goods carried none: metal furniture, cotton T-shirts and lithium-ion
batteries all returned "no Chapter 99 provisions found".

Coverage is actually defined from the other direction. A Chapter 99 heading
states in its subchapter U.S. Note which base subheadings it reaches:

> **(k)** The rates of duty in heading 9903.85.08 apply to all entries of
> derivative aluminum products classifiable in the following HTSUS provisions
> … 0402.99.68; 0402.99.70; … 9403.20.00; …

Those notes are in the Chapter 99 document — 2.6 MB of text — *after* the first
tariff table, which is why the notes extraction never reached them. The sync
now parses them into a screening index: **1,217 subheadings**, each with the
note reference, the headings named in the note's operative sentence, and that
sentence itself. Metal furniture now returns note 19(k) → heading 9903.85.08
rather than silence.

Two deliberate limits. Each note block is bounded at the tariff table that
follows it — an unbounded block runs into the table and treats every code
printed there as enumerated (667 spurious codes from one block). And this is a
**flag, not a determination**: see Known limitations.

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
| `hts_notes` | Section and Chapter Notes — binding under GRI 1. A chapter read also names its section, since the two are published together but apply separately |
| `hts_gri` | The rule text verbatim |
| `chapter99_lookup` | Section 301 / 232 exposure, from footnotes *and* the notes that enumerate coverage |
| `schedule_b_lookup` | Export candidates under the shared HS-6 subheading |
| `schedule_b_search` | The export schedule by description, when HS-6 finds nothing |
| `web_search`, `web_fetch` | Part research and CROSS rulings |

### Two guardrails

**Nothing is accepted on the model's word.** After the run, every returned code
is re-checked against the snapshot (`verifyAgainstTariff` in `classify.ts`).
Codes that do not exist, or that resolve to a line the schedule breaks out
further, are dropped and the candidates re-ranked; if everything fails, the analysis fails
rather than presenting something unverifiable. A fluent, well-formed,
nonexistent 10-digit code is the highest-consequence failure mode in this
domain, and the one a language model is most prone to.

**Facts come from the tariff, not the transcription.** Duty rates, units, and
description paths are lookups rather than judgements, so the index overwrites
whatever the model wrote. Chapter 99 provisions are checked the same way — an
invented "+25% Section 301" line is a larger duty error than most base-rate
mistakes, and it renders in the callout a reader is most likely to act on.

Every disagreement is recorded and appears **both** on screen and in the
exported PDF. Leaving it out of the document made the artifact systematically
more confident than the run it came from, which is the wrong direction for a
record someone may rely on without having watched the analysis.

**CROSS citations are screened, not confirmed.** A ruling can only be verified
by retrieving it, which the app does not do; what it can reject is a citation
that could not be real — a malformed ruling number, a link off CBP's domain, or
a link that does not reference the ruling it cites. Survivors are labelled as
cited-but-not-retrieved in the UI and the PDF rather than presented as checked
authority.

**`web_fetch` is domain-limited.** Fetching is the only tool that can send data
outward, and the inputs here are customer part numbers. Without a limit, a page
reached during part research can instruct the model to fetch an
attacker-controlled URL with the part number in the query string. Retrieval is
confined to CBP, USITC, Census and a few federal sources, the system prompt
treats all fetched content as untrusted data rather than instruction, and
content is token-capped so one datasheet cannot dominate the run.

The selected code is verified a second time when the analyst records their
decision, in case the snapshot was re-synced in between. A run that ended in
`needs_more_info` cannot be recorded at all: the model declining to answer is
not a conclusion to sign.

**The snapshot can change under a running server.** Syncs write to a staging
directory and swap it in, so a rebuild is never half-visible, and the app
re-checks the manifest periodically rather than holding one handle for the life
of the process — otherwise it would keep serving the old index *and* keep
stamping the old revision after a sync, silently.

---

## Measuring whether it is right

`npm run eval` runs the classifier over a case file and reports accuracy and
confidence calibration. Nothing else in the repo answers the question "is this
tool correct", and without it the effort sweep below is guesswork.

```bash
npm run eval                                    # committed seed set
npm run eval -- --effort high                   # sweep against your bar
npm run eval -- --cases ./eval/team.local.jsonl # your own ruled cases
```

It reports more than one number, deliberately:

- **Accuracy by depth.** Exact 10-digit, then correct to the 8-digit rate line
  — duty right, statistical suffix wrong — then 6-digit, then chapter. A suffix
  miss and a wrong-chapter miss are both "incorrect" and are not the same
  failure.
- **Recall at any rank.** Whether the right code was offered but ranked below
  the pick. That is a re-ranking problem, not a retrieval one, and it is fixed
  differently.
- **Calibration.** Stated confidence against observed accuracy per band, plus
  expected calibration error and a Brier score. An analyst's only defence
  against a fluent wrong answer is the confidence number telling them to look
  harder, and a model that is 70% accurate and knows it beats one that is 80%
  accurate and claims 95% throughout.
- **Wrong while above 0.9.** Counted separately, because the prompt reserves
  that band for classifications defensible to CBP unaided — so anything here is
  a case where the analyst was told not to check and should have.

**The seed set proves less than a green number suggests, and the harness says
so.** All five cases are constructed from the tariff's own eo nomine wording,
so they measure retrieval and GRI mechanics rather than judgement on
contestable goods. Every run prints that caveat until the case file contains
work grounded in CBP rulings or your own analysts' determinations. Cases
declaring `"source": "cbp_ruling"` must carry the ruling number, so the claim
can be checked rather than taken.

Add your own in `eval/*.local.jsonl` — gitignored, because a real case file
contains customer part numbers and this repository is public:

```json
{"id":"pump-housing","mode":"DESCRIPTION","source":"cbp_ruling","citation":"N301234",
 "expected":"8413.91.90.80","input":"Cast aluminum centrifugal pump housing…"}
```

The harness costs real money — each case is a full agent run — so it never runs
in the test suite and is not wired into CI. The scoring is pure and unit-tested
separately, so the harness itself is verifiable without spending anything.

---

## Tuning cost vs. depth

`CLASSIFIER_EFFORT` defaults to `max` because classification is a
correctness-over-cost task. It is genuinely expensive and slow — a thorough run
takes minutes.

Sweep it with `npm run eval -- --effort high` and compare exact accuracy
against wall clock and tokens; `max` can overthink routine goods. It is one
config value and nothing else changes, but change it on measurement rather than
on impression — that is what the harness is for.

### The three levers, in the order they pay off

**1. Caching does the heavy lifting, and it is already on.** The dominant cost
of an agent loop is not the model tier — it is that every iteration resends the
whole accumulated history. A top-level cache breakpoint moves that history to
cache reads at about a tenth of the rate. On a measured description-mode run,
uncached input fell from ~23,000 tokens to 18, with 96% of a 97,000-token prompt
served from cache. If `npm run try` reports a low cache-read share on a
multi-step run, something has invalidated the prefix — that is the first thing
to look at, well before the model.

**2. Replay the rest.** Most of this application is not the model: sign-in, the
question loop, selection, determination recording, the PDF, history and the SSE
transport all sit downstream of a finished run. Record one real run and drive
them from it, indefinitely, for nothing:

```bash
npx tsx scripts/dev/try-classify.ts --record data/cassettes/bottle.json "steel water bottle"
npx tsx scripts/dev/try-classify.ts --replay data/cassettes/bottle.json    # free, ~2s
CLASSIFIER_REPLAY=data/cassettes/bottle.json npm run dev                   # whole UI, free
npx tsx scripts/dev/verify-e2e.tsx --replay data/cassettes/bottle.json     # PDF path
./scripts/dev/browser-e2e.sh                                              # 17 checks, a real browser
./scripts/dev/browser-ux.sh                                               # touch audit + 29 checks, phone viewport
```

`browser-ux.sh` opens with `audit-touch-targets.mjs`, which walks every
interactive element at phone width and exits non-zero on anything under 44px or
any text field under 16px (below which iOS zooms the viewport on focus and does
not zoom back). It found 37 the first time it ran — including the candidate
radio at 16x16, the control that decides which code a determination is written
against. It is a guard, not a report: without the exit code the next component
to land a small control would put the number quietly back to 1.

The two browser scripts differ in more than their assertions. `browser-e2e.sh`
replays at 1 ms a step, because it is checking outcomes — what was recorded,
what the PDF contains, what the duplicate guard refuses. `browser-ux.sh` replays
at 900 ms in an iPhone profile, because it is checking behaviour *during* a run:
whether the page stays put while the log streams, whether the log keeps up with
itself. Timing-dependent defects are invisible at 1 ms — an earlier review pass
declared the scroll behaviour fine having run it at that speed, and it was not.

Replay is refused in production builds, and every run it produces is stamped
`replay:<model>` — that string reaches the PDF provenance block, so a document
built from a recorded run says so permanently. A cassette proves the plumbing
carries a result; only a live run proves the result is any good. Cassettes are
gitignored: they contain whatever was classified.

**3. Model and effort last.** `CLASSIFIER_MODEL` takes `claude-opus-5`,
`claude-sonnet-5` or `claude-haiku-4-5`. Prefer Sonnet 5 for trials: it keeps
the request shape identical to production, so a green run there means something.
Haiku accepts neither an effort level nor adaptive thinking, so it takes a
different request shape *and* — measured — it drops required fields from the
output contract, because the schema is too large for the API to enforce as a
grammar and nothing then compels a smaller model to fill every field.

Lower effort also buys fewer alternates: on the same subject, `low` returned one
to two candidates and `medium` three. The brief asks for a determination plus
three to five rejected alternates, so a cheap setting can produce a
structurally-valid determination that is thinner than the deliverable wants.
`verify-e2e` reports that as a warning rather than a failure, because it is a
property of the run and not of the export path.

---

## Deploying

**`docs/SETUP.md`** is the one to follow if you are putting this online: four
steps, no terminal, no Docker, runnable from a phone. Paste two keys into the
repository's secrets and tap *Run workflow*; GitHub builds the image on Fly's
remote builders, provisions the volume, deploys, downloads the tariff, and
health-checks the result. A second workflow re-syncs the tariff weekly.

**`docs/DEPLOY.md`** is the same deployment done by hand, for when you need to
understand or debug what the automation is doing: `Dockerfile`, `fly.toml` with
a persistent volume, seeding the snapshot, backups, and the Render/Railway
variants.

The short version of why it is a container with a volume rather than
serverless: one analysis holds an SSE connection for up to 13 minutes, the
tariff snapshot and audit database are files on disk, and `better-sqlite3` is a
native addon. Those three rule out platforms that cap request duration or hand
you an ephemeral filesystem.

`/api/health` reports the active revision and its age, and turns `degraded`
once the snapshot passes three weeks — point an uptime check at the status
field, not just the HTTP code.

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
| `npm run eval` | Measure classification accuracy and calibration (costs API credits) |

Deployment env vars beyond the two required secrets: `HTSUS_DATA_DIR` and
`DATABASE_URL` should both point at the mounted volume, and
`ANALYZE_RATE_LIMIT` / `ANALYZE_RATE_WINDOW_MINUTES` bound spend on a publicly
reachable URL (default: 10 analyses per client per 15 minutes).

---

## The look, and why it is that look

Every artifact in this trade is a ruled form — an entry summary, a commercial
invoice, the tariff schedule itself: boxes with small condensed captions above
the values they hold. That is not decoration, it is how the people who use
those documents find things, and it is the one visual language a compliance
analyst already reads fluently. So the interface borrows it instead of
inventing another card layout.

- **Three typefaces, vendored** (`src/app/fonts/`). Archivo for prose, Archivo
  Narrow for the captions a form puts above its boxes, IBM Plex Mono for
  everything numeric — its figures are tabular by construction, so a column of
  ten-digit codes aligns digit under digit, which is how codes get compared.
  Checked in rather than fetched by `next/font/google`, so the build needs no
  network. 84 KB, both OFL-1.1, licenses included.
- **Ruled field blocks** (`.field`, `.field-grid`, `.field-block`, `.caption`)
  for anything transcribed onto an entry — duty rates, units, the tariff
  edition. Loose label/value pairs let the eye pair a value with the wrong
  caption on a narrow screen; boxes sharing a rule do not.
- **Struck marks, not filled pills** (`.stamp`). Status takes its colour from
  `currentColor`, so one mark serves every state without a palette of variants.
- **`<HtsCode>`** spaces a code at its segment boundaries — heading,
  subheading, rate line, statistical suffix — because that structure is what an
  analyst is comparing. The dots stay real characters, so a copy still pastes.

### Keeping the screen and the document in step

The determination is drawn twice, by engines that share nothing: CSS custom
properties on screen, `@react-pdf` for the PDF, which has no cascade and cannot
read a variable. The palette therefore lives in `src/lib/brand.ts`; the PDF
imports it, `globals.css` mirrors it, and `brand.test.ts` parses the stylesheet
and fails naming the pair that drifted. It also checks the `themeColor` in
`layout.tsx` — the easiest value in the app to forget, since it lives in a
`Viewport` export rather than the stylesheet.

Design changes want looking at, not reasoning about. `node scripts/dev/shoot.mjs`
drives a replayed run and captures every screen at phone width in both themes;
`npm run dev:pdf` renders the sample determination.

---

## Layout

```
src/
  app/            routes: splash (/), /analyze, /history, API handlers
    fonts/        vendored woff2 + OFL licenses
  components/     UI — analysis client, candidate cards, masthead, theme
  lib/
    brand.ts      the palette both renderers agree on
    agent/        system prompt, tools, run loop, output schema, verification
    hts/          USITC parsing, SQLite index, query layer
    pdf/          determination document and view assembly
    auth/         session signing and validation
  test/           shared fixtures
scripts/
  sync-htsus.ts   the tariff sync
  dev/            offline seed, sample PDF render, browser checks, screenshots
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
- **The General Notes stop at General Note 3, by design.** The stored body is
  the GRIs, the Additional U.S. Rules, and General Notes 1–2. The full document
  is 878 pages and ~2.7 MB — everything past General Note 3 is
  preference-eligibility material: rate-column definitions, GSP, USMCA, and
  every FTA's rules of origin and tariff-shift annexes. This tool does not
  analyse preference eligibility, so it does not carry the material that would
  imply it does. `hts_gri` states the limit in its own description, and the
  Special column's programme codes on a determination are reproduced from the
  tariff, not analysed.
- **Chapter 99 screening flags exposure; it does not determine duty.** The
  notes carry conditions the index does not evaluate — country of origin,
  effective and expiry dates, granted exclusions, carve-outs — and some notes
  enumerate goods that are *exempt* rather than covered. A hit means "read this
  note", and the note's operative sentence travels with it so the reader can.
  Neither linkage is complete: footnotes reach 771 of 35,789 lines, the notes
  reach 1,217 subheadings, and they overlap only partly, so "none found" still
  means "not detected in this revision", never "none apply".
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
