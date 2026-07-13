// Submission is intentionally pluggable. The default `prepare` submitter never
// contacts an employer — it just marks the packet ready for human review/submit
// (the honest default, since Greenhouse submission needs the employer's private
// Board Token and Lever's hosted form is reCAPTCHA-protected).
//
// A real backend — an employer/ATS-owner API key, or a browser-automation
// worker you run yourself — can be dropped in behind this same interface with
// the packet already fully built.

function prepareSubmitter() {
    return {
        mode: "prepare",
        async submit() {
            return { submitted: false, status: "prepared" };
        },
    };
}

// Builds the Greenhouse Job Board API submission body from a ready packet.
// Pure + exported so it can be unit-tested without hitting the network.
// NOTE: the POST endpoint requires the EMPLOYER'S Board Token API key (Basic
// auth). Job seekers don't have this; it's provided for ATS owners / testing.
export function buildGreenhouseSubmission(packet) {
    const body = new URLSearchParams();
    for (const field of packet.fields) {
        if (field.source === "unfilled" || field.value == null) continue;

        if (field.name === "resume") {
            // We carry resume text, not a binary upload, so use resume_text.
            const content = typeof field.value === "object" ? field.value.content : field.value;
            if (content) body.set("resume_text", String(content));
            continue;
        }
        if (Array.isArray(field.value)) {
            const key = field.name.endsWith("[]") ? field.name : `${field.name}[]`;
            for (const v of field.value) body.append(key, String(v));
            continue;
        }
        body.set(field.name, String(field.value));
    }
    return {
        url: packet.applyUrl,
        body,
    };
}

function greenhouseApiSubmitter(token) {
    return {
        mode: "greenhouse-api",
        async submit(packet) {
            if (packet.source !== "greenhouse") {
                return { submitted: false, status: "unsupported-source" };
            }
            if (!packet.ready) {
                return { submitted: false, status: "not-ready", missing: packet.missing };
            }
            const jobId = packet.applyUrl.match(/gh_jid=(\d+)/)?.[1] ?? packet.applyUrl.split("/").pop();
            const slug = packet.job?.slug;
            const endpoint = slug && jobId
                ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}`
                : null;
            if (!endpoint) return { submitted: false, status: "no-endpoint" };

            const { body } = buildGreenhouseSubmission(packet);
            try {
                const res = await fetch(endpoint, {
                    method: "POST",
                    signal: AbortSignal.timeout(30_000),
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`,
                    },
                    body,
                });
                if (!res.ok) {
                    const text = await res.text().catch(() => "");
                    return { submitted: false, status: `http-${res.status}`, detail: text.slice(0, 200) };
                }
                return { submitted: true, status: "submitted" };
            } catch (err) {
                return { submitted: false, status: "error", detail: err instanceof Error ? err.message : String(err) };
            }
        },
    };
}

export function getSubmitter(env = process.env) {
    const mode = env.APPLY_MODE || "prepare";
    if (mode === "greenhouse-api") {
        const token = env.GREENHOUSE_BOARD_TOKEN;
        if (!token) {
            console.log("APPLY_MODE=greenhouse-api but GREENHOUSE_BOARD_TOKEN is not set; falling back to prepare.");
            return prepareSubmitter();
        }
        return greenhouseApiSubmitter(token);
    }
    return prepareSubmitter();
}
