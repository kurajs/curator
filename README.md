# Kura Curator

**Mori (守) keeps your docs true to your code.**

A GitHub Action for [Kura](https://kura.build) docs sites: on a pull request, it finds the doc
pages a code change affects, updates them with an AI agent, and opens a **separate docs PR** for
review. Targeted (only pages whose `sources:` match the diff), engine-swappable, and never touches
anything outside your docs.

> Curator is the **maintainer** half of the Kura Agent (persona: Mori). The **reader** half (Ask —
> answers your site's visitors) is a separate product. Both ground on the same read-only knowledge
> surface; only Curator can propose edits, and only via a reviewed PR.

## Usage

Add `.github/workflows/curator.yml`:

```yaml
name: curator
on:
  pull_request:
permissions:
  contents: write          # commit the docs update onto the PR branch
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
          docs-dir: content/docs
```

On a `pull_request`, Curator commits the docs update **onto the same PR branch** — the triggering
PR gains the docs change, no second PR. (Run it on `push`/`workflow_dispatch` instead and it opens a
standalone docs PR off the base; that needs `pull-requests: write` too.)

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
