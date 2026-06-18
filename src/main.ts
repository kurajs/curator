// Kura Curator — the maintainer agent (Mori 守) as a GitHub Action.
// On a PR: diff → pages whose `sources:` match (sources.ts) → backend edits the .md (Mori
// maintainer persona) → branch/commit/push → open a docs PR. Read/PR steps are vendor-neutral;
// only the backend is swappable. See docs/kura-agent-architecture.md.
import * as core from "@actions/core";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { moriPrompt } from "@kurajs/docs/agent";
import { candidatesFor } from "./sources.js";
import { resolveBackend } from "./backends/index.js";

const sh = (cmd: string, args: string[], cwd = process.cwd(), env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: env ?? process.env }).trim();

async function run() {
  const cwd = process.cwd();
  const docsDir = core.getInput("docs-dir") || "content/docs";
  const base = core.getInput("base") || process.env.GITHUB_BASE_REF || "main";
  const backendName = core.getInput("backend") || "claude-agent-sdk";
  const apiKey = core.getInput("anthropic-api-key");
  const token = core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
  if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey;

  // 1. changed files in this PR (vs base)
  let changed: string[] = [];
  try {
    changed = sh("git", ["diff", "--name-only", `origin/${base}...HEAD`]).split("\n").filter(Boolean);
  } catch {
    changed = sh("git", ["diff", "--name-only", "HEAD~1...HEAD"]).split("\n").filter(Boolean);
  }

  // 2. candidate docs via `sources:`
  const candidates = candidatesFor(join(cwd, docsDir), changed);
  core.info(`changed ${changed.length} file(s) → ${candidates.length} candidate doc(s): ${candidates.join(", ") || "(none)"}`);
  if (!candidates.length) {
    core.info("No docs reference the changed code (via `sources:`). Nothing to do.");
    return;
  }

  // 3. backend edits the candidate pages (Mori, maintainer surface)
  const backend = resolveBackend(backendName, { model: core.getInput("model"), agentCmd: core.getInput("agent-cmd") });
  const prompt =
    `${moriPrompt("maintainer")}\n\n` +
    `Changed file(s): ${changed.join(", ")}\n` +
    `Pages to reconcile (edit only these, only under ${docsDir}/): ${candidates.map((p) => `${docsDir}/${p}`).join(", ")}\n` +
    `Read the current code and each page, then update the page so its prose and examples match the current code. ` +
    `If a page is already accurate, leave it.`;
  core.info(`backend: ${backend.name}`);
  const { summary } = await backend.run({ cwd, prompt, allowEdits: [`${docsDir}/**`] });

  // 4. publish the edits
  if (!sh("git", ["status", "--porcelain", "--", docsDir])) {
    core.info("Agent made no edits — docs already in step.");
    return;
  }
  sh("git", ["add", docsDir]);
  sh("git", ["-c", "user.name=Mori", "-c", "user.email=mori@kura.build", "commit", "-m", `docs: sync with ${changed[0]}`]);

  // On a pull_request, ride the SAME PR: commit the docs onto its head branch (the consumer must
  // check out `ref: github.head_ref`). Otherwise (push / manual) open a standalone docs PR off base.
  const head = process.env.GITHUB_HEAD_REF;
  if (head) {
    sh("git", ["push", "origin", `HEAD:${head}`]);
    core.info(`Pushed the docs update onto the PR branch '${head}' — it rides the same PR.`);
    return;
  }
  const branch = `curator/${changed[0].replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`;
  sh("git", ["branch", branch]);
  sh("git", ["push", "origin", `${branch}:${branch}`]);
  const body = `Opened by **Mori** (Kura Curator).\n\nChanged: ${changed.join(", ")}\nPages: ${candidates.map((p) => docsDir + "/" + p).join(", ")}\n\n${summary.slice(0, 800)}`;
  const url = sh("gh", ["pr", "create", "--title", `docs: sync with ${changed[0]}`, "--body", body, "--head", branch, "--base", base], cwd, { ...process.env, GH_TOKEN: token });
  core.info(`Opened docs PR: ${url}`);
  core.setOutput("pr-url", url);
}

run().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)));
