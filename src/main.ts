// Kura Curator — the maintainer agent (Mori 守) as a GitHub Action.
// On a PR/push: diff → pages whose `sources:` match (sources.ts) → backend edits the .md (Mori
// maintainer persona) → open a docs PR. Two topologies:
//   • same-repo  — docs live beside the code; rides the PR (or opens one) in THIS repo.
//   • cross-repo — `docs-repo` set; clone it, edit there, open a PR over THERE.
// Read/PR steps are vendor-neutral; only the backend is swappable. See docs/kura-agent-architecture.md.
import * as core from "@actions/core";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { moriPrompt } from "@kurajs/docs/agent";
import { candidatesFor } from "./sources.js";
import { resolveBackend, type ResolveOpts } from "./backends/index.js";

const sh = (cmd: string, args: string[], cwd = process.cwd(), env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: env ?? process.env }).trim();

// Inputs arrive as CURATOR_* env vars set by the composite action.yml (clean names — no hyphens, so
// no INPUT_DOCS-DIR-style quirks). Falls back to @actions/core for any non-composite invocation.
const inp = (key: string, action: string) => ((process.env[`CURATOR_${key}`] ?? "").trim() || core.getInput(action));

// A unique-enough branch suffix without Math.random/Date import churn — the run id is stable per job.
const runSuffix = () => (process.env.GITHUB_RUN_ID || String(Date.now())).slice(-8);

async function run() {
  const cwd = process.cwd(); // the CODE repo checkout
  const docsDir = inp("DOCS_DIR", "docs-dir") || "content/docs";
  const base = inp("BASE", "base") || process.env.GITHUB_BASE_REF || "main";
  const backendName = inp("BACKEND", "backend") || "claude-agent-sdk";
  const apiKey = inp("ANTHROPIC_API_KEY", "anthropic-api-key");
  const token = inp("GITHUB_TOKEN", "github-token") || process.env.GITHUB_TOKEN || "";
  const docsRepo = inp("DOCS_REPO", "docs-repo"); // "owner/name" → cross-repo; empty → same-repo
  const docsRef = inp("DOCS_REF", "docs-ref") || "main";
  if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey;
  const resolveOpts: ResolveOpts = { model: inp("MODEL", "model"), agentCmd: inp("AGENT_CMD", "agent-cmd") };

  // 1. changed files in this PR/push (vs base), in the CODE repo
  let changed: string[] = [];
  try {
    changed = sh("git", ["diff", "--name-only", `origin/${base}...HEAD`]).split("\n").filter(Boolean);
  } catch {
    changed = sh("git", ["diff", "--name-only", "HEAD~1...HEAD"]).split("\n").filter(Boolean);
  }

  if (docsRepo) {
    return await crossRepo({ cwd, docsDir, docsRepo, docsRef, changed, backendName, resolveOpts, token });
  }
  return await sameRepo({ cwd, docsDir, base, changed, backendName, resolveOpts, token });
}

interface Ctx {
  cwd: string;
  docsDir: string;
  changed: string[];
  backendName: string;
  resolveOpts: ResolveOpts;
  token: string;
}

// SAME-REPO: docs live beside the code in this checkout.
async function sameRepo({ cwd, docsDir, base, changed, backendName, resolveOpts, token }: Ctx & { base: string }) {
  const candidates = candidatesFor(join(cwd, docsDir), changed);
  core.info(`changed ${changed.length} file(s) → ${candidates.length} candidate doc(s): ${candidates.join(", ") || "(none)"}`);
  if (!candidates.length) {
    core.info("No docs reference the changed code (via `sources:`). Nothing to do.");
    return;
  }

  const backend = resolveBackend(backendName, resolveOpts);
  core.info(`backend: ${backend.name}`);
  const { summary } = await backend.run({
    cwd,
    prompt: editPrompt(changed, candidates.map((p) => `${docsDir}/${p}`), `under ${docsDir}/`),
    allowEdits: [`${docsDir}/**`],
  });

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
  const branch = `curator/${changed[0].replace(/[^a-z0-9]+/gi, "-")}-${runSuffix()}`;
  sh("git", ["branch", branch]);
  sh("git", ["push", "origin", `${branch}:${branch}`]);
  const url = sh(
    "gh",
    ["pr", "create", "--title", `docs: sync with ${changed[0]}`, "--body", prBody(changed, candidates, docsDir, summary), "--head", branch, "--base", base],
    cwd,
    { ...process.env, GH_TOKEN: token },
  );
  core.info(`Opened docs PR: ${url}`);
  core.setOutput("pr-url", url);
}

