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

const BLUE = 0x5865f2;
const ORANGE = 0xf59e0b;
const FIELD_VALUE_MAX = 1024;

// Builds an embed summarizing a prepared/submitted application packet: what was
// auto-filled, what still needs a human, the cover letter, and the apply link.
export function buildApplicationEmbed(packet, result) {
    const filled = packet.fields.filter((f) => f.source !== "unfilled").length;
    const statusLine = result?.submitted
        ? "✅ Submitted"
        : packet.ready
          ? "📝 Ready to submit"
          : "⚠️ Needs review before submitting";

    const lines = [
        `**${packet.job.company}** — ${packet.source}`,
        statusLine,
        `Fields filled: ${filled}/${packet.fields.length}`,
    ];
    if (packet.missing.length > 0) {
        lines.push(`**Needs you:** ${packet.missing.join(", ")}`);
    }
    if (!packet.formComplete) {
        lines.push("_Note: this board hides custom questions from the API — review the form._");
    }
    if (packet.coverLetter) {
        lines.push("", "**Cover letter:**", packet.coverLetter);
    }
    lines.push("", `[Open application →](${packet.applyUrl})`);

    return {
        title: `Application: ${packet.job.title}`.slice(0, 256),
        description: lines.join("\n").slice(0, DESC_MAX),
        color: packet.ready || result?.submitted ? BLUE : ORANGE,
        fields: packet.fields
            .filter(
                (f) =>
                    f.source === "generated" &&
                    f.role !== "coverLetter" &&
                    f.role !== "coverLetterText" &&
                    f.display,
            )
            .slice(0, 10)
            .map((f) => ({
                name: f.label.slice(0, 256),
                value: String(f.display).slice(0, FIELD_VALUE_MAX),
                inline: false,
            })),
    };
}

export async function postApplication(webhookUrl, packet, result) {
    try {
        const res = await fetch(webhookUrl, {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ embeds: [buildApplicationEmbed(packet, result)] }),
        });
        if (!res.ok) {
            throw new Error(`Discord HTTP ${res.status}: ${await res.text()}`);
        }
        return true;
    } catch (err) {
        console.log(
            `discord application post failed for ${packet.applyUrl}: ${err instanceof Error ? err.message : err}`,
        );
        return false;
    }
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
