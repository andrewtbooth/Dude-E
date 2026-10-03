# Standing up in GCC High

The ordered list of everything that has to be decided or reconfigured before
this application works in a restricted government cloud. Work through it top to
bottom: each section is what you hit first, in the order you hit it.

Every item was found by checking the code and the installed packages, not by
assumption — file references are given so the claim can be re-checked. Tick
items off in this file as they are resolved, so it stays the live record.

`docs/TRANSFER.md` explains *why* each of these exists. This file is the
working list.

---

## Decisions already made — do not reopen without the owner

- **Part numbers on their own are not ITAR-controlled.** Owner's determination,
  2026-10-03. `web_search` and `web_fetch` are therefore a capability question
  (§4), not an export-control one.
- **No prior analyses or determinations are carried over.** Owner's decision,
  2026-10-03. The new environment starts with an empty audit database; nothing
  on the old Fly volume is migrated.
- **This tool produces a durable classification for a product, not an entry
  decision for a shipment.** Why Chapters 98 and 99 are never the answer — see
  `docs/DECISIONS.md` #5 and #6.

## 0. Before the first Claude Code session

- [ ] **How will Claude Code itself reach a model from inside GCC High?**
  Anthropic models are not offered in GCC High (Microsoft's own documentation,
  as of 2026-10). The known FedRAMP High routes are Claude for Government, which
  includes Claude Code, and Claude Code pointed at Amazon Bedrock in AWS
  GovCloud. The plan to iterate with Claude Code depends on this — settle it
  first.
- [ ] **The setup hook will not run on a local CLI.**
  `.claude/hooks/session-start.sh` exits at once unless `CLAUDE_CODE_REMOTE=true`,
  which only Claude Code on the web sets. On a local install, either remove that
  guard — the hook is idempotent and will not clobber a real snapshot or a
  recorded cassette — or run the five commands in `CLAUDE.md` once by hand.
- [ ] **`CLAUDE.md`'s "This repository is public" section goes stale on arrival.**
  Rewrite it for a private internal host. Keep the `.gitignore` protections
  regardless.

## 1. Before `npm ci`

- [ ] **Package registry.** All 749 packages resolve from `registry.npmjs.org`
  (`package-lock.json`). Needs direct access or an internal mirror (Azure
  Artifacts, Artifactory, Nexus) configured in `.npmrc`.
- [ ] **Prisma downloads a native binary during install.** The `@prisma/engines`
  postinstall fetches `schema-engine` from `binaries.prisma.sh`, and `db push`
  cannot run without it. Mirror it with `PRISMA_ENGINES_MIRROR`, or provision
  the binary and set `PRISMA_SCHEMA_ENGINE_BINARY`. It is OS- and
  OpenSSL-specific — this container uses `debian-openssl-3.0.x`; RHEL and
  Windows need other targets.
- [ ] **TLS inspection.** If outbound HTTPS passes through an inspecting proxy,
  Node needs the organisation's root CA via `NODE_EXTRA_CA_CERTS`, or every call
  — npm, Prisma, USITC, the model endpoint — fails certificate validation.
- [ ] **Node 22** on every machine that builds or runs it. `.nvmrc` pins it;
  `engines` in `package.json` is advisory only.
- [x] **No compiler needed for SQLite.** `better-sqlite3` 13.0.2 ships prebuilt
  binaries for Windows, Linux (glibc and musl) and macOS, x64 and arm64.
  Verified in `node_modules/better-sqlite3/prebuilds/`.

## 2. Before `docker build`

- [ ] **Base image.** `Dockerfile:12` is `FROM node:22-bookworm-slim`, from
  Docker Hub. Restricted environments usually require an approved registry
  (ACR in Azure Government) or hardened images. Whatever replaces it needs
  Node 22 and a libc the prebuilds above support.
- [ ] **OS packages.** `Dockerfile:26-28` runs `apt-get install python3 make g++
  ca-certificates` against Debian's mirrors. With the prebuilds, `python3`,
  `make` and `g++` are a fallback rather than a need; `ca-certificates` may need
  the organisation's root CA added.
- [x] **Telemetry is off.** Next.js (`telemetry.nextjs.org`) and Prisma
  (`checkpoint.prisma.io`) both phone home by default, which a monitored
  boundary records as unapproved egress. `NEXT_TELEMETRY_DISABLED=1` and
  `CHECKPOINT_DISABLE=1` are set in the image, `.env.example` and the setup hook.
