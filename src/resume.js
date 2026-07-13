import { existsSync, readFileSync } from "node:fs";
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

const isPdf = (path) => /\.pdf$/i.test(path);

// Extracts plain text from a PDF resume so the same file can serve as both the
// AI's source material and the uploaded document. pdf-parse is imported lazily
// so text-only setups don't need it.
async function extractPdfText(path) {
    const buffer = readFileSync(path);
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
        const { text } = await parser.getText();
        return text;
    } finally {
        await parser.destroy?.().catch(() => {});
    }
}

async function loadResumeText(path, label) {
    if (isPdf(path)) {
        try {
            return (await extractPdfText(path)).trim();
        } catch (err) {
            throw new Error(
                `Could not extract text from ${label} PDF at ${path}: ${err instanceof Error ? err.message : err}`,
            );
        }
    }
    return readTextFile(path, label).trim();
}

export async function loadApplicant(env = process.env) {
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

    // The file uploaded into application forms (e.g. a PDF), if provided.
    let resumeFile = null;
    const resumeFileRaw = env.RESUME_FILE || profile.resumeFile;
    if (resumeFileRaw) {
        resumeFile = resolvePath(resumeFileRaw);
        if (!existsSync(resumeFile)) {
            throw new Error(`RESUME_FILE points to a missing file: ${resumeFile}`);
        }
    }

    // Where the resume TEXT comes from. Precedence: an explicit RESUME_PATH /
    // profile.resumePath; otherwise the upload file itself when it's a PDF (so a
    // single PDF works for both); otherwise the default resume.txt.
    const explicitTextRaw = env.RESUME_PATH || profile.resumePath;
    let textPath;
    if (explicitTextRaw) textPath = resolvePath(explicitTextRaw);
    else if (resumeFile && isPdf(resumeFile)) textPath = resumeFile;
    else textPath = resolvePath("resume.txt");

    let resumeText = await loadResumeText(textPath, "resume");
    if (!resumeText) {
        throw new Error(`resume at ${textPath} produced no text`);
    }
    if (resumeText.length > RESUME_MAX_CHARS) {
        resumeText = resumeText.slice(0, RESUME_MAX_CHARS);
    }

    // If no explicit upload file was set but the text came from a PDF, use that
    // PDF as the upload document too.
    if (!resumeFile && isPdf(textPath)) resumeFile = textPath;

    const resumeFilename = (resumeFile || textPath).split("/").pop() || "resume.txt";

    return { profile, resumeText, resumeFilename, resumeFile };
}
