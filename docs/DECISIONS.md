# Decision record

Why the application is shaped the way it is, in the order it learned.

**This file exists because pull request descriptions are not part of the
repository.** They are GitHub metadata — they survive a repo transfer within
github.com and are lost by any clone, mirror or push to a different host. The
reasoning behind thirteen pull requests would have left the building with them.

Entries are one per pull request, oldest first. Each states the defect, the
decision, and — where one exists — the guard that stops it coming back. Nearly
every entry is a correction: this is a record of things that were wrong, not a
list of features.

Point-in-time facts (test counts, "all green") are omitted. Figures that
describe the tariff are kept, because they are the evidence behind a decision
and several of them are load-bearing on the exported artifact.

---

## #1 — The workbench (2026-08-04)

The founding shape. An analyst signs in, submits a part number or description,
the model works GRI 1–6 against a pinned snapshot, and the analyst selects a
code and exports a PDF recording who decided, when, and against which edition.

**The core design decision: nothing is taken on the model's word.** A fluent,
well-formed, nonexistent 10-digit code is the highest-consequence failure in
this domain and the one a language model is most prone to. Every returned code
is re-verified against the snapshot and dropped if absent; duty rates, units and
description paths are lookups rather than judgements, so the index overwrites
the model's transcription and records the disagreement on screen *and* in the
PDF; Chapter 99 provisions and CROSS citations get the same treatment. If
everything fails verification the analysis fails rather than presenting
something unverifiable.

Data-layer facts worth keeping:

- **Section Notes are published nowhere directly by USITC.** All 22 are
  recovered from the head of each section's first chapter. That recovery is what
  makes Section XVI Note 2 reachable when classifying in Chapter 85 — without it
  the binding material for machinery is simply absent.
- **Chapter 99 coverage is defined from the Chapter 99 side.** Footnote-based
  detection alone missed staple exposed goods entirely, which is why the
  subchapter U.S. Notes are parsed into a coverage table.
- **Schedule B joins at the 6-digit HS subheading, never at ten.** Only 30.1% of
  tariff numbers have an identical 10-digit export code, so an equality-based
  crosswalk is wrong roughly 70% of the time.

Scope is tariff classification only. Origin, valuation, FTA eligibility, AD/CVD,
quota and PGA are not analysed, and the PDF says so rather than implying
completeness. Sign-in is attribution, not access control.

## #2 — Make the determination defensible, and trials cheap (2026-08-09)

**The determination hash was never reproducible.** The renderer stamped
wall-clock time into `/CreationDate` and derived the `/ID` trailer from it, so
three renders of identical frozen inputs produced three different hashes 61
bytes apart. The integrity alarm therefore fired on *every* re-issue of a
document that had not changed. A check that always cries wolf teaches you to
ignore the one case it exists for. Both dates now pin to `decidedAt`.

**Chapter 99 gaps rendered as silence.** The additional-duties block appeared
only on a hit, so the highest-exposure outcome produced the cleanest-looking
page — a Chinese-origin good the screening missed came out reading `GENERAL
(COL. 1): Free` with no additional-duty section, under a footer implying
Chapter 99 had been considered. The negative is now stated with the reach of the
screening attached.

**Real CBP rulings were called malformed.** The pattern accepted only
`[HN]?\d{6}`, rejecting the entire 2002–2005 NY letter series (`NY J80123`) and
W-prefixed pre-classification rulings (`HQ W968156`). Rejections are written
into the discarded list, so the document told a reader *in writing* that a
genuine citation was invalid.

**Two UI guards that were live defects.** `MODEL'S PICK` rendered off
`candidate.rank === 1` rather than the run's recommendation — but verification
can reject the model's own pick and leave a different candidate at rank 1, and
`needs_more_info` nulls the recommendation deliberately; in both cases the badge
labelled something the model did not choose. And the PDF opened via
`window.open` two awaits after the click, which popup blockers eat — the analyst
sees nothing, clicks again, and mints a second determination for one decision.
It is a link now, and `Determination.analysisId` is unique, because the
application-level check alone loses the race between two in-flight POSTs.

