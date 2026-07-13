# job-search-agent

Replaces the n8n job-watch workflow. Every weekday at 11:00 UTC it polls the
public Greenhouse/Lever job boards of ~150 target companies, filters titles
for senior growth/marketing roles, scores new postings against Avi's profile
with Claude, records everything in Supabase, and posts score ≥ 7 matches to
Discord.

## How a run works

1. **Poll** every company in `companies.json` (5 at a time, 15s timeout).
   Dead slugs / 404s / network errors are logged and skipped.
2. **Filter** titles against the role regex (Head/VP/Director of Marketing,
   Head of Growth, Senior Marketing Manager, Demand Gen, etc.).
3. **Normalize** descriptions: decode entities (Greenhouse), strip HTML,
   prepend location, cap at 2,500 chars.
4. **Dedup** against the `job_leads` table by URL — already-seen postings
   are skipped before any scoring spend.
5. **Score** each new posting with `claude-sonnet-4-6` (1–10 + verdict +
   angle + watch point + salary fit). Unparseable responses fall back to
   score 5 / "Review manually" — nothing is dropped.
6. **Insert** every scored job into `job_leads` (status `new` for score ≥ 7,
   else `skipped`); duplicate-URL races are ignored.
7. **Alert**: score ≥ 7 goes to Discord as an embed (green for 8+, yellow
   for 7) with verdict, angle, watch point, and apply link.
8. **Summary** line: `Summary: companies=N matched=N new=N posted=N`.

## Cover letters (opt-in)

Given your résumé, the agent can generate a **tailored cover letter for every
strong match** and provide it to you. Enable with `--cover-letters` or
`COVER_LETTERS=1`. For each new match scoring ≥ `APPLY_THRESHOLD` (default 7) it
asks Claude to write a concise, first-person letter grounded strictly in your
résumé (no invented employers, titles, or metrics), then **delivers it**:

- **Saved to a file** at `cover-letters/<company>-<title>.md` (dir configurable
  via `COVER_LETTER_DIR`; git-ignored so résumé-derived content isn't
  committed).
- **Posted to Discord** as an embed with the letter and the apply link.

```bash
cp profile.example.json profile.json    # your details (git-ignored)
cp resume.example.txt resume.txt          # your résumé as plain text (git-ignored)
node src/index.js --dry-run --cover-letters   # preview which letters would be written, no spend
node src/index.js --cover-letters             # generate + save + post cover letters
```

Capped at `APPLY_MAX` per run (default 5). This runs off the same deduped
"new matches" set, so each posting gets a letter once.

## Auto-apply (opt-in)

Given your résumé, the agent can also **prepare a tailored, ready-to-submit
application** for every strong match — not just alert you. Enable it with the
`--apply` flag or `AUTO_APPLY=1`. For each new match scoring ≥ `APPLY_THRESHOLD`
(default 7), it:

1. **Fetches the posting's real application form.** Greenhouse exposes every
   field via `?questions=true` (name, email, résumé, cover letter, and custom
   dropdown/free-text questions). Lever hides custom questions from its public
   API, so those forms get the standard fields and are always flagged for a
   quick human look.
2. **Auto-fills the standard fields** (name, email, phone, links, résumé)
   from `profile.json` + your résumé.
3. **Drafts the rest with Claude:** an answer to every custom question, grounded
   in your résumé, plus a cover letter **only when the form requires one**.
   Dropdown answers are validated against the real options — an unmatched answer
   is dropped rather than submitted.
4. **Records + posts each application**, dedup'd against the `applications`
   table. Capped at `APPLY_MAX` per run (default 5) **and `APPLY_DAILY_MAX` per
   day across runs (default 3)** — "a few a day." Posts to Discord showing what
   was filled, what still needs you, and the link.

### Submission backends (`APPLY_MODE`)

Fully unattended, no-human submission isn't possible (or ToS-compliant) via the
public APIs: Greenhouse submission needs the **employer's** private Board Token,
and Lever's form is reCAPTCHA-protected. So the final click is always yours —
but where that click happens is configurable via `src/submit.js`:

- **`prepare`** (default) — builds a review-ready packet; you open the link and
  submit yourself from any device.
