# Putting the app online

No terminal, no Docker, no commands. Four steps, and all of them work in a
phone browser — though a tablet or laptop is more comfortable for the copying
and pasting in step 3.

Budget about 20 minutes, most of it waiting.

---

## What you are setting up

The app needs somewhere to live and two keys to work:

- **Fly.io** runs it. Think of it as renting a small always-on computer.
- **An Anthropic API key** lets it do the actual classification analysis.

You paste both into GitHub, then tap a button. GitHub does the rest — it
builds the app, sets it up on Fly, downloads the current tariff, and checks
that it works.

You will need a **payment method on both accounts**. Fly is a few dollars a
month for a machine that stays running. Anthropic is charged per analysis —
see [Cost](#cost) below, and set a spending cap.

---

## Step 1 — Create the app on Fly and get a token

1. Go to **fly.io** and sign up. Add a payment method when asked.

2. **Create the app.** In the dashboard, create a new app named exactly
   **`dude-e`**. Fly app names are unique across all its customers, so if that
   is taken, pick something like `dude-e-yourinitials` and remember it — you
   will type it into the workflow later.

3. **Add the storage.** Open the app, find **Volumes**, and create one:
   - name: `dude_e_data`
   - size: 3 GB
   - region: the same region as the app

   This holds the tariff data and your records. Without it, both are wiped
   every time the app updates.

4. **Create the token.** Go to **fly.io/user/personal_access_tokens**, tap
   **Create token**, and pick the app you just made. Name it `github-deploy`.

   **Copy it immediately** — it is shown once and never again. It starts with
   `Fly`.

> **If Fly refuses to create a token** and mentions single sign-on, your email
> belongs to a company Fly organisation that blocks personal tokens. Either
> create an app-scoped token as above, or sign up again with a personal email
> address — a fresh account has no such restriction, and keeping a public trial
> separate from a corporate account is sensible anyway.

---

## Step 2 — Get an Anthropic API key

1. Go to **console.anthropic.com** and sign in.
2. Add a payment method, then go to **Settings → Limits** and set a monthly
   spending cap. Pick a number you would not mind losing — this is your
   safety net, and it is worth doing before the key exists rather than after.
3. Go to **API keys** and create one. It starts with `sk-ant-`.
4. **Copy it now** — like the Fly token, it is shown once.

---

## Step 3 — Put both keys into GitHub

1. Open the repository on GitHub.
2. Tap **Settings** (on a phone this may be behind a **⋯** menu).
3. In the sidebar: **Secrets and variables → Actions**.
4. Tap **New repository secret**, twice:

| Name (type exactly) | Value |
|---|---|
| `FLY_API_TOKEN` | the token from step 1 |
| `ANTHROPIC_API_KEY` | the key from step 2 |

The names must match exactly, including capitals and underscores. GitHub hides
the values once saved — that is expected, and it is why you copied them
somewhere first.

> If **Settings** is not visible, you do not have admin rights on the
> repository. Whoever owns it can add the two secrets for you; they never need
> to touch anything else.

---

## Step 4 — Run it

1. Go to the **Actions** tab.
2. Choose **Deploy** in the left sidebar.
3. Tap **Run workflow**. Leave *Download the current tariff* ticked — the
   first run needs it.
4. If you named the Fly app anything other than `dude-e`, type that name into
   the **Fly app name** box.
5. Tap the green **Run workflow** button.

Now wait. It takes **10 to 15 minutes** the first time. You can close the page;
it keeps running.

The app downloads the tariff itself when it first starts, so nothing else is
needed. For a minute or two after deploying, the site will load but say it has
no tariff data — that is the download in progress, and it clears on its own.

Tap into the run to watch. When it finishes, the summary shows your web
address, something like `https://dude-e.fly.dev`.

Open it, enter your name and work email, and you are in.

---

## Using it

Once it is live, everything works in a phone browser — including running an
analysis and opening the exported PDF.

Good first things to try, because they exercise the parts worth judging:

| Type this | What to watch for |
|---|---|
| `stainless steel vacuum-insulated water bottle, 750ml` | It should reason from the *tariff's notes*, not from "it's made of steel". Two chapters compete and the notes decide it. |
| `household free-standing steel shelving unit` | Should raise a Section 232 duty warning, conditional on country of origin. |
| `plastic housing` | Deliberately vague. It should ask you questions rather than guess, and refuse to let you export until answered. |

Then pick a code and tap **Export PDF**. Check the top of the document names
you, the date, and the tariff edition — that provenance is the point of the
whole tool.

---

## Keeping it running

**The tariff updates itself.** A second workflow re-downloads it every Sunday
morning. Nothing for you to remember.

**To update the app** after a code change, run the **Deploy** workflow again.
You can untick *Download the current tariff* to make it faster, since the
tariff is already there.

**To check it is healthy**, visit `/api/health` on your address. It reports
the tariff edition in use and how old it is.

---

## Looking at the running app

Most Fly diagnostics are done with `flyctl`, a program you type commands into
on a computer. If you are working from a phone there is no terminal to put it
in — so the **Ops** workflow does it for you. A GitHub Actions runner is a
temporary Linux machine, it installs `flyctl` the same way the deploy does, and
the result comes back as a readable page rather than a wall of log text.

Actions → **Ops** → *Run workflow* → pick one:

| Action | Answers |
|---|---|
| `status` | Is the app up? Which release is live? |
| `health` | Which tariff edition is being stamped on determinations, how old it is, which build is serving |
| `logs` | The last few hundred lines — the first place to look when a machine boots and dies |
| `check-duplicates` | Whether two determinations exist for one analysis, which blocks a deploy at the uniqueness pre-check |
| `disk` | How full the volume is. The tariff snapshot and the audit database both live there |
| `restart` | Bounce the machine. Type the app name in the confirm box or nothing happens |

Everything except `restart` is read-only — running them cannot change anything.
Each run explains what the output means, so you do not have to know the tools
to read the answer.

Fly's own dashboard covers some of this too: **Monitoring** for live logs,
**Machines** for status, **Secrets** for keys. Use whichever is easier on the
screen you have. The workflow exists for the things the dashboard cannot do,
which is anything that needs to run a command *inside* the machine.

---

## Cost

Two separate bills:

- **Fly** — a few dollars a month for the always-on machine and storage.
- **Anthropic** — roughly **$3–6 per analysis** at the default depth setting,
  because each one is a genuinely thorough piece of research. Ten people
  trying it a few times each is tens of dollars, not hundreds. The spending
  cap from step 2 is what stops a surprise.

The app also limits itself to 10 analyses per person per 15 minutes.

### Spending less while you are still testing

Most of that per-analysis cost is reasoning depth, and depth is one setting.
In the Fly dashboard, under **Secrets**, add:

| Name | Value |
|---|---|
| `CLASSIFIER_EFFORT` | `low`, `medium`, `high`, `xhigh` or `max` |

Saving it restarts the app; no redeploy, no code change. Delete it to go back
to the default (`max`). An invalid value fails loudly at startup rather than
silently picking something for you.

Which to use depends on what you are testing:

| You are checking | Use | Why |
|---|---|---|
| Does the app work at all — sign-in, progress log, PDF export | `low` | Cheapest, fastest, exercises the same plumbing |
| Whether a classification is any good | `high` or `max` | Depth is the thing being judged; anything less measures the setting, not the tool |

> **One trap worth knowing.** Lower effort also means *fewer tool calls*. A
> `low` run on a plain product description may never reach web search at all —
> so it can pass while leaving a chunk of the pipeline untouched, and look like
> proof of something it did not test. If you are specifically checking the
> research path, use a **part number** (which forces the research step) rather
> than turning the depth down and hoping.

Actual token usage is recorded per analysis in the database, so real spend can
be measured rather than estimated once you have a few runs behind you.

---

## If something goes wrong

**The workflow shows a red X.** Tap into it and read the step that failed. The
common ones:

| Message mentions | Meaning |
|---|---|
| `ANTHROPIC_API_KEY is not set` | Step 3 was missed, or the name has a typo. |
| `Error: Not authorized` | The Fly token is wrong or expired. Make a new one and update the secret. |
| `did not answer its health check` | It deployed but did not start. Re-run the workflow; if it repeats, send me the log. |
| `Cannot read properties of null (reading 'useContext')` | An old copy of the `Dockerfile` that builds with `NODE_ENV=development`. Take the current one from the repository. |

**You deployed from Fly's own web interface instead of the workflow.** Fly
generates its own `fly.toml` with `internal_port = 8080`, but this app listens
on **3000**. Change that line to `internal_port = 3000` or every health check
fails even though the build succeeded. The `fly.toml` in this repository
already has the right value — the workflow uses it.

**The site loads but says "No HTSUS data".** For the first couple of minutes
after a deploy this is normal — the app is downloading the tariff and will
clear it on its own. If it persists past five minutes, the download failed;
re-run the **Deploy** workflow.

**An analysis seems stuck.** They genuinely take several minutes — the
progress log should keep moving. If it stops dead for more than five minutes,
that is a real fault worth reporting.

---

## What this deployment is not

It has **no password and no access control**. Anyone with the address can use
it and can see every analysis anyone has run. That is a deliberate trade for a
capability trial on test data, and it is fine for that.

**Do not put real customer part numbers or unreleased product details into
it** until it has moved into a controlled environment. That change is
configuration, not code, when you get there.
