import assert from "node:assert/strict";
import { test } from "node:test";
import { annualizedMax, belowSalaryFloor } from "../src/salary.js";

test("annualizedMax reads a yearly USD range (top of band)", () => {
    assert.equal(
        annualizedMax({ min: 150000, max: 180000, currency: "USD", interval: "per-year-salary" }),
        180000,
    );
});

test("annualizedMax annualizes hourly", () => {
    assert.equal(
        annualizedMax({ min: 50, max: 70, currency: "USD", interval: "per-hour-wage" }),
        70 * 2080,
    );
});

test("annualizedMax infers annual from magnitude when interval missing", () => {
    assert.equal(annualizedMax({ min: 140000, max: 160000, currency: "USD" }), 160000);
});

test("annualizedMax returns null for non-USD (never gate)", () => {
    assert.equal(
        annualizedMax({ min: 150000, max: 200000, currency: "EUR", interval: "per-year-salary" }),
        null,
    );
});

test("annualizedMax returns null when no range", () => {
    assert.equal(annualizedMax(null), null);
    assert.equal(annualizedMax({ min: 100 }), null);
});

test("belowSalaryFloor drops a known low-paying job", () => {
    assert.equal(belowSalaryFloor({ salaryAnnualMax: 150000 }, 175000), true);
});

test("belowSalaryFloor keeps a job at or above the floor", () => {
    assert.equal(belowSalaryFloor({ salaryAnnualMax: 200000 }, 175000), false);
    assert.equal(belowSalaryFloor({ salaryAnnualMax: 175000 }, 175000), false);
});

test("belowSalaryFloor keeps unknown-salary jobs (unknown != below)", () => {
    assert.equal(belowSalaryFloor({ salaryAnnualMax: null }, 175000), false);
    assert.equal(belowSalaryFloor({}, 175000), false);
});
