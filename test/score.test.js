import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEmbed } from "../src/discord.js";
import { FALLBACK, parseScoreResponse } from "../src/score.js";

test("parses clean JSON", () => {
    const parsed = parseScoreResponse(
        '{"score": 8, "verdict": "Strong fintech fit", "topAngle": "Opto pipeline", "watchPoint": "none", "salaryFit": true}',
    );
    assert.equal(parsed.score, 8);
    assert.equal(parsed.salaryFit, true);
});

test("strips markdown fences", () => {
    const parsed = parseScoreResponse(
        '```json\n{"score": 7, "verdict": "ok", "topAngle": "a", "watchPoint": "b", "salaryFit": false}\n```',
    );
    assert.equal(parsed.score, 7);
    assert.equal(parsed.salaryFit, false);
});

test("extracts JSON embedded in prose", () => {
    const parsed = parseScoreResponse(
        'Here is the assessment: {"score": 9, "verdict": "great", "topAngle": "x", "watchPoint": "none", "salaryFit": true} hope that helps',
    );
    assert.equal(parsed.score, 9);
});

test("clamps out-of-range scores", () => {
    assert.equal(parseScoreResponse('{"score": 14, "verdict": "v"}').score, 10);
    assert.equal(parseScoreResponse('{"score": -2, "verdict": "v"}').score, 1);
});

test("falls back to score 5 Review manually on garbage", () => {
    for (const garbage of ["not json at all", '{"broken": ', "", null, '{"score": "NaN-ish"}']) {
        const parsed = parseScoreResponse(garbage);
        assert.equal(parsed.score, FALLBACK.score);
        assert.equal(parsed.verdict, FALLBACK.verdict);
        assert.equal(parsed.salaryFit, null);
    }
});

test("discord embed formats title, color, and link", () => {
    const job = {
        title: "Head of Growth",
        company: "Ramp",
        url: "https://jobs.example/1",
        location: "NYC",
        salary: "USD 180,000-220,000 per year",
    };
    const green = buildEmbed(job, {
        score: 9,
        verdict: "Excellent",
        topAngle: "Fintech depth",
        watchPoint: "none",
    });
    assert.equal(green.title, "9/10 - Head of Growth");
    assert.equal(green.color, 0x57f287);
    assert.match(green.description, /\[Apply →\]\(https:\/\/jobs\.example\/1\)/);
    assert.match(green.description, /USD 180,000-220,000/);

    const yellow = buildEmbed(job, { score: 7, verdict: "v", topAngle: "", watchPoint: "" });
    assert.equal(yellow.color, 0xfee75c);
});
