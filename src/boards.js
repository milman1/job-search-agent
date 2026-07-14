import { buildJdText, titleMatches } from "./filter.js";
import { annualizedMax } from "./salary.js";

const FETCH_TIMEOUT_MS = 15_000;

function companyName(slug) {
    return slug.charAt(0).toUpperCase() + slug.slice(1);
}

async function fetchJson(url) {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function formatLeverSalary(range) {
    if (!range || typeof range.min !== "number" || typeof range.max !== "number") {
        return "";
    }
    const currency = range.currency || "USD";
    const interval = range.interval ? ` per ${range.interval.replace(/-/g, " ")}` : "";
    return `${currency} ${range.min.toLocaleString("en-US")}-${range.max.toLocaleString("en-US")}${interval}`;
}

async function fetchGreenhouse(slug) {
    const data = await fetchJson(
        `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
    );
    return (data.jobs ?? [])
        .filter((job) => titleMatches(job.title))
        .map((job) => ({
            title: job.title,
            company: companyName(slug),
            url: job.absolute_url,
            location: job.location?.name ?? "",
            salary: "",
            salaryAnnualMax: null, // Greenhouse API doesn't expose a structured range
            source: "greenhouse",
            slug,
            atsJobId: job.id,
            jdText: buildJdText({
                location: job.location?.name,
                description: job.content,
                decodeFirst: true,
            }),
        }));
}

async function fetchLever(slug) {
    const postings = await fetchJson(
        `https://api.lever.co/v0/postings/${slug}?mode=json`,
    );
    if (!Array.isArray(postings)) throw new Error("unexpected response shape");
    return postings
        .filter((job) => titleMatches(job.text))
        .map((job) => ({
            title: job.text,
            company: companyName(slug),
            url: job.hostedUrl,
            location: job.categories?.location ?? "",
            salary: formatLeverSalary(job.salaryRange),
            salaryAnnualMax: annualizedMax(job.salaryRange),
            source: "lever",
            slug,
            atsJobId: job.id,
            applyUrl: job.applyUrl ?? `${job.hostedUrl}/apply`,
            jdText: buildJdText({
                location: job.categories?.location,
                description: job.descriptionPlain || job.description,
                decodeFirst: false,
            }),
        }));
}

async function pool(items, limit, fn) {
    const results = [];
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, worker),
    );
    return results;
}

// Polls every company board; per-company failures (404s, timeouts, bad
// slugs) are logged and skipped so one dead board never kills the run.
export async function pollBoards(companies, concurrency = 5) {
    let failed = 0;
    const perCompany = await pool(companies, concurrency, async (company) => {
        try {
            return company.ats === "lever"
                ? await fetchLever(company.slug)
                : await fetchGreenhouse(company.slug);
        } catch (err) {
            failed++;
            console.log(
                `skip ${company.ats}:${company.slug} (${err instanceof Error ? err.message : err})`,
            );
            return [];
        }
    });
    return { jobs: perCompany.flat(), failed };
}