- **`browser`** — **fills the form and uploads your résumé in a hosted cloud
  browser** ([Browserbase](https://browserbase.com)); captchas are auto-solved
  (`BROWSERBASE_SOLVE_CAPTCHAS`, on by default). Your computer never has to be
  on. Requires `BROWSERBASE_API_KEY` + `RESUME_FILE` (your PDF). How the *final
  submit* happens depends on your Browserbase plan:
  - **Paid (`BROWSERBASE_KEEP_ALIVE=1`):** the filled session persists after the
    run, so it posts a **live link** you open on your **phone** to review and tap
    Submit whenever. This is the "fill now, submit later" flow.
  - **Free plan:** the session ends when the run disconnects. Browser mode
    **auto-submits by default**: after filling + solving the captcha it clicks
    Submit for a fully hands-off apply. As a safety, it only submits when every
    required field was filled — incomplete forms (and all Lever forms, whose
    questions aren't API-visible) are *held for review* and surfaced in Discord
    instead of submitted blind. Set `BROWSER_AUTO_SUBMIT=0` to switch to
    review-only, optionally with `BROWSER_REVIEW_WINDOW=300` to hold the session
    open ~5 min so you can submit from the live link while it's alive.
  > Note: this path talks to your Browserbase account and the live form, so it
  > could not be exercised in CI; field-filling and the submit click are
  > best-effort, and anything that doesn't stick (e.g. custom dropdown widgets)
  > is left for your review.
- **`greenhouse-api`** — POSTs ready packets using an employer/ATS-owner
  Greenhouse Board Token (`GREENHOUSE_BOARD_TOKEN`). Not available to job seekers.

### Setup

```bash
cp profile.example.json profile.json   # your details (git-ignored)
# Provide your résumé as a PDF — its text is auto-extracted for the AI and the
# same file is uploaded into forms. (A plain-text resume.txt also works.)
export RESUME_FILE=resume.pdf
node src/index.js --dry-run --apply     # preview: lists forms + field counts, no spend
node src/index.js --apply               # full run (prepare mode by default)

# Hands-off cloud browser + phone approval, a few a day, PDF upload:
export APPLY_MODE=browser
export BROWSERBASE_API_KEY=...          # project id is inferred from the key
node src/index.js --apply
```

Your résumé can be a single **PDF**: set `RESUME_FILE=resume.pdf` (or
`"resumeFile"` in `profile.json`) and the tool extracts its text for tailoring
*and* uploads the file itself in browser mode — no separate `resume.txt` needed.

`profile.json`, `resume.txt`, and common résumé file names are git-ignored so
your personal data is never committed. The `applications` table must exist
before you run with `--apply` — create it (and `job_leads`) from
[`schema.sql`](schema.sql). It has a UNIQUE constraint on `url` and a
`created_at timestamptz default now()` column that powers the daily budget.

## Deploy on Railway (two steps)

1. Create a new Railway project from this GitHub repo. The included
   `railway.toml` already configures it as a cron service
   (`0 11 * * 1-5`, no restarts).
2. In the service's **Variables** tab, set:
   `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `DISCORD_WEBHOOK_URL` (see `.env.example`).

That's it — the service runs `npm start` on the schedule and exits.

> **Anthropic key name:** the app reads `ANTHROPIC_API_KEY`. If your host
> already occupies that name with its own platform key (some managed agent
> environments do), set `JOB_AGENT_ANTHROPIC_KEY` instead — it takes
> precedence. Railway does not have this collision, so `ANTHROPIC_API_KEY` is
> all you need there.

> **Timezone note:** Railway cron is UTC. `0 11 * * 1-5` is 7am ET during
> daylight saving but 6am ET in winter; switch to `0 12 * * 1-5` each
> November if you want a constant 7am.

The `job_leads` table must already exist (UNIQUE constraint on `url`). Create
it — and the optional `applications` table used by `--apply` — by running
[`schema.sql`](schema.sql) once in the Supabase SQL Editor (or via `psql`).

### Enabling auto-apply on Railway (browser mode)

Browser mode fills each form and uploads your résumé in a **hosted** cloud
browser (Browserbase), connected over CDP — Railway needs **no local Chromium**,
just the `playwright-core` dependency that's already installed. To turn it on,
add these variables alongside the four above:

| Variable | Value |
| --- | --- |
| `AUTO_APPLY` | `1` — without this, apply never runs |
| `APPLY_MODE` | `browser` |
| `BROWSERBASE_API_KEY` | your Browserbase key (project id is inferred from it) |
| `BROWSER_AUTO_SUBMIT` | `0` **recommended to start** — fills the form then posts a link for you to approve + submit; set `1` only for fully hands-off, irreversible auto-submit |
| `APPLY_DAILY_MAX` | applications per day across runs (default 3) |

> **Your résumé and `profile.json` must reach the container.** They are
> git-ignored, so a fresh Railway deploy won't include them and the apply step
> will error on load. Two options:
> - **Commit them** to this **private** repo and set `RESUME_FILE` to the PDF's path.
> - **Provision from env** (keeps personal files out of git): set `PROFILE_JSON`
>   (inline profile contents) and `RESUME_PDF_BASE64` (`base64 -w0 resume.pdf`)
>   — or `RESUME_TEXT` if you have no PDF — and the app writes them to disk at
>   startup.
>
> Auto-apply stays off until `AUTO_APPLY=1`, so scoring + Discord alerts work
> with none of this configured.

## Adding companies

Append to `companies.json`:

```json
{ "slug": "acme", "ats": "gh" }      // Greenhouse: boards-api.greenhouse.io/v1/boards/acme/jobs
{ "slug": "acme", "ats": "lever" }   // Lever: api.lever.co/v0/postings/acme?mode=json
```

The slug is the last path segment of the company's job-board URL
(`boards.greenhouse.io/<slug>` or `jobs.lever.co/<slug>`). Wrong slugs are
harmless — they 404 and get skipped.

## Run locally

```bash
npm install
cp .env.example .env   # fill in keys
# One-time: create the Supabase tables (job_leads, applications).
#   Supabase SQL Editor -> paste schema.sql -> Run   (or: psql "$DATABASE_URL" -f schema.sql)
npm start              # full run: scores, inserts, posts to Discord
npm start -- --dry-run # poll + filter only; prints matches, touches nothing
npm test
```
