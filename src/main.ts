// Kura Curator — the maintainer agent (Mori 守) as a GitHub Action.
// On a PR/push: diff → pages whose `sources:` match (sources.ts) → backend edits the .md (Mori
// maintainer persona) → open a docs PR. Two topologies:
//   • same-repo  — docs live beside the code; rides the PR (or opens one) in THIS repo.
//   • cross-repo — `docs-repo` set; clone it, edit there, open a PR over THERE.
// Read/PR steps are vendor-neutral; only the backend is swappable. See docs/kura-agent-architecture.md.
import * as core from "@actions/core";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

// The `before` SHA of a push event, read from the event payload (no standard env var carries it).
function pushBefore(): string | undefined {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8"))?.before;
  } catch {
    return undefined;
  }
}

// A fork PR's head lives in a different repo, so the default GITHUB_TOKEN (read-only on forks) cannot
// push to it — `same-pr` must fall back to a standalone PR. Detected from the event payload.
function isForkPR(): boolean {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p) return false;
  try {
    const ev = JSON.parse(readFileSync(p, "utf8"));
    const head = ev?.pull_request?.head?.repo?.full_name;
    const base = ev?.repository?.full_name;
    return !!(head && base && head !== base);
  } catch {
    return false;
  }
}

// Changed files vs the right baseline: a PR diffs against its base ref; a push diffs the pushed range
// (event.before…HEAD); both fall back to HEAD~1. Returns the first NON-EMPTY result (an empty diff is
// not an error — keep trying the next range).
function changedFiles(base: string): string[] {
  const isPR = !!process.env.GITHUB_BASE_REF;
  const before = pushBefore();
  const ranges = isPR
    ? [`origin/${base}...HEAD`, "HEAD~1...HEAD"]
    : [...(before && !/^0+$/.test(before) ? [`${before}...HEAD`] : []), `origin/${base}...HEAD`, "HEAD~1...HEAD"];
  for (const r of ranges) {
    try {
      const out = sh("git", ["diff", "--name-only", r]).split("\n").filter(Boolean);
      if (out.length) return out;
    } catch {
      /* range not valid in this checkout — try the next */
    }
  }
  return [];
}

async function run() {
  const cwd = process.cwd(); // the CODE repo checkout
  const docsDir = inp("DOCS_DIR", "docs-dir") || "content/docs";
  const base = inp("BASE", "base") || process.env.GITHUB_BASE_REF || "main";
  const backendName = inp("BACKEND", "backend") || "claude-agent-sdk";
  const apiKey = inp("ANTHROPIC_API_KEY", "anthropic-api-key");
  const token = inp("GITHUB_TOKEN", "github-token") || process.env.GITHUB_TOKEN || "";
  const docsRepo = inp("DOCS_REPO", "docs-repo"); // "owner/name" → cross-repo; empty → same-repo
  const docsRef = inp("DOCS_REF", "docs-ref") || "main";
  const mode = (inp("MODE", "mode") || "new-pr").toLowerCase(); // new-pr (default) | same-pr
  if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey;
  const resolveOpts: ResolveOpts = { model: inp("MODEL", "model"), agentCmd: inp("AGENT_CMD", "agent-cmd") };

  // 1. changed files in this PR/push (vs base), in the CODE repo
  const changed = changedFiles(base);

  if (docsRepo) {
    return await crossRepo({ cwd, docsDir, docsRepo, docsRef, changed, backendName, resolveOpts, token });
  }
  return await sameRepo({ cwd, docsDir, base, mode, changed, backendName, resolveOpts, token });
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
//   mode=new-pr (default) → open a standalone, docs-only PR off `base`.
//   mode=same-pr          → commit onto the triggering PR's branch (only valid for a non-fork PR).
async function sameRepo({ cwd, docsDir, base, mode, changed, backendName, resolveOpts, token }: Ctx & { base: string; mode: string }) {
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
  const docsCommit = sh("git", ["rev-parse", "HEAD"]);

  // same-pr: ride the triggering PR by pushing the docs commit onto its head branch. Only works for a
  // same-repo PR — a fork PR's head is in another repo the GITHUB_TOKEN can't write, so fall back.
  const head = process.env.GITHUB_HEAD_REF;
  if (mode === "same-pr" && head && !isForkPR()) {
    sh("git", ["push", "origin", `HEAD:${head}`]);
    core.info(`Pushed the docs update onto the PR branch '${head}' — it rides the same PR.`);
    return;
  }
  if (mode === "same-pr" && head) {
    core.info("Fork PR: the GITHUB_TOKEN is read-only on forks and can't push to the contributor's branch — opening a standalone docs PR instead.");
  }

  // new-pr: a standalone, docs-only PR. Rebase the docs commit onto `base` so the PR carries ONLY the
  // docs change (never the code diff), even when this run is on a PR head.
  const branch = `curator/docs-${runSuffix()}`;
  const baseRef = tryRef(`origin/${base}`) ?? base;
  sh("git", ["checkout", "-B", branch, baseRef]);
  try {
    sh("git", ["-c", "user.name=Mori", "-c", "user.email=mori@kura.build", "cherry-pick", docsCommit]);
  } catch {
    core.info("Docs already in step with the base — nothing to propose.");
    return;
  }
  sh("git", ["push", "origin", branch]);
  const url = sh(
    "gh",
    ["pr", "create", "--title", `docs: sync with ${changed[0]}`, "--body", prBody(changed, candidates, docsDir, summary), "--head", branch, "--base", base],
    cwd,
    { ...process.env, GH_TOKEN: token },
  );
  core.info(`Opened docs PR: ${url}`);
  core.setOutput("pr-url", url);
}

// Resolve a ref to a commit if it exists in this checkout, else undefined.
function tryRef(ref: string): string | undefined {
  try {
    return sh("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) || undefined;
  } catch {
    return undefined;
  }
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
