# Deploying the trial

Standalone deployment for trialling functionality. Written for Fly.io, with
notes for Render and Railway at the end.

> **This configuration has no access control.** Sign-in records who made a
> determination; it gates nothing. Anyone who reaches the URL can run analyses
> against your Anthropic budget and read every part number in
> `/history?scope=all`. That is a deliberate choice for a trial and it is the
> right thing to revisit before real product data goes through it — see
> [Exposure](#exposure).

---

## Why not serverless

Three properties of the app decide the hosting shape, and none is a preference:

| | |
|---|---|
| **Long requests** | One analysis holds an SSE connection for up to 13 minutes (`maxDuration = 800`). Most function platforms cap well below that. |
| **Durable local files** | The tariff snapshot and the SQLite audit database are files. Ephemeral or read-only filesystems lose both on every deploy. |
| **A native addon** | `better-sqlite3` compiles against the target platform; it cannot be copied from a laptop. |

So: a container with a persistent volume. Vercel, Netlify and bare Lambda need
the app reworked, not configured.

---

## First deploy

### 1. Create the app and its volume

```bash
fly launch --no-deploy          # accept the existing fly.toml; rename the app
fly volumes create dude_e_data --size 3 --region iad
```

The volume holds `/data/htsus` (the snapshot, ~60 MB) and `/data/dude-e.db`
(the audit log). Without it, every deploy wipes both.

### 2. Set secrets

```bash
fly secrets set \
  ANTHROPIC_API_KEY="sk-ant-..." \
  SESSION_SECRET="$(openssl rand -base64 48)"
```

`SESSION_SECRET` signs the session cookie. Generate it — do not reuse the
development value, and do not let it be short: a weak secret means a forgeable
cookie and therefore a forgeable analyst name on a determination.

### 3. Deploy

```bash
fly deploy
```

The entrypoint applies the Prisma schema on every boot, which is idempotent, so
a fresh volume comes up working.

### 4. Seed the tariff snapshot

The app starts but **refuses to classify until a snapshot exists** — by design,
since a code that cannot be verified against a published edition is worse than
no answer. The sync is not run at boot because it takes about ninety seconds
and would make every restart a cold start.

```bash
fly ssh console -C "npm run sync:htsus"
```

Expect roughly: 35,800 tariff lines, 121 note documents, 1,217 Chapter 99
coverage subheadings, 9,779 Schedule B export codes. Confirm with:

```bash
curl https://<your-app>.fly.dev/api/health
```

`status: "ok"` with a revision and a `retrievedAt` means it is ready.

---

## Keeping it current

HTSUS revisions ship every few weeks and Section 301/232 actions move faster
still. A stale snapshot classifies silently against a superseded edition.

Schedule a weekly machine to re-run the sync:

```bash
fly machine run . --schedule weekly \
  --volume dude_e_data:/data \
  --entrypoint "" \
  -- npm run sync:htsus
```

`/api/health` reports `degraded` once the snapshot passes 21 days, so point
your uptime check at it and alert on the status field rather than only on HTTP
200 — the endpoint deliberately returns 200 when degraded, because restarting
the app cannot produce a snapshot and a failing check would just cause a
restart loop.

---

## Backups

`/data/dude-e.db` is the audit trail. Customs recordkeeping runs five years,
and Fly volumes are single-host storage, not a backup.

```bash
fly ssh console -C "sqlite3 /data/dude-e.db .dump" > backup-$(date +%F).sql
```

Run it on a schedule and keep the output somewhere else. Fly's automatic
volume snapshots are a useful second line but are retained for days, not years.

---

## Exposure

With a public URL and no gate, the controls that exist are:

- **Rate limiting** on `/api/analyze` — 10 analyses per client per 15 minutes,
  tunable via `ANALYZE_RATE_LIMIT` and `ANALYZE_RATE_WINDOW_MINUTES`. This is a
  budget guard, not access control: it is per-process and in-memory, so it
  resets on deploy and does not coordinate across instances. Run one instance.
- **A hard cap on Anthropic spend**, which you should set in the Anthropic
  console rather than relying on the above. One analysis at `max` effort costs
  meaningful money; a scripted caller finding the endpoint is the scenario to
  bound.

What is *not* protected: the URL itself, the history view listing every
analysed part number and description, and the ability to export any
determination PDF by id. If the goods being classified are covered by supplier
NDAs, put the app behind Cloudflare Access, Tailscale, or your VPN before the
trial widens. That is a platform change and needs no code.

Lowering `CLASSIFIER_EFFORT` to `high` reduces both cost and exposure per
request — measure the accuracy cost first with `npm run eval -- --effort high`.

---

## Other platforms

The `Dockerfile` is portable; only the plumbing differs.

**Render** — Web Service from the Dockerfile, attach a Persistent Disk at
`/data`, set the same env vars. Check the plan's request timeout: it must
exceed 800 seconds or long analyses are severed mid-stream.

**Railway** — deploy from the Dockerfile, attach a Volume at `/data`, set the
same env vars. Confirm there is no proxy-level request cap below 800 seconds.

On any platform sitting behind your own nginx, two settings are mandatory or
SSE breaks in a way that looks like the app hanging:

```nginx
proxy_read_timeout 900s;
proxy_buffering off;
```

Caddy handles `text/event-stream` correctly without configuration.

---

## What was verified, and what was not

Verified here: the production build serves, `/api/health` returns live snapshot
data, the degraded path returns 200 with `status: "degraded"`, the entrypoint
is valid shell, the full test suite passes, and nothing shipped at runtime
imports a dev-only package.

**Not verified: the container image build.** The environment this was written
in has the Docker CLI but no daemon, so `docker build` could not be run. Build
it once locally before the first deploy —

```bash
docker build -t dude-e:trial .
docker run --rm -p 3000:3000 -v dude-e-data:/data \
  -e ANTHROPIC_API_KEY=... -e SESSION_SECRET=... dude-e:trial
```

— and expect the native `better-sqlite3` compile to be the step that fails if
anything does.
