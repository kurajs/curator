# Kura Curator

**Mori (守) keeps your docs true to your code.**

A GitHub Action for [Kura](https://kura.build) docs sites: when a code change lands, it finds the doc
pages that change affects, updates them with an AI agent, and proposes the result as a PR for review.
Targeted (only pages whose `sources:` match the diff), engine-swappable, and never touches anything
outside your docs.

> Curator is the **maintainer** half of the Kura Agent (persona: Mori). The **reader** half (Ask —
> answers your site's visitors) is a separate product. Both ground on the same read-only knowledge
> surface; only Curator can propose edits, and only via a reviewed PR.

## Quickstart (2 steps)

1. Add `ANTHROPIC_API_KEY` as a repository secret.
2. Add `.github/workflows/curator.yml`:

```yaml
name: curator
on:
  push:
    branches: [main]
    paths: ["src/**"]      # the code your docs track
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  curate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: kurajs/curator@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          docs-dir: content/docs
```

That's it — the built-in `GITHUB_TOKEN` is enough. When code lands, Mori opens a docs-only PR updating
the pages whose [`sources:`](#the-sources-convention) match. Everything below is **optional**:
[ride the PR instead](#alternative-ride-the-pr-same-pr-same-repo-only), [docs in a separate
repo](#cross-repo), [a branded commit avatar](#commit-identity--avatar), or [a different agent
engine](#swappable-engine-no-lock-in).

## Delivery modes: `new-pr` vs `same-pr`

Mori writes AI-drafted prose, which always wants human review. Two delivery modes:

| `mode` | What happens | Trigger it on | Best for |
| --- | --- | --- | --- |
| **`new-pr`** (default) | a standalone, **docs-only** PR | **`push` to your default branch** (post-merge) | the robust default — works with fork contributors, docs reflect *merged* code, the docs PR gets its own review/checks |
| **`same-pr`** | commits onto the **triggering PR's** branch | **`pull_request`** | same-repo / monorepo / trusted, when you want code + docs to review and merge atomically |

Why `new-pr` is the default: on a `pull_request`, GitHub gives the workflow a **read-only**
`GITHUB_TOKEN` for fork PRs, so `same-pr` *can't push back* to an external contributor's branch (it
auto-falls back to `new-pr`). Triggering `new-pr` on **push (post-merge)** sidesteps this entirely —
the merge already happened in your repo, so the token can write — and the docs then track code that
actually landed. (Mori never uses `pull_request_target`; that would run with a write token against
untrusted PR content.)

> Note: a docs change Mori commits with the default `GITHUB_TOKEN` does **not** re-trigger other
> workflows (GitHub's loop guard). If you need the docs PR to run your CI checks, pass a PAT or
> GitHub App token as `github-token`.

The default `new-pr` + post-merge trigger is the [Quickstart](#quickstart-2-steps) above.

### Alternative: ride the PR (`same-pr`, same-repo only)

```yaml
name: curator
on:
  pull_request:
    paths: ["src/**", "packages/**"]
permissions:
  contents: write
  pull-requests: write
jobs:
  curate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.head_ref }}  # the PR branch, so Mori can push onto it
          fetch-depth: 0
      - uses: kurajs/curator@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          docs-dir: content/docs
          mode: same-pr
```

### Cross-repo

Code is in one repo, the docs site is in another. The Action runs in the **code** repo, clones the
**docs** repo, edits there, and opens a (docs-only) PR **in the docs repo**. Set `docs-repo` and give
a token that can write to it (the default `GITHUB_TOKEN` cannot reach another repo — see *Cross-repo
auth*). Best triggered on **push** to your default branch.

```yaml
name: curator
on:
  push:
    branches: [main]
    paths: ["src/**", "packages/**"]
  workflow_dispatch:
jobs:
  curate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: kurajs/curator@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          docs-repo: my-org/my-docs-site      # the SEPARATE docs repo
          docs-dir: content/docs              # path inside that repo
          github-token: ${{ secrets.DOCS_REPO_TOKEN }}
```

### Cross-repo auth

Cross-repo needs a credential with **Contents: write + Pull requests: write** on the docs repo —
this is a GitHub platform rule (the built-in `GITHUB_TOKEN` is scoped to the repo it runs in). Two
options, both one-time:

- **Fine-grained PAT** (fastest): create a token scoped to *only* the docs repo, store it as a secret
  (`DOCS_REPO_TOKEN`) in the code repo, pass it as `github-token`. Tied to your account; set an expiry.
- **GitHub App** (best for orgs / long-term): create an App with those permissions, install it on the
  docs repo, mint a short-lived token in the workflow with
  [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token), and pass
  *that* as `github-token`. Not tied to a person; tokens auto-rotate.

## The `sources:` convention

A doc page declares which code it documents, in frontmatter:

```md
---
title: Authentication
sources: [src/auth/**, src/middleware/session.ts]
---
```

When a PR changes a file matching a page's `sources` globs, that page becomes a candidate for
update — nothing else is touched. Pages with no `sources` are never auto-edited.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `anthropic-api-key` | — | Key for the default `claude-agent-sdk` backend (use a secret). |
| `docs-dir` | `content/docs` | Where the Markdown docs live. |
| `mode` | `new-pr` | `new-pr` (standalone docs-only PR) or `same-pr` (commit onto the triggering PR; same-repo only). |
| `commit-message` | `docs: sync with <file>` | Commit subject; also the PR title. |
| `commit-trailer` | `via @kurabuild` | Body line appended to the commit. Set to `""` to omit. |
| `backend` | `claude-agent-sdk` | `claude-agent-sdk` or `cli`. |
| `model` | — | Model id for the Claude backend. |
| `agent-cmd` | — | For `backend: cli` — the external agent CLI (e.g. `codex exec`). |
| `base` | PR base / `main` | Ref to diff against. |
| `docs-repo` | — | Cross-repo mode: `owner/name` of a separate docs repo. Empty = same-repo. |
| `docs-ref` | `main` | Base branch in the docs repo to open the PR against (cross-repo). |
| `github-token` | `GITHUB_TOKEN` | Token used to push/open the PR. For cross-repo, a PAT/App token with write to `docs-repo`. |
| `committer-name` | `Mori` | Git author/committer name for the docs commit. |
| `committer-email` | `mori@kura.build` | Git author/committer email. See *Commit identity & avatar*. |

## Commit identity & avatar

By default Mori commits as `Mori <mori@kura.build>`. GitHub renders a commit avatar by matching the
**email** to a GitHub account's verified email — `mori@kura.build` belongs to no account, so it shows
the generic placeholder and the name isn't a link. To get a real, branded avatar you need a backing
GitHub identity. Two options:

- **GitHub App (recommended)** — create an App named *Mori*, upload its avatar, and commit as its bot.
  Mint a token in the workflow and pass the bot identity:

  ```yaml
  - uses: actions/create-github-app-token@v2
    id: app
    with:
      app-id: ${{ vars.MORI_APP_ID }}
      private-key: ${{ secrets.MORI_APP_PRIVATE_KEY }}
  - id: bot
    run: echo "uid=$(gh api /users/${{ steps.app.outputs.app-slug }}'[bot]' --jq .id)" >> "$GITHUB_OUTPUT"
    env: { GH_TOKEN: ${{ steps.app.outputs.token }} }
  - uses: kurajs/curator@v1
    with:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      github-token: ${{ steps.app.outputs.token }}
      committer-name: ${{ steps.app.outputs.app-slug }}[bot]
      committer-email: ${{ steps.bot.outputs.uid }}+${{ steps.app.outputs.app-slug }}[bot]@users.noreply.github.com
  ```

  Commits then show the App's avatar, a `bot` badge, and a Verified mark. (The same App can also be the
  cross-repo `github-token`.)

- **Machine user** — create a GitHub user, set its avatar, and pass its email as `committer-email`
  with that user's PAT as `github-token`.

## Swappable engine (no lock-in)

The agent runs behind an `AgentBackend` interface. The default is the Claude Agent SDK; set
`backend: cli` + `agent-cmd` to drive any external coding-agent CLI (Copilot / Codex / Gemini /
aider). The sources-matching and PR steps never depend on the engine.

## Guarantees

- **Docs-only edits.** The agent may edit only files under `docs-dir` (enforced; the Claude backend
  denies out-of-scope edits at the tool layer).
- **Human-in-the-loop.** Output is always a PR for review — never a direct push to your branch.

## Build / release

This is a **composite action**: the Claude Agent SDK spawns a per-platform native CLI shipped in
optional packages (`@anthropic-ai/claude-agent-sdk-<platform>`), so the action installs its deps on
the runner itself (`npm ci`) rather than shipping a pre-bundled binary that can't carry every
platform. `npm install && npm run build` compiles `src/` → `dist/` with `tsc` (committed for
releases). Tag `vX.Y.Z` + move the `v1` tag to release.

### Testing locally

Logic (sources matching, the PR flow) runs on any OS — point `dist/main.js` at a throwaway git repo
with `CURATOR_*` env set. But platform/packaging issues (like the native CLI binary) only surface on
**linux-x64**, the runner's platform — a run on macOS pulls the darwin binary and looks fine. To
reproduce the runner, run the action's steps in a Linux container:

```bash
docker run --rm -v "$PWD":/src:ro -v /path/to/sandbox:/repo \
  -e CURATOR_DOCS_DIR=content/docs -e CURATOR_ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  node:24 bash -c 'mkdir /action && cp /src/package*.json /action/ && cp -r /src/dist /action/dist \
    && cd /action && npm ci --omit=dev && git config --global --add safe.directory /repo \
    && cd /repo && node /action/dist/main.js'
```

Or use [`act`](https://github.com/nektos/act) to run the workflow YAML end-to-end in Docker.

## License

[MIT](LICENSE) © Lawrence Lin
