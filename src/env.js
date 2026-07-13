// Resolve the Anthropic API key.
//
// Standard hosts (Railway, local) just set ANTHROPIC_API_KEY and that's used.
// Some managed environments pre-occupy the name ANTHROPIC_API_KEY with their
// own platform key, which then shadows yours. For those, set a project-scoped
// JOB_AGENT_ANTHROPIC_KEY — it takes precedence so the app never depends on a
// host-specific variable name.
export function resolveAnthropicKey(env = process.env) {
    return env.JOB_AGENT_ANTHROPIC_KEY || env.ANTHROPIC_API_KEY || "";
}
