const GREEN = 0x57f287;
const YELLOW = 0xfee75c;
const DESC_MAX = 4096;

export function buildEmbed(job, scored) {
    const lines = [`**${job.company}**`];
    if (job.location) lines.push(`📍 ${job.location}`);
    if (job.salary) lines.push(`💰 ${job.salary}`);
    lines.push(
        "",
        `**Verdict:** ${scored.verdict}`,
        `**Angle:** ${scored.topAngle || "—"}`,
        `**Watch:** ${scored.watchPoint || "none"}`,
        "",
        `[Apply →](${job.url})`,
    );
    return {
        title: `${scored.score}/10 - ${job.title}`.slice(0, 256),
        description: lines.join("\n").slice(0, DESC_MAX),
        color: scored.score >= 8 ? GREEN : YELLOW,
    };
}

export async function postToDiscord(webhookUrl, job, scored) {
    try {
        const res = await fetch(webhookUrl, {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ embeds: [buildEmbed(job, scored)] }),
        });
        if (!res.ok) {
            throw new Error(`Discord HTTP ${res.status}: ${await res.text()}`);
        }
        return true;
    } catch (err) {
        console.log(
            `discord post failed for ${job.url}: ${err instanceof Error ? err.message : err}`,
        );
        return false;
    }
}
