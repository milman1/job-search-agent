# AGENTS.md

## Cursor Cloud specific instructions

`job-search-agent` is a headless Node.js (ES modules, Node >= 20) CLI/cron job — there is
no web server or UI and no long-running process; each invocation runs once and exits.
Standard commands live in `package.json` and `README.md` ("Run locally"); reference those
rather than duplicating.

Non-obvious notes for running/testing here:

- Dependencies are already installed by the startup update script (`npm install`). No build
  step exists.
- `npm test` (`node --test` over `test/*.test.js`) runs fully **offline** with **no env
  vars/secrets** — network calls (`fetch`) and Supabase are stubbed in the tests.
- `npm start -- --dry-run` is the safe end-to-end smoke test: it polls the live public
  Greenhouse/Lever boards and filters titles, but touches **no** Supabase/Claude/Discord and
  spends nothing. It only needs outbound HTTPS. Dead company slugs return HTTP 404 and are
  logged/skipped — that is expected, not an error.
- A **full** `npm start` requires three secrets — `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_KEY` — and the Supabase tables from `schema.sql` created once. Without
  them the run throws immediately (`requireEnv`). `DISCORD_WEBHOOK_URL` and Browserbase are
  optional and degrade gracefully.
- There is **no linter/formatter** configured (no ESLint/Prettier/tsconfig, no `lint`
  script). Don't expect a lint command.
- The opt-in `--apply APPLY_MODE=browser` path uses Browserbase + a live form and cannot be
  exercised in CI/cloud without a Browserbase account.
