import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { provisionApplicantFiles } from "../src/provision.js";
import { loadApplicant } from "../src/resume.js";

test("provisions profile + resume text from env; loadApplicant reads them", async () => {
    const env = {
        PROFILE_JSON: JSON.stringify({
            firstName: "Avi",
            lastName: "Milman",
            email: "avi@example.com",
        }),
        RESUME_TEXT: "Growth marketing leader. 10 years B2B SaaS fintech.",
    };
    const done = provisionApplicantFiles(env);
    assert.deepEqual(done.sort(), ["profile.json", "resume.txt"]);
    assert.ok(env.PROFILE_PATH && env.RESUME_PATH);

    const applicant = await loadApplicant(env);
    assert.equal(applicant.profile.firstName, "Avi");
    assert.match(applicant.resumeText, /Growth marketing/);
});

test("no-op without env vars", () => {
    const env = {};
    assert.deepEqual(provisionApplicantFiles(env), []);
    assert.equal(env.PROFILE_PATH, undefined);
    assert.equal(env.RESUME_FILE, undefined);
});

test("explicit path vars win over inline env", () => {
    const env = { PROFILE_JSON: '{"x":1}', PROFILE_PATH: "/existing/profile.json" };
    provisionApplicantFiles(env);
    assert.equal(env.PROFILE_PATH, "/existing/profile.json");
});

test("decodes base64 resume pdf to a file and prefers it over RESUME_TEXT", () => {
    const env = {
        RESUME_PDF_BASE64: Buffer.from("%PDF-1.4 fake").toString("base64"),
        RESUME_TEXT: "should be ignored when a PDF is provided",
    };
    provisionApplicantFiles(env);
    assert.ok(env.RESUME_FILE.endsWith("resume.pdf"));
    assert.equal(readFileSync(env.RESUME_FILE, "utf8"), "%PDF-1.4 fake");
    assert.equal(env.RESUME_PATH, undefined);
});
