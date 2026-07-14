// Structured salary handling for the hard salary-floor gate.
//
// We only gate on a *reliable* number. Lever exposes a real salaryRange
// {min,max,currency,interval}; Greenhouse's API generally doesn't, so those
// postings have an unknown salary and are never gated (kept, not dropped).

// Annualization factors by pay interval. Lever intervals look like
// "per-year-salary", "per-hour-wage", etc.
function intervalFactor(interval, max) {
    const s = String(interval || "").toLowerCase();
    if (s.includes("year")) return 1;
    if (s.includes("month")) return 12;
    if (s.includes("week")) return 52;
    if (s.includes("day")) return 260;
    if (s.includes("hour")) return 2080;
    // Unknown interval: infer from magnitude — a max >= 1000 is an annual
    // salary (nobody's hourly/daily rate is in the thousands); below that we
    // can't tell, so don't gate.
    return typeof max === "number" && max >= 1000 ? 1 : null;
}

// Highest annual figure a posting could pay, or null when unknown / not
// confidently comparable (non-USD, un-annualizable). Uses the TOP of the band:
// if even the max is below the floor, the job definitely can't meet it.
export function annualizedMax(range) {
    if (!range || typeof range.max !== "number") return null;
    const currency = String(range.currency || "USD").toUpperCase();
    // Only gate USD (or unspecified) so a higher-numbered foreign currency
    // (or a genuinely-different one) never causes a wrong drop.
    if (currency !== "USD") return null;
    const factor = intervalFactor(range.interval, range.max);
    if (factor == null) return null;
    return range.max * factor;
}

// True only when the posting has a KNOWN salary whose top of band is below the
// floor. Unknown salary → false (don't drop).
export function belowSalaryFloor(job, floor) {
    return typeof job.salaryAnnualMax === "number" && job.salaryAnnualMax < floor;
}
