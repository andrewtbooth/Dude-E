# Moving this application to another environment

Written for a move into a government or otherwise restricted cloud, where the
deployment platform, the git host and the model endpoint all change at once.

The application code is portable. What is not portable is everything *around*
it, and this file is the inventory: what travels with a clone, what has to be
replaced, and what is still unfinished so it does not get lost in the move.

**For the ordered list of what to do on arrival, read `docs/GCC-HIGH.md`.** This
file explains why each item on that list exists; that one is the checklist.

**Before you start**, these companion pieces are worth knowing about. Each was
written for this move, and the steps below assume all of them are present:

| | What it does for the move |
|---|---|
| `docs/GCC-HIGH.md` | The working checklist: every question to settle and setting to change, in the order you hit them |
| `docs/DECISIONS.md` | The reasoning from every pull request, extracted before the descriptions became unreachable |
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
every pull request before they became unreachable. Add to it rather than
relying on a PR description again.

Also does not travel: GitHub Actions run history, GitHub secrets, and anything
on the Fly volume.

## 2. What is carried, and what is deliberately left behind

**Nothing from prior analyses is carried over.** Owner's decision, 2026-10-03.
The audit database on the old deployment volume — every analysis and
determination recorded there — stays behind, and the new environment starts
with an empty one. `npm run db:push` creates it, and the entrypoint does the
same on first boot.

That makes this a clean start rather than a migration: no row counts to
reconcile, no older-build rows to backfill, and no duplicate-determination
history for the boot gate to object to. It also means the old deployment can be
taken down outright rather than drained — see `docs/GCC-HIGH.md` §8.

From here on the audit database is the one artifact in the new environment that
cannot be regenerated. Back it up from the first determination recorded there.

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

An earlier draft of this section claimed application code was clean, that the
only mentions of the current host under `src/` were two explanatory comments,
and that the app was configured entirely through three environment variables.
A review falsified all three. The corrected position:

**Application code is *nearly* clean, with one real exception.**
`src/lib/rateLimit.ts:82` reads the Fly-specific `fly-client-ip` header in
`clientKey()`, and `src/lib/rateLimit.test.ts:56` asserts it. That is live
behaviour on the request path, not prose. It fails soft — the
`x-forwarded-for` branch above it wins behind any ordinary load balancer — but
where neither header is present every caller collapses into one `"unknown"`
bucket, so the rate limiter stops distinguishing clients. Rename it for the new
host or drop it; it is a two-file change.

The genuinely comment-only mentions are `runRegistry.ts:25`,
`history/page.tsx:156` and `fonts/README.md:21`. (The earlier draft also cited
`check-snapshot-derivation.ts`, which is under `scripts/deploy/`, not `src/`.)