- [x] **Cryptography is FIPS-compatible.** The application uses only SHA-256
  (`renderDetermination.tsx:57`, the PDF hash) and HS256 (`session.ts:21`, the
  session token), both FIPS-approved. No MD5 or SHA-1 anywhere in `src/` or
  `scripts/`.

## 3. Before the first tariff sync

- [ ] **Egress to `hts.usitc.gov` and `www.census.gov`**, or mirror them and set
  `USITC_BASE_URL` and `CENSUS_SCHEDULE_B_BASE`. Download only; nothing about a
  product is sent.
- [ ] **A full snapshot, not the fixture.** `npm run dev:seed` builds a
  four-chapter fixture that is enough for the test suite and nothing else.
  `npm run eval:check` refuses to run against it, by design.
- [ ] **Schedule the weekly re-sync.** It was a GitHub Actions cron
  (`.github/workflows/sync-tariff.yml`, Sundays 06:00 UTC) and does not come
  with you. HTSUS revisions ship every few weeks and a snapshot ages silently.
- [ ] **Update the sync's User-Agent.** `scripts/sync-htsus.ts:93` names the
  public GitHub repository, and is sent to USITC with every request.

## 4. Before the first model call

- [ ] **Which endpoint?** Amazon Bedrock in AWS GovCloud (FedRAMP High, DoD
  IL4/5) or Vertex AI with Assured Workloads. Either way the call leaves the
  GCC High boundary, which is an authorization question before it is an
  engineering one.
- [ ] **Wire the egress proxy into the server.** `HTTPS_PROXY` is honoured by
  `scripts/sync-htsus.ts:75` and by nothing under `src/`. Behind a mandatory
  proxy the sync works and every model call fails with an error that names no
  proxy. Hoist that `ProxyAgent` into a module the server loads at startup.
  Do this before concluding the endpoint is misconfigured.
- [ ] **Construct the right client.** `src/lib/agent/classify.ts` has one
  `new Anthropic({ apiKey })`. Bedrock wants `AnthropicBedrock` from
  `@anthropic-ai/bedrock-sdk`, with IAM credentials and a GovCloud region rather
  than a key — and `config.anthropicApiKey` (`config.ts`) is `required()` and
  throws, so relax it. For a gateway in front of the first-party API,
  `ANTHROPIC_BASE_URL` alone may be enough; see `.env.example`.
- [ ] **Register the authorized model IDs.** `parseModel` in `config.ts` accepts
  only the keys of `CLASSIFIER_MODELS`, so a Bedrock model ID throws at startup.
  Add a row per authorized model, with its request-shape facts — adaptive
  thinking or a thinking budget, and whether it takes an effort level.
- [ ] **Which model is authorized?** Last checked (2026-10): Sonnet 5 in GovCloud,
  Opus 5 not. The prompt was tuned against Opus 5 and `config.ts` notes that the
  GRI discipline degrades on smaller models. Re-check before choosing.
- [ ] **Re-baseline accuracy after the model changes.** On a full snapshot:
  `npm run eval:check`, then `npm run eval`. The seed set measures mechanics;
  real cases come from CROSS or the team's own determinations
  (`eval/README.md`).
- [ ] **Decide what part-number mode does without web tools.** The server-side
  `web_search` and `web_fetch` tools are not available on Bedrock (`web_fetch`
  not on Vertex either). Removing them loses part-number research and CROSS
  ruling citations; description mode is unaffected. Options: drop
  part-number research, or provide search another way inside the boundary.
  If the tools stay, their hosts need egress too — `classify.ts` allowlists
  eight `.gov` sites for `web_fetch`.

## 5. Before the first deploy

- [ ] **Where does the volume physically live?** Answer this before choosing a
  host. SQLite is not safe on a network filesystem: the tariff index runs in WAL
  mode (`store.ts:37`), which SQLite documents as not working over a network
  filesystem at all, and the audit database's file locking is unreliable on one.
  Azure Files — what App Service mounts as persistent storage — is a network
  filesystem. If the only durable storage on offer is network-backed, that alone
  decides the database question in §6.
- [ ] **Exactly one instance.** Two instances on separate disks keep two
  audit databases that cannot see each other, so the one-determination-per-
  analysis guard stops working across them; two on a shared network disk hit the
  locking problem above. The run registry and the rate limiter are per-process
  too. Turn off scale-out.
- [ ] **Front-end timeouts on a 13-minute stream.** An analysis streams for up
  to 13 minutes and the stream has no heartbeat — it writes only when the model
  emits an event (`src/app/api/analyze/route.ts`). App Service, Front Door,
  Application Gateway and load balancers all impose response or idle timeouts.
  A cut stream loses no work — the run finishes into the database and the saved
  page watches for it — but every long run would show "connection dropped".
  If the front end's timeouts are short, add an SSE comment heartbeat.
