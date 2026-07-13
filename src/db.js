import { createClient } from "@supabase/supabase-js";

const CHUNK = 200;
const UNIQUE_VIOLATION = "23505";

export function makeDb(url, serviceKey) {
    const supabase = createClient(url, serviceKey, {
        auth: { persistSession: false },
    });

    return {
        // Returns the subset of `urls` already present in job_leads.
        async existingUrls(urls) {
            const seen = new Set();
            for (let i = 0; i < urls.length; i += CHUNK) {
                const chunk = urls.slice(i, i + CHUNK);
                const { data, error } = await supabase
                    .from("job_leads")
                    .select("url")
                    .in("url", chunk);
                if (error) throw new Error(`Supabase select failed: ${error.message}`);
                for (const row of data ?? []) seen.add(row.url);
            }
            return seen;
        },

        // Inserts one lead; unique-violation (already inserted by a
        // concurrent/prior run) is ignored, other errors are logged.
        async insertLead(row) {
            const { error } = await supabase.from("job_leads").insert(row);
            if (error && error.code !== UNIQUE_VIOLATION) {
                console.log(`insert failed for ${row.url}: ${error.message}`);
                return false;
            }
            return !error;
        },

        // Returns the subset of `urls` we've already built an application for,
        // so a job is never applied to twice.
        async existingApplications(urls) {
            const seen = new Set();
            for (let i = 0; i < urls.length; i += CHUNK) {
                const chunk = urls.slice(i, i + CHUNK);
                const { data, error } = await supabase
                    .from("applications")
                    .select("url")
                    .in("url", chunk);
                if (error) throw new Error(`Supabase select failed: ${error.message}`);
                for (const row of data ?? []) seen.add(row.url);
            }
            return seen;
        },

        // Counts applications recorded at/after `sinceIso` — used to enforce a
        // "few per day" budget across runs.
        async countApplicationsSince(sinceIso) {
            const { count, error } = await supabase
                .from("applications")
                .select("url", { count: "exact", head: true })
                .gte("created_at", sinceIso);
            if (error) throw new Error(`Supabase count failed: ${error.message}`);
            return count ?? 0;
        },

        // Records one application attempt; unique-violation is ignored.
        async insertApplication(row) {
            const { error } = await supabase.from("applications").insert(row);
            if (error && error.code !== UNIQUE_VIOLATION) {
                console.log(`application insert failed for ${row.url}: ${error.message}`);
                return false;
            }
            return !error;
        },
    };
}
