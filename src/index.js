import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyToJobs, dailyBudget, startOfUtcDay } from "./apply.js";
import { pollBoards } from "./boards.js";
import { generateCoverLetters } from "./coverletter.js";
import { makeDb } from "./db.js";
import { postApplication, postCoverLetter, postToDiscord } from "./discord.js";
import { resolveAnthropicKey } from "./env.js";
import { provisionApplicantFiles } from "./provision.js";
import { loadApplicant } from "./resume.js";
import { scoreJob } from "./score.js";
import { getSubmitter } from "./submit.js";

const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const APPLY = process.argv.includes("--apply") || process.env.AUTO_APPLY === "1";
const COVER_LETTERS =
    process.argv.includes("--cover-letters") || process.env.COVER_LETTERS === "1";
const POST_THRESHOLD = 7;
const APPLY_THRESHOLD = Number(process.env.APPLY_THRESHOLD) || POST_THRESHOLD;
const APPLY_MAX = Number(process.env.APPLY_MAX) || 5;
// "A few a day": cap applications across all of today's runs, not just this one.
const APPLY_DAILY_MAX = Number(process.env.APPLY_DAILY_MAX) || 3;
const COVER_LETTER_DIR = process.env.COVER_LETTER_DIR
    ? process.env.COVER_LETTER_DIR
    : fileURLToPath(new URL("../cover-letters", import.meta.url));

function loadCompanies() {
    const path = fileURLToPath(new URL("../companies.json", import.meta.url));
    const companies = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(companies) || companies.length === 0) {
        throw new Error("companies.json must be a non-empty array");
    }
    return companies;
}

function requireEnv(names) {
    const missing = names.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        throw new Error(`Missing required env vars: ${missing.join(", ")}`);
    }
}

async function main() {
    // Hydrate git-ignored personal files (profile/resume) from env when set, so
    // apply mode works on ephemeral hosts without committing them. No-op locally.
    if (APPLY || COVER_LETTERS) {
        const provisioned = provisionApplicantFiles();
        if (provisioned.length) {
            console.log(`Provisioned from env: ${provisioned.join(", ")}`);
        }
    }

    const companies = loadCompanies();

    // 1-3. Poll boards, filter titles, normalize + build jdText.
    const { jobs, failed } = await pollBoards(companies);
    console.log(
        `Polled ${companies.length} companies (${failed} skipped), ${jobs.length} title matches.`,
    );

    if (DRY_RUN) {
        for (const job of jobs) {
            console.log(`  [${job.source}] ${job.title} @ ${job.company} — ${job.url}`);
        }
        if (APPLY || COVER_LETTERS) {
            // Read-only preview: validates the resume/profile load and reports
            // what would be produced. No scoring/Claude/DB.
            const applicant = await loadApplicant();
            console.log(
                `Loaded resume for ${applicant.profile.firstName} ${applicant.profile.lastName} (${applicant.resumeText.length} chars).`,
            );
            if (APPLY) {
                await applyToJobs({
                    matched: jobs.map((job) => ({ job })),
                    applicant,
                    cap: APPLY_MAX,
                    dryRun: true,
                });
            }
            if (COVER_LETTERS) {
                await generateCoverLetters({
                    matched: jobs.map((job) => ({ job })),
                    applicant,
                    cap: APPLY_MAX,
                    dryRun: true,
                });
            }
        }
        console.log(
            `Summary: companies=${companies.length} matched=${jobs.length} new=? posted=? (dry run: no DB/scoring/Discord)`,
        );
        return;
    }

    requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_KEY"]);
    const anthropicKey = resolveAnthropicKey();
    if (!anthropicKey) {
        throw new Error(
            "Missing Anthropic API key: set ANTHROPIC_API_KEY (or JOB_AGENT_ANTHROPIC_KEY).",
        );
    }
    if (!process.env.DISCORD_WEBHOOK_URL) {
        console.log("DISCORD_WEBHOOK_URL not set; alerts will be skipped.");
    }
    const db = makeDb(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // 4. Dedup against job_leads by URL.
    const seen = await db.existingUrls(jobs.map((job) => job.url));
    const newJobs = jobs.filter((job) => job.url && !seen.has(job.url));

    // 5-7. Score, insert, alert.
    let posted = 0;
    const applyCandidates = [];
    for (const job of newJobs) {
        const scored = await scoreJob(job, anthropicKey);
        await db.insertLead({
            title: job.title,
            company: job.company,
            url: job.url,
            source: job.source,
            score: scored.score,
            verdict: scored.verdict,
            top_angle: scored.topAngle,
            watch_point: scored.watchPoint,
            salary_fit: scored.salaryFit,
            status: scored.score >= POST_THRESHOLD ? "new" : "skipped",
        });
        if (scored.score >= POST_THRESHOLD && process.env.DISCORD_WEBHOOK_URL) {
            const ok = await postToDiscord(process.env.DISCORD_WEBHOOK_URL, job, scored);
            if (ok) posted++;
        }
        if ((APPLY || COVER_LETTERS) && scored.score >= APPLY_THRESHOLD) {
            applyCandidates.push({ job, scored });
        }
    }

    // 9. From the resume (opt-in): generate tailored cover letters and/or
    // prepare review-ready applications for each strong match. Both operate on
    // the already-deduped new matches and share the resume/profile load.
    let applyResult = { prepared: 0, submitted: 0 };
    let coverResult = { written: 0 };
    if (APPLY || COVER_LETTERS) {
        const applicant = await loadApplicant();
        if (COVER_LETTERS) {
            coverResult = await generateCoverLetters({
                matched: applyCandidates,
                applicant,
                apiKey: anthropicKey,
                outDir: COVER_LETTER_DIR,
                webhookUrl: process.env.DISCORD_WEBHOOK_URL,
                postCoverLetter,
                cap: APPLY_MAX,
                dryRun: false,
            });
        }
        if (APPLY) {
            const todayCount = await db.countApplicationsSince(startOfUtcDay());
            const cap = dailyBudget({
                dailyMax: APPLY_DAILY_MAX,
                todayCount,
                perRunCap: APPLY_MAX,
            });
            if (cap === 0) {
                console.log(
                    `apply: daily budget reached (${todayCount}/${APPLY_DAILY_MAX} today); skipping.`,
                );
            } else {
                applyResult = await applyToJobs({
                    matched: applyCandidates,
                    applicant,
                    db,
                    submitter: await getSubmitter(),
                    apiKey: anthropicKey,
                    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
                    postApplication,
                    cap,
                    dryRun: false,
                });
            }
        }
    }

    // 8. One-line summary.
    console.log(
        `Summary: companies=${companies.length} matched=${jobs.length} new=${newJobs.length} posted=${posted}` +
            (COVER_LETTERS ? ` coverLetters=${coverResult.written}` : "") +
            (APPLY ? ` applications=${applyResult.prepared} submitted=${applyResult.submitted}` : ""),
    );
}

main().catch((err) => {
    console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
