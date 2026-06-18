// Swap backend: any external coding-agent CLI (Copilot / Codex / Gemini / aider). Spawned in
// cwd with the prompt on stdin; allowEdits surfaced via env. Proves the orchestrator is identical
// regardless of engine — point `agent-cmd` at the tool you want.
import { spawn } from "node:child_process";
export function cliBackend(cmdline) {
    const [cmd, ...args] = cmdline.split(" ").filter(Boolean);
    return {
        name: `cli:${cmd ?? "<unset>"}`,
        async run({ cwd, prompt, allowEdits }) {
            if (!cmd)
                throw new Error("backend=cli requires the 'agent-cmd' input");
            const out = await new Promise((resolve, reject) => {
                const p = spawn(cmd, args, { cwd, env: { ...process.env, DOCS_SYNC_ALLOW_EDITS: allowEdits.join(",") } });
                let o = "";
                p.stdout.on("data", (d) => (o += d));
                p.stderr.on("data", (d) => (o += d));
                p.on("error", reject);
                p.on("close", (code) => (code === 0 ? resolve(o) : reject(new Error(`${cmd} exited ${code}: ${o}`))));
                p.stdin.write(prompt);
                p.stdin.end();
            });
            return { summary: out.trim().slice(0, 200) };
        },
    };
}
//# sourceMappingURL=cli.js.map