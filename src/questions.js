const FETCH_TIMEOUT_MS = 15_000;

// Field "roles" let the packet/answer logic map profile data onto whatever the
// employer named the field. Anything without a recognised role is treated as a
// custom question and answered by Claude.
const ROLE_BY_NAME = {
    first_name: "firstName",
    last_name: "lastName",
    name: "fullName",
    email: "email",
    phone: "phone",
    resume: "resume",
    resume_text: "resumeText",
    cover_letter: "coverLetter",
    cover_letter_text: "coverLetterText",
};

// Common link/URL questions vary wildly in field name but consistently mention
// these tokens in their label; used as a soft hint for standard mapping.
const LINK_HINTS = [
    { role: "linkedin", re: /linkedin/i },
    { role: "github", re: /github|git hub/i },
    { role: "website", re: /website|portfolio|personal site/i },
];

function roleFor(name, label) {
    if (ROLE_BY_NAME[name]) return ROLE_BY_NAME[name];
    for (const hint of LINK_HINTS) {
        if (hint.re.test(label || "")) return hint.role;
    }
    return null;
}

// Normalizes Greenhouse's `questions` array into a flat field list the rest of
// the pipeline understands. One question can expose multiple fields (e.g.
// Resume => resume file + resume_text textarea); we keep them all.
export function normalizeGreenhouseQuestions(questions) {
    const fields = [];
    for (const question of questions ?? []) {
        for (const field of question.fields ?? []) {
            const values = (field.values ?? []).map((v) => ({
                label: String(v.label),
                value: v.value,
            }));
            fields.push({
                label: question.label?.trim() || field.name,
                name: field.name,
                type: field.type,
                required: Boolean(question.required),
                values,
                role: roleFor(field.name, question.label),
            });
        }
    }
    return fields;
}

async function fetchJson(url) {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function fetchGreenhouseForm(job) {
    const data = await fetchJson(
        `https://boards-api.greenhouse.io/v1/boards/${job.slug}/jobs/${job.atsJobId}?questions=true`,
    );
    return {
        source: "greenhouse",
        applyUrl: job.url,
        fields: normalizeGreenhouseQuestions(data.questions),
        complete: true,
    };
}

// Lever's public postings API does not expose the application form's custom
// questions, so we return the standard fields every Lever form has and flag the
// form as incomplete — the packet will note that custom cards need review on
// the hosted page.
export function leverStandardForm(job) {
    return {
        source: "lever",
        applyUrl: job.applyUrl || job.url,
        complete: false,
        fields: [
            { label: "Full name", name: "name", type: "input_text", required: true, values: [], role: "fullName" },
            { label: "Email", name: "email", type: "input_text", required: true, values: [], role: "email" },
            { label: "Phone", name: "phone", type: "input_text", required: false, values: [], role: "phone" },
            { label: "Resume", name: "resume", type: "input_file", required: true, values: [], role: "resume" },
            { label: "LinkedIn URL", name: "urls[LinkedIn]", type: "input_text", required: false, values: [], role: "linkedin" },
            { label: "Additional information", name: "comments", type: "textarea", required: false, values: [], role: null },
        ],
    };
}

// Fetches and normalizes a posting's application form. Per-job failures bubble
// up to the caller, which logs and skips (never kills the run).
export async function fetchApplicationForm(job) {
    if (job.source === "lever") return leverStandardForm(job);
    return fetchGreenhouseForm(job);
}
