import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Materialize applicant files from env vars so browser/apply mode can run in an
// ephemeral container (e.g. Railway) WITHOUT committing personal files to git.
//
//   PROFILE_JSON        full contents of profile.json, inline
//   RESUME_PDF_BASE64   resume PDF, base64-encoded (uploaded into forms + text
//                       extracted for the AI)
//   RESUME_TEXT         plain-text resume, used when you have no PDF
//
// No-op unless the relevant var is set, and an explicit path var
// (PROFILE_PATH / RESUME_FILE / RESUME_PATH) always wins over its inline
// counterpart. Mutates `env` so the downstream loadApplicant() picks up the
// written paths. Returns the list of files written.
export function provisionApplicantFiles(env = process.env) {
    const provisioned = [];
    let dir;
    const ensureDir = () => (dir ??= mkdtempSync(join(tmpdir(), "job-agent-")));

    if (env.PROFILE_JSON && !env.PROFILE_PATH) {
        const path = join(ensureDir(), "profile.json");
        writeFileSync(path, env.PROFILE_JSON);
        env.PROFILE_PATH = path;
        provisioned.push("profile.json");
    }

    if (env.RESUME_PDF_BASE64 && !env.RESUME_FILE) {
        const path = join(ensureDir(), "resume.pdf");
        writeFileSync(path, Buffer.from(env.RESUME_PDF_BASE64, "base64"));
        env.RESUME_FILE = path;
        provisioned.push("resume.pdf");
    } else if (env.RESUME_TEXT && !env.RESUME_PATH) {
        const path = join(ensureDir(), "resume.txt");
        writeFileSync(path, env.RESUME_TEXT);
        env.RESUME_PATH = path;
        provisioned.push("resume.txt");
    }

    return provisioned;
}
