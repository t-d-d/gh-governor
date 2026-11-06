# Serving a repo

How a repo puts governor to work: what each feature does, how to opt in, what `.github/governor.json` holds, and the two checks a served repo runs on itself. The [README](../README.md) is the overview. [How governor works](how-it-works.md) is the detail behind each feature, and [Hooks](hooks.md) covers sessions an outside system starts.

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

Each served repo turns on the features it wants, one section of its config file each:

- **Pickup.** A ticket carrying the repo's ready labels, with no open blocker, gets a cloud session of its own. Governor claims the ticket with the repo's claim label first, and comments the session's link on it. Only the ticket's own labels and blockers count, never its parent issue's, so a repo pauses work by taking the ready labels off the tickets that should wait. Governor does the same itself when a ready, unclaimed ticket's blocker closes as not planned: it takes the ready labels off and says so in a comment, so nothing starts before a person decides the ticket still stands. Putting them back readies it again. This is pickup's work, whatever `unblocked` says. Until a person puts them back or answers the comment, a later blocker's close starts no spec session for the ticket either.
- **Summons.** `@claude` in an issue, a comment or a review, from someone with a say in the repo, starts a session on that remark.
- **PR messages.** A PR a session wrote names that session. Every comment, review, push, merge and close on it is sent into that session, and a fresh session takes the PR over if the first one is archived.
- **Subscriptions.** Any other session hears a PR or issue it is party to by adding a `<!-- governor:subscribe <session URL> events=… -->` line to its body.
- **CI and deploys.** A red CI run on the default branch tells the sessions whose merges may have broken it. A shipping job tells the sessions of the merges it shipped, and can label their tickets `deployed: <target>`.
- **The PR review.** A model reviews each PR against the repo's checklist. Paths on the repo's human-only list wait for a person, unless an entry's `unless` labels waive it. A PR closes tickets in its own repo only; work spanning repos marks the other repo's ticket as blocked by an issue here. A pass merges the PR, or, with `merge` off, leaves it for the owner to merge. Each review also posts its verdict as a `governor` check, which a ruleset can require.
- **Sign-off.** A session whose last reply ends `Signing off.` is archived by the next turn, and a message about a close or a deploy, with nothing else open, asks the session to sign off. With `sessionRules` on, an open issue the session owns holds that ask only where it carries a ready or claim label. No session writes anything for this.

How dark the factory runs is the repo's choice: with pickup and the review on and `merge` true, a ticket can go from label to merged commit with no person, except where its PR touches a human-only path.

### A ticket that waits

One behaviour needs no switch. A ticket whose body opens with `Blocked until: 2026-11-05` is not started before that date, in every served repo. The wait ends at 00:00 UTC on the date, and a ready ticket is picked up at the first sweep on or after it. Text after the date can give the reason: `Blocked until: 2026-11-05 for a few days of log lines`. Only the body's first non-empty line counts, in any case. A line whose date governor cannot read, such as `2026-13-01` or `next week`, holds the ticket too, and governor comments once on the ticket to say so. To end a wait early, delete the line; to move it, change the date.

A ticket can also wait a number of days after one of its blockers closes: `Blocked until: 3 days after #143 closes`, or `acme/tools#143` for another repo's issue. The issue must be linked as a blocker of the ticket, so the ticket is held while it is open. When it closes as completed, governor rewrites the line once into its date, `Blocked until: 2026-11-06 (3 days after #143 closed)`, the first day whose 00:00 UTC is at least that many days after the close, and the date holds the ticket from then on. A close that is not completed leaves the line, and the ticket held, with one comment saying how to free it. This works whatever the repo's switches say. With `waits` on, governor links a same-repo issue the line names if it is not linked. A ready ticket whose relative line no open blocker holds is settled at the sweep, or gets one comment asking for the link or a date.

With the `waits` switch on, governor also acts when a wait ends. A ticket that is not ready gets one comment at the first schedule fire after its date, and, with `unblocked` on too, its spec rewritten, as a blocker's close does: by the session whose link ends its body, or by a fresh session where the body names none or that session is archived. Every session governor starts in the repo is told how to make a ticket wait. Governor learns of the line when the issue is opened, reopened or its body edited, so a ticket whose delivery was lost gets no comment or session; a ready one is still picked up.

A file with `waits` on may also name a wait ticket, `"waits": { "issue": <number> }`. Governor then links each waiting ticket as blocked by it, so the ticket's sidebar shows it is held, and removes the link when the wait ends or the line is deleted, before the sweep reads the backlog. The link is only for display: the line holds the ticket. A ticket linked to the wait ticket with no line, such as one linked by hand, gets one comment saying so, and keeps its link, which still holds it as an open blocker. GitHub lets one issue block at most 50; a ticket past that gets one comment saying the wait ticket is full, and its line still holds it. A closed wait ticket gets no new links.

## How a repo opts in