**Cost is dominated by history resend, not model tier.** A tool loop resends its
whole accumulated history every iteration, so spend grows with the square of the
tool count. A top-level cache breakpoint moves that history to cache reads:
measured on the same input, uncached input fell from **22,678 tokens to 18**,
with 96% of a 97,000-token prompt served from cache.

Telemetry counted only `input_tokens` — the *uncached remainder* — so caching
made tokens vanish from the total rather than appear as a saving, and every cost
figure the app had ever reported was low. All three counters are carried now.

**Record and replay.** Most of this application is not the model. A cassette is
one real run's event stream captured verbatim; replaying it drives the identical
code path for nothing. Refused in production builds, and every run it yields is
stamped `replay:<model>`, which reaches the PDF provenance block permanently.

## #3 — Say which secret is missing (2026-08-09)

The deploy failed demanding `ANTHROPIC_API_KEY` in GitHub secrets when the app
already held it on Fly. An earlier run failed at *Create the app* with a
name-collision message whose real cause was one line higher: `FLY_API_TOKEN` was
empty, `flyctl status` failed for want of credentials, and the step read that as
"the app is not there".

The rule is now **set what is genuinely missing, leave alone what is there**.
Supplying a key in GitHub becomes how you rotate it rather than a setup
requirement. Keeping one copy of a credential rather than two is the point:
either can leak, and two can drift apart.

Workflow files are invisible to both typecheck and unit tests, which is how two
of these reached `main`. Tests now read the workflow files directly.

## #4 — Legible on a phone, and honest about its own derivation (2026-08-11)

**Declarability is decided by the schedule, not by digit count.** `is_reportable`
required ten digits; **3,564 subheadings terminate at eight** and were rejected
outright — 374 in Chapter 98, 95 in the Chapter 91 watch provisions. The rule
became "nothing is published beneath it". Chapter 99 stayed excluded.

**`DERIVATION_VERSION` was introduced here, and it is the guard that matters
most in this file.** A snapshot is not a copy of the USITC payload — it is that
payload run through `parse.ts` with the results *stored*. `is_reportable` is a
column. So the change above would have deployed green and done nothing: the
entrypoint re-synced only when the data directory was empty, and nothing
compared the data to the code that derived it. The version is stamped into every
manifest and checked on boot. It fails *toward* re-syncing, because a crash in
the check costs 90 seconds of redundant download versus serving a tariff derived
by unidentifiable rules.

**The corrections advisory fired on every analysis.** Every correction ever
raised was punctuation — a leading tariff number the model kept, a dropped
trailing colon — presented in the language reserved for a wrong duty rate.
Corrections carry a severity now. The first attempt at that filtered on
`severity === "material"`, which silently dropped every correction recorded
before the field existed, on screen and in re-issued PDFs; corrections preserve
both values, so the same comparison classifies an old record exactly.

**Touch targets were measured, not guessed.** 37 interactive elements were under
44px at phone width — the worst being the candidate radio at **16×16**, the
control that decides which code a determination is written against. The audit
exits non-zero, so it guards the state rather than describing it.

**Two PDF layout bugs found by rendering rather than reasoning.** The footer is
absolutely positioned and the page reserves its space by arithmetic — 60pt
against a footer running to eight lines, so it printed on top of the body. Every
text assertion passed throughout, because extracting text from a PDF does not
care whether glyphs collide. Separately, `wrap={false}` on the whole
DETERMINATION section survived only while the section fit; one added callout
tipped it over and the renderer moved the entire section to page 2, pushing the
determination off the first page of a document whose purpose is to state it.

Typefaces are **vendored** rather than fetched by `next/font/google`, which
fails the build when it cannot reach Google.

## #5 — Chapter 98 is a claim beside the classification (2026-08-11)

Acting on the owner's call: this app produces a **durable classification for a
product library**, not a per-shipment entry decision.

Chapter 98 joined Chapter 99 in `SECONDARY_CHAPTERS`. The reasoning is the app's
purpose rather than the shape of the line: 9801 turns on goods having been
exported and returned, 9813 on temporary importation under bond, 9823 on
originating under USMCA. Those are facts about **one importation** — the same
product arrives under a different provision, or none, next month.

