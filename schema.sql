-- Supabase / Postgres schema for job-search-agent.
-- Run once against your project (SQL Editor, or `psql`) before the first run.
--
--   job_leads     — every scored posting (required for the core alert flow)
--   applications  — one row per prepared/submitted application (only needed
--                   when you use --apply / AUTO_APPLY=1)
--
-- Both tables dedup by a UNIQUE `url`; the agent relies on that constraint to
-- skip postings it has already seen (unique-violation inserts are ignored).

-- ---------------------------------------------------------------------------
-- job_leads: results of poll -> filter -> score.
-- ---------------------------------------------------------------------------
create table if not exists job_leads (
    id          bigint generated always as identity primary key,
    title       text        not null,
    company     text        not null,
    url         text        not null unique,
    source      text        not null,             -- 'greenhouse' | 'lever'
    score       integer,                          -- 1-10 (Claude), 5 on fallback
    verdict     text,
    top_angle   text,
    watch_point text,
    salary_fit  boolean,                          -- nullable: unknown when unparseable
    status      text        not null default 'new', -- 'new' (>=7) | 'skipped'
    created_at  timestamptz not null default now()
);

-- Recent-first browsing and status filtering.
create index if not exists job_leads_created_at_idx on job_leads (created_at desc);
create index if not exists job_leads_status_idx     on job_leads (status);

-- ---------------------------------------------------------------------------
-- applications: one row per application the --apply pipeline prepares/submits.
-- `created_at` powers the per-day budget (APPLY_DAILY_MAX), so keep the default.
-- ---------------------------------------------------------------------------
create table if not exists applications (
    id             bigint generated always as identity primary key,
    url            text        not null unique,    -- posting URL (dedup key)
    title          text        not null,
    company        text        not null,
    source         text        not null,           -- 'greenhouse' | 'lever'
    ready          boolean     not null default false, -- all required fields filled + full form seen
    submitted      boolean     not null default false, -- actually sent (browser / greenhouse-api)
    status         text        not null default 'prepared',
    review_url     text,                            -- live browser link when awaiting your submit
    missing_fields text,                            -- comma-separated labels still needing you
    cover_letter   text,                            -- generated only when the form requires one
    answers        text,                            -- JSON string of AI-generated custom answers
    created_at     timestamptz not null default now()
);

-- Used by the daily-budget count (created_at >= start of UTC day).
create index if not exists applications_created_at_idx on applications (created_at desc);
