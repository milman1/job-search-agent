import { generateApplication } from "./answer.js";
import { fetchApplicationForm } from "./questions.js";
import { assemblePacket, coverLetterRequired, questionsToAnswer } from "./packet.js";

// Fetches the posting's real application form, has Claude draft answers (and a
// cover letter ONLY when the form requires one) from the resume, and assembles
// a review-ready packet.
export async function prepareApplication({ job, applicant, apiKey }) {
    const form = await fetchApplicationForm(job);
    const questions = questionsToAnswer(form.fields);
    // Lever hides its form from the API, so we can't be sure a cover letter
    // isn't required — include one for Lever; for Greenhouse, only when the
    // form marks it required.
    const includeCoverLetter = form.source === "lever" || coverLetterRequired(form);
    const generated = await generateApplication({
        job,
        profile: applicant.profile,
        resumeText: applicant.resumeText,
        questions,
        apiKey,
        includeCoverLetter,
    });
    return assemblePacket({ job, form, applicant, generated });
}

// How many applications we're allowed to do this run: the smaller of the
// per-run cap and whatever's left of the daily budget. Never negative.
export function dailyBudget({ dailyMax, todayCount, perRunCap }) {
    return Math.max(0, Math.min(perRunCap, dailyMax - todayCount));
}

export function startOfUtcDay(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function applicationRow(packet, result) {
    return {
        url: packet.job.url,
        title: packet.job.title,
        company: packet.job.company,
        source: packet.source,
        ready: packet.ready,
        submitted: Boolean(result?.submitted),
        status: result?.status ?? "prepared",
        review_url: result?.reviewUrl ?? null,
        missing_fields: packet.missing.join(", ") || null,
        cover_letter: packet.coverLetter || null,
        answers: JSON.stringify(
            Object.fromEntries(
                packet.fields
                    .filter((f) => f.source === "generated")
                    .map((f) => [f.name, f.display]),
            ),
        ),
    };
}

// Orchestrates applying to already-scored, high-value matches: dedup against
// prior applications, respect the per-run cap, prepare (and optionally submit)
// each packet, record it, and post to Discord for review.
export async function applyToJobs({
    matched,
    applicant,
    db,
    submitter,
    apiKey,
    webhookUrl,
    postApplication,
    cap,
    dryRun,
}) {
    if (matched.length === 0) return { prepared: 0, submitted: 0 };

    const urls = matched.map((m) => m.job.url).filter(Boolean);
    const alreadyApplied = dryRun ? new Set() : await db.existingApplications(urls);
    const todo = matched
        .filter((m) => m.job.url && !alreadyApplied.has(m.job.url))
        .slice(0, cap);

    if (dryRun) {
        for (const { job } of todo) {
            let fieldCount = "?";
            try {
                const form = await fetchApplicationForm(job);
                fieldCount = String(form.fields.length);
            } catch (err) {
                fieldCount = `form fetch failed: ${err instanceof Error ? err.message : err}`;
            }
            console.log(`  would apply: ${job.title} @ ${job.company} (${fieldCount} fields) — ${job.url}`);
        }
        console.log(`Apply (dry run): ${todo.length} application(s) would be prepared.`);
        return { prepared: todo.length, submitted: 0 };
    }

    let prepared = 0;
    let submitted = 0;
    for (const { job } of todo) {
        let packet;
        try {
            packet = await prepareApplication({ job, applicant, apiKey });
        } catch (err) {
            console.log(
                `apply: skip ${job.title} @ ${job.company} (${err instanceof Error ? err.message : err})`,
            );
            continue;
        }

        const result = await submitter.submit(packet, { applicant });
        prepared++;
        if (result.submitted) submitted++;

        await db.insertApplication(applicationRow(packet, result));
        if (webhookUrl) await postApplication(webhookUrl, packet, result);

        const state = result.submitted
            ? "submitted"
            : result.reviewUrl
              ? `filled — awaiting your approval: ${result.reviewUrl}`
              : packet.ready
                ? "prepared (ready)"
                : `prepared (needs review: ${packet.missing.join(", ") || "custom questions"})`;
        console.log(`apply: ${state} — ${job.title} @ ${job.company}`);
    }

    return { prepared, submitted };
}