**The app reads eleven environment variables, not three.** `src/lib/config.ts`
reads `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `SESSION_TTL_HOURS`,
`ANALYZE_RATE_LIMIT`, `ANALYZE_RATE_WINDOW_MINUTES`, `CLASSIFIER_MODEL`,
`CLASSIFIER_EFFORT`, `CLASSIFIER_REPLAY`, `CLASSIFIER_REPLAY_DELAY_MS`,
`HTSUS_DATA_DIR` and `USITC_BASE_URL`; `DATABASE_URL` and `NODE_ENV` are read
elsewhere. The first two **throw** if absent. All of them are documented in
`.env.example`. What is true is the narrower statement: nothing about the
*platform* is compiled in — the paths, the port and the volume are all env.

| File | What it assumes | What to do |
|---|---|---|
| `Dockerfile` | Node 22; builds `better-sqlite3` from source, so it needs `python3`, `make`, `g++` | **Portable as-is.** Nothing host-specific in it |
| `docker-entrypoint.sh` | A writable volume, and the three env vars above | Portable. It also runs the boot gates — duplicate-determination check, additive-DDL check, derivation check — which are worth keeping whatever runs the container |
| `fly.toml` | Fly.io specifically | Delete it, but carry its *requirements* forward — see below |
| `.github/workflows/deploy.yml` | GitHub Actions, `flyctl`, GitHub secrets | Replace. Worth preserving: the deploy is gated on the full check suite, and secrets follow "set what is missing, leave alone what is there" |
| `.github/workflows/sync-tariff.yml` | A weekly cron (Sundays 06:00 UTC) | **Replace with something.** Not optional — HTSUS revisions ship every few weeks and a snapshot ages silently. During development USITC published Revision 15 days after Revision 14 |
| `.github/workflows/ops.yml` | Actions UI as a phone-friendly ops console | Replace or drop, depending on whether that need survives |
| `src/lib/deploy/workflow.test.ts` | Reads **two** of the workflow files — `deploy.yml` and `ops.yml`; `sync-tariff.yml` is never read | **This test will fail** the moment those two are replaced. Rewrite it against the new pipeline or delete it with them — do not leave it asserting about files that no longer exist |
| `src/lib/deploy/entrypoint.test.ts` | Same shape: reads `docker-entrypoint.sh` from `process.cwd()`, and shells out to `npx prisma --help` | Survives as long as the entrypoint does. If the boot gates move to an init container or a platform startup command, this breaks too — and it is the only automated check that the boot sequence's Prisma flags are still valid |
| `src/lib/rateLimit.ts` | Reads the `fly-client-ip` header as a fallback client identity | Rename to the new host's header, or drop it and rely on `x-forwarded-for`. Two files, counting its test |
| `docs/SETUP.md` | 27 Fly-specific references — it is a first-deploy walkthrough for a non-developer | Rewrite for the new platform, or it will walk someone through a console that does not exist |
| `docs/DEPLOY.md` | 11 Fly-specific references, including `fly volumes create --region iad` and the backup procedure | Rewrite. Its closing section already sketches generic container hosts, so it is salvageable rather than a rewrite from nothing |

### What `fly.toml` encodes that any host must satisfy

These are properties of the application, not preferences, and they are the real
output of that file:

- **Persistent disk**, mounted where `HTSUS_DATA_DIR` and `DATABASE_URL` point.
  Both pieces of durable state are files.
- **No request-duration cap.** A max-effort analysis holds an SSE connection for
  up to thirteen minutes. Platforms that cap this require reworking the app
  rather than configuring it.
- **No idle suspension.** A machine that stops mid-analysis loses the run.
- **Exactly one instance.** Not merely "do not scale to zero" — do not scale
  *up* either. Two instances on separate disks keep two audit databases that
  cannot see each other, so the one-determination-per-analysis guard stops
  holding across them; two on a shared network disk run into SQLite's file
  locking, which is not reliable over a network filesystem. The run registry
  (`runRegistry.ts`) and the rate limiter are per-process as well. Moving the
  audit database to Postgres is what lifts this — see §7.
- **Local disk, not a network filesystem.** Two SQLite files live on the volume.
  The tariff index runs in WAL mode (`store.ts:37`), which SQLite documents as
  not working over a network filesystem at all; the audit database runs in
  rollback-journal mode and depends on file locks that network filesystems do
  not reliably honour. (An earlier draft of this section said the audit database
  was the WAL one. It is the tariff index.) Persistent storage offered as a
  network share — Azure Files, which App Service mounts, is one — does not
  qualify.
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

### If egress goes through a proxy, read this before deploying

**`HTTPS_PROXY` is honoured by exactly one process, and it is not the server.**
`scripts/sync-htsus.ts:75` installs an undici `ProxyAgent` via
`setGlobalDispatcher`. Nothing under `src/` does — `grep setGlobalDispatcher src/`
returns nothing.

Undici does not read proxy environment variables on its own, which is why the
sync has to install one explicitly. So in a boundary with mandatory egress
proxying, the shape of the failure is: **`npm run sync:htsus` works, and every
model call fails** with a connection error that names no proxy and suggests no
cause. The server-side `web_search` and `web_fetch` tools fail the same way.

The fix is to hoist that dispatcher install into a module the server imports
once at startup rather than leaving it in a script. It is deliberately not done
here, because it cannot be verified from an environment without a mandatory
proxy — but it is the first thing to do on arrival, and it should be done before
anyone concludes the model endpoint itself is misconfigured.

## 6. Where to cut for a different model provider

Not done here, deliberately: the right shape depends on which endpoint you land
on. But the surface is small, and it is three places.

1. **`src/lib/config.ts`** — the `CLASSIFIER_MODELS` registry and the
   `anthropicApiKey` getter. The registry already encodes per-model request-shape
   facts, which is the hook a second provider wants. Note that
   `anthropicApiKey` is `required()` and throws, so an endpoint authenticating
   by IAM role or managed identity cannot boot until that is relaxed.
2. **`src/lib/agent/classify.ts`** — one `new Anthropic({ apiKey })` call site,
   with no `baseURL`. It may not need one: the SDK defaults `baseURL` from
   `ANTHROPIC_BASE_URL`, so a gateway or regional front door is reachable by
   environment alone. That variable appeared nowhere in this repository until
   it was added to `.env.example` for this move — worth knowing before anyone
   plans a code change to do what an env var already does.
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
- **The audit database may need to be Postgres.** Three things decide it: whether
  the only persistent storage on offer is a network filesystem (§4), whether
  more than one instance is wanted, and the environment's own rules on
  encryption at rest, backup and access logging. The schema avoids anything
  SQLite-specific; `src/lib/db.ts` is where the adapter is chosen.

**Decided, recorded so it is not reopened:** part numbers on their own are not
ITAR-controlled (owner's determination, 2026-10-03). Earlier drafts listed
`web_search` here as a possible export, because part-number mode searches the
web for the part number. With that settled, the web tools are a capability
question only — and on Bedrock they are unavailable regardless; see §6 and
`docs/GCC-HIGH.md` §4.

**Two things that stop working the moment the pipeline is replaced:**

- **Nothing runs the gate automatically.** All three workflows are
  `workflow_dispatch` (plus the Sunday cron), and the checks live *inside*
  `deploy.yml`. There is no `push` or `pull_request` trigger, so until someone
  wires CI in the new environment the gate is whatever a person remembers to
  run. The gate itself is written down in `CLAUDE.md`.
- **`SESSION_SECRET` is generated by the thing being deleted.**
  `.github/workflows/deploy.yml:195` mints it with `openssl rand -base64 48` on
  first deploy and leaves it alone after. §3 says rotate it on arrival; what it
  did not say is that nothing else in the repository generates it. Worse,
  nothing *checks* it: `/api/health` never touches `anthropicApiKey` or
  `sessionSecret` — both are lazy getters — so a deployment missing both passes
  its health check, reports green, and fails at the first analyst sign-in. On
  Fly that was masked because `deploy.yml` refused to deploy without them.

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
