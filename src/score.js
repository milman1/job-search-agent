const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

export const FALLBACK = Object.freeze({
    score: 5,
    verdict: "Review manually",
    topAngle: "",
    watchPoint: "",
    salaryFit: null,
});

function buildPrompt(job, salaryFloor) {
    const floorK = Math.round(salaryFloor / 1000);
    return `Score this job for the candidate. Return ONLY valid JSON no markdown.
CANDIDATE: Avi Milman, Growth Marketing Leader. 10+ years B2B SaaS Fintech. Opto Invest: 1.2M budget, 6.4M pipeline, 3M ARR, CAC -19%, close rate 21 to 29 percent. Founded GTM: 1.8M pipeline 6 months, 15-20 meetings/week. Code Climate: MQL +86%, pipeline +57%. State Street fund ops. Target: Head/VP/Senior Marketing Manager. Salary floor ${floorK}K (minimum acceptable; salaryFit=false below this). NYC metro or Remote US.
JOB: ${job.title} at ${job.company}
${job.jdText}
Return JSON only with keys: score (number 1-10), verdict (8 words max), topAngle (single best emphasis), watchPoint (gap or none), salaryFit (boolean)`;
}

export function parseScoreResponse(text) {
    try {
        const cleaned = String(text)
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
        const score = Math.min(10, Math.max(1, Math.round(Number(parsed.score))));
        if (!Number.isFinite(score)) throw new Error("no numeric score");
        return {
            score,
            verdict: String(parsed.verdict ?? "").slice(0, 200) || FALLBACK.verdict,
            topAngle: String(parsed.topAngle ?? "").slice(0, 500),
            watchPoint: String(parsed.watchPoint ?? "").slice(0, 500),
            salaryFit: typeof parsed.salaryFit === "boolean" ? parsed.salaryFit : null,
        };
    } catch {
        return { ...FALLBACK };
    }
}

export async function scoreJob(job, apiKey, salaryFloor = 175_000) {
    try {
        const res = await fetch(ANTHROPIC_URL, {
            method: "POST",
            signal: AbortSignal.timeout(60_000),
            headers: {
                "content-type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 400,
                messages: [{ role: "user", content: buildPrompt(job, salaryFloor) }],
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        const text = (data.content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
        return parseScoreResponse(text);
    } catch (err) {
        console.log(
            `score failed for "${job.title}" at ${job.company}: ${err instanceof Error ? err.message : err}`,
        );
        return { ...FALLBACK };
    }
}
