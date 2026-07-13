// Roles that we fill deterministically from the applicant profile/resume rather
// than asking Claude to answer.
const PROFILE_ROLES = new Set([
    "firstName",
    "lastName",
    "fullName",
    "email",
    "phone",
    "linkedin",
    "github",
    "website",
    "resume",
    "resumeText",
    "coverLetter",
    "coverLetterText",
]);

function profileValue(role, applicant) {
    const { profile, resumeText, resumeFilename } = applicant;
    switch (role) {
        case "firstName":
            return { value: profile.firstName, display: profile.firstName };
        case "lastName":
            return { value: profile.lastName, display: profile.lastName };
        case "fullName":
            return {
                value: `${profile.firstName} ${profile.lastName}`,
                display: `${profile.firstName} ${profile.lastName}`,
            };
        case "email":
            return { value: profile.email, display: profile.email };
        case "phone":
            return profile.phone ? { value: profile.phone, display: profile.phone } : null;
        case "linkedin":
            return profile.linkedin ? { value: profile.linkedin, display: profile.linkedin } : null;
        case "github":
            return profile.github ? { value: profile.github, display: profile.github } : null;
        case "website":
            return profile.website ? { value: profile.website, display: profile.website } : null;
        case "resume":
            return {
                value: { filename: resumeFilename, content: resumeText },
                display: `[resume: ${resumeFilename}]`,
            };
        case "resumeText":
            return { value: resumeText, display: "[resume text attached]" };
        default:
            return null;
    }
}

// Fields the answer generator should handle: custom questions (no known role)
// of a fillable input type.
const ANSWERABLE_TYPES = new Set([
    "input_text",
    "textarea",
    "multi_value_single_select",
    "multi_value_multi_select",
    "value_select",
]);

export function questionsToAnswer(fields) {
    return fields.filter(
        (f) => !PROFILE_ROLES.has(f.role) && ANSWERABLE_TYPES.has(f.type),
    );
}

// True only when the form has a REQUIRED cover-letter field. Used to skip
// cover-letter generation unless the application actually demands one.
export function coverLetterRequired(form) {
    return (form.fields ?? []).some(
        (f) => (f.role === "coverLetter" || f.role === "coverLetterText") && f.required,
    );
}

// Combines profile-mapped values, the generated cover letter, and Claude's
// per-question answers into one ordered, review-ready packet and reports
// whether every required field could be filled.
export function assemblePacket({ job, form, applicant, generated }) {
    const coverLetter = generated?.coverLetter || "";
    const answers = generated?.answers || {};
    const fields = [];
    const missing = [];

    for (const field of form.fields) {
        let filled = null;
        let source = null;

        if (field.role === "coverLetter" || field.role === "coverLetterText") {
            if (coverLetter) {
                filled = { value: coverLetter, display: coverLetter };
                source = "generated";
            }
        } else if (PROFILE_ROLES.has(field.role)) {
            const mapped = profileValue(field.role, applicant);
            if (mapped) {
                filled = mapped;
                source = "profile";
            }
        } else if (answers[field.name]) {
            filled = answers[field.name];
            source = "generated";
        }

        fields.push({
            label: field.label,
            name: field.name,
            type: field.type,
            role: field.role ?? null,
            required: field.required,
            value: filled ? filled.value : null,
            display: filled ? filled.display : "",
            source: source ?? "unfilled",
        });

        if (field.required && !filled) missing.push(field.label);
    }

    return {
        job: {
            title: job.title,
            company: job.company,
            url: job.url,
            slug: job.slug,
            atsJobId: job.atsJobId,
        },
        applyUrl: form.applyUrl,
        source: form.source,
        formComplete: form.complete,
        coverLetter,
        fields,
        // "ready" means every required field is filled AND we saw the whole
        // form. Lever forms are incomplete (custom cards hidden), so they are
        // never auto-"ready" — they always warrant a human glance.
        ready: missing.length === 0 && form.complete,
        missing,
    };
}
