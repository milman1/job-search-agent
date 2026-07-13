import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateCoverLetter } from "./answer.js";

// Filesystem-safe base name for a job's cover letter, e.g.
// "ramp-head-of-growth". Collisions are harmless (last write wins per run).
export function coverLetterSlug(job) {
    const raw = `${job.company}-${job.title}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return raw || "cover-letter";
}

// Renders the saved-file contents: the letter plus a small header so you know
// which posting it belongs to.
export function renderCoverLetterFile(job, text) {
    return [
        `# ${job.title} — ${job.company}`,
        job.url ? `Apply: ${job.url}` : "",
        "",
        text,
        "",
    ]
        .filter((line) => line !== null && line !== undefined)
        .join("\n");
}

// Generates a tailored cover letter for each strong match and PROVIDES it:
// written to `outDir/<slug>.md` and (when configured) posted to Discord.
// Operates on the already-deduped set of new matches, so letters are only
// generated once per posting.
export async function generateCoverLetters({
    matched,
    applicant,
    apiKey,
    outDir,
    webhookUrl,
    postCoverLetter,
    cap,
    dryRun,
}) {
    const todo = matched.slice(0, cap);
    if (todo.length === 0) return { written: 0, files: [] };

    if (dryRun) {
        for (const { job } of todo) {
            console.log(`  would write cover letter: ${coverLetterSlug(job)}.md — ${job.title} @ ${job.company}`);
        }
        console.log(`Cover letters (dry run): ${todo.length} would be generated.`);
        return { written: todo.length, files: [] };
    }

    mkdirSync(outDir, { recursive: true });
    const files = [];
    for (const { job } of todo) {
        const text = await generateCoverLetter({
            job,
            profile: applicant.profile,
            resumeText: applicant.resumeText,
            apiKey,
        });
        if (!text) {
            console.log(`cover letter: skip ${job.title} @ ${job.company} (generation failed)`);
            continue;
        }
        const path = join(outDir, `${coverLetterSlug(job)}.md`);
        writeFileSync(path, renderCoverLetterFile(job, text), "utf8");
        files.push(path);
        if (webhookUrl && postCoverLetter) await postCoverLetter(webhookUrl, job, text);
        console.log(`cover letter: wrote ${path} — ${job.title} @ ${job.company}`);
    }

    return { written: files.length, files };
}
