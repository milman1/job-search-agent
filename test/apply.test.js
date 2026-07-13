import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnswerResponse } from "../src/answer.js";
import { buildApplicationEmbed } from "../src/discord.js";
import { assemblePacket, questionsToAnswer } from "../src/packet.js";
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
    const submitter = getSubmitter({});
    assert.equal(submitter.mode, "prepare");
    const result = await submitter.submit({ ready: true });
    assert.deepEqual(result, { submitted: false, status: "prepared" });
});

test("getSubmitter falls back to prepare when greenhouse token missing", () => {
    const submitter = getSubmitter({ APPLY_MODE: "greenhouse-api" });
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
