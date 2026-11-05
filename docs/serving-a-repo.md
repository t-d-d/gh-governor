# Serving a repo

How a repo puts governor to work: what each feature does, how to opt in, what `.github/dispatch.json` holds, and the two checks a served repo runs on itself. The [README](../README.md) is the overview. [How governor works](how-it-works.md) is the detail behind each feature, and [Hooks](hooks.md) covers sessions an outside system starts.

- [What governor does](#what-governor-does)
- [How a repo opts in](#how-a-repo-opts-in)
  - [The starter kit](#the-starter-kit)
  - [The schema](#the-schema)
  - [Deploy messages and labels](#deploy-messages-and-labels)
  - [Editing the file with its JSON Schema](#editing-the-file-with-its-json-schema)
  - [Pickup's sweep interval](#pickups-sweep-interval)
  - [Whose issues and pull requests work may be about](#whose-issues-and-pull-requests-work-may-be-about)
  - [Whose issues governor sets going by itself](#whose-issues-governor-sets-going-by-itself)
  - [Whose text reaches a running session](#whose-text-reaches-a-running-session)
  - [The heartbeat checker](#the-heartbeat-checker)
  - [The config check](#the-config-check)

## What governor does

Each served repo turns on the features it wants, one switch each:

- **Pickup.** A ticket carrying the repo's ready labels, with no open blocker, gets a cloud session of its own. Governor claims the ticket with the repo's claim label first, and comments the session's link on it. Only the ticket's own labels and blockers count, never its parent issue's, so a repo pauses work by taking the ready labels off the tickets that should wait. Governor does the same itself when a ready, unclaimed ticket's blocker closes as not planned: it takes the ready labels off and says so in a comment, so nothing starts before a person decides the ticket still stands. Putting them back readies it again. This is pickup's work, whatever `unblocked` says. Until a person puts them back or answers the comment, a later blocker's close starts no spec session for the ticket either.
- **Summons.** `@claude` in an issue, a comment or a review, from someone with a say in the repo, starts a session on that remark.
- **PR messages.** A PR a session wrote names that session. Every comment, review, push, merge and close on it is sent into that session, and a fresh session takes the PR over if the first one is archived.
- **Issue messages.** An issue a session filed names that session. Each comment on it, and its close or reopen, is sent into that session. No other session hears of a PR or an issue.
- **CI and deploys.** A red CI run on the default branch tells the sessions whose merges may have broken it. A shipping job tells the sessions of the merges it shipped, and can label their tickets `deployed: <target>`.
- **The PR review.** A model reviews each PR against the repo's checklist. Paths on the repo's human-only list wait for a person, unless an entry's `unless` labels waive it. A PR closes tickets in its own repo only; work spanning repos marks the other repo's ticket as blocked by an issue here. A pass merges the PR, or, with `merge` off, leaves it for the owner to merge. Each review also posts its verdict as a `governor` check, which a ruleset can require.
- **Sign-off.** A session whose last reply ends `Signing off.` is archived by the next turn, and a message about a close or a deploy, with nothing else open, asks the session to sign off. No session writes anything for this.

How dark the factory runs is the repo's choice: with pickup and the review on and `merge` true, a ticket can go from label to merged commit with no person, except where its PR touches a human-only path.

### A ticket that waits

One behaviour needs no switch. A ticket whose body opens with `Blocked until: 2026-11-05` is not started before that date, in every served repo. The wait ends at 00:00 UTC on the date, and a ready ticket is picked up at the first sweep on or after it. Text after the date can give the reason: `Blocked until: 2026-11-05 for a few days of log lines`. Only the body's first non-empty line counts, in any case. A line whose date governor cannot read, such as `2026-13-01` or `next week`, holds the ticket too, and governor comments once on the ticket to say so. To end a wait early, delete the line; to move it, change the date.

A ticket can also wait a number of days after one of its blockers closes: `Blocked until: 3 days after #143 closes`, or `acme/tools#143` for another repo's issue. The issue must be linked as a blocker of the ticket, so the ticket is held while it is open. When it closes as completed, governor rewrites the line once into its date, `Blocked until: 2026-11-06 (3 days after #143 closed)`, the first day whose 00:00 UTC is at least that many days after the close, and the date holds the ticket from then on. A close that is not completed leaves the line, and the ticket held, with one comment saying how to free it. This works whatever the repo's switches say. With `waits` on, governor links a same-repo issue the line names if it is not linked. A ready ticket whose relative line no open blocker holds is settled at the sweep, or gets one comment asking for the link or a date.

With the `waits` switch on, governor also acts when a wait ends. A ticket that is not ready gets one comment at the first schedule fire after its date, and, with `unblocked` on too, its spec rewritten, as a blocker's close does: by the session whose link ends its body, or by a fresh session where the body names none or that session is archived. Every session governor starts in the repo is told how to make a ticket wait. Governor learns of the line when the issue is opened, reopened or its body edited, so a ticket whose delivery was lost gets no comment or session; a ready one is still picked up.

A file with `waits` on may also name a wait ticket, `"waits": { "issue": <number> }`. Governor then links each waiting ticket as blocked by it, so the ticket's sidebar shows it is held, and removes the link when the wait ends or the line is deleted, before the sweep reads the backlog. The link is only for display: the line holds the ticket. A ticket linked to the wait ticket with no line, such as one linked by hand, gets one comment saying so, and keeps its link, which still holds it as an open blocker. GitHub lets one issue block at most 50; a ticket past that gets one comment saying the wait ticket is full, and its line still holds it. A closed wait ticket gets no new links.

## How a repo opts in

1. Install the App (`governor-app`, or your fork's own) on the repo. The account that installs it must be on the deployment's owner list.
2. Give the Claude GitHub App access to the repo, so the cloud sessions can push and comment.
3. Commit `.github/dispatch.json` to the default branch.

The next fire serves the repo. No deploy is needed. Deleting the file or uninstalling the App stops it at the next fire.

Sessions should sign what they post on GitHub. Claude Code ends a session's comment with a footer that names no session, so governor cannot tell a session's own comment from another session's. It sends such a comment to every session that hears of the PR or issue, the author included, and tells each that the comment may be its own. A session that puts its own link alone on the line just above the footer is not sent its own posts. Governor tells every session it starts to do this. For sessions a person starts, add a line like this to the repo's CLAUDE.md:

```
On every comment, review and reply you post on GitHub, put this session's link, its https://claude.ai/code/session_… URL, alone on the line just above the Claude Code footer.
```

Governor reads the file from the default branch only. A file that fails the schema skips the repo and raises the `governor-config-invalid` alarm. The file holds no secret: a served repo may be public.

The smallest useful file:

```json
{
  "environment": "my-env",
  "labels": { "ready": ["mode: afk"], "claim": "claimed" },
  "features": { "pickup": true, "summons": true, "prMessages": true, "subscribeMessages": true }
}
```

### The starter kit

[examples/starter/](../examples/starter/) is a starter kit a new repo copies into its own `.github/`, so it gets recurring work from day one. It offers two policies, one `dispatch.json` each, and a repo copies one of them:

- **`.github/dispatch.json`, where the owner merges.** Pick it for a repo starting out, or one where a person reads every pull request before it merges. Sessions pick up tickets and hear their PRs, and governor reviews nothing.
- **`.github/dispatch.dark-factory.json`, a dark factory.** Pick it for a repo whose CI you trust to stop a bad change, where a ticket should go from its label to a merged commit with no person. It turns on every switch but `hooks`, the PR review among them, with `merge` true.

The kit holds four files:

- `.github/dispatch.json` names its JSON Schema in `$schema`, at the commit the config check is pinned to, so an editor describes each key on hover. Its `features` lists every switch, so the file shows every feature governor has: the ones it leaves off are `false`. It turns on pickup, summons, PR and issue messages, sign-off, the heartbeat and three periodics: a code review every 10 merges into the default branch, a backlog review every 5 issues opened, each also weekly when its count has counted anything, and a weekly review on its day limit alone. The backlog review checks the issues opened, then lists on the heartbeat issue the tickets left stuck: claimed ones with no open pull request, and, where ticket reviews are on, open ones no ticket review ran on and ones still carrying a review's `failure` or `neutral` labels. Ticket reviews are off, with none listed, and the ready labels are `mode: afk` alone: a ready label only a review adds would stop pickup with the reviews off. Each prompt is plain text that needs no skill, and acts on the window governor writes under it: the last fire's time, and what each count counted since. A repo can swap any prompt for one that calls its own skill.
- `.github/dispatch.dark-factory.json` is the same file with every switch but `hooks` on. It keeps the placeholders and the three periodics, and reviews every ticket before pickup builds it. Its `triage` ticket review runs on each ticket opened, or with its body edited, that is not claimed. It reads governor's default checklist, then a check of the ticket's type: a PRD, a bug (`type: bug` or `bug`) or an enhancement. A pass adds `triaged`, a ticket its filer must edit gets `triage: needs edit`, and one a person must decide gets `mode: human`. A bug that passes also gets `mode: afk`. The ready labels are `mode: afk` and `triaged`, so pickup takes only a ticket the review passed, and `mode: human` is among the excluded labels, so pickup never takes one it doubts. A person overrules the review by adding `triaged` by hand, and by taking off `mode: human` where the review added it. Create the `triaged` label before the file goes in, or the config check warns that no ticket can carry it. It names the CI workflow `ciMessages` reads in `workflows.ci`, and has a `review` section: a plain-text checklist that needs no skill, `merge` true, and a human-only list that leaves every `CLAUDE.md`, `.claude/`, `.github/workflows/`, `.github/actions/`, `.github/dispatch.json` itself and `infra/` to a person, each with its reason. A PR touching one of them waits for a person to merge it.
- `.github/workflows/heartbeat.yml` calls [the heartbeat checker](#the-heartbeat-checker) every hour, pinned to a commit of this repo.
- `.github/workflows/config-check.yml` calls [the config check](#the-config-check) on each pull request that changes `dispatch.json` or an issue template, pinned to a commit of this repo.

To use it:

1. Create the heartbeat issue. Its body must carry governor's marker, `<!-- governor:heartbeat -->`, or governor writes nothing into it. Put the marker on a line of its own: governor writes its block after it. Anything else in the body stays yours.
2. Copy the files into the repo's `.github/`, all but the policy you did not pick. For a dark factory, copy `dispatch.dark-factory.json` in place of `dispatch.json`, saved as `.github/dispatch.json`. Governor reads no other name.
3. In `dispatch.json`, set `environment` to the repo's cloud environment, by name, in place of the `my-env` placeholder. Set `heartbeat.issue` to the issue's number, and the labels to the repo's own.
4. Keep, edit or drop the periodics, and set the checker's labels in `heartbeat.yml`.
5. For a dark factory, also set these before the file merges:
   - `workflows.ci` to the repo's own CI workflow, in place of `.github/workflows/ci.yml`.
   - The human-only globs to the repo's own paths: `infra/**` stands for wherever the repo keeps its infrastructure. Add any other path a person should see change, such as billing or auth code.
   - The checklist, if the repo has its own rules for a pull request.
   - Nothing more for CI. The review waits for the latest run of `workflows.ci` at a PR's head to end green, whether or not the plan lets the default branch require it. A CI workflow with a `paths` filter has no run at the head of a PR it skips, so that PR waits until a push starts one, or a person merges it, as it would on a required check. A CI workflow that runs only after the merge has no run at any PR's head: set `review.waitForCi` to `false`. The review needs the App's Actions read to see the run. For any other check the review should wait for, list its name in `review.requireChecks`.
   - Each shipping job's name, ending `· deployed: <target>`, and the deploy workflow's top-level `TICKET_LABEL_PATHS`, which deploy messages and `deployed:` labels read ([Deploy messages and labels](#deploy-messages-and-labels)).
   - `merge` to false, if a person should merge each pass after all. A pass then posts its comment and check, and merges nothing. Require the `governor` check in a ruleset on the default branch, with governor's App as its source, so a pull request cannot merge while its session still owes a fix.
6. Merge them into the default branch through a pull request. The config check runs on it.

The dark factory keeps `hooks` off, since a hook needs a key the owner mints after the file merges. To add one, merge a `hooks` entry with `hooks` turned on, then mint its key as [Hooks](hooks.md) says.

Governor writes pickup's line after its next sweep. A periodic's line appears when governor first reads it, on the next sweep or counted event, and says it has not fired yet. Its first fire comes one day limit or one count later, and replaces the line. Until a line appears, the checker measures from when `dispatch.json` last changed.

### The schema

The schema is `configSchema` in [dispatch/repo-config.mjs](../dispatch/repo-config.mjs). An unknown key anywhere is a fault, except a top-level `$schema`, which names the JSON Schema for an editor ([Editing the file with its JSON Schema](#editing-the-file-with-its-json-schema)) and which governor ignores.

| Key | Required | What it holds |
|---|---|---|
| `$schema` | no | The URL of this file's JSON Schema, for an editor to describe and check each key. Governor ignores it. Use the schema at the commit the config check is pinned to, and bump both together. |
| `environment` | yes | The claude.ai cloud environment the repo's sessions start in: its name as `/remote-env` lists it, or its ID. A public repo should use the name. |
| `labels.ready` | yes | Every label a ready ticket carries. |
| `labels.claim` | yes | The label governor claims a ticket with before its session starts. It is created in a repo that lacks it. A ticket carrying it is never picked up. |
| `labels.claimRemoves` | no | The ready labels the claim takes off, and a failed launch puts back. Default none. |
| `labels.exclude` | no | Labels that keep a ticket out: a ticket carrying any of them is never picked up, and a blocker's close starts no session for it. It cannot name a ready label. Default `["type: prd"]`. A hold label, one that marks a ticket as needing a person or staying not ready (`mode: human`, say), belongs here, or a blocker's close starts a session to rewrite that ticket's spec. |
| `features` | yes | The switches that turn governor's features on, each `true` or `false`. A switch left out is off. |
| `workflows` | no | What the repo's workflows are to governor: `ci`, `triage` and `tags`. |
| `review` | when `prReview` is on | The PR review's settings: its checklist, and the lists it checks a PR against. Needed when `prReview` is on. |
| `heartbeat` | when `heartbeat` is on | `{ "issue": <number> }`: the issue governor records every fire on, under the `<!-- governor:heartbeat -->` marker its body must carry. The older `{ "issue": <number>, "marker": "<!-- … -->" }` keeps one `last-run:` line under the repo's own marker, which the hourly sweep updates. Needed when `heartbeat` is on. |
| `waits` | no | `{ "issue": <number> }`: the wait ticket, which each waiting ticket is linked as blocked by while it waits, so its sidebar shows the wait. Read only with `waits` on. Without it, governor links nothing. |
| `pickup` | no | `{ "sweepHours": <number>, "by": [ … ] }`: how many whole hours the hourly fire leaves between two sweeps of the repo's ready tickets, at least one, default one; and `by`, the retired name of `trust.task`, which governor reads as it. |
| `trust` | no | `{ "start": [ … ], "auto": [ … ], "task": [ … ], "relay": [ … ], "review": [ … ] }`: whose GitHub text governor acts on, by `author_association`. `start` is who may set work going, by readying a ticket or writing a summons, default `OWNER`, `MEMBER` and `COLLABORATOR`, which a repo may narrow and never widen. `auto` is whose issues and PRs governor sets going by itself, default `OWNER`, `MEMBER` and `COLLABORATOR`. `task` is whose issue or PR may become work when a person readies it or summons a session on it, default the same three. `relay` is whose text may reach a running session, default those three and `BOT`. `review` is whose pull requests the PR review reads, default the three. |
| `prompts` | no | Replacement wording for the instruction in each kind of message, keyed by kind. |
| `periodics` | when `periodics` is on | The recurring sessions governor starts on a day limit, or on a count of merges, issues opened or issues closed. At least one when the `periodics` switch is on. |
| `hooks` | when `hooks` is on | The sessions an outside system starts with a signed request, each with an optional `perHour` cap on fires. At least one when the `hooks` switch is on. |
| `ticketReviews` | when `ticketReviews` is on | The ticket reviews governor runs, in file order, each with its `name`, its selector `when`, the labels each of its `conclusions` adds, and optionally its own `checklist` and checks and labels per ticket type (`types`). Each comments on a ticket it selects whether it passes, waits for an edit, or waits for a person, and applies that conclusion's labels. At least one when the `ticketReviews` switch is on. |

The switches in `features`:

| Switch | What it turns on |
|---|---|
| `pickup` | A session per ready ticket, picked up on its label, on the close of its last open blocker, and on the sweep at the interval `pickup.sweepHours` sets. |
| `summons` | A session per `@claude` remark, and a dispatch started by hand. |
| `prMessages` | Messages into the session a PR names, or the local session holding its branch. |
| `subscribeMessages` | Messages to an issue's filer, the session its body names: a comment on the issue, and its close or reopen. A filer hears no label, a `deployed:` label included. |
| `redScheduledRun` | A fresh session on a scheduled run on the default branch that went red. |
| `unblocked` | What a blocker's close does to a ticket that is not ready to pick up: a comment when the blocker closed as not planned, a message to a claimed ticket's session, and the spec work on a not-ready ticket. The session whose link ends the ticket's body owns it and is asked to rewrite its own spec; a fresh session rewrites it only where the body names no session or that session is archived, so nobody takes a ticket from its owner. A file that still sets the older `mergeHandoff` reads as this. |
| `ciMessages` | A red CI run tells the sessions of the merges it may blame. Needs `workflows.ci`. |
| `deployMessages` | A shipping job, or a red deploy, tells the sessions of the merges it shipped. |
| `branchRunMessages` | A run dispatched on a branch tells the session that wrote its commit. |
| `conflicts` | A merge into the default branch tells each PR it left conflicted. |
| `deployedLabels` | A shipping job labels the tickets it shipped `deployed: <target>`. Needs `deployMessages`. |
| `prReview` | The PR review, run from the `review` section. |
| `heartbeat` | Governor records each fire on the issue the `heartbeat` section names: a line for pickup and one per periodic. In the older shape with a `marker`, the hourly sweep stamps the issue's `last-run:` line instead. |
| `periodics` | A session per periodic in the `periodics` list, each time its day limit passes or one of its counts is reached. |
| `hooks` | A session on a hook's prompt when a signed request fires one of the hooks the `hooks` list holds. A fire while the hook's last session is open goes into that session as a message. |
| `waits` | When a ticket's `Blocked until:` date passes and it is not ready, one comment saying the wait ended, and, if `unblocked` is on, its spec work, which goes to its owner first as a blocker's close does. Every session governor starts is told how to make a ticket wait. The hold itself needs no switch. |
| `signOff` | Governor archives an idle session in the repo whose last reply ends `Signing off.`, and a message about a close or a deploy, with nothing else open, asks the session to sign off. |
| `ticketReviews` | Each review the `ticketReviews` list holds comments on a ticket it selects, when the ticket is opened, reopened or has its body edited: whether it passes, waits for an edit, or waits for a person. |

`workflows`:

- `ci`: the CI workflow's file, under `.github/workflows/`. Without it, no run is CI. With `prReview` on, the review also waits for this workflow's latest run at a PR's head and fails test 8 where it ended red, unless `review.waitForCi` is `false`. A red run on the default branch drives `ciMessages` either way.
- `triage`: the deploy targets whose failure starts one fresh session, rather than messages to the sessions of the merges it shipped.
- `tags`: the tag each target's deploy moves, which messages name.

A deploy is seen only if the repo's workflow declares it: the shipping job's name ends `· deployed: <target>`, and the workflow sets a top-level `TICKET_LABEL_PATHS` env. [Deploy messages and labels](#deploy-messages-and-labels) gives the steps.

`review`:

- `checklist` (required): the model's system prompt, after governor's fixed frame and before a suffix naming what the code decided, as text or `{ "file": "<path>" }`.
- `humanOnly`: `{ "glob", "reason", "unless" }` entries. A PR changing a matching path waits for a person, unless every ticket it closes carries one of the `unless` labels.
- `tickets`: `require` and `forbid` lists of `{ "labels", "unless" }` rules that every ticket the PR closes must meet.
- `quote`: globs of changed files the model reads whole. A `!` entry takes a path back out.
- `decides`: labels of a ticket that may decide a quoted file's change.
- `dependabot`: the manifests a Dependabot PR may change and pass with no model.
- `requireChecks`: names of check runs and commit status contexts the review treats as required, beside any the default branch requires on GitHub. Use it where the plan cannot require a check, for checks other than `workflows.ci`: static analysis from another App, a status from an outside service, another workflow's job. One red on a PR's head fails the review for a push. One not finished, or not posted at all, holds the review with `governor` in progress until it ends. A name GitHub also requires counts once. Default none.
- `waitForCi`: whether the review waits for the `workflows.ci` run at a PR's head. Default `true`. Set it `false` where the CI workflow does not run on pull requests, such as one with only `on: push` to the default branch and `workflow_dispatch`: its PRs have no CI run at their head and would otherwise wait forever. With `false`, the review reads no workflow runs, and still reads the required checks and `requireChecks`. A PR already waiting is reviewed on its next push or body edit.
- `merge`: whether a pass merges. Default `true`. With `false`, a pass posts its comment and a `success` check, and the owner merges.

`periodics`: a list of recurring sessions, each `{ "name", "prompt", "days" }`, with `counts`, `gapHours` and `connectors` if wanted.

- `name`: one line, unique in the file. The session is named after it.
- `prompt`: what the session runs, as text or `{ "file": "<path>" }` read from the default branch. Governor adds a line under it giving the last fire's time, or saying this is the first run, and lists what each count counted since then, by number and title.
- `days` (required): the day limit, in whole days, at least one. The periodic is due on the sweep nearest that many days after its last fire.
- `counts`: any of `merges` (pull requests merged into the default branch), `issuesOpened` and `issuesClosed`, each a whole number of at least one. The periodic is also due once that many have happened since its last fire, whichever limit comes first. At its day limit, a periodic with counts that counted nothing starts no session, and its next day limit counts from then.
- `gapHours`: the fewest whole hours between two runs, at least one. A count reached inside the gap fires on the first event or sweep after it.
- `connectors`: the claude.ai connectors the session needs, each by its name in the account's connector list, such as `gmail_prod`: letters, digits, hyphens and underscores, each named once. A session governor starts with `claude --cloud` has none of the account's connectors, so a periodic that names any starts as a run of a routine instead, with those connectors attached and no others. Governor keeps one routine for the periodic, named after the repo and the periodic, and fires it itself. The routine is kept disabled, so its own schedule never starts a run. A connector the account has not connected starts nothing and pages (`governor-connector-missing`), and the periodic stays due. So does a routine the routines API refuses (`governor-routine-refused`), and the repo's tickets and other periodics still start. This works in public repos too, where whatever the session writes is public.

```json
{ "name": "Code review", "prompt": "Review what merged since the last review.", "days": 7, "counts": { "merges": 20 }, "gapHours": 4 }
```

A new periodic starts its first session one day limit, or one count, after the first fire that reads it. A periodic never overlaps itself: while the session its last fire started is still open, a due periodic is held. Governor starts nothing, logs the fire as held with that session's link, and leaves the last fire's time alone, so the count keeps growing and the first check after the session is archived fires it. Archived by the sign-off sweep or by hand, or deleted, the run is finished. How governor keeps each one's record is in [docs/how-it-works.md](how-it-works.md#periodics).

`hooks`: a list of hooks, each `{ "name", "prompt", "keyVersion" }`, with `perHour` if wanted. How a caller signs its request, and how the owner mints its key, is in [Hooks](hooks.md).

- `name`: lower-case letters, digits and hyphens, unique in the file. It ends the hook's URL, and the session is named after it.
- `prompt`: what the session runs, as text or `{ "file": "<path>" }` read from the default branch. Governor adds lines under it saying which hook fired and when, and quoting the caller's text as the caller's data.
- `keyVersion` (required): the version of the hook's key a request must be signed with, a positive whole number of at most nine digits. It is not a secret.
- `perHour`: the most fires governor queues for the hook in one clock hour, a positive whole number up to 100. Default 20. A fire past it gets `429`, so a leaked key cannot flood the queue every repo shares. Each signed request counts once in its clock hour: sending the same request again in that hour, after a timeout or a `502`, takes no second place.

```json
{ "name": "operator-prod", "prompt": { "file": "ops/prod-alarm.md" }, "keyVersion": 1, "perHour": 20 }
```

`prompts`: each value is text, or `{ "file": "<path>" }` read from the default branch. The kinds, and the facts each may name as `{fact}`, are in [docs/how-it-works.md](how-it-works.md#prompts).

[test/fixtures/factory/.github/dispatch.json](../test/fixtures/factory/.github/dispatch.json) is a full file with every feature on.

### Deploy messages and labels

`deployMessages` tells the sessions of the merges a deploy shipped, and `deployedLabels` labels their tickets `deployed: <target>`. Turning the switches on is not enough: governor sees a deploy only through two marks in the deploy workflow. It reads the first from the shipping job's name as the run reports it (from the workflow file, for a red run), and the second from the workflow file at the run's head commit.

1. **Mark the shipping job.** Name the job whose success means the change is live so the name ends ` · deployed: <target>`: a middle dot (U+00B7) with one space each side, then the target, such as `live` or `prod`. Mark only that job for each target. Never mark a rollback job that redeploys an older build, or governor tells sessions their change is live as it is taken down.
2. **Add `at <sha>` only when it is needed.** Put `at <sha>` before the dot when the job builds a commit other than the run's head, such as a release dispatched at an older commit. The sha is the whole 40-character commit id in lower case, the form `${{ github.sha }}` gives: a short one makes the job fire nothing. Without it, governor takes the run's head as the commit shipped.
3. **Declare `TICKET_LABEL_PATHS`.** Set it as a top-level `env:` entry of the workflow file. It picks which of the shipped PRs hear of the deploy and have their tickets labelled. `all` picks every PR the job shipped. `trigger` picks the PRs that changed a file under the workflow's own `on.push.paths`, and needs those paths. Anything else is read as globs, one per line, so more than one glob needs a YAML block (`|`).
4. **Name the target's tag.** Without a `workflows.tags` entry, a message says "Your change is on the <target>", so a target named `live` reads "on the live". With `"tags": { "live": "live-ok" }` it says "Your change is on live", and "the live-ok tag is on <sha>".
5. **Turn on the switches.** `deployMessages`, and `deployedLabels` for the labels, which needs `deployMessages`.

What to expect once it is set up:

- **The tag is named when the job ends.** A message says "the <tag> tag is on <sha>" as soon as the shipping job succeeds. If a later job moves the tag, the message runs ahead of it, and is wrong if that job fails. Mark the job that moves the tag, or a job after it.
- **The first marked deploy tells nobody.** A shipping job covers the merges since the last green run that shipped the same label. The first run with the marker has none, so it only sets the baseline. Messages and labels start with the next one.
- **A deploy workflow that is also `workflows.ci`.** Many small repos run the gate inside the deploy. A red run of that workflow is then CI: it goes to `ciMessages` (the one suspect's session, or one fresh session for several), never to the red-deploy message (the `deployRed` prompt). A green shipping job in it still uses `deployMessages`. A deploy runs only after the merge, so it has no run at a PR's head: with `prReview` on, set `review.waitForCi` to `false`, or every PR's review waits for a CI run that never comes.
- **An issue's filer does not hear the label.** A filer hears every comment on its issue and its close, but no label, a `deployed:` label included. The label is still set. The session that wrote the PR hears the deploy itself.

A minimal deploy workflow, `.github/workflows/deploy.yml`, with both marks:

```yaml
name: Deploy
on:
  push:
    branches: [main]
env:
  TICKET_LABEL_PATHS: all
jobs:
  deploy:
    # Quoted: an unquoted ": " inside a value is not valid YAML.
    name: "Deploy · deployed: live"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/deploy.sh
```

And the lines that match it in `dispatch.json`:

```json
{
  "features": { "deployMessages": true, "deployedLabels": true },
  "workflows": { "tags": { "live": "live-ok" } }
}
```

### Editing the file with its JSON Schema

[schema/dispatch.schema.json](../schema/dispatch.schema.json) is `configSchema` exported as a JSON Schema. It describes every key: what governor does with it, and for a switch, what the switch turns on. An editor that reads it shows each key's description on hover and in completion, keys the file leaves out included, and flags an unknown key. A repo names the schema in the file's own `$schema` key, at a pinned commit of this repo, so it needs no editor settings, and anyone reading the file, an AI included, finds the descriptions from the file itself:

```json
{
  "$schema": "https://raw.githubusercontent.com/t-d-d/gh-governor/<commit>/schema/dispatch.schema.json",
  "environment": "my-env"
}
```

Use the commit the config check is pinned to, so the editor and the check read the same schema, and bump both together. Governor ignores `$schema`. It refuses the key anywhere but the top, as it does any other unknown key.

Add `$schema` only with a config-check pin at or after the commit that taught governor the key. Before that commit, governor and the config check both refuse a file that sets it, and governor skips the repo with `governor-config-invalid`. A pin older than the schema file has no such file either, so the editor reports it cannot load the schema.

The JSON Schema covers the file's shape only. It leaves out the rules across keys, such as a claim label that is also a ready label, and the checks on one value that are not a shape, such as a prompt naming a fact its kind lacks or a prompt file's path leaving the repo. It cannot read prompt files either, so a file it accepts can still be refused. [The config check](#the-config-check) is the full check. After a change to `configSchema`, run `node scripts/export-config-schema.mjs` and commit the result; the gate fails while the committed file differs from a fresh export.

### Pickup's sweep interval

A ready label a person adds, and the close of a ready ticket's last open blocker, pick a ticket up at once. A new ready label in the file is picked up at once from the repo's next turn after the merge, which reads the file; no deploy is needed. The sweep catches what those miss: a lost event, or a new ready label added to a ticket before that turn. It runs at the hourly fire, once `pickup.sweepHours` have passed since the repo's last sweep, and every hour when the file sets none. A repo that trusts its events can sweep less often:

```json
"pickup": { "sweepHours": 6 }
```

The fire's clock is the deployment's, which the file cannot see, so a repo is swept at the first fire at or after its interval. An interval shorter than the clock's tick sweeps at every fire. Pickup's line on the heartbeat issue records each sweep.

### Who may set work going

`trust.start` lists, by GitHub `author_association`, who may set work going:

- a ready label counts only when its latest add was by someone in it, or by governor's own App;
- an `@claude` summons starts a session only when its writer is in it. An issue assigned to `claude` is a summons by whoever assigned it.

The default is `OWNER`, `MEMBER` and `COLLABORATOR`, and a repo may only narrow it. Governor refuses any other value, and `BOT`. A repo where only the owner starts work sets:

```json
"trust": { "start": ["OWNER"] }
```

Sessions act through the owner's account, so they still start work there. At the default nobody is looked up: without triage access a person can add a label only through an issue template, so anyone but the ticket's author who added one is in the three, and the author's association is on the issue. Once `start` is narrowed, governor looks up whoever added a ready label, or assigned an issue to `claude`. The repo owner's login is `OWNER`. On a user's repo anyone else who can add a label is a `COLLABORATOR`, and on an org's repo the repo's outside-collaborator list tells a `COLLABORATOR` from a `MEMBER`. A lookup that fails starts nothing that turn and logs at warn, and the next turn looks again.

When a person outside `start` readies a ticket or summons a session, nothing starts. Governor logs it at info and comments once on the issue or pull request, under the `<!-- governor:uncounted-ready -->` marker, naming who set it going, what they count as, and who may. Someone `start` lets in who takes the labels off and adds them again starts the ticket.

### Whose issues and pull requests work may be about

`trust.task` lists, by GitHub `author_association`, whose issue or pull request may become work when a person sets it going:

- pickup starts a ready ticket only where its author is in it;
- an `@claude` summons starts a session only where the author of the issue or pull request it is on is in it.

The default is `OWNER`, `MEMBER` and `COLLABORATOR`, narrowed to fit a `trust.relay` or `trust.review` the file sets ([Whose text reaches a running session](#whose-text-reaches-a-running-session), [Whose pull requests the PR review reads](#whose-pull-requests-the-pr-review-reads)). So a stranger's ticket is not started, even once someone with a say adds its ready labels, and a member's summons on a stranger's issue starts nothing. An issue's body can hide instructions in HTML comments GitHub does not render, so readying it would vouch for text nobody has seen. Where a person readied the ticket, or someone with a say summoned a session on it, governor comments once on it, under the `<!-- governor:uncounted-ready -->` marker, saying `trust.task` refused it and the two ways on: restate the work in a ticket of your own, linking this one, or widen `task`. A stranger's ticket that its own template, a bot or nobody readied gets no comment. Each refusal is logged at info, and nothing pages the operator. A repo that builds strangers' tickets as they stand lists more:

```json
"trust": { "task": ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"] }
```

Governor refuses `BOT` in it. The older `pickup.by` is read as `trust.task`, so a file that sets it keeps working, but a file that sets both is refused. Where the file sets `trust.relay` or `trust.review` too, every value `task` names, `BOT` aside, must be in each. The [config check](#the-config-check) warns where `trust.task` reaches beyond owners, members and collaborators, saying what that opens.

On a ticket whose author has no say, a ready label counts only when a person other than its author, or governor's own App, added it last. A label the author added, as an issue template does, or that a labelling workflow or another App added, does not count. Once `trust.start` is narrowed, the same holds on every ticket: a bot's label never counts. Governor logs `dispatch-pickup` at warn and comments once on the ticket, naming the labels and who added each. Someone with triage access who takes the labels off and adds them again starts the ticket. The [config check](#the-config-check) fails an issue template that names a ready label, whatever `trust.task` says.

### Whose issues governor sets going by itself

Some of governor's work starts with nobody choosing the ticket. `trust.auto` lists, by GitHub `author_association`, whose issues and pull requests that work may act on:

- a spec session, or a message to the ticket's owner session, when a not-ready ticket's blocker closes or its wait ends;
- a periodic's counts of issues opened and closed, and the issues its prompt lists. Merges count whoever opened them;
- the conflicts check's message to a PR's session, and the fresh session that takes the PR over when that one is archived;
- a ticket review's ready label: governor refuses a file where a review whose `by`, narrowed by `trust.review`, reaches beyond `trust.auto` names a ready label in any of its `conclusions` ([Ticket reviews and pickup](#ticket-reviews-and-pickup)).

The default is `OWNER`, `MEMBER` and `COLLABORATOR`. So a stranger's issue linked as blocked by a real ticket gets no spec session when that ticket closes, a stranger's `Blocked until:` line starts nothing when its date passes, and a stranger's issue neither brings a periodic due nor appears in its prompt. Each of these is logged at info, and nothing pages the operator. A repo can narrow the list:

```json
"trust": { "auto": ["OWNER"] }
```

Or widen it, with the same values pickup reads. Governor refuses `BOT` in it, since no person read a bot's issue. Where the file sets `trust.task` (or the older `pickup.by`) too, every value `auto` names must be in it, or governor refuses the file: it would set going a ticket that pickup may not start. Where the file sets `trust.relay` or `trust.review`, the same holds for each. Where the file leaves `auto` unset and sets a narrower `trust.task`, `pickup.by`, `trust.relay` or `trust.review`, `auto` is narrowed to fit, never widened. The [config check](#the-config-check) warns where `auto` reaches beyond owners, members and collaborators, saying what that opens, and notes where it narrowed an unset `auto`.

### Whose text reaches a running session

`trust.relay` lists, by GitHub `author_association`, whose text may reach a session that is already working:

- their comments, review comments and reviews on a PR or issue a session owns;
- a session link in the body of an issue or PR they opened. Only then does it name a session, for the receiver's messages, a message to a PR's owner, CI and deploy messages, and a session's standing line.

An event with no text, a label, a close, a reopen or a push, is judged by the author of the issue or PR it is on. The default is `OWNER`, `MEMBER`, `COLLABORATOR` and `BOT`, where `BOT` is any account GitHub marks as a bot, so a review bot's findings reach the session waiting for them. Governor's own App is never judged, so the PR review's comment reaches its PR's owner whatever the list says. So a stranger who copies a session link from a merged PR into a new issue routes nothing to that session, and a stranger's comment on a session's PR is not relayed. Each refusal is logged at info, and nothing pages the operator. A repo can drop bots:

```json
"trust": { "relay": ["OWNER", "MEMBER", "COLLABORATOR"] }
```

Or widen it, for an open-source repo whose sessions should hear outside contributors. Where the file sets `auto` or `task` (or `pickup.by`) too, every value each names, `BOT` aside, must be in `relay`, or governor refuses the file: it would start work on a ticket whose author's comments could not reach its session. Where the file sets `relay` and leaves `auto` or `task` unset, each is narrowed to fit, never widened. An `auto` set wider than an unset `relay` narrows nothing. The [config check](#the-config-check) warns where `relay` reaches beyond owners, members and collaborators. `BOT` in a `relay` the file sets warns too: a bot that quotes strangers' issues, such as a triage or summary bot, carries their text into a session. Where the file sets `trust.review` too, every value `relay` names, `BOT` aside, must be in it, and where it leaves `relay` unset, `relay` is narrowed to fit `review`, keeping `BOT`.

### Whose pull requests the PR review reads

`trust.review` lists, by GitHub `author_association`, whose pull requests governor's PR review reads. A pull request by an author it leaves out is not read: it gets a `neutral` `governor` check saying a person merges it, which a ruleset that requires the check counts as passing. Dependabot's pull requests are read by `review.dependabot`, with no model, whatever the list says.

The default is `OWNER`, `MEMBER` and `COLLABORATOR`. So a stranger's pull request is never read by the model, nor merged by a pass. An open-source repo that wants outside contributors' pull requests reviewed widens it:

```json
"trust": { "review": ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"] }
```

`review` sits at the top of the chain `auto` ⊆ `task` ⊆ `relay` ⊆ `review`: where the file sets it beside any of the others, every value each names, `BOT` aside, must be in `review`, or governor refuses the file. A list the file leaves unset is narrowed to fit it, never widened, and `review` itself is never narrowed. The [config check](#the-config-check) warns where `review` reaches beyond owners, members and collaborators: where `review.merge` is on, a pass merges such a pull request with no person reading it.

### Ticket reviews and pickup

Each ticket review names, in `conclusions`, the labels each of its conclusions adds:

```json
"ticketReviews": [
  {
    "name": "triage",
    "when": { "on": "opened", "exclude": ["workflow: under development"] },
    "conclusions": {
      "success": ["triaged"],
      "failure": ["triage: needs edit"],
      "neutral": ["mode: human"]
    }
  }
]
```

On every run governor adds the conclusion's labels and removes the ones the other two conclusions name, creating a label the repo lacks. It touches no other label. Reviews and pickup share no code: they meet only through these labels. Two patterns:

- **Review every ticket before it is built.** List the review's `success` label among `labels.ready`, here `"ready": ["mode: afk", "triaged"]`. A ticket is not ready until the review has passed it, and a later `failure` or `neutral` takes the label off again. Pickup takes a ticket the review readied at the repo's next sweep (`pickup.sweepHours`), since a label governor adds queues no selection of its own.
- **Trust a ticket someone has readied.** List the ready labels in the review's `when.exclude`. A ticket that carries them when it opens is not reviewed, and pickup starts it as today. That review's `conclusions` then cannot name those labels, so it readies nothing itself.

Put the `neutral` labels in `labels.exclude`, as `mode: human` is, so pickup never takes a ticket the review doubted. Put the claim label in `when.exclude`, so a ticket already being built is not reviewed when its session edits the body. A person overrules a review by adding its `success` label by hand.

Governor refuses a file where one label appears under two conclusions of one review, where one label appears in two reviews' conclusions, where a review whose `by` reaches beyond `trust.auto` names a ready label, or where a conclusion names a label a `types` entry matches on, a label the same review's `when.labels` or `when.exclude` names, or `labels.claim`. The ready-label rule reads a review's `by` narrowed by `trust.review`, since the review reads no ticket whose author `trust.review` leaves out. Each rule reads a review's `conclusions` with every `types` entry's. On an open-source repo, keep the default `by` on the review whose labels can ready a ticket, and give strangers a second review whose labels ready nothing.

### A ticket review's checklists and ticket types

A review's `checklist` replaces governor's default checklist, after governor's fixed frame. It is text or `{ "file": "<path>" }`, read from the default branch with the config file, as `review.checklist` is. A missing or empty file makes the config invalid.

`types` adds checks and labels per ticket type, matched by label:

```json
"ticketReviews": [
  {
    "name": "triage",
    "when": { "on": "opened", "exclude": ["workflow: under development"] },
    "checklist": { "file": ".github/ticket-review.md" },
    "conclusions": { "success": ["triaged"], "failure": ["triage: needs edit"], "neutral": ["mode: human"] },
    "types": [
      {
        "labels": ["type: bug"],
        "checklist": "A bug says how to make it happen, what happened, and what should have.",
        "conclusions": { "success": ["triaged", "mode: afk"] }
      }
    ]
  }
]
```

- An entry matches a ticket carrying any of its `labels`, in any case.
- A ticket gets the base checklist, then each matching entry's `checklist`, in file order. A ticket matching no entry gets the base alone, and is not failed for lacking a type label.
- An entry's `conclusions` names only the conclusions it overrides. For each conclusion, the labels come from the first matching entry that names it, and otherwise from the review's `conclusions`. Here a bug that passes is readied with no person, and an enhancement that passes waits for one.
- With `types`, the key a review's marker carries covers the labels the entries name. A label change alone queues no review: the ticket is reviewed again at its next body edit or reopen, under its labels then.

### The heartbeat checker

Governor cannot report that it has stopped, so the check runs in the served repo, on GitHub Actions. The repo calls the reusable workflow [.github/workflows/heartbeat-check.yml](../.github/workflows/heartbeat-check.yml) on a schedule of its own, pinned to a commit of this repo:

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
      tolerance-hours: 3
      labels: heartbeat
```

What it reads:

- `.github/dispatch.json` from the default branch. It reads only `features.heartbeat`, `features.pickup`, `features.periodics`, `heartbeat.issue`, `pickup.sweepHours` and each periodic's `name` and `days`, and ignores every other key. A file using a key added after the pinned commit still reads.
- The heartbeat issue the file names, and the lines governor keeps under its `<!-- governor:heartbeat -->` marker.
- When `.github/dispatch.json` last changed on the default branch, only for a pickup sweep or periodic that has no line yet. A change brought in by a merge commit counts from the merge, not from when its branch commit was made. It reads up to 1,000 commits of the branch's history for this, and past that uses the commit's own date.

The inputs:

- `tolerance-hours`: how far past its limit a line may run before the check opens an issue. Default 3. Governor's schedule fires every hour, so a line can run up to an hour past its limit when nothing is wrong. Set the tolerance above that.
- `labels`: the labels the check's issues carry, separated by commas or new lines. Default none.

What its issues say:

- **Pickup's sweep is overdue.** Pickup's last sweep is older than `pickup.sweepHours`, or an hour when unset, plus the tolerance. The issue gives the last sweep's time.
- **A periodic is overdue.** Its last fire is older than its `days` plus the tolerance. The issue names the periodic, gives its last fire time and state, and says whether governor holds it for an open session, with that session's link. A periodic governor has read but never fired is measured from when governor first read it, and its issue says it has never fired.
- **No line.** The file lists pickup or a periodic with no line on the heartbeat issue, and the file last changed longer ago than its limit plus the tolerance. A checker pinned to a commit older than the `not fired yet` state skips such a line, and treats the periodic as having none.
- **The heartbeat could not be read.** The config file is missing, unreadable, does not parse, or does not turn the heartbeat on in the `{ "issue": <number> }` shape, or the heartbeat issue cannot be read or lacks governor's marker. The issue says which.

The check keeps one issue open for each of these and updates it on each run. It closes the issue, with a comment, once the line is fresh again, the heartbeat reads again, or the file no longer lists the line. While the heartbeat cannot be read, it leaves the other issues as they are. Runs in a repo queue rather than overlap, so two never open the same issue. A failure to list, open or close its issues fails the run.

It runs on the caller's own token, `contents: read` and `issues: write`, and holds no secret or id. It uses no action. The step carries [checker/heartbeat-check.mjs](../checker/heartbeat-check.mjs) and runs it on the runner's node.

### The config check

Governor reads `.github/dispatch.json` from the default branch only, so a bad file shows up only after it merges. The repo then goes unserved, and the alarm pages the operator, not the repo. The config check catches the file on the pull request instead. The repo calls the reusable workflow [.github/workflows/config-check.yml](../.github/workflows/config-check.yml) on pull requests that change the file or an issue template, pinned to a commit of this repo. It passes the same commit as `commit`, because a called workflow cannot learn which commit it runs from:

```yaml
name: config check
on:
  pull_request:
    paths:
      - .github/dispatch.json
      - .github/ISSUE_TEMPLATE/**
      - ISSUE_TEMPLATE.md
      - .github/ISSUE_TEMPLATE.md
      - docs/ISSUE_TEMPLATE.md
permissions:
  contents: read
jobs:
  check:
    uses: t-d-d/gh-governor/.github/workflows/config-check.yml@<commit>
    with:
      commit: <commit>
```

A repo whose prompts live in files adds their paths under `paths:`, so a change to a prompt file runs the check too.

The workflow fetches this repo at `commit` with git, installs the task's dependencies in `dispatch/`, and runs [checker/config-check.mjs](../checker/config-check.mjs). It reads the pull request's head: the config file and every prompt file the file names. It runs governor's own `readConfig` and `resolveFiles` over them, so the check and governor share one schema.

The run fails, with governor's fault text, on:

- a file that is not JSON, or that the schema refuses, a rule across keys included, such as a claim label that is also a ready label or `prReview` on with no `review` section;
- a prompt file that is missing or empty, or that names a fact its kind lacks;
- an issue template whose `labels:` names one of the file's ready labels: an issue form or a Markdown template's front matter under `.github/ISSUE_TEMPLATE/`, or a single `ISSUE_TEMPLATE.md` at the root, in `.github/` or in `docs/`. The template adds its labels whoever opens the issue, so it would ready every ticket of its kind before anyone read it. The error is on the template, and holds whatever `trust.task` says.

It warns, without failing, on a file governor reads but that cannot work:

- a ready label the repo does not have;
- a `workflows.ci` file that is not in the repo;
- a heartbeat issue that does not exist or lacks its marker, `<!-- governor:heartbeat -->`, or the repo's own in the older shape;
- a `review.humanOnly` or `review.quote` glob that matches no path;
- a ticket review whose `by`, or its default, shares no value with `trust.review`: governor refuses every ticket such a review selects before it runs, so it never comments;
- an issue template it cannot parse, or a template folder in a tree too large for GitHub to list whole, so its labels went unchecked.

It warns too, under a title of its own, where a `trust` list the file sets reaches beyond `OWNER`, `MEMBER` and `COLLABORATOR`, and says what that list opens. Such a file works, so this is not a "cannot work" warning. It adds a notice for each list the file leaves unset that governor narrowed to fit the lists it sets, `trust.task` among them ([Whose issues governor sets going by itself](#whose-issues-governor-sets-going-by-itself), [Whose issues and pull requests work may be about](#whose-issues-and-pull-requests-work-may-be-about), [Whose text reaches a running session](#whose-text-reaches-a-running-session), [Whose pull requests the PR review reads](#whose-pull-requests-the-pr-review-reads)).

A pull request that deletes the file gets a warning that governor will stop serving the repo.

It runs on the caller's own token, `contents: read` alone, and holds no secret or id. It uses no action. Where that token may not read the repo's labels or the heartbeat issue, as can happen in a private repo, the check warns that it could not, and leaves that part undone.

What it cannot see:

- **Whether `environment` resolves.** Only governor can check that, because it needs the claude.ai login.
- **A rule newer than the pin.** A pinned check refuses a key governor added after its commit, so the repo bumps the pin. A rule governor tightened after the pin lets a file through that governor then refuses, and the alarm still catches that.
