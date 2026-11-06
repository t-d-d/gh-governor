# How this repo is built

Governor is built the way it builds any repo it serves. The owner shapes and approves each feature's PRD and its technical design. Claude Code sessions that governor starts write the code, the tests and the pull requests. The owner reviews and merges. This page describes that loop, and the files in this repo that keep it on track, for anyone who wants to run a repo the same way.

## The numbers

Governor came out of building [Podstow](https://podstow.com), a production service, with Claude Code agents. Podstow's repo is private. Governor's code moved here on 28 October 2026, in one commit of about 14,700 lines of source and 1,360 tests. In the five days to 12:00 UTC on 2 November 2026:

| | |
|---|---|
| Tickets governor picked up in this repo and started a session on | 94 |
| Pull requests merged after the move, written by Claude Code sessions | 98 |
| Median time from pickup to merge, the owner's review included | 29 minutes, over the 90 tickets a merged pull request closed, and half of them between 16 and 94 minutes |
| Sessions' pull requests closed unmerged | 2, a probe that closes its own pull request by design and a duplicate of another |
| Deploys of main | The gate never failed on main. Two deploys failed: the first, run by hand while the stack was set up, and one on 30 October that the post-deploy probe caught. The 47 since then all passed. A fault in a merge is fixed forward by the next change, not by reverting the merge. |
| Commits authored by Claude, merges aside, the move included | 207 of 211 |
| Source, stack and scripts | about 14,700 lines at the move, about 22,000 after |
| Tests | 1,360 at the move, 2,261 at the end of that window |
| Constraint files, and the fitness-function suites that hold them | 6 and 28 |

This repo's [governor.json](../.github/governor.json) turns on `pickup`, `summons`, `prMessages`, `subscribeMessages`, `unblocked`, `conflicts`, `signOff` and `prReview`, and leaves every other switch off, CI messages and deploy messages among them. Governor reviews this repo's pull requests against [its checklist](../.claude/skills/pr-review/SKILL.md) with `merge` off, so a pass only posts a comment and a `governor` check. A person still reviews and merges every pull request here, so governor never passes its own work with nobody looking. The owner weighs each pull request's net complexity against the value of the change. The `pr-description` skill writes the description for that review: what the change adds and removes, a net line saying whether the system got simpler or more complex and what the complexity buys, any drift from the ticket, and a table mapping each acceptance criterion to the test or check that answers it.

## The loop

1. **A PRD.** Each feature starts as an issue labelled `type: prd`. The owner shapes it and its technical design, and approves both. The PRD holds the problem, goals, non-goals, user journeys, acceptance criteria, the tickets that deliver it, and which constraint files change meaning. Non-goals bind: a session does not build one. [#185](https://github.com/t-d-d/gh-governor/issues/185), the PRD for `Blocked until:` waits, is a typical one.
2. **A ticket.** Each ticket is an issue with its own acceptance criteria. Labelling it `mode: afk` hands it to governor. A ticket labelled `mode: human` is the owner's, such as a secret to set or an AWS setting to change.
3. **Pickup.** Governor claims the ticket, starts a Claude Code cloud session on it, and comments the session's link on the ticket.
4. **Context.** The session reads [CLAUDE.md](../CLAUDE.md), then runs the `fetch-ticket` skill: the ticket, its blockers, its PRD, the issues those cite, and the constraint files that bind the work. A ticket with an open blocker, or one that conflicts with a constraint, stops there with a comment.
5. **Tests first.** The session writes the failing test, watches it fail for the reason it expects, and then writes the code.
6. **Pre-push.** The `pre-push` skill merges main in, runs the gate on the merged tree, and has a clean-room sub-agent, with a fresh context and no part in writing the code, review the diff at high effort. Each finding is fixed, dismissed only after the session has traced it through the code, or filed as a new issue. Then the session pushes and raises the pull request, written to the `pr-description` skill.
7. **Review.** Governor relays everything on the pull request to the session that wrote it: the owner's comments and reviews, pushes, and the conflicts that other merges leave. The session answers them on the same branch.
8. **Merge and sign-off.** The owner merges. The session ends its last reply with `Signing off.`, and governor archives it at its next turn.

Work a session finds in passing becomes a new issue, not a fix in the branch it is on, so each pull request delivers one ticket and reads in one screen.

## The files that keep it on track

| File | What it does |
|---|---|
| [CLAUDE.md](../CLAUDE.md) | The rules every session reads first: scope, tests first, the gate, branches, what only the owner can do, and how to sign off. |
| [.claude/skills/fetch-ticket](../.claude/skills/fetch-ticket/SKILL.md) | Gathers a ticket's full context and stops on an open blocker or a conflict. |
| [.claude/skills/constraints](../.claude/skills/constraints/SKILL.md) | Builds the index of `docs/constraints/` from each file's `Relevance:` line, and has the session read every file that matches its change before it edits code. |
| [.claude/rules/constraints.md](../.claude/rules/constraints.md) | A rule scoped to the code paths. Working on a file under `dispatch/`, `scripts/`, `test/`, `infra/`, `eslint-rules/`, `.claude/hooks/` or `.github/`, or on `package.json`, `tsconfig.json` or the lint config, reminds the session to run the constraints skill. |
| [.claude/skills/pre-push](../.claude/skills/pre-push/SKILL.md) | Catch up, gate, review, push, in that order, with a rule for how each review finding ends. |
| [.claude/skills/pr-description](../.claude/skills/pr-description/SKILL.md) | A pull request body the owner can judge without opening the diff, including a table that maps each acceptance criterion to the test that answers it. |
| [.claude/skills/unslop](../.claude/skills/unslop/SKILL.md) | Writing rules for anything a person reads: pull requests, issues, docs, and the messages governor sends. |
| [.claude/skills/github-tooling](../.claude/skills/github-tooling/SKILL.md) | Which GitHub routes work from a cloud session, so a session does not mistake a refused route for missing access. |
| [.claude/hooks/session-start.sh](../.claude/hooks/session-start.sh) | Installs dependencies when a cloud session starts, unless the installed tree already matches the lockfile. |

## Constraints and fitness functions

[docs/constraints/](constraints/README.md) holds the architectural rules in force, one file per topic, each in the same shape: when to read it, the decision in one line, why, the rules, the alternatives that were rejected and why, and the history of the issues that set it. An agent reads the rule before it edits the code the rule covers. A rule changes meaning only through an issue the owner agrees to, linked from the file's History line.

A test that holds a rule is a fitness function. Its describe name starts `fitness:` and names its constraint file, such as `fitness: the deploy's log never shows the AWS account id (public-repo.md)`. So a session that breaks an architectural rule fails the gate, whether or not it read the file.

## The gate

`npm run gate` runs a public-repo scan, ESLint with no warnings allowed, the TypeScript check, and every test. CI runs the same command on every pull request and before each deploy from main, and nothing deploys except a green merge to main. The gate is offline and holds no secrets: tests touch memory, temporary folders, and node, python3 and git, and never the network or AWS. So a fork's pull request can run it safely.

The repo is public and agents write most of it, so the scan ([scripts/public-repo-scan.mjs](../scripts/public-repo-scan.mjs)) refuses an AWS account id, a claude.ai session or environment id, a GitHub App installation id, an issue reference of four or more digits, and Podstow's private repo in any tracked file, with no file exempt, so a session cannot leak one by accident. Only a doc may name Podstow, and link its site.

## Running a repo this way

Governor needs a deployment of its own to serve your repos: [Running your own governor](self-hosting.md) has the steps. [Serving a repo](serving-a-repo.md) then shows how a repo opts in, and its [starter kit](../examples/starter/) gives a new repo a heartbeat, a config check and three recurring reviews. The files above carry over to any repo. Copy and edit them as you need.
