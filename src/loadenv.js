// Load a local .env into process.env for local/dev runs. Side-effect module:
// import it FIRST, before anything reads process.env.
//
// No-op when .env is absent (e.g. Railway, which injects real env vars), and
// it never overrides a variable that's already set — a real environment
// variable always wins over the file.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));

if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key] === undefined) {
            process.env[key] = rawValue.replace(/^["']|["']$/g, "");
        }
    }
}
