// Default backend: Claude Agent SDK. Full agent loop — Reads code + doc, Edits the doc itself.
// allowEdits is enforced with a PreToolUse hook that DENIES edits outside the allowed globs.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { relative, isAbsolute } from "node:path";
function inScope(cwd, filePath, allow) {
    if (!filePath)
        return false;
    const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
    if (rel.startsWith(".."))
        return false;
    return allow.some((g) => g.endsWith("/**") ? rel === g.slice(0, -3) || rel.startsWith(g.slice(0, -2)) : g === rel);
}
export function claudeAgentSdk(model) {
    return {
        name: "claude-agent-sdk",
        async run({ cwd, prompt, allowEdits }) {
            const deny = async (input) => {
                const fp = input?.tool_input?.file_path;
                return inScope(cwd, fp, allowEdits)
                    ? {}
                    : { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: `edit outside ${allowEdits.join(", ")}` } };
            };
            let summary = "";
            for await (const m of query({
                prompt,
                options: {
                    cwd,
                    ...(model ? { model } : {}),
                    allowedTools: ["Read", "Grep", "Glob", "Edit"],
                    permissionMode: "acceptEdits",
                    hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [deny] }] },
                },
            })) {
                if ("result" in m)
                    summary = String(m.result);
            }
            return { summary };
        },
    };
}
//# sourceMappingURL=claude-agent-sdk.js.map