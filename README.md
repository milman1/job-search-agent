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
2. **Auto-fills the standard fields** (name, email, phone, links, résumé text)
   from `profile.json` + your résumé.
3. **Drafts the rest with Claude:** a cover letter tailored to the role plus an
   answer to every custom question, grounded in your résumé. Dropdown answers
   are validated against the real options — an unmatched answer is dropped
   rather than submitted.
4. **Assembles a review-ready packet**, dedup'd against the `applications`
   table and capped at `APPLY_MAX` per run (default 5), records it, and posts it
   to Discord showing what was filled, what still needs you, and the apply link.

### Why it prepares instead of blindly clicking submit

Fully unattended submission isn't possible (or ToS-compliant) through the public
APIs: Greenhouse submission requires the **employer's** private Board Token, and
Lever's hosted form is reCAPTCHA-protected. So the default `APPLY_MODE=prepare`
does all the work — tailoring, answers, cover letter — and hands you a packet to
submit with one click.

Submission is pluggable via `src/submit.js`. If you *do* have a compliant
backend (an employer/ATS-owner Greenhouse Board Token, or a browser-automation
worker you run yourself), set `APPLY_MODE=greenhouse-api` +
`GREENHOUSE_BOARD_TOKEN` and ready packets are POSTed automatically. The packet
is already fully built, so any submitter drops in behind the same interface.

### Setup

```bash
cp profile.example.json profile.json   # your details (git-ignored)
cp resume.example.txt resume.txt        # your résumé as plain text (git-ignored)
node src/index.js --dry-run --apply     # preview: lists forms + field counts, no spend
node src/index.js --apply               # full run: prepares/records/posts applications
```

`profile.json`, `resume.txt`, and common résumé file names are git-ignored so
your personal data is never committed. The `applications` table must exist with
a UNIQUE constraint on `url` and columns: `id, url, title, company, source,
ready, submitted, status, missing_fields, cover_letter, answers, created_at`.

## Deploy on Railway (two steps)

1. Create a new Railway project from this GitHub repo. The included
   `railway.toml` already configures it as a cron service
   (`0 11 * * 1-5`, no restarts).
2. In the service's **Variables** tab, set:
   `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `DISCORD_WEBHOOK_URL` (see `.env.example`).

That's it — the service runs `npm start` on the schedule and exits.

> **Timezone note:** Railway cron is UTC. `0 11 * * 1-5` is 7am ET during
> daylight saving but 6am ET in winter; switch to `0 12 * * 1-5` each
> November if you want a constant 7am.

The `job_leads` table must already exist with a UNIQUE constraint on `url`
and columns: `id, title, company, url, source, score, verdict, top_angle,
watch_point, salary_fit, status, created_at`.

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
npm start              # full run: scores, inserts, posts to Discord
npm start -- --dry-run # poll + filter only; prints matches, touches nothing
npm test
```
