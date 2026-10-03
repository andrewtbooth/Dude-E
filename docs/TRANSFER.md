# Moving this application to another environment

Written for a move into a government or otherwise restricted cloud, where the
deployment platform, the git host and the model endpoint all change at once.

The application code is portable. What is not portable is everything *around*
it, and this file is the inventory: what travels with a clone, what has to be
carried deliberately, what has to be replaced, and what is still unfinished so
it does not get lost in the move.

**Before you start**, four companion pieces are worth knowing about. Each was
written for this move, and the steps below assume all four are present:

| | What it does for the move |
|---|---|
| `docs/DECISIONS.md` | The reasoning from thirteen pull requests, extracted before the descriptions became unreachable |
| `CLAUDE.md` | Orientation for an agent picking the repository up cold — what costs money, what fails silently, what is deliberate |
| `.claude/hooks/session-start.sh` | Brings a fresh clone to where its own tests run, with no manual setup |
| `npm run dev:cassettes` | Builds the replay cassettes the browser suites need, so a clean checkout can verify itself without a paid model run |

---

## 1. What a clone carries, and what it does not

**Travels.** Every commit, branch and tag, and every commit message. The commit
messages in this repository are written to carry reasoning rather than
changelog, so the *why* survives a clone even where nothing else does.

**Does not travel.** Pull request descriptions, review threads, and issue
history are GitHub metadata, not git objects. They survive a repo transfer
*within* github.com and are lost by any clone, mirror, or push to a different
host. That is why `docs/DECISIONS.md` exists — it is the record extracted from
thirteen pull requests before they became unreachable. Add to it rather than
relying on a PR description again.

Also does not travel: GitHub Actions run history, GitHub secrets, and anything
on the Fly volume.

## 2. The one thing that cannot be regenerated

**The audit database.** `/data/dude-e.db` on the deployment volume, or
`prisma/dude-e.db` locally.

It holds the determinations: who classified what, when, against which tariff
edition, on what reasoning, with the hash of the document they signed. Customs
recordkeeping is the reason this application exists. Copy it deliberately,
before tearing anything down, and confirm afterwards that the row count matches.

In a controlled environment it is also the artifact that carries the most
obligation: the inputs are part numbers and product descriptions, so if those
are controlled then so is this file — encryption at rest, retention, and access
logging all attach to it. A single SQLite file on a volume is unlikely to
satisfy that. The schema is deliberately Postgres-portable for exactly this
moment; see "Known-unfinished work" below.

**Everything else regenerates** and should be left behind rather than copied:

| | How to rebuild |
|---|---|
| `node_modules/` | `npm install` |
| `prisma/generated/` | `npm run db:generate` |
| The tariff snapshot | `npm run sync:htsus`, or `npm run dev:seed` for the offline fixture |
| Replay cassettes | `npm run dev:cassettes` |
| `.next/` | `npm run build` |

`.claude/hooks/session-start.sh` runs that whole sequence, so a fresh clone in a
Claude Code session comes up ready without anyone typing it.

## 3. Rotate on arrival, do not carry

- **`ANTHROPIC_API_KEY`** — a new credential in the new environment regardless.
  If inference moves to Bedrock or Vertex this stops being a key at all and
  becomes an IAM role or service account.
- **`SESSION_SECRET`** — rotating it invalidates every existing session, which
  is the correct outcome across an environment boundary rather than a side
  effect to work around.

`config.anthropicApiKey` and `config.sessionSecret` are getters that read
`process.env` on each access, so neither needs a code change or a rebuild.

## 4. Platform coupling, file by file

The useful finding first: **application code is clean.** The only two mentions
of the current host anywhere under `src/` are explanatory comments — one in
`runRegistry.ts` noting why a per-process registry is adequate, one in
`check-snapshot-derivation.ts` about volume sizing. Neither is behaviour. The
app is configured entirely through `HTSUS_DATA_DIR`, `DATABASE_URL` and `PORT`.

| File | What it assumes | What to do |
|---|---|---|
| `Dockerfile` | Node 22; builds `better-sqlite3` from source, so it needs `python3`, `make`, `g++` | **Portable as-is.** Nothing host-specific in it |
| `docker-entrypoint.sh` | A writable volume, and the three env vars above | Portable. It also runs the boot gates — duplicate-determination check, additive-DDL check, derivation check — which are worth keeping whatever runs the container |
| `fly.toml` | Fly.io specifically | Delete it, but carry its *requirements* forward — see below |
| `.github/workflows/deploy.yml` | GitHub Actions, `flyctl`, GitHub secrets | Replace. Worth preserving: the deploy is gated on the full check suite, and secrets follow "set what is missing, leave alone what is there" |
| `.github/workflows/sync-tariff.yml` | A weekly cron (Sundays 06:00 UTC) | **Replace with something.** Not optional — HTSUS revisions ship every few weeks and a snapshot ages silently. During development USITC published Revision 15 days after Revision 14 |
| `.github/workflows/ops.yml` | Actions UI as a phone-friendly ops console | Replace or drop, depending on whether that need survives |
| `src/lib/deploy/workflow.test.ts` | Reads the three workflow files and asserts their step ordering | **This test will fail** the moment the workflows are replaced. Rewrite it against the new pipeline or delete it with them — do not leave it asserting about files that no longer exist |

