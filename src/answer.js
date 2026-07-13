const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const COVER_LETTER_MAX = 2500;
const ANSWER_MAX = 1500;

function describeQuestion(q) {
    const parts = [`- name: "${q.name}" | label: "${q.label}" | type: ${q.type}`];
    if (q.required) parts.push("(required)");
    if (q.values && q.values.length > 0) {
        const options = q.values.map((v) => v.label).join(" | ");
        const kind = q.type === "multi_value_multi_select" ? "choose one or more of" : "choose exactly one of";
        parts.push(`\n    ${kind}: ${options}`);
    }
    return parts.join(" ");
}

export function buildAnswerPrompt({ job, profile, resumeText, questions }) {
    const questionBlock = questions.length
        ? questions.map(describeQuestion).join("\n")
        : "(none — only a cover letter is needed)";
    const profileLine = JSON.stringify({
        name: `${profile.firstName} ${profile.lastName}`,
        location: profile.location ?? null,
        workAuthorization: profile.workAuthorization ?? null,
        requiresSponsorship: profile.requiresSponsorship ?? null,
        salaryExpectation: profile.salaryExpectation ?? null,
        yearsExperience: profile.yearsExperience ?? null,
    });

    return `You are filling out a job application on behalf of a candidate using their real resume. Answer truthfully and ONLY from the resume/profile below — never invent employers, titles, dates, or credentials. Write in the candidate's first person.

CANDIDATE PROFILE: ${profileLine}

RESUME:
${resumeText}

JOB: ${job.title} at ${job.company}
${job.jdText ?? ""}

Write a concise, specific cover letter (max ~220 words) tailored to this role, plus answers to the application questions below. For select questions you MUST return one of the provided option labels verbatim; for multi-select return an array of option labels. For free-text questions keep answers focused and grounded in the resume. If a question cannot be answered truthfully from the resume/profile, return an empty string for it.

QUESTIONS:
${questionBlock}

Return ONLY valid JSON, no markdown, with this shape:
{"coverLetter": "string", "answers": {"<field name>": "string or array of strings"}}`;
}

function resolveSelectValue(question, raw) {
    const options = question.values ?? [];
    const match = (label) =>
        options.find((o) => o.label.trim().toLowerCase() === String(label).trim().toLowerCase());

    if (question.type === "multi_value_multi_select") {
        const list = Array.isArray(raw) ? raw : [raw];
        const resolved = list.map(match).filter(Boolean);
        if (resolved.length === 0) return null;
        return { display: resolved.map((o) => o.label), value: resolved.map((o) => o.value) };
    }
    const label = Array.isArray(raw) ? raw[0] : raw;
    const found = match(label);
    if (!found) return null;
    return { display: found.label, value: found.value };
}

// Parses Claude's application JSON and validates each answer against its
// question. Select answers that don't map to a real option are dropped
// (treated as unanswered) so we never submit garbage into a dropdown.
export function parseAnswerResponse(text, questions) {
    let parsed;
    try {
        const cleaned = String(text)
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    } catch {
        return { coverLetter: "", answers: {} };
    }

    const coverLetter = String(parsed.coverLetter ?? "").slice(0, COVER_LETTER_MAX);
    const rawAnswers = parsed.answers && typeof parsed.answers === "object" ? parsed.answers : {};
    const answers = {};

    for (const question of questions) {
        const raw = rawAnswers[question.name];
        if (raw === undefined || raw === null || raw === "") continue;

        const isSelect =
            question.type === "multi_value_single_select" ||
            question.type === "multi_value_multi_select" ||
            (question.values && question.values.length > 0);

        if (isSelect) {
            const resolved = resolveSelectValue(question, raw);
            if (resolved) answers[question.name] = resolved;
            continue;
        }
        const flat = Array.isArray(raw) ? raw.join(", ") : String(raw);
        const trimmed = flat.trim();
        if (trimmed) answers[question.name] = { display: trimmed, value: trimmed.slice(0, ANSWER_MAX) };
    }

    return { coverLetter, answers };
}

export function buildCoverLetterPrompt({ job, profile, resumeText }) {
    return `Write a cover letter for this candidate applying to the job below. Use ONLY facts from the resume/profile — never invent employers, titles, metrics, dates, or credentials. Write in the candidate's first person, warm but concise (~250 words), with a specific hook tied to this company/role and 2-3 concrete, quantified achievements from the resume. No placeholders, no "[Your Name]" — sign off with the candidate's real name. Return ONLY the letter text, no preamble, no markdown.

CANDIDATE: ${profile.firstName} ${profile.lastName}${profile.location ? ` — ${profile.location}` : ""}

RESUME:
${resumeText}

JOB: ${job.title} at ${job.company}
${job.jdText ?? ""}`;
}

// Generates a single tailored cover letter as plain text. Returns "" on any
// failure so the caller can skip cleanly.
export async function generateCoverLetter({ job, profile, resumeText, apiKey }) {
    try {
        const res = await fetch(ANTHROPIC_URL, {
            method: "POST",
            signal: AbortSignal.timeout(60_000),
            headers: {
                "content-type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 800,
                messages: [
                    { role: "user", content: buildCoverLetterPrompt({ job, profile, resumeText }) },
                ],
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        const text = (data.content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("")
            .trim();
        return text.slice(0, COVER_LETTER_MAX);
    } catch (err) {
        console.log(
            `cover letter failed for "${job.title}" at ${job.company}: ${err instanceof Error ? err.message : err}`,
        );
        return "";
    }
}

export async function generateApplication({ job, profile, resumeText, questions, apiKey }) {
    try {
        const res = await fetch(ANTHROPIC_URL, {
            method: "POST",
            signal: AbortSignal.timeout(60_000),
            headers: {
                "content-type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 1500,
                messages: [
                    { role: "user", content: buildAnswerPrompt({ job, profile, resumeText, questions }) },
                ],
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        const text = (data.content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
        return parseAnswerResponse(text, questions);
    } catch (err) {
        console.log(
            `answer generation failed for "${job.title}" at ${job.company}: ${err instanceof Error ? err.message : err}`,
        );
        return { coverLetter: "", answers: {} };
    }
}
