import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Standard profile fields the apply pipeline knows how to map onto ATS forms.
// Only firstName / lastName / email are hard requirements; everything else is
// filled when present and left for review when absent.
const REQUIRED_PROFILE_FIELDS = ["firstName", "lastName", "email"];

function resolvePath(relativeOrAbsolute) {
    if (!relativeOrAbsolute) return null;
    // Absolute paths pass through; relative paths resolve against the repo root
    // (one level up from src/) so `resume.txt` / `profile.json` work as documented.
    if (relativeOrAbsolute.startsWith("/")) return relativeOrAbsolute;
    return fileURLToPath(new URL(`../${relativeOrAbsolute}`, import.meta.url));
}

function readTextFile(path, label) {
    try {
        return readFileSync(path, "utf8");
    } catch (err) {
        throw new Error(
            `Could not read ${label} at ${path}: ${err instanceof Error ? err.message : err}`,
        );
    }
}

// Trims a resume to a sane size for prompting / resume_text fields. Greenhouse
// caps resume_text and Claude context is finite; 20k chars is plenty for the
// text a job seeker's resume contains.
const RESUME_MAX_CHARS = 20_000;

export function loadApplicant(env = process.env) {
    const profilePath = resolvePath(env.PROFILE_PATH || "profile.json");
    const profileRaw = readTextFile(profilePath, "profile");

    let profile;
    try {
        profile = JSON.parse(profileRaw);
    } catch (err) {
        throw new Error(
            `profile.json is not valid JSON: ${err instanceof Error ? err.message : err}`,
        );
    }

    const missing = REQUIRED_PROFILE_FIELDS.filter(
        (field) => !profile[field] || String(profile[field]).trim() === "",
    );
    if (missing.length > 0) {
        throw new Error(`profile.json is missing required fields: ${missing.join(", ")}`);
    }

    const resumePath = resolvePath(env.RESUME_PATH || profile.resumePath || "resume.txt");
    let resumeText = readTextFile(resumePath, "resume").trim();
    if (!resumeText) {
        throw new Error(`resume file at ${resumePath} is empty`);
    }
    if (resumeText.length > RESUME_MAX_CHARS) {
        resumeText = resumeText.slice(0, RESUME_MAX_CHARS);
    }

    const resumeFilename = resumePath.split("/").pop() || "resume.txt";

    return { profile, resumeText, resumeFilename };
}