// CROSS-REPO: docs live in a separate repo — clone it, edit there, open a PR over there.
async function crossRepo({ cwd, docsDir, docsRepo, docsRef, changed, backendName, resolveOpts, token }: Ctx & { docsRepo: string; docsRef: string }) {
  if (!token) throw new Error("cross-repo mode needs a `github-token` with write access to the docs repo (a PAT or GitHub App token); the default GITHUB_TOKEN cannot reach another repo.");
  const checkout = join(cwd, ".curator-docs");
  const cloneUrl = `https://x-access-token:${token}@github.com/${docsRepo}.git`;
  sh("git", ["clone", "--depth", "1", "--branch", docsRef, cloneUrl, checkout], cwd, { ...process.env, GIT_TERMINAL_PROMPT: "0" });

  const candidates = candidatesFor(join(checkout, docsDir), changed);
  core.info(`changed ${changed.length} file(s) → ${candidates.length} candidate doc(s) in ${docsRepo}: ${candidates.join(", ") || "(none)"}`);
  if (!candidates.length) {
    core.info(`No docs in ${docsRepo} reference the changed code (via \`sources:\`). Nothing to do.`);
    return;
  }

  const backend = resolveBackend(backendName, resolveOpts);
  core.info(`backend: ${backend.name}`);
  // The agent runs from the CODE repo (so it can Read the changed code) and edits the docs in the
  // checked-out subtree; allowEdits fences it to `.curator-docs/<docsDir>/`.
  const rel = candidates.map((p) => `.curator-docs/${docsDir}/${p}`);
  const { summary } = await backend.run({
    cwd,
    prompt: editPrompt(changed, rel, `under .curator-docs/${docsDir}/ (the docs repo ${docsRepo}); the code you are documenting is in the working directory`),
    allowEdits: [`.curator-docs/${docsDir}/**`],
  });

  if (!sh("git", ["status", "--porcelain", "--", docsDir], checkout)) {
    core.info("Agent made no edits — docs already in step.");
    return;
  }
  const branch = `curator/sync-${runSuffix()}`;
  sh("git", ["checkout", "-b", branch], checkout);
  sh("git", ["add", docsDir], checkout);
  sh("git", ["-c", "user.name=Mori", "-c", "user.email=mori@kura.build", "commit", "-m", `docs: sync with ${changed[0]}`], checkout);
  sh("git", ["push", "origin", branch], checkout);
  const from = process.env.GITHUB_REPOSITORY ? ` from \`${process.env.GITHUB_REPOSITORY}\`` : "";
  const url = sh(
    "gh",
    ["pr", "create", "--repo", docsRepo, "--title", `docs: sync with ${changed[0]}`, "--body", prBody(changed, candidates, docsDir, summary, from), "--head", branch, "--base", docsRef],
    checkout,
    { ...process.env, GH_TOKEN: token },
  );
  core.info(`Opened docs PR in ${docsRepo}: ${url}`);
  core.setOutput("pr-url", url);
}

function editPrompt(changed: string[], pages: string[], scope: string): string {
  return (
    `${moriPrompt("maintainer")}\n\n` +
    `Changed file(s): ${changed.join(", ")}\n` +
    `Pages to reconcile (edit only these, only ${scope}): ${pages.join(", ")}\n` +
    `Read the current code and each page, then update the page so its prose and examples match the current code. ` +
    `If a page is already accurate, leave it.`
  );
}

function prBody(changed: string[], candidates: string[], docsDir: string, summary: string, from = ""): string {
  return `Opened by **Mori** (Kura Curator)${from}.\n\nChanged: ${changed.join(", ")}\nPages: ${candidates.map((p) => docsDir + "/" + p).join(", ")}\n\n${summary.slice(0, 800)}`;
}

run().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)));