1. Install the App (`governor-app`, or your fork's own) on the repo. The account that installs it must be on the deployment's owner list.
2. Give the Claude GitHub App access to the repo, so the cloud sessions can push and comment.
3. Commit `.github/governor.json` to the default branch.

The next fire serves the repo. No deploy is needed. Deleting the file or uninstalling the App stops it at the next fire.

Governor reads the file from the default branch only. A file that fails the schema skips the repo and raises the `governor-config-invalid` alarm. The file holds no secret: a served repo may be public.

The smallest useful file:

```json
{
  "environment": "my-env",
  "pickup": { "ready": ["mode: afk"], "claim": "claimed" },
  "summons": {},
  "prMessages": {},
  "subscribeMessages": {}
}
```

### The session rules

Every session that works in a served repo follows three rules: sign what it posts on GitHub, leave a body and a PR's branch to their owner, and comment on what it does not own. Claude Code ends a session's comment with a footer that names no session, so without the first rule governor cannot tell a session's own comment from another session's. With `sessionRules` off, it sends such a comment to every session that hears of the PR or issue, the author included, and tells each that the comment may be its own. With it on, governor searches the login's live sessions working in the repo for the one that posted it, tells that session once to sign its post, and does not relay the post back to it ([An unsigned post's author](how-it-works.md#who-a-pr-or-issue-belongs-to)). A session that puts its own link alone on the line just above the footer is not sent its own posts.

Turn the rules on with a `sessionRules` section, `{}`. Every session governor starts then reads the three rules in the lines governor adds to its opening prompt, before the line on waiting where `waits` is on. With the section off, governor gives its sessions only the first rule, as one line on signing posts.

Sessions a person starts read the repo's `CLAUDE.md`, not governor's prompt. Copy this block into `CLAUDE.md` at the repo's root, or into the file `sessionRules.file` names, a path from the root:

```
<!-- governor:session-rules v1 -->
Rules for every session in this repo:

1. Sign everything you write on GitHub: comments, reviews, replies, and issue and PR bodies, with this session's link, its https://claude.ai/code/session_… URL, alone on the line just above the Claude Code footer. Governor reads the link there to know who wrote a post, so it does not send you your own posts.
2. Only an issue's or a PR's owner edits its body, and only a PR's owner pushes to its branch. You own what you filed or opened, or what governor tells you that you own. Signing off gives up the issues you own. While you own an open PR, do not sign off until governor asks.
3. To change an issue or a PR you do not own, comment on it. Where governor tells you nobody owns an issue, you may take it by editing its body so your link ends it.
<!-- governor:session-rules-end -->
```

Copy it whole, markers included. Its first marker names the version of the rules. Where `sessionRules` is on, [the config check](#the-config-check) warns on a pull request whose `CLAUDE.md`, or the file `sessionRules.file` names, has no block, or a block that is not this one. Governor's hourly fire reads the same file on the default branch. A missing or old block there logs a warning naming the repo and the file, and, where the heartbeat is on, puts a line on the heartbeat issue saying the same, until the block is current or the section is off ([The heartbeat](how-it-works.md#the-heartbeat)). Neither stops governor serving the repo. The [starter kit](#the-starter-kit)'s `CLAUDE.md` carries it.

With the section on, governor also offers an issue nobody owns to a session that comments on it. An issue has no owner once the session its link names is archived, or where a session filed it without signing it. A session's signed comment on such an issue gets a message from governor saying nobody owns the issue, no owner reads the comment, and the session may take the issue by editing its body so its link ends it. Rule 3 tells the session what to do with the offer. A person's issue, a PR, and a session building the ticket get no offer. An archived owner is learnt from the comment's own message to it, so that offer also needs `subscribeMessages` on ([An issue nobody owns](how-it-works.md#who-a-pr-or-issue-belongs-to)).

With `subscribeMessages` on as well, a session that edits an issue's body to end it with its own link is answered. Where the issue had no live owner, or a session filed it unsigned, the session has taken it, and governor tells it so. Where a live session owns it, governor writes the owner's link back, keeps the rest of the edit, and tells the editor once to comment instead. A builder that edits its ticket's body, or a session that edits a person's issue, has its link replaced by the old owner's or removed, and is told once ([A body edit that moves the owner link](how-it-works.md#who-a-pr-or-issue-belongs-to)).

With `subscribeMessages` on as well, governor also looks for who made a body edit that leaves the owner link in place, reading the owner's own events first. The owner is not told of its own edit. Where another session made it, that session is told once to post its change as a comment instead, and the owner is told someone else edited its issue. Where the owner's events cannot be read, the owner hears the edit as before ([Who made a body edit](how-it-works.md#who-a-pr-or-issue-belongs-to)).

With `prMessages` on as well, a session that edits a PR's body to move its session link to itself is answered the same way. Governor tells the PR's owner. Where the owner is live, governor writes its link back and tells the editor once to comment instead. Where the owner is archived, the editor owns the PR by its link ([A PR body edit that moves the session link](how-it-works.md#who-a-pr-or-issue-belongs-to)).

### The starter kit

[examples/starter/](../examples/starter/) is a starter kit a new repo copies into its own `.github/`, so it gets recurring work from day one. It offers two policies, one config file each, and a repo copies one of them:

- **`.github/governor.json`, where the owner merges.** Pick it for a repo starting out, or one where a person reads every pull request before it merges. Sessions pick up tickets and hear their PRs, and governor reviews nothing.
- **`.github/governor.dark-factory.json`, a dark factory.** Pick it for a repo whose CI you trust to stop a bad change, where a ticket should go from its label to a merged commit with no person. It turns on every feature but `hooks`, the PR review among them, with `merge` true.

The kit holds five files:

- `.github/governor.json` names its JSON Schema in `$schema`, at the commit the config check is pinned to, so an editor describes each key on hover. It lists every feature's section, so the file shows every feature governor has: the ones it leaves off are `{ "enabled": false }`. It turns on pickup, summons, PR messages, subscriptions, sign-off, the heartbeat and three periodics: a code review every 10 merges into the default branch, a backlog review every 5 issues opened, each also weekly when its count has counted anything, and a weekly review on its day limit alone. The backlog review checks the issues opened, then lists on the heartbeat issue the tickets left stuck: claimed ones with no open pull request, and, where issue reviews are on, open ones no issue review ran on and ones still carrying a review's `failure` or `neutral` labels. Its issue reviews are off, since its `issueReviews` section sets `"enabled": false`, and the ready labels are `mode: afk` alone: a ready label only a review adds would stop pickup with the reviews off. Each prompt is plain text that needs no skill, and acts on the window governor writes under it: the last fire's time, and what each count counted since. A repo can swap any prompt for one that calls its own skill.
- `.github/governor.dark-factory.json` is the same file with every feature but `hooks` on. It keeps the placeholders and the three periodics, and reviews every ticket before pickup builds it. Its `triage` issue review runs on each ticket that is not claimed, when it is opened, reopened or has its body edited, and when a label that changes which of its `byLabel` entries apply is added or removed. It reads governor's default prompt, then a check of the ticket's type from its `byLabel` entries: a PRD, a bug (`type: bug` or `bug`) or an enhancement. Readiness is the review's label and the mode is a person's. The one ready label is `triage: build`. A bug that passes gets `triage: build`, so pickup builds it with no person. An enhancement that passes gets `triage: passed`, and a person readies it by adding `triage: build`. A ticket its filer must edit gets `triage: needs edit`, and one a person must decide gets `triage: needs a person`, which is among the excluded labels beside `mode: human`, so pickup never takes a ticket the review doubts. A person holds a ticket by adding `mode: human`, and no review run takes it off. A person overrules the review by adding `triage: build` by hand. Create the `triage: build` label before the file goes in, or the config check warns that no ticket can carry it. It names the CI workflow `ciMessages` reads in `workflows.ci`, and has a `prReview` section: a plain-text prompt that needs no skill, `merge` true, and a human-only list that leaves every `CLAUDE.md`, `.claude/`, `.github/workflows/`, `.github/actions/`, `.github/governor.json` itself and `infra/` to a person, each with its reason. A PR touching one of them waits for a person to merge it.
- `.github/workflows/heartbeat.yml` calls [the heartbeat checker](#the-heartbeat-checker) every hour, pinned to a commit of this repo.
- `.github/workflows/config-check.yml` calls [the config check](#the-config-check) on each pull request that changes `governor.json`, an issue template or `CLAUDE.md`, pinned to a commit of this repo.
- `CLAUDE.md` carries [the session rules](#the-session-rules) block, for the repo's root. The dark-factory file turns `sessionRules` on, and `governor.json` lists it as `{ "enabled": false }`.

To use it:

1. Create the heartbeat issue. Its body must carry governor's marker, `<!-- governor:heartbeat -->`, or governor writes nothing into it. Put the marker on a line of its own: governor writes its block after it. Anything else in the body stays yours.
2. Copy the files into the repo's `.github/`, all but the policy you did not pick. For a dark factory, copy `governor.dark-factory.json` in place of `governor.json`, saved as `.github/governor.json`. Governor reads no other name. Copy the block in `CLAUDE.md` into the repo's own `CLAUDE.md` at its root, or copy the file there where the repo has none.
3. In `governor.json`, set `environment` to the repo's cloud environment, by name, in place of the `my-env` placeholder. Set `heartbeat.issue` to the issue's number, and pickup's labels to the repo's own.
4. Keep, edit or drop the periodics, and set the checker's labels in `heartbeat.yml`.
5. For a dark factory, also set these before the file merges:
   - `workflows.ci` to the repo's own CI workflow, in place of `.github/workflows/ci.yml`.
   - The human-only globs to the repo's own paths: `infra/**` stands for wherever the repo keeps its infrastructure. Add any other path a person should see change, such as billing or auth code.
   - The checklist, if the repo has its own rules for a pull request.
   - Nothing more for CI. The review waits for the latest run of `workflows.ci` at a PR's head to end green, whether or not the plan lets the default branch require it. A CI workflow with a `paths` filter has no run at the head of a PR it skips, so that PR waits until a push starts one, or a person merges it, as it would on a required check. A CI workflow that runs only after the merge has no run at any PR's head: set `prReview.waitForCi` to `false`. The review needs the App's Actions read to see the run. For any other check the review should wait for, list its name in `review.requireChecks`.
   - Each shipping job's name, ending `· deployed: <target>`, and the deploy workflow's top-level `TICKET_LABEL_PATHS`, which deploy messages and `deployed:` labels read ([Deploy messages and labels](#deploy-messages-and-labels)).
   - `merge` to false, if a person should merge each pass after all. A pass then posts its comment and check, and merges nothing. Require the `governor` check in a ruleset on the default branch, with governor's App as its source, so a pull request cannot merge while its session still owes a fix.
6. Merge them into the default branch through a pull request. The config check runs on it.

The dark factory keeps `hooks` off, since a hook needs a key the owner mints after the file merges. To add one, merge a `hooks` entry with `hooks` turned on, then mint its key as [Hooks](hooks.md) says.

Governor writes pickup's line after its next sweep. A periodic's line appears when governor first reads it, on the next sweep or counted event, and says it has not fired yet. Its first fire comes one day limit or one count later, and replaces the line. Until a line appears, the checker measures from when `governor.json` last changed.

### The schema

The schema is `configSchema` in [dispatch/repo-config.mjs](../dispatch/repo-config.mjs). An unknown key anywhere is a fault, except a top-level `$schema`, which names the JSON Schema for an editor ([Editing the file with its JSON Schema](#editing-the-file-with-its-json-schema)) and which governor ignores.

The file has one rule for where a setting lives. `environment`, `trust` and `workflows` are shared settings, since several features read them. Every other top-level key is one feature's section, and holds every setting and prompt that feature reads:

- A section turns its feature on, unless it sets `"enabled": false`. A feature with no settings is `{}`. A feature with no section is off.
- A section that is off needs none of its required settings.
- A section's named entries are an object keyed by name: `periodics.sessions`, `hooks.sessions` and `issueReviews.reviews`. An entry does not set `name`.
- A field holding text or `{ "file": "<path>" }` is `prompt`. A section with more than one has `prompts`, keyed by kind.
- Pickup's labels serve the other features that read them: `unblocked`, `waits`, `prReview` and `issueReviews`. A file that turns one of those on has a `pickup` section with `ready` and `claim`, which may set `"enabled": false` to keep pickup itself off.

Governor read `.github/dispatch.json` in an older layout before this one, and reads it no more. [Moving from dispatch.json](#moving-from-dispatchjson) says where each key went.

| Key | Required | What it holds |
|---|---|---|
| `$schema` | no | The URL of this file's JSON Schema, for an editor to describe and check each key. Governor ignores it. Use the schema at the commit the config check is pinned to, and bump both together. |
| `environment` | yes | The claude.ai cloud environment the repo's sessions start in: its name as `/remote-env` lists it, or its ID. A public repo should use the name. |
| `trust` | no | `{ "start": [ … ], "auto": [ … ], "task": [ … ], "relay": [ … ], "review": [ … ] }`: whose GitHub text governor acts on, by `author_association`. `start` is who may set work going, by readying a ticket or writing a summons, default `OWNER`, `MEMBER` and `COLLABORATOR`, which a repo may narrow and never widen. `auto` is whose issues and PRs governor sets going by itself, default `OWNER`, `MEMBER` and `COLLABORATOR`. `task` is whose issue or PR may become work when a person readies it or summons a session on it, default the same three. `relay` is whose text may reach a running session, default those three and `BOT`. `review` is whose pull requests the PR review reads, default the three. |
| `workflows` | no | What the repo's workflows are to governor: `ci`. |
| `workflows.ci` | no | The CI workflow's file, under `.github/workflows/`. A red run of it tells the sessions of the merges it may blame, and the PR review waits for its run at a PR's head. Without it, no run is CI. |
| `pickup.ready` | when pickup, `unblocked`, `waits`, `prReview` or `issueReviews` is on | Required when pickup, `unblocked`, `waits`, `prReview` or `issueReviews` is on. Every label a ready ticket carries. |
| `pickup.claim` | when pickup, `unblocked`, `waits`, `prReview` or `issueReviews` is on | Required when pickup, `unblocked`, `waits`, `prReview` or `issueReviews` is on. The label governor claims a ticket with before its session starts. It is created in a repo that lacks it. A ticket carrying it is never picked up. |
| `pickup.claimRemoves` | no | The ready labels the claim takes off, and a failed launch puts back. Default none. |
| `pickup.exclude` | no | Labels that keep a ticket out: a ticket carrying any of them is never picked up, and a blocker's close starts no session for it. It cannot name a ready label. Default `["type: prd"]`. A hold label, one that marks a ticket as needing a person or staying not ready (`mode: human`, say), belongs here, or a blocker's close starts a session to rewrite that ticket's spec. |
| `pickup.sweepHours` | no | How many whole hours the hourly fire leaves between two sweeps of the repo's ready tickets, at least one. Default one, which sweeps at every fire. |
| `pickup.prompt` | no | Replaces the default wording of a pickup session's opening prompt, below `Pickup #N 'title'`. It may name the facts {issue}, {repo} and {claim}, which governor writes in. The text, or { "file": "<path>" }. |
| `deployMessages.triage` | no | The deploy targets whose failure starts one fresh session, rather than messages to the sessions of the merges it shipped. Default none. |
| `deployMessages.tags` | no | The tag each deploy target's deploy moves, keyed by target, which deploy messages name. Default none. |
| `deployMessages.deployedLabels` | no | Whether a shipping job labels the tickets it shipped `deployed: <target>`, and comments on each ticket the first time it gets that label, for people to read; the shipping job messages each such ticket's spec owner and builders itself. Default false. |
| `prReview.prompt` | when `prReview` is on | Required when on. The review model's system prompt, after governor's fixed frame and before a suffix naming what the code decided: the text, or { "file": "<path>" }. |
| `heartbeat.issue` | when `heartbeat` is on | Required when on. The number of the issue governor records its fires on. Its body must already carry the `<!-- governor:heartbeat -->` marker, or governor writes nothing into it. |
| `periodics.sessions` | when `periodics` is on | The recurring sessions governor starts on a day limit, or on a count of merges, issues opened or issues closed, each keyed by its name: one line, with no space at either end. Its session is named after it, and governor keys its record by it. At least one when on. |
| `hooks.sessions` | when `hooks` is on | The sessions an outside system starts with a signed request, each keyed by its name: lower-case letters, digits and hyphens. The name ends the hook's URL, and its session is named after it. Each may cap its fires with `perHour`. At least one when on. |
| `waits.issue` | no | The number of the wait ticket: governor links each waiting ticket as blocked by it, and removes the link when the wait ends. An issue can block at most 50. Without it, governor links nothing. |
| `waits.prompts` | no | Replacement wording for the instruction in each kind of message the feature sends, keyed by kind: `spec`, `ownerSpec`. |
| `signOff.heldMessage` | no | Whether governor messages a session the first time the sweep holds it: its reply signed off, but an open PR's body names it, so it was not archived, and it stays open until governor asks it to sign off. Governor sends this once per session. Default false: every hold is only logged. |
| `sessionRules.file` | no | The file that carries governor's session rules block, a path from the repo's root, which the config check reads at a pull request's head, and governor's hourly fire on the default branch. Default `CLAUDE.md` at the root. |

| Section | What it turns on |
|---|---|
| `pickup` | A session per ready ticket, picked up on its label, on the close of its last open blocker, and on the sweep at the interval `sweepHours` sets. Its labels serve the features that read them, so a file turning on `unblocked`, `waits`, `prReview` or `issueReviews` has this section, with `"enabled": false` if pickup is to stay off. |
| `summons` | A session per `@claude` remark, and a dispatch started by hand. |
| `prMessages` | Messages into the session a PR names, or the newest live session holding its branch. |
| `subscribeMessages` | Messages to sessions subscribed by a `governor:subscribe` line, and to an issue's filer. On a claimed ticket, a comment, a close and a reopen also reach the sessions building it, and each message names the ticket's spec owner and builders. Governor's own comments on an issue reach no session through it: the turn that posts one tells the roles itself. A session hears a `deployed:` label only through a subscribe line for `deploys`. |
| `redScheduledRun` | A fresh session on a scheduled run on the default branch that went red. |
| `unblocked` | What a blocker's close does to a ticket that is not ready to pick up: a comment when the blocker closed as not planned, a message to a claimed ticket's session, and the spec work on a not-ready ticket. The session whose link ends the ticket's body owns it and is asked to rewrite its own spec; a fresh session rewrites it only where the body names no session or that session is archived, so nobody takes a ticket from its owner. |
| `ciMessages` | A red CI run tells the sessions of the merges it may blame. Needs `workflows.ci`. |
| `deployMessages` | A shipping job, or a red deploy, tells the sessions of the merges it shipped. |
| `branchRunMessages` | A run dispatched on a branch tells the session that wrote its commit. |
| `conflicts` | A merge into the default branch tells each PR it left conflicted. |
| `prReview` | The PR review: its prompt, and the lists it checks a PR against. Needs `prompt` when on. |
| `heartbeat` | Governor records each fire on the issue `issue` names: a line for pickup and one per periodic, under the `<!-- governor:heartbeat -->` marker its body must carry. Needs `issue` when on. |
| `periodics` | A session per periodic in `sessions`, each time its day limit passes or one of its counts is reached. Needs at least one periodic when on. |
| `hooks` | A session on a hook's prompt when a signed request fires one of the hooks `sessions` holds. A fire while the hook's last session is open goes into that session as a message. Needs at least one hook when on. |
| `waits` | When a ticket's `Blocked until:` date passes and it is not ready, one comment saying the wait ended, and, if `unblocked` is on, its spec work, which goes to its owner first as a blocker's close does. Every session governor starts is told how to make a ticket wait. The hold itself needs no switch. |
| `signOff` | Governor archives an idle session in the repo whose last reply ends `Signing off.`, and a message about a close or a deploy, with nothing else open, asks the session to sign off. |
| `sessionRules` | The three rules every session in the repo follows: sign what you post, only an owner edits a body or pushes to a PR's branch, and comment on what you do not own. Every session governor starts reads them in the lines governor adds to its opening prompt, in place of the signing line. Sessions a person starts read them in the block the repo copies into its `CLAUDE.md`, or the file `file` names, and the config check warns where that block is missing or old. With `signOff` on as well, an issue a session owns holds its ask to sign off only where it carries a ready label or the claim label, since signing off gives it up. Governor also offers an issue nobody owns to a session that signs a comment on it, confirms a take by a session that ends its body with its own link, and, with `subscribeMessages` on, writes a live owner's link back after another session moves it. With `prMessages` on, it does the same for a PR's session link. A session's post that names no session has its author searched for among the login's live sessions in the repo, and that session is told once to sign it. |
| `issueReviews` | The issue reviews: `reviews`, each keyed by its name, with its selector `when`, the labels each of its `conclusions` adds, and optionally its own `prompt` and checks and labels per label (`byLabel`), and `enabled`. Each comments on a ticket it selects whether it passes, waits for an edit, or waits for a person, and applies that conclusion's labels. Governor runs them where the file has this section, unless `enabled` is `false`. |

`workflows`:

- `ci`: the CI workflow's file, under `.github/workflows/`. Without it, no run is CI. With `prReview` on, the review also waits for this workflow's latest run at a PR's head and fails test 8 where it ended red, unless `prReview.waitForCi` is `false`. A red run on the default branch drives `ciMessages` either way.

`deployMessages` holds the deploy targets beside its switch:

- `triage`: the deploy targets whose failure starts one fresh session, rather than messages to the sessions of the merges it shipped.
- `tags`: the tag each target's deploy moves, which messages name.
- `deployedLabels`: whether a shipping job labels the tickets it shipped `deployed: <target>`. Default `false`.

A deploy is seen only if the repo's workflow declares it: the shipping job's name ends `· deployed: <target>`, and the workflow sets a top-level `TICKET_LABEL_PATHS` env. [Deploy messages and labels](#deploy-messages-and-labels) gives the steps.

`prReview`:

- `prompt` (required when on): the model's system prompt, after governor's fixed frame and before a suffix naming what the code decided, as text or `{ "file": "<path>" }`.
- `humanOnly`: `{ "glob", "reason", "unless" }` entries. A PR changing a matching path waits for a person, unless every ticket it closes carries one of the `unless` labels.
- `tickets`: `require` and `forbid` lists of `{ "labels", "unless" }` rules that every ticket the PR closes must meet.
- `quote`: globs of changed files the model reads whole. A `!` entry takes a path back out.
- `decides`: labels of a ticket that may decide a quoted file's change.
- `dependabot`: the manifests a Dependabot PR may change and pass with no model.
- `requireChecks`: checks the review treats as required, beside any the default branch requires on GitHub. Use it where the plan cannot require a check, for checks other than `workflows.ci`: static analysis from another App, a status from an outside service, another workflow's job. An entry is a name, which a check run from any App or a commit status context meets, or `{ "name": "CodeQL", "app": "github-code-scanning" }`, which only that App's check run of the name meets. Name the App where `merge` is on: a PR can add a workflow job with a listed name, and with a bare name its green run meets the entry before the real check posts. The App's slug is the last part of its `github.com/apps/<slug>` page; a workflow's job is posted by `github-actions`. One red on a PR's head fails the review for a push. One not finished, or not posted at all, holds the review with `governor` in progress until it ends. A name GitHub also requires counts once. Default none.
- `waitForCi`: whether the review waits for the `workflows.ci` run at a PR's head. Default `true`. Set it `false` where the CI workflow does not run on pull requests, such as one with only `on: push` to the default branch and `workflow_dispatch`: its PRs have no CI run at their head and would otherwise wait forever. With `false`, the review reads no workflow runs, and still reads the required checks and `requireChecks`. A PR already waiting is reviewed on its next push or body edit.
- `merge`: whether a pass merges. Default `true`. With `false`, a pass posts its comment and a `success` check, and the owner merges.

`periodics.sessions`: the recurring sessions, each keyed by its name, each `{ "prompt", "days" }`, with `counts`, `gapHours` and `connectors` if wanted.

- The key is the name: one line, with no space at either end. The session is named after it.
- `prompt`: what the session runs, as text or `{ "file": "<path>" }` read from the default branch. Governor adds a line under it giving the last fire's time, or saying this is the first run, and lists what each count counted since then, by number and title.
- `days` (required): the day limit, in whole days, at least one. The periodic is due on the sweep nearest that many days after its last fire.
- `counts`: any of `merges` (pull requests merged into the default branch), `issuesOpened` and `issuesClosed`, each a whole number of at least one. The periodic is also due once that many have happened since its last fire, whichever limit comes first. At its day limit, a periodic with counts that counted nothing starts no session, and its next day limit counts from then.
- `gapHours`: the fewest whole hours between two runs, at least one. A count reached inside the gap fires on the first event or sweep after it.
- `connectors`: the claude.ai connectors the session needs, each by its name in the account's connector list, such as `gmail_prod`: letters, digits, hyphens and underscores, each named once. A session governor starts with `claude --cloud` has none of the account's connectors, so a periodic that names any starts as a run of a routine instead, with those connectors attached and no others. Governor keeps one routine for the periodic, named after the repo and the periodic, and fires it itself. The routine is kept disabled, so its own schedule never starts a run. A connector the account has not connected starts nothing and pages (`governor-connector-missing`), and the periodic stays due. So does a routine the routines API refuses (`governor-routine-refused`), and the repo's tickets and other periodics still start. This works in public repos too, where whatever the session writes is public.

```json
"periodics": { "sessions": { "Code review": { "prompt": "Review what merged since the last review.", "days": 7, "counts": { "merges": 20 }, "gapHours": 4 } } }
```

A new periodic starts its first session one day limit, or one count, after the first fire that reads it. A periodic never overlaps itself: while the session its last fire started is still open, a due periodic is held. Governor starts nothing, logs the fire as held with that session's link, and leaves the last fire's time alone, so the count keeps growing and the first check after the session is archived fires it. Archived by the sign-off sweep or by hand, or deleted, the run is finished. How governor keeps each one's record is in [docs/how-it-works.md](how-it-works.md#periodics).

`hooks.sessions`: the hooks, each keyed by its name, each `{ "prompt", "keyVersion" }`, with `perHour` if wanted. How a caller signs its request, and how the owner mints its key, is in [Hooks](hooks.md).

- The key is the name: lower-case letters, digits and hyphens. It ends the hook's URL, and the session is named after it.
- `prompt`: what the session runs, as text or `{ "file": "<path>" }` read from the default branch. Governor adds lines under it saying which hook fired and when, and quoting the caller's text as the caller's data.
- `keyVersion` (required): the version of the hook's key a request must be signed with, a positive whole number of at most nine digits. It is not a secret.
- `perHour`: the most fires governor queues for the hook in one clock hour, a positive whole number up to 100. Default 20. A fire past it gets `429`, so a leaked key cannot flood the queue every repo shares. Each signed request counts once in its clock hour: sending the same request again in that hour, after a timeout or a `502`, takes no second place.

```json
"hooks": { "sessions": { "operator-prod": { "prompt": { "file": "ops/prod-alarm.md" }, "keyVersion": 1, "perHour": 20 } } }
```

A section's `prompt`, or each of its `prompts`, replaces the instruction in one kind of message the feature sends. Each value is text, or `{ "file": "<path>" }` read from the default branch. The kinds, the key each sits under, and the facts each may name as `{fact}`, are in [docs/how-it-works.md](how-it-works.md#prompts).

[test/fixtures/factory/.github/governor.json](../test/fixtures/factory/.github/governor.json) is a full file with every feature on.

### Moving from dispatch.json

Governor reads `.github/governor.json`, and no longer reads `.github/dispatch.json`. A repo with only the old file is not served, and governor logs that at warn, naming the file to add. To move a repo:

1. Add `.github/governor.json` in the new layout before the governor that reads it is deployed. The governor running before then never reads it.
2. After the deploy, bump the pins of the config check and the heartbeat checker to a commit that reads the new file.
3. Delete `.github/dispatch.json`.

Where each key went:

| In `dispatch.json` | In `governor.json` |
|---|---|
| `features.<switch>` | the section's presence, and its `enabled` |
| `labels.ready`, `labels.claim`, `labels.claimRemoves`, `labels.exclude` | `pickup.ready`, `pickup.claim`, `pickup.claimRemoves`, `pickup.exclude` |
| `prompts.pickup` | `pickup.prompt` |
| `prompts.signOff` | `signOff.prompt` |
| `prompts.unblockedReady`, `unblockedSpec`, `unblockedOwnerSpec`, `unblockedClaimed`, `unblockedNotPlanned` | `unblocked.prompts.ready`, `spec`, `ownerSpec`, `claimed`, `notPlanned` |
| `prompts.waitEndedSpec`, `waitEndedOwnerSpec` | `waits.prompts.spec`, `ownerSpec` |
| `prompts.redScheduledRun` | `redScheduledRun.prompt` |
| `prompts.ciBreaker`, `ciTriage`, `ciBumpTriage` | `ciMessages.prompts.breaker`, `triage`, `bumpTriage` |
| `prompts.prodTriage`, `deployGreen`, `deployGreenMany`, `deployRed`, `deployRedMany` | `deployMessages.prompts.triage`, `green`, `greenMany`, `red`, `redMany` |
| `prompts.subscribed` | `subscribeMessages.prompt` |
| `prompts.conflicts` | `conflicts.prompt` |
| `workflows.triage`, `workflows.tags` | `deployMessages.triage`, `deployMessages.tags` |
| `features.deployedLabels` | `deployMessages.deployedLabels` |
| `review` | `prReview` |
| `review.checklist` | `prReview.prompt` |
| `periodics` (a list) | `periodics.sessions`, keyed by name |
| `hooks` (a list) | `hooks.sessions`, keyed by name |

`pickup.sweepHours`, `heartbeat.issue`, `waits.issue`, `trust`, `workflows.ci` and `issueReviews` keep their places. These are gone, and governor refuses a file that sets them: `features.mergeHandoff`, `features.ticketReviews`, the prompts `mergeHandoff` and `mergeHandoffUnread`, `pickup.by` (use `trust.task`), and the heartbeat's older shape with its own `marker`.

### Deploy messages and labels

`deployMessages` tells the sessions of the merges a deploy shipped, and `deployedLabels` labels their tickets `deployed: <target>`. Turning the switches on is not enough: governor sees a deploy only through two marks in the deploy workflow. It reads the first from the shipping job's name as the run reports it (from the workflow file, for a red run), and the second from the workflow file at the run's head commit.

1. **Mark the shipping job.** Name the job whose success means the change is live so the name ends ` · deployed: <target>`: a middle dot (U+00B7) with one space each side, then the target, such as `live` or `prod`. Mark only that job for each target. Never mark a rollback job that redeploys an older build, or governor tells sessions their change is live as it is taken down.
2. **Add `at <sha>` only when it is needed.** Put `at <sha>` before the dot when the job builds a commit other than the run's head, such as a release dispatched at an older commit. The sha is the whole 40-character commit id in lower case, the form `${{ github.sha }}` gives: a short one makes the job fire nothing. Without it, governor takes the run's head as the commit shipped.
3. **Declare `TICKET_LABEL_PATHS`.** Set it as a top-level `env:` entry of the workflow file. It picks which of the shipped PRs hear of the deploy and have their tickets labelled. `all` picks every PR the job shipped. `trigger` picks the PRs that changed a file under the workflow's own `on.push.paths`, and needs those paths. Anything else is read as globs, one per line, so more than one glob needs a YAML block (`|`).
4. **Name the target's tag.** Without a `deployMessages.tags` entry, a message says "Your change is on the <target>", so a target named `live` reads "on the live". With `"tags": { "live": "live-ok" }` it says "Your change is on live", and "the live-ok tag is on <sha>".
5. **Turn on the switches.** `deployMessages`, and `deployedLabels` for the labels, which needs `deployMessages`.

What to expect once it is set up:

- **The tag is named when the job ends.** A message says "the <tag> tag is on <sha>" as soon as the shipping job succeeds. If a later job moves the tag, the message runs ahead of it, and is wrong if that job fails. Mark the job that moves the tag, or a job after it.
- **The first marked deploy tells nobody.** A shipping job covers the merges since the last green run that shipped the same label. The first run with the marker has none, so it only sets the baseline. Messages and labels start with the next one.
- **A deploy workflow that is also `workflows.ci`.** Many small repos run the gate inside the deploy. A red run of that workflow is then CI: it goes to `ciMessages` (the one suspect's session, or one fresh session for several), never to the red-deploy message (the `deployRed` prompt). A green shipping job in it still uses `deployMessages`. A deploy runs only after the merge, so it has no run at a PR's head: with `prReview` on, set `prReview.waitForCi` to `false`, or every PR's review waits for a CI run that never comes.
- **A ticket's sessions hear the shipping job, not the comment or the label.** The first time a ticket gets a `deployed:` label, governor comments on it, naming the target, the job and the commit it built. The comment is for people, and reaches no session. The shipping job messages the ticket's spec owner, the session its body's link names, and its builders where it is claimed, beside the PRs' sessions. Each session hears the deploy once, in one message naming its PRs and tickets and its role on each, and is asked to sign off where nothing else names it. With `sessionRules` on, an issue the session owns counts only where it carries a ready label or the claim label: a follow-up it filed in passing does not hold it, and signing off gives that issue up. The repo needs `deployedLabels` on. A ticket that already had the label gets no second comment, and only its PRs' sessions hear. A session is not told of the label itself unless a `governor:subscribe` line names it for `deploys`. A session that has signed off by then refuses the message, and nothing starts.

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

And the section that matches it in `governor.json`:

```json
{
  "deployMessages": { "deployedLabels": true, "tags": { "live": "live-ok" } }
}
```

### Editing the file with its JSON Schema

[schema/governor.schema.json](../schema/governor.schema.json) is `configSchema` exported as a JSON Schema. It describes every key: what governor does with it, and for a section, what the feature does. An editor that reads it shows each key's description on hover and in completion, keys the file leaves out included, and flags an unknown key. A repo names the schema in the file's own `$schema` key, at a pinned commit of this repo, so it needs no editor settings, and anyone reading the file, an AI included, finds the descriptions from the file itself:

```json
{
  "$schema": "https://raw.githubusercontent.com/t-d-d/gh-governor/<commit>/schema/governor.schema.json",
  "environment": "my-env"
}
```

Use the commit the config check is pinned to, so the editor and the check read the same schema, and bump both together. Governor ignores `$schema`. It refuses the key anywhere but the top, as it does any other unknown key.

Add `$schema` only with a config-check pin at or after the commit that taught governor the key. Before that commit, governor and the config check both refuse a file that sets it, and governor skips the repo with `governor-config-invalid`. A pin older than the schema file has no such file either, so the editor reports it cannot load the schema.

The JSON Schema covers the file's shape only. It leaves out the rules across keys, such as a claim label that is also a ready label, and the checks on one value that are not a shape, such as a prompt naming a fact its kind lacks or a prompt file's path leaving the repo. It cannot read prompt files either, so a file it accepts can still be refused. [The config check](#the-config-check) is the full check. After a change to `configSchema`, run `node scripts/export-config-schema.mjs` and commit the result; the gate fails while the committed file differs from a fresh export.

### Pickup's sweep interval

A ready label, whoever adds it, and the close of a ready ticket's last open blocker, pick a ticket up at once. A new ready label in the file is picked up at once from the repo's next turn after the merge, which reads the file; no deploy is needed. The sweep catches what those miss: a lost event, or a new ready label added to a ticket before that turn. It runs at the hourly fire, once `pickup.sweepHours` have passed since the repo's last sweep, and every hour when the file sets none. A repo that trusts its events can sweep less often:

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

Governor refuses `BOT` in it, and refuses the older `pickup.by`. Where the file sets `trust.relay` or `trust.review` too, every value `task` names, `BOT` aside, must be in each. The [config check](#the-config-check) warns where `trust.task` reaches beyond owners, members and collaborators, saying what that opens.

On a ticket whose author has no say, a ready label counts only when a person other than its author, or governor's own App, added it last. A label the author added, as an issue template does, or that a labelling workflow or another App added, does not count. Once `trust.start` is narrowed, the same holds on every ticket: a bot's label never counts. Governor logs `dispatch-pickup` at warn and comments once on the ticket, naming the labels and who added each. Someone with triage access who takes the labels off and adds them again starts the ticket. The [config check](#the-config-check) fails an issue template that names a ready label, whatever `trust.task` says.

### Whose issues governor sets going by itself

Some of governor's work starts with nobody choosing the ticket. `trust.auto` lists, by GitHub `author_association`, whose issues and pull requests that work may act on:

- a spec session, or a message to the ticket's owner session, when a not-ready ticket's blocker closes or its wait ends;
- a periodic's counts of issues opened and closed, and the issues its prompt lists. Merges count whoever opened them;
- the conflicts check's message to a PR's session, and the fresh session that takes the PR over when that one is archived;
- an issue review's ready label: governor refuses a file where a review whose `by`, narrowed by `trust.review`, reaches beyond `trust.auto` names a ready label in any of its `conclusions` ([Issue reviews and pickup](#issue-reviews-and-pickup)).

The default is `OWNER`, `MEMBER` and `COLLABORATOR`. So a stranger's issue linked as blocked by a real ticket gets no spec session when that ticket closes, a stranger's `Blocked until:` line starts nothing when its date passes, and a stranger's issue neither brings a periodic due nor appears in its prompt. Each of these is logged at info, and nothing pages the operator. A repo can narrow the list:

```json
"trust": { "auto": ["OWNER"] }
```

Or widen it, with the same values pickup reads. Governor refuses `BOT` in it, since no person read a bot's issue. Where the file sets `trust.task` too, every value `auto` names must be in it, or governor refuses the file: it would set going a ticket that pickup may not start. Where the file sets `trust.relay` or `trust.review`, the same holds for each. Where the file leaves `auto` unset and sets a narrower `trust.task`, `pickup.by`, `trust.relay` or `trust.review`, `auto` is narrowed to fit, never widened. The [config check](#the-config-check) warns where `auto` reaches beyond owners, members and collaborators, saying what that opens, and notes where it narrowed an unset `auto`.

### Whose text reaches a running session

`trust.relay` lists, by GitHub `author_association`, whose text may reach a session that is already working:

- their comments, review comments and reviews on a PR or issue a session owns or subscribes to;
- a session link, or a `governor:subscribe` line, in the body of an issue or PR they opened. Only then does it name a session, for the receiver's messages, a message to a PR's owner, CI and deploy messages, and a session's standing line.

An event with no text, a label, a close, a reopen or a push, is judged by the author of the issue or PR it is on. The default is `OWNER`, `MEMBER`, `COLLABORATOR` and `BOT`, where `BOT` is any account GitHub marks as a bot, so a review bot's findings reach the session waiting for them. Governor's own App is never judged, so the PR review's comment reaches its PR's owner whatever the list says. So a stranger who copies a session link from a merged PR into a new issue routes nothing to that session, and a stranger's comment on a session's PR is not relayed. Each refusal is logged at info, and nothing pages the operator. A repo can drop bots:

```json
"trust": { "relay": ["OWNER", "MEMBER", "COLLABORATOR"] }
```

Or widen it, for an open-source repo whose sessions should hear outside contributors. Where the file sets `auto` or `task` too, every value each names, `BOT` aside, must be in `relay`, or governor refuses the file: it would start work on a ticket whose author's comments could not reach its session. Where the file sets `relay` and leaves `auto` or `task` unset, each is narrowed to fit, never widened. An `auto` set wider than an unset `relay` narrows nothing. The [config check](#the-config-check) warns where `relay` reaches beyond owners, members and collaborators. `BOT` in a `relay` the file sets warns too: a bot that quotes strangers' issues, such as a triage or summary bot, carries their text into a session. Where the file sets `trust.review` too, every value `relay` names, `BOT` aside, must be in it, and where it leaves `relay` unset, `relay` is narrowed to fit `review`, keeping `BOT`.

### Whose pull requests the PR review reads

`trust.review` lists, by GitHub `author_association`, whose pull requests governor's PR review reads. A pull request by an author it leaves out is not read: it gets a `neutral` `governor` check saying a person merges it, which a ruleset that requires the check counts as passing. Dependabot's pull requests are read by `review.dependabot`, with no model, whatever the list says.

The default is `OWNER`, `MEMBER` and `COLLABORATOR`. So a stranger's pull request is never read by the model, nor merged by a pass. An open-source repo that wants outside contributors' pull requests reviewed widens it:

```json
"trust": { "review": ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"] }
```

`review` sits at the top of the chain `auto` ⊆ `task` ⊆ `relay` ⊆ `review`: where the file sets it beside any of the others, every value each names, `BOT` aside, must be in `review`, or governor refuses the file. A list the file leaves unset is narrowed to fit it, never widened, and `review` itself is never narrowed. The [config check](#the-config-check) warns where `review` reaches beyond owners, members and collaborators: where `prReview.merge` is on, a pass merges such a pull request with no person reading it.

### Issue reviews

A repo turns issue reviews on with an `issueReviews` section. Governor runs its reviews unless the section sets `"enabled": false`, and a file without the section runs none. 

`reviews` holds each review keyed by its name: lower-case letters, digits and hyphens. The name goes into every comment and marker the review writes, so renaming a review starts its rounds afresh. Reviews run in the order of their keys, except that JavaScript puts a key made only of digits first. A file with two reviews under one name keeps the last.

A review's `when` selects the issues it reads, and is optional:

- `labels`: the issue must carry every one of these, in any case.
- `exclude`: the issue must carry none of these, in any case.
- `by`: whose issues it reads, by `author_association`, narrowed by `trust.review`. Default `OWNER`, `MEMBER` and `COLLABORATOR`.

A review without `when` reads every issue its default `by` lets in.

**When a review runs.** An issue opened, reopened or with its body edited queues the reviews. So does a label change that can bring the issue into a review or change which of its `byLabel` entries apply: a label added that a review's `when.labels` or a `byLabel` entry's `labels` names, or a label removed that a review's `when.exclude` or a `byLabel` entry's `labels` names. Any other label change, such as a review's own conclusion labels or the claim label, starts nothing. Each run reads the issue's labels as they are then, and skips a review whose newest marker on the issue carries the issue's current key: its body, and with `byLabel`, which of the entries' labels it carries. A label change that leaves that key as it was makes no model call.

### Issue reviews and pickup

Each issue review names, in `conclusions`, the labels each of its conclusions adds:

```json
"issueReviews": {
  "reviews": {
    "triage": {
      "when": { "exclude": ["workflow: under development"] },
      "conclusions": {
        "success": ["triage: build"],
        "failure": ["triage: needs edit"],
        "neutral": ["triage: needs a person"]
      }
    }
  }
}
```

On every run governor adds the conclusion's labels and removes the ones the other two conclusions name, creating a label the repo lacks. It touches no other label. Every label a review's conclusions name, in its `conclusions` and in each `byLabel` entry's, starts with the review's name, a colon and a space, in any case: `triage: build` for a review named `triage`. Governor refuses a file otherwise. A run removes labels, so a label it shares with people would come off when a person had put it there: a `success` would take off a `mode: human` hold a member added, and pickup would start the ticket. So a review's labels are its own, new labels for its outcomes. The repo's own labels, such as `mode: afk` and `mode: human`, stay a person's: list them in `pickup.ready`, `pickup.exclude` and a review's `when`, and no review adds or removes them. Reviews and pickup share no code: they meet only through the review's labels. Two patterns:

- **Review every ticket before it is built.** List the review's `success` label among `pickup.ready`, here `"ready": ["triage: build"]`. A ticket is not ready until the review has passed it, and a later `failure` or `neutral` takes the label off again. A ticket the review readies is picked up by its label's own fire, as a person's label is. The review queues no pickup fire of its own.
- **Review a ticket once someone readies it.** List the ready label in the review's `when.labels`, here `"labels": ["mode: afk"]`. Adding the label queues the review at once, so a ticket filed before it was ready is read when it becomes so. That review's `conclusions` then cannot name the label, so it readies nothing itself.

Put the `neutral` labels in `pickup.exclude`, beside a person's hold such as `mode: human`, so pickup never takes a ticket the review doubted. Put the claim label in `when.exclude`, so a ticket already being built is not reviewed when its session edits the body. A person overrules a review by adding its `success` label by hand.

Governor refuses a file where a conclusion names a label that does not start with the review's name, a colon and a space, where one label appears under two conclusions of one review, where one label appears in two reviews' conclusions, where a review whose `by` reaches beyond `trust.auto` names a ready label, or where a conclusion names a label a `byLabel` entry matches on, a label the same review's `when.labels` or `when.exclude` names, or `pickup.claim`. The ready-label rule reads a review's `by` narrowed by `trust.review`, since the review reads no ticket whose author `trust.review` leaves out. Each rule reads a review's `conclusions` with every `byLabel` entry's. On an open-source repo, keep the default `by` on the review whose labels can ready a ticket, and give strangers a second review whose labels ready nothing.

### An issue review's prompt and its checks per label

A review's `prompt` replaces governor's default prompt, after governor's fixed frame. It is text or `{ "file": "<path>" }`, read from the default branch with the config file, as `prReview.prompt` is. A missing or empty file makes the config invalid.

`byLabel` adds checks and labels per issue label:

```json
"issueReviews": {
  "reviews": {
    "triage": {
      "when": { "exclude": ["workflow: under development"] },
      "prompt": { "file": ".github/issue-review.md" },
      "conclusions": { "success": ["triage: passed"], "failure": ["triage: needs edit"], "neutral": ["triage: needs a person"] },
      "byLabel": [
        {
          "labels": ["type: bug"],
          "prompt": "A bug says how to make it happen, what happened, and what should have.",
          "conclusions": { "success": ["triage: build"] }
        }
      ]
    }
  }
}
```

- An entry matches a ticket carrying any of its `labels`, in any case.
- A ticket gets the review's prompt, then each matching entry's `prompt`, in file order. A ticket matching no entry gets the review's prompt alone, and is not failed for lacking a label.
- An entry's `conclusions` names only the conclusions it overrides. For each conclusion, the labels come from the first matching entry that names it, and otherwise from the review's `conclusions`. Here, with `"ready": ["triage: build"]`, a bug that passes is readied with no person, and an enhancement that passes waits for one to add `triage: build`.
- With `byLabel`, the key a review's marker carries covers the labels the entries name. Adding or removing one of those labels queues the review, which runs again only where the key changed.

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

- `.github/governor.json` from the default branch. It reads only the `heartbeat`, `pickup` and `periodics` sections, each on unless it sets `"enabled": false`, and in them `heartbeat.issue`, `pickup.sweepHours` and each periodic's name and `days`, and ignores every other key. A file using a key added after the pinned commit still reads.
- The heartbeat issue the file names, and the lines governor keeps under its `<!-- governor:heartbeat -->` marker. The session rules line, which says the repo's `CLAUDE.md` lacks the current block, is read and opens no issue. A checker pinned to a commit older than the line skips it.
- When `.github/governor.json` last changed on the default branch, only for a pickup sweep or periodic that has no line yet. A change brought in by a merge commit counts from the merge, not from when its branch commit was made. It reads up to 1,000 commits of the branch's history for this, and past that uses the commit's own date.

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

Governor reads `.github/governor.json` from the default branch only, so a bad file shows up only after it merges. The repo then goes unserved, and the alarm pages the operator, not the repo. The config check catches the file on the pull request instead. The repo calls the reusable workflow [.github/workflows/config-check.yml](../.github/workflows/config-check.yml) on pull requests that change the file or an issue template, pinned to a commit of this repo. It passes the same commit as `commit`, because a called workflow cannot learn which commit it runs from:

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

A repo whose prompts live in files adds their paths under `paths:`, so a change to a prompt file runs the check too, and so does a repo whose `sessionRules.file` names a file other than `CLAUDE.md`.

The workflow fetches this repo at `commit` with git, installs the task's dependencies in `dispatch/`, and runs [checker/config-check.mjs](../checker/config-check.mjs). It reads the pull request's head: the config file and every prompt file the file names. It runs governor's own `readConfig` and `resolveFiles` over them, so the check and governor share one schema.

The run fails, with governor's fault text, on:

- a file that is not JSON, or that the schema refuses, a rule across keys included, such as a claim label that is also a ready label or `prReview` on with no `prompt`;
- a prompt file that is missing or empty, or that names a fact its kind lacks;
- an issue template whose `labels:` names one of the file's ready labels: an issue form or a Markdown template's front matter under `.github/ISSUE_TEMPLATE/`, or a single `ISSUE_TEMPLATE.md` at the root, in `.github/` or in `docs/`. The template adds its labels whoever opens the issue, so it would ready every ticket of its kind before anyone read it. The error is on the template, and holds whatever `trust.task` says.

It warns, without failing, on a file governor reads but that cannot work:

- a ready label the repo does not have;
- a `workflows.ci` file that is not in the repo;
- a heartbeat issue that does not exist or lacks its marker, `<!-- governor:heartbeat -->`;
- a `prReview.humanOnly` or `prReview.quote` glob that matches no path;
- an issue review whose `by`, or its default, shares no value with `trust.review`: governor refuses every ticket such a review selects before it runs, so it never comments;
- an issue template it cannot parse, or a template folder in a tree too large for GitHub to list whole, so its labels went unchecked;
- with `sessionRules` on, a `CLAUDE.md`, or the file `sessionRules.file` names, that is missing, has no session rules block, or has a block that is not the current one. A file the token cannot read gets a warning that the block went unchecked.

It warns too, under a title of its own, where a `trust` list the file sets reaches beyond `OWNER`, `MEMBER` and `COLLABORATOR`, and says what that list opens. Such a file works, so this is not a "cannot work" warning. It adds a notice for each list the file leaves unset that governor narrowed to fit the lists it sets, `trust.task` among them ([Whose issues governor sets going by itself](#whose-issues-governor-sets-going-by-itself), [Whose issues and pull requests work may be about](#whose-issues-and-pull-requests-work-may-be-about), [Whose text reaches a running session](#whose-text-reaches-a-running-session), [Whose pull requests the PR review reads](#whose-pull-requests-the-pr-review-reads)).

A pull request that deletes the file gets a warning that governor will stop serving the repo. Where the head still has `.github/dispatch.json`, the warning says governor no longer reads it.

It runs on the caller's own token, `contents: read` alone, and holds no secret or id. It uses no action. Where that token may not read the repo's labels or the heartbeat issue, as can happen in a private repo, the check warns that it could not, and leaves that part undone.

What it cannot see:

- **Whether `environment` resolves.** Only governor can check that, because it needs the claude.ai login.
- **A rule newer than the pin.** A pinned check refuses a key governor added after its commit, so the repo bumps the pin. A rule governor tightened after the pin lets a file through that governor then refuses, and the alarm still catches that.
