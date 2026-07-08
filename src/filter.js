export const TITLE_REGEX =
    /head of marketing|vp.{0,3}marketing|vice president.{0,3}marketing|director of marketing|marketing director|senior marketing manager|marketing lead|head of growth|director of growth|growth marketing (lead|manager|director)|senior (manager|director).{0,3}(growth|demand|marketing)|demand gen(eration)? (manager|director|lead)/i;

export function titleMatches(title) {
    return TITLE_REGEX.test(title ?? "");
}

const NAMED_ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
    hellip: "…",
    bull: "•",
};

export function decodeEntities(text) {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

export function stripHtml(html) {
    return html
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section)>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

const JD_MAX_CHARS = 2500;

// Greenhouse `content` is entity-encoded HTML (decode first); Lever
// descriptions are plain HTML or already-plain text.
export function buildJdText({ location, description, decodeFirst }) {
    let text = description ?? "";
    if (decodeFirst) text = decodeEntities(text);
    text = stripHtml(text);
    const withLocation = `Location: ${location || "unspecified"}\n\n${text}`;
    return withLocation.length > JD_MAX_CHARS
        ? withLocation.slice(0, JD_MAX_CHARS)
        : withLocation;
}
