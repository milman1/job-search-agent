// Cloud browser worker (Browserbase + Playwright). It fills each application
// form and uploads the resume file in a remote browser, then leaves the session
// alive and hands back a shareable live-view URL so you can solve the reCAPTCHA
// and hit Submit from any device (e.g. your phone). Your computer stays off.
//
// Nothing here auto-submits — the final click is always yours, which is both
// what these sites require (captcha) and the safe default.
//
// NOTE: live submission depends on your Browserbase account and a real form, so
// this path could not be exercised in the build environment; the fill logic is
// best-effort and logs per-field outcomes.

const BROWSERBASE_API = "https://api.browserbase.com/v1";

// Candidate CSS selectors for a form field, most specific first. Greenhouse and
// Lever both expose `name` attributes matching the API field names, and often
// matching ids too; we try several so a small markup difference doesn't break
// filling. Pure + exported for testing.
export function fieldSelectors(name) {
    const raw = name.replace(/\[\]$/, "");
    const idSafe = raw.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    return [...new Set([`[name="${name}"]`, `[name="${raw}"]`, `#${idSafe}`])];
}

async function firstVisible(page, selectors) {
    for (const selector of selectors) {
        const el = page.locator(selector).first();
        if ((await el.count()) > 0) return el;
    }
    return null;
}

// Best-effort fill of one packet into a live page. Returns {filled, failed}.
export async function fillForm(page, packet, resumeFile) {
    let filled = 0;
    let failed = 0;

    for (const field of packet.fields) {
        if (field.source === "unfilled" || field.value == null) continue;
        try {
            if (field.role === "resume") {
                const input = await firstVisible(page, [
                    'input[type="file"][name="resume"]',
                    'input[type="file"][name="resume/cv"]',
                    'input[type="file"]',
                ]);
                if (input && resumeFile) {
                    await input.setInputFiles(resumeFile);
                    filled++;
                } else {
                    failed++;
                }
                continue;
            }

            const el = await firstVisible(page, fieldSelectors(field.name));
            if (!el) {
                failed++;
                continue;
            }
            const tag = (await el.evaluate((node) => node.tagName)).toLowerCase();
            if (tag === "select") {
                const values = Array.isArray(field.value) ? field.value : [field.value];
                await el.selectOption(values.map((v) => ({ value: String(v) })));
            } else {
                await el.fill(String(Array.isArray(field.value) ? field.value.join(", ") : field.value));
            }
            filled++;
        } catch {
            // Custom dropdowns / dynamic widgets may not fill cleanly; leave
            // them for the human review step rather than aborting the run.
            failed++;
        }
    }
    return { filled, failed };
}

async function createSession(env) {
    const timeout = Number(env.BROWSERBASE_TIMEOUT) || 3600;
    const payload = {
        // keepAlive lets the session outlive our process so you can take over
        // later from your phone (requires a paid Browserbase plan).
        keepAlive: true,
        timeout,
    };
    // projectId is optional — Browserbase infers it from the API key.
    if (env.BROWSERBASE_PROJECT_ID) payload.projectId = env.BROWSERBASE_PROJECT_ID;

    const res = await fetch(`${BROWSERBASE_API}/sessions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bb-api-key": env.BROWSERBASE_API_KEY,
        },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        throw new Error(`Browserbase session create failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    }
    return res.json();
}

async function liveViewUrl(sessionId, env) {
    const res = await fetch(`${BROWSERBASE_API}/sessions/${sessionId}/debug`, {
        headers: { "x-bb-api-key": env.BROWSERBASE_API_KEY },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.debuggerFullscreenUrl || data.debuggerUrl || null;
}

// Builds a submitter that fills the form in a remote browser and returns a
// review link. Requires Browserbase creds + playwright-core; the caller
// (getSubmitter) falls back to prepare mode when they're missing.
export function browserSubmitter(env) {
    return {
        mode: "browser",
        async submit(packet, { applicant } = {}) {
            let chromium;
            try {
                ({ chromium } = await import("playwright-core"));
            } catch {
                return { submitted: false, status: "playwright-missing" };
            }

            let session;
            try {
                session = await createSession(env);
            } catch (err) {
                return { submitted: false, status: "session-failed", detail: String(err.message || err) };
            }

            let browser;
            try {
                browser = await chromium.connectOverCDP(session.connectUrl);
                const context = browser.contexts()[0] ?? (await browser.newContext());
                const page = context.pages()[0] ?? (await context.newPage());
                await page.goto(packet.applyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
                const { filled, failed } = await fillForm(page, packet, applicant?.resumeFile);
                const reviewUrl = await liveViewUrl(session.id, env);
                return {
                    submitted: false,
                    status: "awaiting-review",
                    reviewUrl,
                    sessionId: session.id,
                    detail: `filled ${filled} field(s), ${failed} left for review`,
                };
            } catch (err) {
                return { submitted: false, status: "fill-failed", detail: String(err.message || err) };
            } finally {
                // Disconnect but leave the (keepAlive) session running for you.
                if (browser) await browser.close().catch(() => {});
            }
        },
    };
}
