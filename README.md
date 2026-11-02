# governor

**A software factory for GitHub repos, built on Claude Code.** Label an issue, and an AI agent writes the pull request, answers its review, fixes what breaks, and signs off once the change ships. Each repo decides how much of that happens without a person.

[![Deploy](https://github.com/t-d-d/gh-governor/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/t-d-d/gh-governor/actions/workflows/deploy.yml)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
[![Built by Claude Code sessions](https://img.shields.io/badge/built%20by-Claude%20Code%20sessions-d97757)](docs/building-with-agents.md)

Coding agents can write a pull request. The work around one is still manual: picking the next ticket, starting the agent, passing on review comments, telling it CI went red or the deploy shipped. Governor does that work, as a team lead does for a team of developers. It watches each repo that installs its GitHub App, starts a Claude Code cloud session for each ready ticket, and relays everything that happens on that ticket's pull request back to the session that wrote it.

The name comes from the governor on a steam engine, which holds the engine's speed with nobody at the throttle ([more below](#why-governor)).

## It runs on its own repo

Governor started in a private repo. On 28 October 2026 its code moved here: about 14,700 lines of source and 1,360 tests. In the six days to 2 November 2026, working its own backlog, it:

- picked up **94 tickets** and started a Claude Code session on each;
- merged **98 pull requests** written by Claude Code sessions, a median of **29 minutes** from pickup to merge, the owner's review included;
- grew by about **7,300 lines of source and 900 tests**, to 2,261 tests, every one of them offline.

The owner writes the specs and tickets, and reviews and merges every pull request. Sessions write the code, the tests and the pull request descriptions.

### One feature, start to finish

The `Blocked until:` feature ([PRD #185](https://github.com/t-d-d/gh-governor/issues/185)) was split into four tickets, each blocked by the one before. Governor picked up each later ticket within two minutes of its blocker's pull request merging:

| Ticket | Picked up (UTC) | Pull request | Merged (UTC) |
|---|---|---|---|
| [#186](https://github.com/t-d-d/gh-governor/issues/186) Hold a ticket on its `Blocked until:` line | 1 Nov 23:03 | [#213](https://github.com/t-d-d/gh-governor/pull/213), 15 files | 2 Nov 07:59 |
| [#187](https://github.com/t-d-d/gh-governor/issues/187) Act when a ticket's wait ends | 2 Nov 08:00 | [#231](https://github.com/t-d-d/gh-governor/pull/231), 21 files | 2 Nov 09:07 |
| [#188](https://github.com/t-d-d/gh-governor/issues/188) Show a ticket's wait in its sidebar | 2 Nov 09:08 | [#235](https://github.com/t-d-d/gh-governor/pull/235), 11 files | 2 Nov 10:55 |
| [#189](https://github.com/t-d-d/gh-governor/issues/189) Wait a number of days after a blocker closes | 2 Nov 09:08 | [#236](https://github.com/t-d-d/gh-governor/pull/236), 14 files | 2 Nov 10:45 |

[How this repo is built](docs/building-with-agents.md) shows the loop each ticket goes through, and the files that keep the agents on track.

## How it works

```mermaid
sequenceDiagram
    actor P as Person
    participant GH as GitHub
    participant G as governor
    participant S as Claude Code session
    P->>GH: Label a ticket "mode: afk"
    GH->>G: Webhook
    G->>S: Start a cloud session on the ticket
    S->>GH: Open a pull request
    GH->>G: Review comments, CI, conflicts
    G->>S: Relay each one to the session that wrote the PR
    S->>GH: Push the fixes
    G->>GH: Review against the repo's checklist, and merge on a pass
    Note over G,GH: A change to a human-only path waits for a person
    G->>S: Your change is live
    S->>G: "Signing off."
    G->>S: Archive the session
```

An agent started on each mention, by a bot or a workflow, begins again every time. Governor keeps one session per ticket for the ticket's whole life, so the agent that wrote the code is the one that hears its review, its build, its conflicts and its deploy. It also takes work from the backlog unasked, holds a ticket while its blockers are open, and lets each repo set how far it runs.

## What it does

A repo turns each feature on with a switch in its `.github/dispatch.json`. Two behaviours are always on: sign-off, and the `Blocked until:` hold.

| Feature | What happens |
|---|---|
| Pickup | A ticket labelled ready, with no open blocker, gets a Claude Code session of its own. |
| Summons | `@claude` in an issue, a comment or a review starts a session on that remark. |
| PR messages | Every comment, review, push and merge on a pull request goes to the session that wrote it. A fresh session takes over if that one is archived. |
| CI and deploys | A red build tells the sessions whose merges may have broken it. A deploy tells the sessions whose work it shipped, and labels their tickets. |
| PR review | A model checks each pull request against the repo's own checklist. A pass merges it, or approves it for a person to merge. |
| Periodics | Recurring sessions, such as a code review every 10 merges or a weekly ticket review. |
| Hooks | A system outside GitHub, such as a cloud alarm, starts a session with a signed request. |
| Waits | A ticket that opens with `Blocked until: 2026-11-20` is not started before that date. |
| Sign-off | A session whose last reply ends `Signing off.` is archived. |

### How dark the factory runs

A dark factory runs with the lights off, because nobody works on the floor. Each repo chooses how close to that it gets:

| The repo turns on | What is left for a person |
|---|---|
| Pickup and PR messages | Review and merge every pull request. This repo runs this way. |
| The PR review, with `merge` off | Merge the pull requests the model approved. |
| The PR review, with `merge` on | Only what the review cannot pass, such as a change to a human-only path. |

## Under the hood

Every event governor acts on, a GitHub webhook, the hourly schedule or a signed hook, becomes a *fire*: one message on a queue, which the dispatcher task runs as one turn.

```mermaid
flowchart LR
    GH["GitHub App webhooks"] --> R["Receiver<br/>Lambda"]
    EB["Hourly schedule<br/>EventBridge"] --> R
    HK["Signed hooks"] --> R
    R --> Q["One FIFO queue<br/>SQS"]
    R --> ST["Starter<br/>Lambda"]
    ST --> T["Dispatcher task<br/>ECS Fargate"]
    Q --> T
    T --> CC["Claude Code<br/>cloud sessions"]
    T <--> DB[("State<br/>DynamoDB")]
    SM[("claude.ai login<br/>Secrets Manager")] <--> T
```

Some of the problems it solves, for engineers building something similar:

- **A Fargate task, not a Lambda.** `claude --cloud` will not run without a terminal, and Lambda has no pseudo-terminal. The task starts when a fire is queued and exits after a minute idle, so the AWS bill is a fraction of a cent a fire.
- **One login, one lane.** Every turn refreshes a single stored claude.ai login, and each refresh rotates the token, so two turns at once would leave one holding a dead login. Every fire goes through one FIFO queue to one task, one turn at a time.
- **Code decides before the model does.** The PR review checks the tickets a pull request closes, its human-only paths and its required checks in code, before any model call. The model has no tools, answers in a fixed JSON shape, and judges only what code cannot.
- **Relayed text is marked as data.** Every message governor relays into a session opens with a line naming where its text came from, so the session weighs each quoted remark by who wrote it. Only people with a say in the repo can summon a session. A hook's prompt lives in the repo, where a pull request reviews it, and the caller's text is quoted as data.
- **Hook keys governor never stores.** Each hook's key is derived from one secret, the repo, the hook and a version, so revoking a key is a one-line pull request. A per-hour cap stops a leaked key flooding the shared queue, and a test checks that a signed request expires before the queue forgets it.
- **A heartbeat that runs somewhere else.** Governor cannot report that it has stopped, so a served repo can run a checker on GitHub Actions that opens an issue when a sweep or a recurring session is overdue.

Two CloudFormation stacks hold all of it, and GitHub Actions deploys them after the gate passes on `main`, then runs a probe in the new task. The code is Node.js, typed with JSDoc and checked by TypeScript, with a small Python launcher for the terminal. [How governor works](docs/how-it-works.md) covers each part in depth, and [the fire lane](https://t-d-d.github.io/gh-governor/fire-lane.html) animates a fire's path from the receiver to the task.

## Limits and risks

- **The review reads the description, not the diff.** The model sees the pull request's description, the list of files it changes, the tickets it closes, and any files the repo asks it to quote whole. It judges whether the change does what its tickets ask and stays inside the repo's rules. The code itself is judged by the repo's CI and required checks, which the review will not pass while red.
- **This repo does not run the automatic merge.** Governor does not review its own pull requests, because every file here is its own code. A person merges every one.
- **It depends on Claude Code internals.** Governor starts a session by driving `claude --cloud` in a pseudo-terminal, with flags the CLI does not document, and reads a session's last reply from the sessions API. A CLI release can break it. The probe after each deploy, and 17 CloudWatch alarms, are how that shows up.
- **One subscription login.** Every session runs on one claude.ai login, copied from an interactive sign-in. The operator mints it again about every two weeks, and an alarm warns three days ahead. The subscription's usage limits, not AWS, set the real ceiling on throughput and cost.
- **One lane.** One task runs one turn at a time, and the hourly sweep starts at most two ticket sessions by default. That keeps the login safe and is plenty for one owner's repos. It would not serve a large team without a different design.

## Use the playbook without governor

Most of what keeps the agents on track here is plain files that work in any repo with Claude Code:

- [CLAUDE.md](CLAUDE.md): the rules every session reads first, such as scope, tests first, and what only the owner may do.
- [.claude/skills/](.claude/skills/): `fetch-ticket` gathers a ticket's full context, `constraints` has the agent read the relevant rules before it edits code, `pre-push` runs the gate and a code review before every push, and `pr-description` writes a pull request a reviewer can judge in one screen.
- [docs/constraints/](docs/constraints/README.md): architectural rules in a fixed format, including the alternatives that were rejected and why, each held by `fitness:` tests that fail the gate when a change breaks the rule.
- [The pull request template](.github/pull_request_template.md): a table that maps each acceptance criterion to the test that answers it.

[How this repo is built](docs/building-with-agents.md) explains how they fit together.

## Try it

Governor serves the GitHub accounts on its deployment's owner list, so you run your own. You need an AWS account you can administer, the AWS CLI, Node 22.18 or later, the Claude Code CLI, and a Claude Pro or Max subscription.

1. **Deploy governor.** Create a GitHub App, apply two CloudFormation stacks, and save a claude.ai login. [Running your own governor](docs/self-hosting.md) has every step.
2. **Opt a repo in.** Install the App, and copy the [starter kit](examples/starter/) into the repo's `.github/`. The smallest working config is:

   ```json
   {
     "environment": "my-env",
     "labels": { "ready": ["mode: afk"], "claim": "claimed" },
     "features": { "pickup": true, "summons": true, "prMessages": true, "subscribeMessages": true }
   }
   ```

3. **Label a ticket `mode: afk`.** Governor starts a session on it, and comments the session's link on the ticket.

## Documentation

| Page | Read it to |
|---|---|
| [Serving a repo](docs/serving-a-repo.md) | Opt a repo in, and look up every key and switch in `dispatch.json`. |
| [Running your own governor](docs/self-hosting.md) | Deploy governor to your own AWS account. |
| [Hooks](docs/hooks.md) | Start a session from outside GitHub with a signed request. |
| [How governor works](docs/how-it-works.md) | See what each fire does, what each message says, and what each alarm means. |
| [How this repo is built](docs/building-with-agents.md) | Run a repo the way this one runs, with agents writing the code. |
| [Constraints](docs/constraints/README.md) | Read the architectural rules the code keeps, and the tests that hold them. |

## Why "governor"?

A governor is the part of an engine that holds its speed steady with nobody at the throttle. On James Watt's steam engines, two weights spin on a shaft the engine drives. When the engine speeds up they swing out and close the steam valve, and when it slows they drop and open it. James Clerk Maxwell's 1868 paper *On Governors* is often taken as the start of control theory. The word comes, through Latin, from the Greek *kybernētēs*, the steersman, which is also where Norbert Wiener took the name cybernetics in 1948.

This governor does that job for a software factory. Agents do the work, and each repo's config file sets the limits: which tickets they may start, whether a passing review merges, and which files always wait for a person.

## Who built it

Governor is [Thomas Dickinson](https://github.com/t-d-d)'s project. Thomas designed the factory and the rules its agents work under, writes the specs and tickets, owns the architectural constraints, which change meaning only with Thomas's agreement, and merges every pull request. Claude Code sessions write the code.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
