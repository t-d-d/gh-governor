# Serving a repo

How a repo puts governor to work: what it does, how to opt in, and the two checks a served repo runs on itself. [The config reference](config-reference.md) lists every key of `.github/governor.json`. The [README](../README.md) is the overview, and [Hooks](hooks.md) covers sessions an outside system starts.

## What governor does

Each served repo turns on the features it wants, one section of its config file each:

- **Pickup.** A ticket carrying the repo's ready labels, with no open blocker, gets a cloud session of its own. Governor claims it with the claim label first and comments the session's link on it. Only the ticket's own labels and blockers count, so a repo pauses work by taking the ready labels off.
- **Summons.** `@claude` in an issue, a comment or a review, from someone with a say in the repo, starts a session on that remark.
- **PR messages.** A PR a session wrote names that session. Every comment, review, push, merge and close on it is sent into that session, and a fresh session takes the PR over if the first one is archived.
- **Subscriptions.** Any other session hears a PR or issue it is party to by adding a `<!-- governor:subscribe <session URL> events=… -->` line to its body.
- **CI and deploys.** A red CI run on the default branch tells the sessions whose merges may have broken it. A shipping job tells the sessions of the merges it shipped, and can label their tickets `deployed: <target>`.
- **Reviews.** A model reviews each PR against the repo's checklist, and a pass merges it unless `merge` is off. Issue reviews read each ticket and label it as passed, waiting for an edit, or waiting for a person.
- **Recurring work.** Periodics start a session on a day limit or a count of merges or issues, and hooks start one on an outside system's signed request.
- **Sign-off.** A session whose last reply ends `Signing off.` is archived, and a message about a close or a deploy, with nothing else open, asks the session to sign off.

How dark the factory runs is the repo's choice: with pickup and the PR review on and `merge` true, a ticket can go from label to merged commit with no person, except where its PR touches a path the repo leaves to a person.

One behaviour needs no switch. A ticket whose body opens with `Blocked until: 2026-11-05`, or `Blocked until: 3 days after #143 closes` for a linked blocker, is not started before then. The wait ends at 00:00 UTC on the date, and only the body's first non-empty line counts. A date governor cannot read, such as `next week`, holds the ticket too, and governor comments once to say so. The `waits` section adds a comment when the wait ends.

`trust` says whose text governor acts on, by GitHub `author_association`: who may set work going, whose tickets may become work, whose text reaches a session, and whose PRs the review reads. The default is the repo's owners, members and collaborators. The config check warns where a list reaches further, and says what that opens.

## How a repo opts in

