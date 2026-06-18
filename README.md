# Kura Curator

**Mori (守) keeps your docs true to your code.**

A GitHub Action for [Kura](https://kura.build) docs sites: when a code change lands, it finds the doc
pages that change affects, updates them with an AI agent, and proposes the result as a PR for review.
Targeted (only pages whose `sources:` match the diff), engine-swappable, and never touches anything
outside your docs.

> Curator is the **maintainer** half of the Kura Agent (persona: Mori). The **reader** half (Ask —
> answers your site's visitors) is a separate product. Both ground on the same read-only knowledge
> surface; only Curator can propose edits, and only via a reviewed PR.

## Two ways to run it

| | Docs location | Auth | When |
| --- | --- | --- | --- |
| **Same-repo** | beside the code (incl. a monorepo subdir) | built-in `GITHUB_TOKEN`, zero setup | most projects |
| **Cross-repo** | a separate docs repo | a token with write access to the docs repo | docs site is its own repo |

### Same-repo (recommended)

Docs and code live in one repo. Add `.github/workflows/curator.yml`:

```yaml
name: curator
on:
  pull_request:
permissions:
  contents: write          # commit the docs update onto the PR branch
  pull-requests: write     # (only needed for the push/manual standalone-PR path)
jobs:
  curate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.head_ref }}   # check out the PR branch (not the detached merge ref)
          fetch-depth: 0                # full history, to diff against the base
      - uses: kurajs/curator@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          docs-dir: content/docs        # e.g. apps/site/content/docs in a monorepo
```

On a `pull_request`, Curator commits the docs update **onto the same PR branch** — the triggering
PR gains the docs change, no second PR. (Run it on `push`/`workflow_dispatch` instead and it opens a
standalone docs PR off the base.)

### Cross-repo

Code is in one repo, the docs site is in another. The Action runs in the **code** repo, clones the
**docs** repo, edits there, and opens a PR **in the docs repo**. Set `docs-repo` and give a token
that can write to it (the default `GITHUB_TOKEN` cannot reach another repo — see *Cross-repo auth*).

```yaml
name: curator
on:
  pull_request:
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
| `backend` | `claude-agent-sdk` | `claude-agent-sdk` or `cli`. |
| `model` | — | Model id for the Claude backend. |
| `agent-cmd` | — | For `backend: cli` — the external agent CLI (e.g. `codex exec`). |
| `base` | PR base / `main` | Ref to diff against. |
| `docs-repo` | — | Cross-repo mode: `owner/name` of a separate docs repo. Empty = same-repo. |
| `docs-ref` | `main` | Base branch in the docs repo to open the PR against (cross-repo). |
| `github-token` | `GITHUB_TOKEN` | Token used to push/open the PR. For cross-repo, a PAT/App token with write to `docs-repo`. |

## Swappable engine (no lock-in)

The agent runs behind an `AgentBackend` interface. The default is the Claude Agent SDK; set
`backend: cli` + `agent-cmd` to drive any external coding-agent CLI (Copilot / Codex / Gemini /
aider). The sources-matching and PR steps never depend on the engine.

## Guarantees

- **Docs-only edits.** The agent may edit only files under `docs-dir` (enforced; the Claude backend
  denies out-of-scope edits at the tool layer).
- **Human-in-the-loop.** Output is always a PR for review — never a direct push to your branch.

## Build / release

`npm install && npm run build` bundles `src/main.ts` → `dist/index.js` (committed for releases, since
GitHub runs `dist/index.js`). Tag `vX.Y.Z` + move the `v1` tag to release.

## License

[MIT](LICENSE) © Lawrence Lin