- [ ] **No idle suspension; at least 2 vCPU and 2 GB; health check on
  `/api/health` with about 90 seconds of grace.** What `fly.toml` encoded; see
  `docs/TRANSFER.md` §4.
- [ ] **Re-supply the image's environment if the platform replaces it.** The
  image sets `HTSUS_DATA_DIR`, `DATABASE_URL`, `PORT` and `HOSTNAME=0.0.0.0`
  (`Dockerfile:68-71`). `docker-entrypoint.sh` now refuses to boot without the
  first two rather than writing either to ephemeral storage.
- [ ] **Secrets.** `ANTHROPIC_API_KEY` (or the IAM equivalent) and
  `SESSION_SECRET` both throw if absent. `SESSION_SECRET` was generated by
  `.github/workflows/deploy.yml:195`, which does not come with you — generate one
  with `openssl rand -base64 48` into the platform's secret store.
- [ ] **Make `/api/health` check the secrets.** It touches neither, so a
  deployment missing both reports healthy and fails at the first sign-in.
- [ ] **Client IP for the rate limiter.** `src/lib/rateLimit.ts:82` reads Fly's
  `fly-client-ip` header. Replace it with the new front end's header or drop it,
  and confirm `X-Forwarded-For` carries the real client address.

## 6. Before analysts use it

- [ ] **Authentication.** Sign-in is a name and an email with no password —
  attribution, not access control. Expect Entra ID SSO to be required. It
  changes in `src/lib/auth/session.ts` and `src/app/actions/session.ts`; the
  analyst stamped on each determination should then come from the identity
  provider.
- [ ] **SQLite or Postgres for the audit database?** Decided by the storage
  answer in §5, by instance count, and by the environment's rules on encryption
  at rest, backup and access logging. The schema avoids SQLite-specific
  constructs; the adapter is chosen in `src/lib/db.ts`.
- [ ] **Backups.** The procedure in `docs/DEPLOY.md` is Fly-specific.
- [ ] **Rate limit.** 10 analyses per 15 minutes per analyst, and a refinement
  round consumes one (`ANALYZE_RATE_LIMIT`, `ANALYZE_RATE_WINDOW_MINUTES`).
- [ ] **Overrides.** Recording a code other than the model's pick does not
  require a written reason. A policy question.

## 7. Repository and pipeline

- [ ] **Git host.** Azure DevOps or GitHub Enterprise Server. Pull request
  descriptions do not travel; `docs/DECISIONS.md` does — keep adding to it.
- [ ] **Delete `.github/workflows/` and `src/lib/deploy/workflow.test.ts` in the
  same change.** The test reads `deploy.yml` and `ops.yml` and turns the suite
  red the moment they are gone.
- [ ] **Wire the gate into CI.** Nothing runs it automatically today. The
  commands are in `CLAUDE.md`; the browser suites need the Chromium decision in
  §1.
- [ ] **Playwright's browser.** `npx playwright install chromium` downloads from
  Playwright's CDN. Put a Chromium or Chrome on the build agents and set
  `PLAYWRIGHT_CHROMIUM_PATH` (`scripts/dev/chromium.mjs`).
- [ ] **Rewrite the Fly documentation and delete `fly.toml`.** `docs/SETUP.md`
  carries 27 Fly references and `docs/DEPLOY.md` 11.

## 8. Decommission the old environment

- [ ] **Take down `dude-e.fly.dev`.** It is live, publicly reachable, signs in
  anyone who types a name, and holds a working API key — so anyone who finds it
  can spend the budget. With nothing being carried over, it can simply go:
  `fly apps destroy dude-e`, which removes the volume with it.
- [ ] **Revoke the API key it held**, and delete the `FLY_API_TOKEN` and
  `ANTHROPIC_API_KEY` secrets from the GitHub repository.
- [ ] **Archive the GitHub repository or make it private** once the new home is
  live.

## 9. Optional, once things are stable

- [ ] **Code that only serves rows from older builds is now dormant.** With an
  empty audit database, the backfills in `backfillRunFields` and
  `reconstructReportingNumberNotes`, the `never_hashed` and
  `rerendered_under_new_document` branches of `driftVerdict.ts`, and
  `scripts/deploy/check-determination-uniqueness.ts` with
  `list-duplicate-determinations.ts` have nothing to act on. Harmless; candidates
  for removal. `backfillRunFields` still serves replay cassettes recorded under
  older schemas.