1. Install the App (`governor-app`, or your fork's own) on the repo. The account that installs it must be on the deployment's owner list.
2. Give the Claude GitHub App access to the repo, so the cloud sessions can push and comment.
3. Commit `.github/governor.json` to the default branch. [The starter kit](../examples/starter/) has one to copy.
4. Add the config check, `.github/workflows/config-check.yml`, and, for a heartbeat, an issue whose body carries `<!-- governor:heartbeat -->`. [The starter kit](#the-starter-kit) has both.

The next fire serves the repo. No deploy is needed. Deleting the file or uninstalling the App stops it at the next fire. Governor reads the file from the default branch only. A file that fails the schema skips the repo and raises the `governor-config-invalid` alarm. The file holds no secret: a served repo may be public.

The smallest useful file:

```json
{
  "$schema": "https://raw.githubusercontent.com/t-d-d/gh-governor/<commit>/schema/governor.schema.json",
  "environment": "my-env",
  "pickup": { "ready": ["mode: afk"], "claim": "claimed" },
  "summons": {},
  "prMessages": {},
  "subscribeMessages": {}
}
```

`environment` is the repo's claude.ai cloud environment, by name. `$schema` names the file's JSON Schema at a pinned commit of this repo, so an editor describes each key on hover and flags an unknown one, with no editor settings. Use the commit the config check is pinned to, and bump both together. An unknown key anywhere is a fault, except a top-level `$schema`, which governor ignores.

`environment`, `trust` and `workflows` are shared settings. Every other top-level key is one feature's section, and holds every setting and prompt that feature reads. A section turns its feature on unless it sets `"enabled": false`, a feature with no settings is `{}`, and a feature with no section is off. [The config reference](config-reference.md) gives every key, its default and what governor does with it. [test/fixtures/factory/.github/governor.json](../test/fixtures/factory/.github/governor.json) is a full file with every feature on.

Governor no longer reads `.github/dispatch.json`, the older layout. A repo with only that file is not served, and governor logs a warning naming the file to add.

### The session rules

Every session that works in a served repo follows three rules: sign what it posts on GitHub, leave a body and a PR's branch to their owner, and comment on what it does not own. A signed post lets governor tell a session's own comment from another's, so it does not relay a session's post back to it. With a `sessionRules` section on, every session governor starts reads the rules in its opening prompt, and governor tells a session once when it breaks one. With it off, governor's sessions get only the first rule.

Sessions a person starts read the repo's `CLAUDE.md`, not governor's prompt. Copy this block into `CLAUDE.md` at the repo's root, or into the file `sessionRules.file` names, a path from the root:

```
<!-- governor:session-rules v1 -->
Rules for every session in this repo:

1. Sign everything you write on GitHub: comments, reviews, replies, and issue and PR bodies, with this session's link, its https://claude.ai/code/session_… URL, alone on the line just above the Claude Code footer. Governor reads the link there to know who wrote a post, so it does not send you your own posts.
2. Only an issue's or a PR's owner edits its body, and only a PR's owner pushes to its branch. You own what you filed or opened, or what governor tells you that you own. Signing off gives up the issues you own. While you own an open PR, do not sign off until governor asks.
3. To change an issue or a PR you do not own, comment on it. Where governor tells you nobody owns an issue, you may take it by editing its body so your link ends it.
<!-- governor:session-rules-end -->
```

Copy it whole, markers included. Its first marker names the version of the rules. Where `sessionRules` is on, [the config check](#the-config-check) warns on a pull request whose file has no block, or an old one, and governor's hourly fire logs the same for the default branch and notes it on the heartbeat issue. Neither stops governor serving the repo.

### The starter kit

[examples/starter/](../examples/starter/) is a starter kit a new repo copies, so it gets recurring work from day one. It offers two policies, one config file each, and a repo copies one of them:

- **`.github/governor.json`, where the owner merges.** Pick it for a repo starting out, or one where a person reads every pull request before it merges. Sessions pick up tickets and hear their PRs, and governor reviews nothing.
- **`.github/governor.dark-factory.json`, a dark factory.** Pick it for a repo whose CI you trust to stop a bad change, where a ticket should go from its label to a merged commit with no person. It turns on every feature but `hooks`, the PR review among them, with `merge` true.

Both name their JSON Schema in `$schema`, and list every feature's section, so the file shows every feature governor has: the ones it leaves off are `{ "enabled": false }`. Both run three periodics: a code review every 10 merges, a backlog review every 5 issues opened, and a weekly review. The backlog review checks the issues opened, then lists on the heartbeat issue the tickets left stuck: claimed ones with no open pull request, and, where issue reviews are on, open ones no issue review ran on and ones still carrying a review's `failure` or `neutral` labels. In `governor.json` issue reviews are off, since its `issueReviews` section sets `"enabled": false`, and the ready label is `mode: afk`.

The dark-factory file reviews every ticket before pickup builds it. Its `triage` issue review reads each unclaimed ticket, with checks for a PRD, a bug and an enhancement. The one ready label is `triage: build`. A bug that passes gets it, so pickup builds it with no person. An enhancement that passes gets `triage: passed`, and a person readies it by adding `triage: build`. A ticket its filer must edit gets `triage: needs edit`, and one a person must decide gets `triage: needs a person`, which pickup excludes beside `mode: human`. A person holds a ticket by adding `mode: human`, and no review run takes it off. Its PR review leaves `CLAUDE.md`, `.claude/`, the workflows, the config file and `infra/` to a person.

The kit also holds `.github/workflows/heartbeat.yml` and `.github/workflows/config-check.yml`, each pinned to a commit of this repo, and a `CLAUDE.md` carrying the session rules block. To use it:

1. Create the heartbeat issue, with governor's marker, `<!-- governor:heartbeat -->`, on a line of its own. Governor writes its block after it, and the rest of the body stays yours.
2. Copy the files into the repo, all but the policy you did not pick, saved as `.github/governor.json`. Copy the session rules block into the repo's own `CLAUDE.md`.
3. Set `environment` to the repo's cloud environment, `heartbeat.issue` to the issue's number, and pickup's labels to the repo's own. Keep, edit or drop the periodics, and set the checker's labels in `heartbeat.yml`.
4. For a dark factory, also set `workflows.ci` to the repo's CI workflow, the human-only globs to the repo's own paths, and the checklist if the repo has rules of its own. Create the `triage: build` label. A CI workflow that runs only after the merge needs `prReview.waitForCi` set to `false`. For deploy messages, mark the shipping job as the `deployMessages` entry in [the config reference](config-reference.md#deploymessages) says. Set `merge` to false if a person should merge each pass after all, and require the `governor` check in a ruleset.
5. Merge them through a pull request. The config check runs on it.

The dark factory keeps `hooks` off, since a hook needs a key the owner mints after the file merges. To add a hook, merge a `hooks` entry, then mint its key as [Hooks](hooks.md) says.

### The heartbeat checker

Governor cannot report that it has stopped, so the check runs in the served repo, on GitHub Actions. The repo calls the reusable workflow [.github/workflows/heartbeat-check.yml](../.github/workflows/heartbeat-check.yml) on a schedule of its own, pinned to a commit of this repo. It passes the same commit as `commit`, because a called workflow cannot learn which commit it runs from:

```yaml
name: heartbeat
on:
  schedule:
    - cron: "23 * * * *"
  workflow_dispatch:
permissions:
  contents: read
  issues: write
jobs:
  check:
    uses: t-d-d/gh-governor/.github/workflows/heartbeat-check.yml@<commit>
    with:
      commit: <commit>
      tolerance-hours: 3
      labels: heartbeat
```

It reads the lines governor keeps on the heartbeat issue, and opens an issue, labelled with `labels`, when pickup's sweep or a periodic runs more than `tolerance-hours` past its limit, when a line governor should keep is missing, or when the heartbeat cannot be read. It keeps one issue open for each, and closes it once the line is fresh again. Pickup's line appears after governor's next sweep, and a periodic's when governor first reads it. Until a line appears, the checker measures from when `governor.json` last changed. Governor fires every hour, so keep the tolerance above one hour. It reads the config file with governor's own reader at the pinned commit, so a file that governor at that commit would refuse, such as one using a newer key, is a fault: move the pin when the file takes up a new key. A workflow pinned to a commit before the `commit` input carries its own copy of the checker and takes none. It runs on the caller's own token, holds no secret, and uses no action.

### The config check

Governor reads `.github/governor.json` from the default branch only, so a bad file would show up only after it merges, and page the operator, not the repo. The config check catches it on the pull request instead. The repo calls the reusable workflow [.github/workflows/config-check.yml](../.github/workflows/config-check.yml), pinned to a commit of this repo, and passes the same commit as `commit`, because a called workflow cannot learn which commit it runs from:

```yaml
name: config check
on:
  pull_request:
    paths:
      - .github/governor.json
      - .github/ISSUE_TEMPLATE/**
      - ISSUE_TEMPLATE.md
      - .github/ISSUE_TEMPLATE.md
      - docs/ISSUE_TEMPLATE.md
      - CLAUDE.md
permissions:
  contents: read
jobs:
  check:
    uses: t-d-d/gh-governor/.github/workflows/config-check.yml@<commit>
    with:
      commit: <commit>
```

A repo whose prompts live in files adds their paths under `paths:`, and so does a repo whose `sessionRules.file` names a file other than `CLAUDE.md`.

It runs governor's own schema over the file and its prompt files at the pull request's head. It fails on a file governor would refuse, and on an issue template that adds a ready label, since that readies every ticket of its kind before anyone reads it. It warns on a file that cannot work, such as a ready label the repo lacks or a missing heartbeat marker, and on a `trust` list wider than owners, members and collaborators. It cannot check that `environment` resolves, which needs the claude.ai login, or a rule governor added after its pin, so bump the pin with governor. It runs on the caller's own token, `contents: read` alone, and holds no secret.
