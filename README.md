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
