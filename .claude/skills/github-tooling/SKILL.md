---
name: github-tooling
description: "Use whenever a session reaches GitHub: the gh CLI, gh api, or GitHub MCP tools, for issues, pull requests, labels or Actions runs. Read it before running a gh command. GraphQL is refused in a cloud session, so gh issue, gh pr, gh label and gh search all fail, and the working route is REST or an MCP tool."
---

# GitHub from a cloud session

Which route reaches GitHub from a Claude cloud session, and which routes
are closed. On a laptop with an ordinary `gh` login none of this applies.

Take the repository's owner and name from `git remote get-url origin`.

## Pick the route

1. **A GitHub MCP tool** (`mcp__github__*`), if the session has them.
   Check the tool list, and load a tool's schema before calling it.
2. **`gh api <path>`** for everything else. It speaks REST.

## What is refused

Both are 403 responses.

- **GraphQL is refused.** Every `gh` subcommand built on it fails:
  `gh issue`, `gh pr`, `gh label`, `gh release` and `gh search`, including
  view and list. The REST-backed ones still work: `gh run list`,
  `gh run view`, `gh workflow run` and `gh api`.
- **REST is bound to the session's repositories.** Paths outside
  `repos/{owner}/{repo}/...` are refused. Repository secrets and variables
  cannot be read at all. Ask the owner; do not report them as unset.

A 403 from `gh` is a routing problem, not missing access. Run it again as
REST or an MCP call before concluding anything about permissions.

One 403 is different: "GitHub access to this repository is not enabled for
this session. Use add_repo to request access." The session started without
the repository attached. Find the `add_repo` tool, call it with this
repository's owner and name and `access: push`, then `git fetch origin`.

## Substitutions

| Instead of | Use |
| --- | --- |
| `gh issue view <n>` | `gh api repos/{owner}/{repo}/issues/<n>` |
| `gh issue list --label X` | `gh api "repos/{owner}/{repo}/issues?labels=X&state=open"` |
| `gh issue create` | `gh api repos/{owner}/{repo}/issues -f title=... -f body=... -f "labels[]=..."` |
| `gh issue comment <n>` | `gh api repos/{owner}/{repo}/issues/<n>/comments -f body=...` |
| `gh pr view <n>` | `gh api repos/{owner}/{repo}/pulls/<n>` |
| `gh pr create` | `gh api repos/{owner}/{repo}/pulls -f title=... -f head=<branch> -f base=main -f body=...` |
| `gh pr checks <n>` | `gh api repos/{owner}/{repo}/commits/<sha>/check-runs` |
| `gh label list` | `gh api repos/{owner}/{repo}/labels` |

A label with a space needs encoding in a query: `labels=type:%20enhancement`.

For a long body, write it to a file and pass `-F body=@file.md`.

## Posting

Comment when a reply is needed. Do not narrate progress on an issue or a
pull request.
