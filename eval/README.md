# Eval cases

`npm run eval:check` validates a case file for free.
`npm run eval` runs it — **one full agent run per case, at real cost.**

Always check before you run. The check resolves every expected code against the
loaded snapshot, and a transposed digit that slips through scores as a miss on
every run and reads in the report as the model being wrong.

## Why the seed set is not enough, and cannot be made enough from here

The nine committed cases are all `eo_nomine`: the good is named in the schedule,
so the answer is read off the tariff rather than judged. They are worth having —
several are built around the structural risk a reviewer identified, that
retrieval weights a line's own description over its path and so under-retrieves
residual "Other" provisions, which is where a large share of real goods land.

But they measure retrieval and GRI mechanics. They say nothing about judgement
on contestable goods, which is what the tool is for, and an accuracy figure
computed only over them is not an accuracy figure for the tool. `eval:check`
says so on every run and will keep saying so until the set contains cases with
real ground truth.

**Those cases cannot be written by whoever is building the harness.** Inventing
an expected answer for a good that turns on essential character is manufacturing
ground truth — asserting a judgement as fact, which is the exact failure this
application keeps having to correct. They have to come from somewhere that
already decided.

## The two sources that count

### `cbp_ruling`
CBP ruled on the good. The strongest claim a case can make, so it must carry a
`citation` — the loader refuses the case without one.

Take these from CROSS. **Do not write a ruling number you have not read.** A
citation nobody checked is worse than no case at all, because the report will
present it as ground truth.

### `analyst`
Someone on the team classified this good and stands behind it. Weaker than a
ruling and still real: it is a judgement a named person made and would defend,
which is precisely what the tool is trying to reproduce.

Your own past determinations are the best available source. They are already
written down, already reasoned, and already yours.

## Writing a good case

The value is in the tension, not the count. Fifty easy cases measure less than
ten contestable ones.

- **Pin what the answer turns on.** If the statistical breakout keys on
  men's-versus-boys', or on a value bracket, the input has to say. An
  under-specified input is a fine case for measuring what the tool does with an
  under-specified input, but then the expected answer has to be defensible on
  what was actually supplied.
- **Say what it tests, in `note`.** Written to be read by whoever is staring at
  a failure six months from now.
- **Tag it.** Tags are how "82% overall" becomes "97% on eo nomine, 54% on GRI
  3(b)", which is the only version of that sentence anyone can act on. Tags in
  use: `gri_1_notes`, `gri_3b_essential_character`, `parts_vs_whole`,
  `residual`, `deep_residual`, `gri_6_suffix`, `end_use_suffix`,
  `statistical_note`, `section_note_exclusion`, `textiles`,
  `chapter_99_screening`, `chapter_NN`. Add your own; they are free-form.
- **Supply `refinements`** when the good genuinely needs a fact the description
  omits, so the run does not stall on `needs_more_info` and score as a failure
  that is really an unanswered question.

## Shape

```jsonc
{
  "id": "stable-slug",
  "mode": "DESCRIPTION",              // or "PART_NUMBER"
  "source": "cbp_ruling",             // cbp_ruling | analyst | eo_nomine
  "citation": "<ruling number>",      // required for cbp_ruling
  "expected": "6109.10.00.12",        // 10 digits, dotted
  "tags": ["textiles", "gri_6_suffix"],
  "input": "Exactly what an analyst would type.",
  "note": "The tension this exercises, and what failing it would mean.",
  "refinements": [{ "question": "...", "answer": "..." }]
}
```

Keep team cases out of git — the input is a product description and the repo is
public:

```
npm run eval:check -- --cases ./eval/team.local.jsonl
npm run eval       -- --cases ./eval/team.local.jsonl
```

`eval/*.local.jsonl` is gitignored.

## Reading the result

The headline is exact 10-digit accuracy. The lines under it matter more.

- **To the 8-digit rate line** — duty right, suffix wrong. A different kind of
  error from a wrong heading, and a much cheaper one.
- **Offered at any rank** — whether the right code was on the page at all. High
  recall with low exact accuracy means the analysis is sound and the ranking is
  not, which is a different fix.
- **By provenance and tension** — the slice table. If `eo_nomine` reads 95% and
  `analyst` reads 50%, the headline average is describing neither.
- **Calibration** — does stated confidence track being right? `confidently
  wrong` counts answers above 0.9 that were wrong. The prompt reserves that band
  for classifications defensible to CBP unaided, so every one of those is a case
  where the analyst was told not to look and should have. This is the number
  that decides whether confidence can ever gate anything.

Thirty cases is roughly the floor for reading a calibration curve; below that a
band holds three cases and reports 0%, 33%, 67% or 100% and nothing between.
