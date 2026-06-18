// The one vendor-specific seam. sources→candidates and the PR are backend-neutral; only this
// runs "an agent". Any coding agent that edits files in a working dir given a prompt fits —
// Claude Agent SDK, or a CLI agent (Copilot / Codex / Gemini). See docs/kura-agent-architecture.md.
export interface AgentTask {
  /** Working dir (the checked-out repo) the agent edits in place. */
  cwd: string;
  /** What to do (already includes the Mori maintainer persona). */
  prompt: string;
  /** Globs the agent may edit (e.g. ["content/docs/**"]). The backend MUST confine edits here. */
  allowEdits: string[];
}

export interface AgentResult {
  summary: string;
}

export interface AgentBackend {
  name: string;
  run(task: AgentTask): Promise<AgentResult>;
}