### What `fly.toml` encodes that any host must satisfy

These are properties of the application, not preferences, and they are the real
output of that file:

- **Persistent disk**, mounted where `HTSUS_DATA_DIR` and `DATABASE_URL` point.
  Both pieces of durable state are files.
- **No request-duration cap.** A max-effort analysis holds an SSE connection for
  up to thirteen minutes. Platforms that cap this require reworking the app
  rather than configuring it.
- **No idle suspension.** A machine that stops mid-analysis loses the run.
- **At least 2 vCPU and 2 GB.** PDF rendering and the SQLite FTS queries are both
  synchronous and would block the event loop during a stream on a single shared
  core.
- **A health check on `/api/health`** with roughly 90 seconds of grace: first
  boot applies the schema to an empty volume and may start a tariff download.

## 5. Outbound hosts the application needs

Short on purpose. Everything the classification *relies* on comes from the
pinned snapshot on disk.

| Host | Why | Direction |
|---|---|---|
| `hts.usitc.gov` | The tariff sync | Download only — nothing about a product is sent |
| `www.census.gov` | Schedule B editions | Download only |
| The model endpoint | Every analysis | Sends the product description or part number |

The `web_fetch` allowlist in `classify.ts` adds `rulings.cbp.gov` and a handful
of other authorities. Those matter only while the web tools are in use — see
the next section.

## 6. Where to cut for a different model provider

Not done here, deliberately: the right shape depends on which endpoint you land
on. But the surface is small, and it is three places.

1. **`src/lib/config.ts`** — the `CLASSIFIER_MODELS` registry and the
   `anthropicApiKey` getter. The registry already encodes per-model request-shape
   facts, which is the hook a second provider wants.
2. **`src/lib/agent/classify.ts`** — one `new Anthropic({ apiKey })` call site.
3. **The `tools:` array in the same file** — `web_search_20250305` and
   `web_fetch_20250910` are server-side tools of the first-party API and are not
   available on Amazon Bedrock. Removing them removes part-number research and
   CROSS ruling citations; description mode is unaffected. Confirm current
   support before designing around either answer.

Two things make this cheaper than it looks. `beta.messages.toolRunner` exists in
the Bedrock SDK, so the agent loop does not need rewriting. And the output
schema has never fit the API's compiled-grammar limit, so every live run already
falls back to prompt-enforced shape plus Zod validation on return — an endpoint
with weaker structured-output support costs nothing that was being relied on.

**Check which models are authorized in your target boundary before choosing
one.** The authorized list has historically lagged new releases, and the system
prompt here is tuned against the largest model — `config.ts` says plainly that
the GRI discipline degrades on smaller ones. If the model changes, re-measure
with the eval harness rather than assuming.

## 7. Known-unfinished work

Carried here because it otherwise exists only in pull request discussion, which
does not survive the move.

**Needed before real data, in a controlled environment:**

- **Sign-in is attribution, not access control.** It is a name and an email with
  no password, by design — the point was to stamp an analyst on an artifact. No
  restricted environment will accept it. Needs real SSO.
- **The audit database wants to be Postgres**, for encryption at rest, retention
  and access logging. The schema avoids anything SQLite-specific for this reason;
  `src/lib/db.ts` is where the adapter is chosen.
- **`web_search` publishes its input.** Part-number mode searches the web for the
  part number. If part numbers are controlled technical data, that tool is an
  export, and no network configuration fixes it — the tool has to go or the mode
  has to.

**Known defects and limits, none blocking:**

- `.github/workflows/deploy.yml` splices the API key into shell source rather
  than passing it through `env:` and referencing `"$ANTHROPIC_API_KEY"`.
- `Analyst.@@index([email])` duplicates the index `@unique` already creates.
  Removing it is a `DROP INDEX`, which the additive-only boot gate correctly
  refuses, so it needs a deliberate migration.
- `/history` has no pagination past 50 rows.
- The analyze rate limit is 10 per 15 minutes per analyst, and a refinement round
  consumes one — below a 40-SKU week.
- An override does not require a written reason.
- The rate limiter sweeps O(n) per request past 1,000 windows, and is per-process,
  so a second instance doubles the effective limit.
- `src/lib/hts/store.ts` prepares statements per call. Negligible against a model
  round-trip; it would need invalidating on snapshot swap.

**Asked for by a reviewing customs broker, gating general rollout rather than a
pilot:** a staleness sweep over stored determinations, a product-level duplicate
check, and a recorded second-analyst review step.

**The accuracy baseline does not exist yet.** The eval harness measures match
depth, recall at rank, ECE and Brier, and refuses to present an all-`eo_nomine`
run as an accuracy figure — but the case set is built from the tariff's own
wording. Real ground truth has to come from CROSS or from the team's own
determinations; inventing it for a good that turns on essential character is
asserting a judgement as a fact. `eval/README.md` is the contract.
