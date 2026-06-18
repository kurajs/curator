import type { AgentBackend } from "./types.js";
import { claudeAgentSdk } from "./claude-agent-sdk.js";
import { cliBackend } from "./cli.js";

export function resolveBackend(name: string, opts: { model?: string; agentCmd?: string }): AgentBackend {
  if (name === "claude-agent-sdk") return claudeAgentSdk(opts.model || undefined);
  if (name === "cli") return cliBackend(opts.agentCmd ?? "");
  throw new Error(`unknown backend: ${name} (use 'claude-agent-sdk' or 'cli')`);
}

export type { AgentBackend } from "./types.js";