This did not undo #4. Those provisions had been rejected with a message denying
they could be entered *at all*, printed into the determination's discarded list.
They remain in the index and remain lookup-able; they are refused for the honest
reason now.

Knock-on: with 98 and 99 excluded, the lines stopping short of a ten-digit
reporting number fell from 469 to **95**, all Chapter 91 watch provisions.

**A test was passing for the wrong reason.** "A Chapter 98 provision is not a
classification" passed against a fixture that did not contain one — the code was
rejected as absent from the index, a different rejection with a different
message. It would have kept passing if the rule were deleted outright.

## #6 — Say nothing about Chapter 98 at all (2026-08-11)

#5 did two things: excluded Chapter 98 from being a classification, and surfaced
any provision the facts pointed at, beside the answer. The exclusion was right
and stays. The surfacing did not survive the same reasoning — a provision
printed on a product record **reads as established** when nothing about it has
been checked, and most of the chapter is transactional enough to be true of
nearly any product (`9813.00.05` is "articles to be repaired, altered or
processed", which says nothing about a good). Listing it everywhere is how a
field becomes furniture.

Also: **the Fly dashboard has no environment-variable editor.** Its Environment
panel displays what `fly.toml` bakes in and cannot edit it. The mechanism is
Secrets — and Fly *stages* a secret for the next release, so saving one changes
nothing until a deploy or "Deploy Secrets". Following the old docs meant setting
a value, seeing nothing happen, and having no reason to suspect the docs.

## #7 — Chapter 91, and rendering the same way twice (2026-08-13)

**The app was stating a falsehood on every exported determination.** It said no
ten-digit reporting number is published for the 95 watch and clock provisions of
Chapter 91. Chapter 91 statistical note 1 publishes all of them: the article is
constructively separated into components, each separately valued and reported on
its own line as the eight-digit subheading with a suffix from the note appended.
The note opens by saying what it is for — 9101.11.40's Column 1 rate is `51¢
each + 6.25% on the case and strap, band or bracelet + 5.3% on the battery`,
which nobody can compute without the split.

**Why the wrong answer looked right** is the most instructive thing in this
file. The check counted digits, found these 95 short where 19,831 other leaves
are not, and read the shortfall as the schedule declining to publish. The
corroborating evidence offered at the time was that none of the 95 carries a
unit of quantity, against 19,831 of 19,831 elsewhere. But that is a *consequence*
of the scheme — there is no one quantity for a watch, there is one per
component. A digit count cannot see a footnote, so the strongest-looking
evidence available to it was the very thing it was mistaking for absence. The
question asked is now *where* the number is published, read from the line's own
footnote.

**Three ways the artifact could not render the same way twice.**
`chapter99Scope` was read live at export and one of its counts is the number of
declarable lines in the schedule, which every revision moves — so after any sync
*every* determination re-rendered to different bytes and real drift was
indistinguishable from a ~100% background rate. `reportingNumberNotes` was
reconstructed on every read, so a watch determination issued under one revision
could re-issue saying the *opposite* about its own reporting number, while still
printing the original revision's name beside the claim. And `pdfSha256` was
written on first export — weeks and a sync later — so "as issued" meant "as it
looked when somebody first asked". All inputs are frozen columns written at
decision time now, and one `renderDetermination` serves both routes.

**Statements that were simply false:**

| | was | is |
|---|---|---|
| Chapter 99 coverage | "267 of 19,949 declarable subheadings" — a count of 8-digit subheadings over a count of 10-digit lines, both called subheadings | 267 of 11,387 subheadings by notes; **2,034 of 19,949 lines by either path, about 10%** |
| An overridden model pick | "Ranked lower; no specific rejection rationale was recorded" | "Ranked first by the analysis and passed over by the analyst" |
| Confidence | "Stated confidence in this classification: 88%", under the analyst's name | attributed to the analysis, flagged as uncalibrated |
| A clean verification pass | nothing at all | says what was checked and that nothing was corrected |

The coverage figure understated the tool's own reach by roughly **eight times**,
in the one sentence on the page offered as a measurement rather than a caveat. A
precise wrong number invites reliance where a hedge invites a second look.

**Data loss, twice over.** `/api/analyze` overwrote `refinementsJson` with only
the current screen's answers, so a second round of clarifying questions erased
the first — from the record *and* from what the model was re-run with. The
server-side merge that fixed it was then a read-modify-write with no
transaction: two rounds in flight both read the same prior and the second write
erases the first. The same bug the merge was written to fix, one layer down. The
read and the merge happen inside the write now.

**`why_not_selected` is keyed on the recommendation, not on rank 1.** Rank 1 is
wrong in three cases: a substituted recommendation strips rank 1 of a rationale
it earned, a model recommending below first prints "why it was passed over"
under the answer, and a `needs_more_info` run clears rank 1's for a selection
that never happened.

Two corrections to work done in the same branch: the Chapter 91 component set is
**scheme-dependent** (scheme (a) is movement/case/strap/battery, scheme (b) is
movement-and-case/battery — two lines, not four), and naming the four-component
set as universal was the same over-generalisation from one example that caused
the original defect. And the merge key separator was a **literal NUL byte**,
which made `refinements.ts` binary to git — so the merge logic shipped invisible
to code review.

## #8 — Stop the integrity alarm crying wolf (2026-08-17)

#7 froze every input so the stored hash could mean "these bytes are the bytes
that were signed". It also rewrote half the document's sections — and a template
change moves the bytes of every determination ever recorded. The first re-export
of any existing determination would have stamped **"this re-issues differently
from the document that was signed"** in danger red across the whole history at
once: the same cries-wolf failure the freezing was undertaken to end, arriving
from the other direction.

`appVersion` could not discriminate — a hardcoded `"0.1.0"`, so every row
carries the same value. **`DETERMINATION_TEMPLATE_VERSION` travels with the row
instead**, and a mismatch is drift only when both renders came from the same
document version.

**The fix had its own version of the same flaw.** Rows never exported have no
hash, and the route backfilled today's render as the decision-time baseline —
recording a document produced under a template that did not exist at signing as
the bytes that *were* signed. Not a weak claim, a false one. The template
version is stamped at row creation now, which makes the two null cases
distinguishable: a version with no hash is a row whose render threw; both null
is a determination predating the mechanism, and nothing is written for it.

**The deployment was re-downloading 60 MB on every boot.** The derivation check
scanned *every* snapshot directory and failed if any mismatched. Syncs do not
prune, so a retired directory keeps its old stamp forever — meaning the first
re-sync after a rule change satisfies nothing and the check exits 1 on every
boot for the life of the volume. It asks the store's own `resolveLatestRevisionDir`
now rather than reimplementing the resolution.

**A run that asked a question was unrecoverable.** A `needs_more_info` run
cannot be recorded — correctly — so the only way forward is to answer and
re-run. The saved view rendered the questions read-only and told the analyst the
work "happens on the analysis page", which is the page they were standing on.
Every way of not watching a stream to its end stranded a full max-effort spend,
and boundary goods are exactly the ones that come back asking questions and
exactly the ones you walk away from while they think.

*(The obvious shape — a `renderQuestions` render prop — 500s, because the caller
is a server component and React will not serialise a function across that
boundary. The browser suite caught it; no unit test would have.)*

**"Leave it blank" now means something.** The form had always promised a blank
is carried into the determination as a stated assumption rather than a silent
guess. It was not: blanks were filtered in the component, filtered again on the
way in, and the re-run was never told a question had been put to a human who
could not answer it. A senior analyst declining to assert a material fact is
evidence, and discarding it left the model unable to distinguish that from never
having asked.

**`db push --accept-data-loss` was ungated**, running on every boot against the
live audit database with no diff printed. Every change so far had been additive
— but SQLite has no ALTER COLUMN, so a rename makes Prisma rebuild the table
with an INSERT that does not carry the old column. The reason every analyst gave
for overriding a recommendation, gone from signed determinations, with
"applying database schema" in the log and health reporting `ok`. The pending DDL
is read before it is applied and the boot refuses anything non-additive.
**Failing to read the diff is also a refusal** — this is the one check whose
entire purpose is certainty.

**Peer feedback, both halves the stylesheet's fault.** Explanation sat above the
fields, which is right the first time somebody arrives and wrong every time
after — and every-time-after is nearly all of them. And nothing distinguished
editable from reference: `.field` is a ruled box holding a value you *cannot*
change, and inputs carried the same hairline border on the same surface.

## #9 — Let a run outlive its browser (2026-08-18)

Reported from use: a run stopped by a closed window could not be resumed.
Investigating turned up something worse — closing the window did not leave the
run unresumable, it **killed** it. The route passed `signal: request.signal` into
`classify()`, and Next aborts that signal the moment the client disconnects, so
a locked phone aborted the model call mid-run and the catch block wrote the row
`FAILED`.

**The code said the opposite throughout.** The stream's `cancel()` handler
logged "run continues so the result is kept"; the comment above it explained at
length that the run was deliberately not cancelled. Both were true of the stream
and false of the run. "Stop watching" told the analyst the run continues on the
server while aborting it. And `browser-ux.mjs` asserted *"no button claims to
Cancel a run the server keeps running"* — and passed, **because it checked the
words rather than the behaviour.**

The run holds its own `AbortController` in `runRegistry`, keyed by analysis id.
Stopping became an explicit act: `POST /api/analyses/[id]/cancel` **marks the
row and then aborts, in that order** — the mark is the record and the abort is
an optimisation on top of it, so a cancel still works when this process is not
the one driving the run. Terminal writes are scoped to a row still `RUNNING`, so
a result already in flight cannot resurrect a cancelled analysis into
`COMPLETE`. An abort is never recorded as a failure.

## #10 — Make "would raise confidence" answerable (open)

The model keeps **two** lists of gaps and the app treated only one as real.
`clarifying_questions` block the run and are answered before a determination can
exist. `info_that_would_raise_confidence` — named, specific, not blocking — was
rendered read-only and printed nowhere, so an analyst could be shown three
things that would have firmed the classification up with no way to supply any of
them short of retyping the description as a fresh analysis.

Opt-in rather than a confidence gate, deliberately: some of these are not worth
another run of minutes and real spend, that is the analyst's call, and a
threshold would key off a confidence number that has never been calibrated.
**Untouched items are not recorded as declinations** — unlike the decisive
questions, the analyst never undertook to answer these.

## #11 — Check an eval case file before paying to run it (open)

`parseCases` verified that `expected` is ten digits, not that those ten digits
are a *code*. A transposed pair loads cleanly, scores as a miss on every run,
and is indistinguishable in the report from the model being wrong. The preflight
resolves every expected code against the snapshot for free, and **refuses
outright against a partial snapshot** — the four-chapter dev fixture is the
newest directory on a developer's machine and so wins the store's resolution,
which had the check reporting three of five perfectly good cases as nonexistent.

The report also breaks out by source and tag. A laptop named almost verbatim in
the schedule and a composite article turning on essential character are not the
same measurement, and averaging them lets the easy cases carry the hard ones —
in the direction that flatters the tool.

**What is deliberately not added is the cases that matter most.** Inventing an
expected answer for a good that turns on essential character is manufacturing
ground truth, and inventing a CBP ruling number is worse, because the report
would present it as the strongest evidence it has.

## #12 — CLAUDE.md (open)

Orientation for a fresh agent: what costs money, what the public-repo rule
forbids, the two version stamps with silent failure modes, and the things that
look like bugs and are not.

## #13 — Close the gaps a full read turned up (open)

Four places where the app disagreed with itself. The saved-analysis page parsed
its run raw while every other read went through `backfillRunFields`. Recording a
determination could still lose the race its own comment described, returning a
raw 500 to the loser. `/history` listed `CANCELLED` analyses with no tag for
them. The clarifying-question form supported three of the four answer types the
schema promises, rendering `multi_choice` as a text box with the options as
placeholder text.

Plus the duplication that let them drift: twelve inline digit-strip comparisons
became `sameHtsCode`, and three routes' identical auth preamble — two of which
had drifted to a shorter form — became `sessionOrUnauthorized`.

And `npm run dev:cassettes`, because the browser suites replay gitignored
cassettes and a fresh clone therefore could not run them at all without a live
model run and an API key.
