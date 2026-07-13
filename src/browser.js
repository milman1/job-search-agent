// Cloud browser worker (Browserbase + Playwright). It fills each application
// form and uploads the resume file in a remote browser. What happens next
// depends on your plan/config:
//
//   * Paid Browserbase (keepAlive): the session outlives our run, so we hand
//     back a live-view link and you finish on your phone whenever.
//   * Free Browserbase: the session ends when our run disconnects, so by
//     default we auto-submit (fill + solve captcha + click Submit) — but only
//     when every required field was filled; otherwise the form is held for
//     review. Set BROWSER_AUTO_SUBMIT=0 for review-only, optionally with
//     BROWSER_REVIEW_WINDOW to hold the session open while you act via the link.
//
// Captcha solving (browserSettings.solveCaptchas) is on by default.
//
// NOTE: live submission depends on your Browserbase account and a real form, so
// this path could not be exercised in the build environment; the fill + submit
// logic is best-effort and logs per-field outcomes.

const BROWSERBASE_API = "https://api.browserbase.com/v1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Candidate CSS selectors for a form field, most specific first. Greenhouse and
// Lever both expose `name` attributes matching the API field names, and often
// matching ids too; we try several so a small markup difference doesn't break
// filling. Pure + exported for testing.
export function fieldSelectors(name) {
    const raw = name.replace(/\[\]$/, "");
    const idSafe = raw.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    return [...new Set([`[name="${name}"]`, `[name="${raw}"]`, `#${idSafe}`])];
}

// Common "submit / apply" button selectors, most specific first. Pure +
// exported for testing.
export function submitButtonSelectors() {
    return [
        'button[type="submit"]',
        'input[type="submit"]',
        "button#submit_app",
        'button:has-text("Submit Application")',
        'button:has-text("Submit application")',
        'button:has-text("Submit")',
        'button:has-text("Apply")',
    ];
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

async function clickSubmit(page) {
    const button = await firstVisible(page, submitButtonSelectors());
    if (!button) return false;
    try {
        await button.click({ timeout: 15_000 });
        // Give the form a moment to post / navigate before we disconnect.
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
        return true;
    } catch {
        return false;
    }
}

async function createSession(env) {
    const timeout = Number(env.BROWSERBASE_TIMEOUT) || 3600;
    const payload = {
        // keepAlive keeps the session alive after we disconnect so you can take
        // over later from your phone — but it's a PAID Browserbase feature, so
        // it's opt-in and off by default (free plans can't use it).
        keepAlive: env.BROWSERBASE_KEEP_ALIVE === "1",
        timeout,
        // Let Browserbase attempt captchas automatically (on unless disabled).
        browserSettings: { solveCaptchas: env.BROWSERBASE_SOLVE_CAPTCHAS !== "0" },
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

// Builds a submitter that fills the form in a remote browser. Requires
// Browserbase creds + playwright-core; the caller (getSubmitter) falls back to
// prepare mode when they're missing. `notify(packet, result)` (optional) is
// called as soon as the review link is ready so free-plan users can act during
// the open review window.
export function browserSubmitter(env) {
    // Auto-submit is the default for browser mode; set BROWSER_AUTO_SUBMIT=0 to
    // switch to review-only (fill + hand you the live link).
    const autoSubmit = env.BROWSER_AUTO_SUBMIT !== "0";
    const reviewWindowMs = (Number(env.BROWSER_REVIEW_WINDOW) || 0) * 1000;

    return {
        mode: "browser",
        async submit(packet, { applicant, notify } = {}) {
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

                // Only auto-submit when every required field was fillable. An
                // incomplete packet (or any Lever form, whose questions aren't
                // exposed) is held for review instead of submitted blind.
                if (autoSubmit && packet.ready) {
                    const clicked = await clickSubmit(page);
                    const result = {
                        submitted: clicked,
                        status: clicked ? "submitted-auto" : "submit-button-not-found",
                        reviewUrl,
                        sessionId: session.id,
                        detail: `filled ${filled} field(s), ${failed} skipped`,
                    };
                    if (notify) {
                        await notify(packet, result);
                        result.notified = true;
                    }
                    return result;
                }

                const heldReason = autoSubmit
                    ? `not auto-submitted — ${packet.missing.length ? `missing: ${packet.missing.join(", ")}` : "form not fully verifiable"}`
                    : "awaiting your review";
                const result = {
                    submitted: false,
                    status: autoSubmit ? "held-for-review" : "awaiting-review",
                    reviewUrl,
                    sessionId: session.id,
                    detail: `filled ${filled} field(s), ${failed} left for review — ${heldReason}`,
                };
                // Post the review link now, then hold the connection open so a
                // free-plan session stays alive while you act on your phone.
                if (notify) {
                    await notify(packet, result);
                    result.notified = true;
                }
                if (reviewWindowMs > 0) await sleep(reviewWindowMs);
                return result;
            } catch (err) {
                return { submitted: false, status: "fill-failed", detail: String(err.message || err) };
            } finally {
                if (browser) await browser.close().catch(() => {});
            }
        },
    };
}
