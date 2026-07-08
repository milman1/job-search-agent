import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pollBoards } from "./boards.js";
import { makeDb } from "./db.js";
import { postToDiscord } from "./discord.js";
import { scoreJob } from "./score.js";

const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const POST_THRESHOLD = 7;

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
        console.log(
            `Summary: companies=${companies.length} matched=${jobs.length} new=? posted=? (dry run: no DB/scoring/Discord)`,
        );
        return;
    }

    requireEnv(["ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]);
    if (!process.env.DISCORD_WEBHOOK_URL) {
        console.log("DISCORD_WEBHOOK_URL not set; alerts will be skipped.");
    }
    const db = makeDb(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // 4. Dedup against job_leads by URL.
    const seen = await db.existingUrls(jobs.map((job) => job.url));
    const newJobs = jobs.filter((job) => job.url && !seen.has(job.url));

    // 5-7. Score, insert, alert.
    let posted = 0;
    for (const job of newJobs) {
        const scored = await scoreJob(job, process.env.ANTHROPIC_API_KEY);
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
    }

    // 8. One-line summary.
    console.log(
        `Summary: companies=${companies.length} matched=${jobs.length} new=${newJobs.length} posted=${posted}`,
    );
}

main().catch((err) => {
    console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
