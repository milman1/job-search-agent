import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoverLetterPrompt, parseAnswerResponse } from "../src/answer.js";
import { dailyBudget } from "../src/apply.js";
import { fieldSelectors, submitButtonSelectors } from "../src/browser.js";
import { coverLetterSlug, renderCoverLetterFile } from "../src/coverletter.js";
import { buildApplicationEmbed, buildCoverLetterEmbed } from "../src/discord.js";
import { assemblePacket, coverLetterRequired, questionsToAnswer } from "../src/packet.js";
import { leverStandardForm, normalizeGreenhouseQuestions } from "../src/questions.js";
import { buildGreenhouseSubmission, getSubmitter } from "../src/submit.js";

const APPLICANT = {
    profile: {
        firstName: "Avi",
        lastName: "Milman",
        email: "avi@example.com",
        phone: "+1 555 123 4567",
        linkedin: "https://linkedin.com/in/avi",
    },
    resumeText: "Growth marketing leader, 10+ years B2B SaaS fintech.",
    resumeFilename: "resume.txt",
};

const GH_QUESTIONS = [
    { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text", values: [] }] },
    { label: "Last Name", required: true, fields: [{ name: "last_name", type: "input_text", values: [] }] },
    { label: "Email", required: true, fields: [{ name: "email", type: "input_text", values: [] }] },
    {
        label: "Resume/CV",
        required: true,
        fields: [
            { name: "resume", type: "input_file", values: [] },
            { name: "resume_text", type: "textarea", values: [] },
        ],
    },
    { label: "Cover Letter", required: false, fields: [{ name: "cover_letter_text", type: "textarea", values: [] }] },
    {
        label: "Why do you want to work here?",
        required: true,
        fields: [{ name: "question_1", type: "textarea", values: [] }],
    },
    {
        label: "Country of residence",
        required: true,
        fields: [
            {
                name: "question_2",
                type: "multi_value_single_select",
                values: [
                    { label: "United States", value: 111 },
                    { label: "Canada", value: 222 },
                ],
            },
        ],
    },
];

test("normalizeGreenhouseQuestions flattens fields and tags roles", () => {
    const fields = normalizeGreenhouseQuestions(GH_QUESTIONS);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    assert.equal(byName.first_name.role, "firstName");
    assert.equal(byName.email.role, "email");
    assert.equal(byName.resume.role, "resume");
    assert.equal(byName.resume_text.role, "resumeText");
    assert.equal(byName.cover_letter_text.role, "coverLetterText");
    assert.equal(byName.question_1.role, null);
    assert.equal(byName.question_2.values.length, 2);
});

test("questionsToAnswer returns only custom fields (not profile-mapped)", () => {
    const fields = normalizeGreenhouseQuestions(GH_QUESTIONS);
    const toAnswer = questionsToAnswer(fields).map((f) => f.name);
    assert.deepEqual(toAnswer.sort(), ["question_1", "question_2"]);
});

test("parseAnswerResponse validates selects and drops invalid options", () => {
    const fields = normalizeGreenhouseQuestions(GH_QUESTIONS);
    const questions = questionsToAnswer(fields);
    const parsed = parseAnswerResponse(
        JSON.stringify({
            coverLetter: "Dear team, I would love to join.",
            answers: {
                question_1: "I admire the mission.",
                question_2: "united states",
            },
        }),
        questions,
    );
    assert.equal(parsed.coverLetter, "Dear team, I would love to join.");
    assert.equal(parsed.answers.question_1.value, "I admire the mission.");
    assert.equal(parsed.answers.question_2.value, 111);

    const bad = parseAnswerResponse(
        JSON.stringify({ coverLetter: "x", answers: { question_2: "Narnia" } }),
        questions,
    );
    assert.equal(bad.answers.question_2, undefined);
});

test("parseAnswerResponse resolves multi-select arrays", () => {
    const questions = [
        {
            name: "q[]",
            type: "multi_value_multi_select",
            values: [
                { label: "US", value: 1 },
                { label: "UK", value: 2 },
            ],
        },
    ];
    const parsed = parseAnswerResponse(
        JSON.stringify({ coverLetter: "", answers: { "q[]": ["US", "UK"] } }),
        questions,
    );
    assert.deepEqual(parsed.answers["q[]"].value, [1, 2]);
});

test("parseAnswerResponse survives garbage", () => {
    const parsed = parseAnswerResponse("not json", []);
    assert.deepEqual(parsed, { coverLetter: "", answers: {} });
});

test("assemblePacket fills profile fields, cover letter, and flags missing", () => {
    const form = { source: "greenhouse", applyUrl: "https://x/1", complete: true, fields: normalizeGreenhouseQuestions(GH_QUESTIONS) };
    const generated = {
        coverLetter: "Tailored letter.",
        answers: {
            question_1: { display: "Because mission.", value: "Because mission." },
            question_2: { display: "United States", value: 111 },
        },
    };
    const packet = assemblePacket({ job: { title: "Head of Growth", company: "Ramp", url: "https://x/1", slug: "ramp", atsJobId: 1 }, form, applicant: APPLICANT, generated });
    assert.equal(packet.ready, true);
    assert.equal(packet.missing.length, 0);
    const byName = Object.fromEntries(packet.fields.map((f) => [f.name, f]));
    assert.equal(byName.first_name.value, "Avi");
    assert.equal(byName.email.value, "avi@example.com");
    assert.equal(byName.resume_text.value, APPLICANT.resumeText);
    assert.equal(byName.cover_letter_text.value, "Tailored letter.");
    assert.equal(byName.question_1.source, "generated");
});

test("assemblePacket marks unfilled required custom question as missing", () => {
    const form = { source: "greenhouse", applyUrl: "https://x/1", complete: true, fields: normalizeGreenhouseQuestions(GH_QUESTIONS) };
    const packet = assemblePacket({ job: { title: "T", company: "C", url: "https://x/1" }, form, applicant: APPLICANT, generated: { coverLetter: "hi", answers: {} } });
    assert.equal(packet.ready, false);
    assert.ok(packet.missing.includes("Why do you want to work here?"));
    assert.ok(packet.missing.includes("Country of residence"));
});

test("lever forms are never auto-ready (custom questions hidden from API)", () => {
    const form = leverStandardForm({ url: "https://jobs.lever.co/x/1", applyUrl: "https://jobs.lever.co/x/1/apply" });
    const packet = assemblePacket({ job: { title: "T", company: "C", url: "https://jobs.lever.co/x/1" }, form, applicant: APPLICANT, generated: { coverLetter: "", answers: {} } });
    assert.equal(packet.formComplete, false);
    assert.equal(packet.ready, false);
});

test("buildGreenhouseSubmission maps fields, selects, and resume_text", () => {
    const form = { source: "greenhouse", applyUrl: "https://x/1?gh_jid=1", complete: true, fields: normalizeGreenhouseQuestions(GH_QUESTIONS) };
    const generated = {
        coverLetter: "Letter.",
        answers: {
            question_1: { display: "ans", value: "ans" },
            question_2: { display: "United States", value: 111 },
        },
    };
    const packet = assemblePacket({ job: { title: "T", company: "C", url: "https://x/1?gh_jid=1", slug: "s", atsJobId: 1 }, form, applicant: APPLICANT, generated });
    const { body } = buildGreenhouseSubmission(packet);
    assert.equal(body.get("first_name"), "Avi");
    assert.equal(body.get("email"), "avi@example.com");
    assert.equal(body.get("resume_text"), APPLICANT.resumeText);
    assert.equal(body.get("question_1"), "ans");
    assert.equal(body.get("question_2"), "111");
    assert.equal(body.has("resume"), false);
});

test("getSubmitter defaults to prepare and never submits", async () => {
    const submitter = await getSubmitter({});
    assert.equal(submitter.mode, "prepare");
    const result = await submitter.submit({ ready: true });
    assert.deepEqual(result, { submitted: false, status: "prepared" });
});

test("getSubmitter falls back to prepare when greenhouse token missing", async () => {
    const submitter = await getSubmitter({ APPLY_MODE: "greenhouse-api" });
    assert.equal(submitter.mode, "prepare");
});

test("getSubmitter falls back to prepare when browser creds missing", async () => {
    const submitter = await getSubmitter({ APPLY_MODE: "browser" });
    assert.equal(submitter.mode, "prepare");
});

test("buildApplicationEmbed summarizes state, missing fields, and cover letter", () => {
    const packet = {
        job: { title: "Head of Growth", company: "Ramp", url: "https://x/1" },
        applyUrl: "https://x/1",
        source: "greenhouse",
        formComplete: true,
        ready: false,
        missing: ["Country of residence"],
        coverLetter: "Tailored letter.",
        fields: [
            { label: "Why?", name: "question_1", source: "generated", display: "Because." },
            { label: "First Name", name: "first_name", source: "profile", display: "Avi" },
        ],
    };
    const embed = buildApplicationEmbed(packet, { submitted: false });
    assert.match(embed.title, /Head of Growth/);
    assert.match(embed.description, /Needs you:\*\* Country of residence/);
    assert.match(embed.description, /Tailored letter\./);
    assert.equal(embed.color, 0xf59e0b);
    assert.equal(embed.fields.length, 1);
    assert.equal(embed.fields[0].name, "Why?");
});

test("coverLetterSlug produces a filesystem-safe base name", () => {
    assert.equal(
        coverLetterSlug({ company: "Ramp", title: "Head of Growth & Marketing!" }),
        "ramp-head-of-growth-marketing",
    );
    assert.equal(coverLetterSlug({ company: "", title: "" }), "cover-letter");
});

test("renderCoverLetterFile includes header, apply link, and body", () => {
    const out = renderCoverLetterFile(
        { title: "Head of Growth", company: "Ramp", url: "https://x/1" },
        "Dear hiring team, ...",
    );
    assert.match(out, /# Head of Growth — Ramp/);
    assert.match(out, /Apply: https:\/\/x\/1/);
    assert.match(out, /Dear hiring team/);
});

test("buildCoverLetterPrompt grounds on the resume and forbids invention", () => {
    const prompt = buildCoverLetterPrompt({
        job: { title: "Head of Growth", company: "Ramp", jdText: "Own demand gen." },
        profile: { firstName: "Avi", lastName: "Milman", location: "NYC" },
        resumeText: "Drove $6.4M pipeline.",
    });
    assert.match(prompt, /Head of Growth at Ramp/);
    assert.match(prompt, /Avi Milman/);
    assert.match(prompt, /\$6\.4M pipeline/);
    assert.match(prompt, /never invent/i);
});

test("coverLetterRequired is true only when a required cover-letter field exists", () => {
    const optional = normalizeGreenhouseQuestions(GH_QUESTIONS);
    assert.equal(coverLetterRequired({ fields: optional }), false);

    const required = normalizeGreenhouseQuestions([
        { label: "Cover Letter", required: true, fields: [{ name: "cover_letter_text", type: "textarea", values: [] }] },
    ]);
    assert.equal(coverLetterRequired({ fields: required }), true);
});

test("dailyBudget clamps to remaining daily allowance and per-run cap", () => {
    assert.equal(dailyBudget({ dailyMax: 3, todayCount: 0, perRunCap: 5 }), 3);
    assert.equal(dailyBudget({ dailyMax: 3, todayCount: 2, perRunCap: 5 }), 1);
    assert.equal(dailyBudget({ dailyMax: 3, todayCount: 3, perRunCap: 5 }), 0);
    assert.equal(dailyBudget({ dailyMax: 3, todayCount: 5, perRunCap: 5 }), 0);
    assert.equal(dailyBudget({ dailyMax: 10, todayCount: 0, perRunCap: 2 }), 2);
});

test("fieldSelectors returns name and id candidates, handling [] suffix", () => {
    assert.deepEqual(fieldSelectors("first_name"), ['[name="first_name"]', "#first_name"]);
    const multi = fieldSelectors("question_9[]");
    assert.ok(multi.includes('[name="question_9[]"]'));
    assert.ok(multi.includes('[name="question_9"]'));
    assert.ok(multi.includes("#question_9"));
});

test("submitButtonSelectors lists submit/apply candidates", () => {
    const sels = submitButtonSelectors();
    assert.ok(sels.includes('button[type="submit"]'));
    assert.ok(sels.some((s) => /Submit Application/.test(s)));
});

test("buildCoverLetterEmbed formats title, body, and apply link", () => {
    const embed = buildCoverLetterEmbed(
        { title: "Head of Growth", company: "Ramp", url: "https://x/1", location: "NYC" },
        "Dear team, I would love to join.",
    );
    assert.equal(embed.title, "Cover letter: Head of Growth");
    assert.match(embed.description, /Dear team, I would love to join\./);
    assert.match(embed.description, /\[Apply →\]\(https:\/\/x\/1\)/);
    assert.equal(embed.color, 0x5865f2);
});
