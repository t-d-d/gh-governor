# governor

A software factory for your GitHub repos, in which each repo sets how dark its factory runs: whether a passing review merges, and which paths always wait for a person.

Governor starts Claude Code cloud sessions for the repos that install its GitHub App and commit a `.github/dispatch.json`. It picks up tickets labelled ready, relays each PR's comments, reviews and CI to the session that wrote it, reviews PRs against the repo's own checklist, and archives a session once it signs off.

- [What governor does](#what-governor-does)
- [How a repo opts in](#how-a-repo-opts-in)
- [How governor runs](#how-governor-runs)
- [Fork and deploy](#fork-and-deploy)
- [Licence](#licence)

## What governor does

Each served repo turns on the features it wants, one switch each:

- **Pickup.** A ticket carrying the repo's ready labels, with no open blocker, gets a cloud session of its own. Governor claims the ticket with the repo's claim label first, and comments the session's link on it. Only the ticket's own labels and blockers count, never its parent issue's, so a repo pauses work by taking the ready labels off the tickets that should wait.
- **Summons.** `@claude` in an issue, a comment or a review, from someone with a say in the repo, starts a session on that remark.
- **PR messages.** A PR a session wrote names that session. Every comment, review, push, merge and close on it is sent into that session, and a fresh session takes the PR over if the first one is archived.
- **Subscriptions.** Any other session hears a PR or issue it is party to by adding a `<!-- governor:subscribe <session URL> events=… -->` line to its body.
- **CI and deploys.** A red CI run on the default branch tells the sessions whose merges may have broken it. A shipping job tells the sessions of the merges it shipped, and can label their tickets `deployed: <target>`.
- **The PR review.** A model reviews each PR against the repo's checklist. Paths on the repo's human-only list always wait for a person. A PR closes tickets in its own repo only; work spanning repos marks the other repo's ticket as blocked by an issue here. A pass merges the PR, or, with `merge` off, approves it for the owner to merge.
- **Sign-off.** A session whose last reply ends `Signing off.` is archived by the next turn. No session writes anything for this.

How dark the factory runs is the repo's choice: with pickup and the review on and `merge` true, a ticket can go from label to merged commit with no person, except where its PR touches a human-only path.

[docs/how-it-works.md](docs/how-it-works.md) describes each feature in full. [docs/constraints/](docs/constraints/README.md) holds the rules the code keeps. Diagrams that need motion or controls are HTML pages in `docs/pages/`, published at <https://t-d-d.github.io/gh-governor/>; [docs/how-it-works.md](docs/how-it-works.md#pages) says how they publish and how to preview one from a branch.

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

[examples/starter/](examples/starter/) is a starter kit a new repo copies into its own `.github/`, so it gets recurring work from day one. It holds three files:

- `.github/dispatch.json` turns on pickup, summons, PR messages, subscriptions, the heartbeat and three periodics: a code review every 10 merges into the default branch, a ticket review every 5 issues opened, each also weekly when its count has counted anything, and a weekly review on its day limit alone. Each prompt is plain text that needs no skill, and acts on the window governor writes under it: the last fire's time, and what each count counted since. A repo can swap any prompt for one that calls its own skill.
- `.github/workflows/heartbeat.yml` calls [the heartbeat checker](#the-heartbeat-checker) every hour, pinned to a commit of this repo.
- `.github/workflows/config-check.yml` calls [the config check](#the-config-check) on each pull request that changes `dispatch.json`, pinned to a commit of this repo.

To use it:

1. Create the heartbeat issue. Its body must carry governor's marker, `<!-- governor:heartbeat -->`, or governor writes nothing into it. Put the marker on a line of its own: governor writes its block after it. Anything else in the body stays yours.
2. Copy the three files into the repo's `.github/`.
3. In `dispatch.json`, set `environment` to the repo's cloud environment, by name, in place of the `my-env` placeholder. Set `heartbeat.issue` to the issue's number, and the labels to the repo's own.
4. Keep, edit or drop the periodics, and set the checker's labels in `heartbeat.yml`.
5. Merge them into the default branch through a pull request. The config check runs on it.

Governor writes pickup's line after its next sweep. A periodic's line appears when governor first reads it, on the next sweep or counted event, and says it has not fired yet. Its first fire comes one day limit or one count later, and replaces the line. Until a line appears, the checker measures from when `dispatch.json` last changed.

### The schema

The schema is `configSchema` in [dispatch/repo-config.mjs](dispatch/repo-config.mjs). An unknown key anywhere is a fault.

| Key | Required | What it holds |
|---|---|---|
| `environment` | yes | The claude.ai cloud environment the repo's sessions start in: its name as `/remote-env` lists it, or its ID. A public repo should use the name. |
| `labels.ready` | yes | Every label a ready ticket carries. |
| `labels.claim` | yes | The label governor claims a ticket with before its session starts. It is created in a repo that lacks it. A ticket carrying it is never picked up. |
| `labels.claimRemoves` | no | The ready labels the claim takes off, and a failed launch puts back. Default none. |
| `labels.exclude` | no | Labels that keep a ticket out: a ticket carrying any of them is never picked up, and a blocker's close starts no session for it. It cannot name a ready label. Default `["type: prd"]`. A hold label, one that marks a ticket as needing a person or staying not ready (`mode: human`, say), belongs here, or a blocker's close starts a session to rewrite that ticket's spec. |
| `features` | yes | The switches below, each `true` or `false`. A switch left out is off. |
| `workflows` | no | What the repo's workflows are to governor: `ci`, `triage` and `tags`. |
| `review` | when `prReview` is on | The PR review's settings. |
| `heartbeat` | when `heartbeat` is on | `{ "issue": <number> }`: the issue governor records every fire on, under the `<!-- governor:heartbeat -->` marker its body must carry. The older `{ "issue": <number>, "marker": "<!-- … -->" }` keeps one `last-run:` line under the repo's own marker, which the hourly sweep updates. |
| `pickup` | no | `{ "sweepHours": <number> }`: how many whole hours the hourly fire leaves between two sweeps of the repo's ready tickets, at least one. Default one, which sweeps at every fire. |
| `prompts` | no | Replacement wording for the instruction in each kind of message, keyed by kind. |
| `periodics` | when `periodics` is on | The recurring sessions governor starts on a day limit, or on a count of merges, issues opened or issues closed. At least one when the switch is on. |
| `hooks` | when `hooks` is on | The sessions an outside system starts with a signed request ([Hooks](#hooks)), each with an optional `perHour` cap on fires. At least one when the switch is on. |

The switches in `features`:

| Switch | What it turns on |
|---|---|
| `pickup` | A session per ready ticket, picked up on its label, on the close of its last open blocker, and on the sweep at the interval `pickup.sweepHours` sets. |
| `summons` | A session per `@claude` remark, and a dispatch started by hand. |
| `prMessages` | Messages into the session a PR names, or the local session holding its branch. |
| `subscribeMessages` | Messages to sessions subscribed by a `governor:subscribe` line, and to an issue's filer. A filer hears a `deployed:` label on its issue only through a subscribe line for `deploys`. |
| `redScheduledRun` | A fresh session on a scheduled run on the default branch that went red. |
| `unblocked` | What a blocker's close does to a ticket that is not ready to pick up: a comment when the blocker closed as not planned, a message to a claimed ticket's session, and a session to rewrite a not-ready ticket's spec from what merged. A file that still sets the older `mergeHandoff` reads as this. |
| `ciMessages` | A red CI run tells the sessions of the merges it may blame. Needs `workflows.ci`. |
| `deployMessages` | A shipping job, or a red deploy, tells the sessions of the merges it shipped. |
| `branchRunMessages` | A run dispatched on a branch tells the session that wrote its commit. |
| `conflicts` | A merge into the default branch tells each PR it left conflicted. |
| `deployedLabels` | A shipping job labels the tickets it shipped `deployed: <target>`. Needs `deployMessages`. |
| `prReview` | The PR review, run from the `review` section. |
| `heartbeat` | Governor records each fire on the issue `heartbeat` names: a line for pickup and one per periodic. In the older shape with a `marker`, the hourly sweep stamps the issue's `last-run:` line instead. |
| `periodics` | A session per periodic in the `periodics` list, each time its day limit passes or one of its counts is reached. |
| `hooks` | A session on a hook's prompt when a signed request fires one of the `hooks` listed. A fire while the hook's last session is open goes into that session as a message. |

`workflows`:

- `ci`: the CI workflow's file, under `.github/workflows/`. Without it, no run is CI.
- `triage`: the deploy targets whose failure starts one fresh session, rather than messages to the sessions of the merges it shipped.
- `tags`: the tag each target's deploy moves, which messages name.

A deploy is seen only if the repo's workflow declares it: the shipping job's name ends `· deployed: <target>`, and the workflow sets a top-level `TICKET_LABEL_PATHS` env. [Deploy messages and labels](#deploy-messages-and-labels) gives the steps.

`review`:

- `checklist` (required): what is appended to the model's system prompt, as text or `{ "file": "<path>" }`.
- `humanOnly`: `{ "glob", "reason", "unless" }` entries. A PR changing a matching path waits for a person, unless every ticket it closes carries one of the `unless` labels.
- `tickets`: `require` and `forbid` lists of `{ "labels", "unless" }` rules that every ticket the PR closes must meet.
- `quote`: globs of changed files the model reads whole. A `!` entry takes a path back out.
- `decides`: labels of a ticket that may decide a quoted file's change.
- `dependabot`: the manifests a Dependabot PR may change and pass with no model.
- `merge`: whether a pass merges. Default `true`. With `false`, a pass approves and the owner merges.

`periodics`: a list of recurring sessions, each `{ "name", "prompt", "days" }`, with `counts`, `gapHours` and `connectors` if wanted.

- `name`: one line, unique in the file. The session is named after it.
- `prompt`: what the session runs, as text or `{ "file": "<path>" }` read from the default branch. Governor adds a line under it giving the last fire's time, or saying this is the first run, and lists what each count counted since then, by number and title.
- `days` (required): the day limit, in whole days, at least one. The periodic is due on the sweep nearest that many days after its last fire.
- `counts`: any of `merges` (pull requests merged into the default branch), `issuesOpened` and `issuesClosed`, each a whole number of at least one. The periodic is also due once that many have happened since its last fire, whichever limit comes first. At its day limit, a periodic with counts that counted nothing starts no session, and its next day limit counts from then.
- `gapHours`: the fewest whole hours between two runs, at least one. A count reached inside the gap fires on the first event or sweep after it.
- `connectors`: the claude.ai connectors the session needs, each by its name in the account's connector list, such as `gmail_prod`: letters, digits, hyphens and underscores, each named once. A session governor starts with `claude --cloud` has none of the account's connectors, so a periodic that names any starts as a run of a routine instead, with those connectors attached and no others. Governor keeps one routine for the periodic, named after the repo and the periodic, and fires it itself; the routine's own schedule never comes due. A connector the account has not connected starts nothing and pages (`governor-connector-missing`), and the periodic stays due. So does a routine the routines API refuses (`governor-routine-refused`), and the repo's tickets and other periodics still start. This works in public repos too, where whatever the session writes is public.

```json
{ "name": "Code review", "prompt": "Review what merged since the last review.", "days": 7, "counts": { "merges": 20 }, "gapHours": 4 }
```

A new periodic starts its first session one day limit, or one count, after the first fire that reads it. A periodic never overlaps itself: while the session its last fire started is still open, a due periodic is held. Governor starts nothing, logs the fire as held with that session's link, and leaves the last fire's time alone, so the count keeps growing and the first check after the session is archived fires it. Archived by the sign-off sweep or by hand, or deleted, the run is finished. How governor keeps each one's record is in [docs/how-it-works.md](docs/how-it-works.md#periodics).

`hooks`: a list of hooks, each `{ "name", "prompt", "keyVersion" }`, with `perHour` if wanted.

- `name`: lower-case letters, digits and hyphens, unique in the file. It ends the hook's URL, and the session is named after it.
- `prompt`: what the session runs, as text or `{ "file": "<path>" }` read from the default branch. Governor adds lines under it saying which hook fired and when, and quoting the caller's text as the caller's data.
- `keyVersion` (required): the version of the hook's key a request must be signed with, a positive whole number of at most nine digits. It is not a secret.
- `perHour`: the most fires governor queues for the hook in one clock hour, a positive whole number up to 100. Default 20. A fire past it gets `429`, so a leaked key cannot flood the queue every repo shares. Each signed request counts once in its clock hour: sending the same request again in that hour, after a timeout or a `502`, takes no second place.

```json
{ "name": "operator-prod", "prompt": { "file": "ops/prod-alarm.md" }, "keyVersion": 1, "perHour": 20 }
```

`prompts`: each value is text, or `{ "file": "<path>" }` read from the default branch. The kinds, and the facts each may name as `{fact}`, are in [docs/how-it-works.md](docs/how-it-works.md#prompts).

[test/fixtures/factory/.github/dispatch.json](test/fixtures/factory/.github/dispatch.json) is a full file with every feature on.

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
- **A deploy workflow that is also `workflows.ci`.** Many small repos run the gate inside the deploy. A red run of that workflow is then CI: it goes to `ciMessages` (the one suspect's session, or one fresh session for several), never to the red-deploy message (the `deployRed` prompt). A green shipping job in it still uses `deployMessages`.
- **An issue's filer does not hear the label by default.** A filer is subscribed to everything on its issue but `labels` and `deploys`. To hear a `deployed:` label, the issue body needs `<!-- governor:subscribe <session link> events=deploys -->` naming the filer, and the repo needs `subscribeMessages` and `deployedLabels` on. A filer that has signed off by then refuses the message, and governor drops its line.

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

[schema/dispatch.schema.json](schema/dispatch.schema.json) is `configSchema` exported as a JSON Schema. An editor that reads it completes key names as the file is written, and flags an unknown key. To use it in VS Code, a repo maps the file to the schema at a pinned commit of this repo in its `.vscode/settings.json`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["/.github/dispatch.json"],
      "url": "https://raw.githubusercontent.com/t-d-d/gh-governor/<commit>/schema/dispatch.schema.json"
    }
  ]
}
```

Use the commit the config check is pinned to, so the editor and the check read the same schema. A pin older than the schema has no such file, so the editor reports it cannot load the schema; bump both pins together. Do not add a `$schema` key to `dispatch.json` instead: the schema refuses any key it does not know, that one included, and so does governor.

The JSON Schema covers the file's shape only. It leaves out the rules across keys, such as a claim label that is also a ready label, and the checks on one value that are not a shape, such as a prompt naming a fact its kind lacks or a prompt file's path leaving the repo. It cannot read prompt files either, so a file it accepts can still be refused. [The config check](#the-config-check) is the full check. After a change to `configSchema`, run `node scripts/export-config-schema.mjs` and commit the result; the gate fails while the committed file differs from a fresh export.

### Hooks

A hook lets a system outside GitHub, such as a cloud alarm, start a session in the repo. The repo lists the hook in its file, and the caller sends governor one HTTPS request signed with that hook's key. The request carries data. The prompt is the file's, so a pull request reviews what the session is told.

**The request.** `POST <receiver URL>/hooks/<owner>/<repo>/<hook>`, where the receiver URL is the stack's `WebhookUrl` output, with a JSON body and one header:

```
POST /hooks/acme/factory/operator-prod
Content-Type: application/json
Governor-Signature: v=1,t=1790000000,sha256=<hex>

{"text":"ALARM: api 5xx over threshold"}
```

- `text` is plain text, at most 32 KiB. Send the alarm's summary, not its whole payload.
- `v` is the key version, `t` the time in Unix seconds, and the hex is the HMAC-SHA256 of `<t>.<raw body>`, keyed with the key's hex digits as text. Sign the exact bytes you send.
- `t` must be no more than 30 seconds ahead of governor's clock and no more than 4 minutes 25 seconds behind it, so sign with the current time. The same request sent twice inside five minutes is one fire, and a request stays valid for 4 minutes 55 seconds, a margin under those five minutes, so a replay never starts a second session.

In Node:

```js
import { createHmac } from 'node:crypto';
const [version, key] = process.env.GOVERNOR_HOOK_KEY.slice(1).split('.'); // the stored value, v<version>.<hex>
const url = process.env.GOVERNOR_HOOK_URL; // the hook's full URL, as scripts/hook-key.mjs saved it
const body = JSON.stringify({ text });
const t = Math.floor(Date.now() / 1000);
const sha256 = createHmac('sha256', key).update(`${t}.${body}`).digest('hex');
await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'governor-signature': `v=${version},t=${t},sha256=${sha256}` } });
```

The known answer in test/dispatch-hook.test.ts checks a caller's code: under the hook secret `hook-secret-fake`, `acme/factory`'s `operator-prod` at version 1 has the key `205f2b1f…`, and that test gives the header for one body and time.

**The answers.**

| Answer | Meaning |
|---|---|
| `202` | The fire was queued. |
| `200` | The repo's owner is not on the deployment's owner list. Nothing was queued. |
| `400` | The body is not JSON, or holds no string `text`. |
| `401` | The header is missing or malformed, the signature does not match, or `t` is more than 30 seconds ahead of governor's clock or more than 4 minutes 25 seconds behind it. Also a hook the repo's file did not list when governor last read it, or a key version older than the one it named. |
| `404` | The path under `/hooks/` names no repo and hook. |
| `413` | The text is over 32 KiB, or too long to start a task with. |
| `429` | The hook has had its `perHour` fires this clock hour. Nothing was queued: send it next hour, or not at all. |
| `503` | Governor could not read what it knows of the repo's hooks, or could not count the fire. Nothing was queued: send it again. |

Governor reads the repo's file on its own schedule and on GitHub events, and keeps the list of hooks, key versions and caps it last read where the receiver can check it. So a new hook answers `401` until governor next reads the file, a raised `keyVersion` turns the old key away at the receiver from then on, and a changed `perHour` holds from then on. Before governor has read the file at all, every signed request is queued, up to 20 an hour per hook.

A `202` means queued, not started. The task then refuses a fire whose repo turns `hooks` off or lists no hook of that name, logged at warn, and one signed with a key version other than the hook's `keyVersion`, which pages as `governor-hook-key-stale`. Otherwise, if the hook's last session is still open, the fire goes into it as a message: governor's relay line naming the hook, then which hook fired and when, the caller's text quoted as the caller's data, and the session's standing line. So one session covers a burst of alarms. Once that session has signed off and been archived, or archived by hand, the next fire starts a new session in the repo's environment. A fire for one hook never reaches another hook's session.

**Minting a key.** Each hook's key is derived from the stack's secret `governor/hook-secret`, the repo, the hook's name and its key version, so governor stores no key. The owner runs the key script once per hook, after the pull request that adds the hook has merged. It needs an AWS identity that may read that secret and the stack's outputs, and the `gh` CLI logged in as an admin of the repo:

```bash
node scripts/hook-key.mjs --repo acme/factory --hook operator-prod --env prod [--profile <p>] [--stack governor]
```

The `prod` environment of `acme/factory` then holds the secret `GOVERNOR_HOOK_KEY`, the key as `v<version>.<hex>`, and the variable `GOVERNOR_HOOK_URL`, the hook's full URL. The key never appears on screen. The script reads the key version from the hook's `keyVersion` in the file on the default branch, and the URL from the stack's `WebhookUrl` output. It writes to an environment that exists and creates none: a name it cannot find fails the run and lists the ones there are. `--key-name` and `--url-name` change the two names. `--version <n>` mints that version without reading the file.

An owner who is not an admin of the repo leaves out `--env`. The script then prints the key alone on stdout, and on stderr the hook's URL and the two commands that save both values. Whoever runs them needs admin on the repo and the same AWS access, since the first runs the script again. The first saves the key only when that run succeeds, so an expired AWS session cannot replace a working key with an empty one:

```bash
(key="$(node scripts/hook-key.mjs --repo acme/factory --hook operator-prod)" && printf '%s' "$key" | gh secret set GOVERNOR_HOOK_KEY --repo acme/factory --env <environment>)
gh variable set GOVERNOR_HOOK_URL --repo acme/factory --env <environment> --body <hook URL>
```

Rotating `governor/hook-secret` replaces every hook's key at once.

**Revoking a key.** Raise the hook's `keyVersion` in the file in a pull request and merge it. Until governor next reads the file, the task refuses each fire signed with the old key. After that read, the receiver answers each one `401` before it reaches the queue. Either way each one logs `hook-key-stale` and pages as `governor-hook-key-stale`. Then mint the new version's key and give it to the caller. The repo's other hooks keep working throughout. To retire a hook, remove it from the file: once governor has read the file, the receiver answers its caller `401` and logs it at warn, which pages nobody.

### Immediate pickup needs the ready label in `SelectLabels`

A label added to an issue starts a selection at once only if the deployment's `SelectLabels` parameter lists it, or is empty. A repo whose ready label is not listed is still served: its tickets wait for the repo's pickup sweep. To have a new ready label picked up at once, add it to `SelectLabels` (the `SELECT_LABELS` repository variable) and deploy.

### Pickup's sweep interval

A ready label listed in `SelectLabels`, and the close of a ready ticket's last open blocker, pick a ticket up at once. The sweep catches what those miss: a lost event, a label `SelectLabels` does not list. It runs at the hourly fire, once `pickup.sweepHours` have passed since the repo's last sweep, and every hour when the file sets none. A repo that trusts its events can sweep less often:

```json
"pickup": { "sweepHours": 6 }
```

The fire's clock is the deployment's, which the file cannot see, so a repo is swept at the first fire at or after its interval. An interval shorter than the clock's tick sweeps at every fire. Pickup's line on the heartbeat issue records each sweep.

### The heartbeat checker

Governor cannot report that it has stopped, so the check runs in the served repo, on GitHub Actions. The repo calls the reusable workflow [.github/workflows/heartbeat-check.yml](.github/workflows/heartbeat-check.yml) on a schedule of its own, pinned to a commit of this repo:

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

It runs on the caller's own token, `contents: read` and `issues: write`, and holds no secret or id. It uses no action. The step carries [checker/heartbeat-check.mjs](checker/heartbeat-check.mjs) and runs it on the runner's node.

### The config check

Governor reads `.github/dispatch.json` from the default branch only, so a bad file shows up only after it merges. The repo then goes unserved, and the alarm pages the operator, not the repo. The config check catches the file on the pull request instead. The repo calls the reusable workflow [.github/workflows/config-check.yml](.github/workflows/config-check.yml) on pull requests that change the file, pinned to a commit of this repo. It passes the same commit as `commit`, because a called workflow cannot learn which commit it runs from:

```yaml
name: config check
on:
  pull_request:
    paths:
      - .github/dispatch.json
permissions:
  contents: read
jobs:
  check:
    uses: t-d-d/gh-governor/.github/workflows/config-check.yml@<commit>
    with:
      commit: <commit>
```

A repo whose prompts live in files adds their paths under `paths:`, so a change to a prompt file runs the check too.

The workflow fetches this repo at `commit` with git, installs the task's dependencies in `dispatch/`, and runs [checker/config-check.mjs](checker/config-check.mjs). It reads the pull request's head: the config file and every prompt file the file names. It runs governor's own `readConfig` and `resolveFiles` over them, so the check and governor share one schema.

The run fails, with governor's fault text, on:

- a file that is not JSON, or that the schema refuses, a rule across keys included, such as a claim label that is also a ready label or `prReview` on with no `review` section;
- a prompt file that is missing or empty, or that names a fact its kind lacks.

It warns, without failing, on a file governor reads but that cannot work:

- a ready label the repo does not have;
- a `workflows.ci` file that is not in the repo;
- a heartbeat issue that does not exist or lacks its marker, `<!-- governor:heartbeat -->`, or the repo's own in the older shape;
- a `review.humanOnly` or `review.quote` glob that matches no path.

A pull request that deletes the file gets a warning that governor will stop serving the repo.

It runs on the caller's own token, `contents: read` alone, and holds no secret or id. It uses no action. Where that token may not read the repo's labels or the heartbeat issue, as can happen in a private repo, the check warns that it could not, and leaves that part undone.

What it cannot see:

- **Whether `environment` resolves.** Only governor can check that, because it needs the claude.ai login.
- **A rule newer than the pin.** A pinned check refuses a key governor added after its commit, so the repo bumps the pin. A rule governor tightened after the pin lets a file through that governor then refuses, and the alarm still catches that.

## How governor runs

- **One task on AWS.** The turns run in one ECS Fargate task, arm64, half a vCPU and a gigabyte. It needs a pseudo-terminal to start a cloud session, which Lambda cannot give. The task takes each fire off the queue and runs it as its own turn, one at a time, and exits once the queue has been empty for a minute. Only one task runs at a time.
- **A webhook receiver.** The App's webhook posts every installation's events to one Lambda Function URL. The receiver checks the signature, routes the event from its payload, queues a fire on a FIFO queue, and calls a starter Lambda. The starter starts the task when a fire waits and none runs, never two at once. It also hears every task's stop, and runs every minute as a backstop.
- **One claude.ai login.** The task creates sessions with a stored claude.ai login, kept in Secrets Manager. Each turn refreshes it and writes it back. The login's refresh expiry is fixed when it is minted, about two weeks on, so it must be minted again before then; an alarm warns three days ahead.
- **An hourly schedule.** EventBridge fires the receiver every hour. That fire sweeps every served repo: it starts due periodics, picks up ready tickets in each repo whose pickup interval has passed, writes heartbeats, and archives signed-off sessions.

Governor runs from one CloudFormation stack, `governor` ([infra/governor.cfn.yml](infra/governor.cfn.yml)). A second stack, `governor-bootstrap` ([infra/bootstrap.cfn.yml](infra/bootstrap.cfn.yml)), holds the deploy's role and the secrets the operator writes. [.github/workflows/deploy.yml](.github/workflows/deploy.yml) applies both on a green push to `main`. A fire costs a fraction of a cent, and no GitHub Actions minutes.

## Fork and deploy

These are the steps to run your own governor. Steps 1 and 2 are for a fork; the operator's own deployment reuses `governor-app` and this repo, so it starts at step 3.

You need an AWS account you can administer, the AWS CLI, Node 22.18 or later, the Claude Code CLI, and a Claude Pro or Max subscription.

### 1. Create the GitHub App

*Not exercised by the operator's setup, which reuses `governor-app`.*

Under your account's or organisation's **Settings → Developer settings → GitHub Apps → New GitHub App**:

1. Name it, and set the homepage URL to your fork.
2. **Webhook**: tick **Active**. Enter any https URL and any secret for now: the deploy overwrites both with the receiver's URL and the stack's key.
3. **Repository permissions**:
   - **Contents**: Read and write. The config file is read from it, and the review's merge writes.
   - **Issues**: Read and write. The claim, the claim label and the session-link comment.
   - **Pull requests**: Read and write.
   - **Actions**: Read. A finished run's jobs, and the runs before it.
   - **Checks**: Read, and **Commit statuses**: Read. The review reads a required check on a PR's head.
4. **Subscribe to events**: Issue comment, Issues, Pull request, Pull request review, Pull request review comment, Workflow job, Workflow run. The API cannot set these, so tick them here. The deploy refuses to point the webhook while one is missing.
5. **Where can this GitHub App be installed?**: **Any account**. A private App installs only on the account that owns it. The deployment's owner list is what keeps an outsider's installation from using your login.
6. Create the App. Note its **App ID** and its slug (the last part of its public URL).
7. Under **Private keys**, generate a key and save the `.pem` file.
8. Install the App on each account whose repos it will serve.
9. Give the [Claude GitHub App](https://github.com/apps/claude) access to the same repos.

### 2. Create the repo and its config file

*Not exercised by the operator's setup, which reuses this repo.*

1. Fork this repo, or create a repo from it. Keep the `LICENSE`.
2. Install your App on it, and give the Claude GitHub App access to it.
3. To have governor work on its own tickets, commit a `.github/dispatch.json` like this one:

   ```json
   {
     "environment": "my-env",
     "labels": { "ready": ["mode: afk"], "claim": "claimed", "claimRemoves": [] },
     "features": { "pickup": true, "summons": true, "prMessages": true, "subscribeMessages": true }
   }
   ```

   and create its ready label, `mode: afk`. Leave `prReview` off: governor should not review changes to its own code.

### 3. Create an AWS account and apply the bootstrap stack

1. Create an AWS account that holds governor and nothing else.
2. Make sure the region you deploy to has a default VPC. If not, run `aws ec2 create-default-vpc` once.
3. Read your repo's numeric ids: `gh api repos/<owner>/<repo> --jq '.owner.id, .id'`.
4. Signed in as an administrator of the account, in the region you deploy to, apply the bootstrap stack from a checkout of your repo:

   ```
   aws cloudformation deploy --stack-name governor-bootstrap \
     --template-file infra/bootstrap.cfn.yml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubOwner=<owner> GitHubOwnerId=<owner id> \
       GitHubRepo=<repo> GitHubRepoId=<repo id>
   ```

   It creates GitHub's OIDC provider, so the account must not have one already. It also creates the deploy role, `governor-github-deploy`, and the three secrets step 4 fills, each holding a placeholder. Every deploy applies the stack again after this.
5. Read the deploy role's ARN, for step 5:

   ```
   aws cloudformation describe-stacks --stack-name governor-bootstrap \
     --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text
   ```

Only a run on your repo's `main` can assume the role. The trust names the repo by its owner and repo ids as well as their names, which is the token subject GitHub gives a repo created after 15 July 2026. The role has `AdministratorAccess`. It creates the main stack's IAM roles, and a role that can do that can make itself an administrator anyway, which is why the account should hold governor alone.

### 4. Save the secrets and the alert address

From a machine with the AWS CLI signed in as an identity that may write the secrets and the parameter (`--profile` names an AWS CLI profile; leave it out in CloudShell), in a checkout of your repo. The commands pass no region, so the profile's region must be the deploy's: set `AWS_REGION` to it in the shell first if it is not.

1. The App key: `node scripts/save-secret.mjs github-app --app-id <id> --file <app.pem> --profile <p>`. The deploy and the task read the App key from Secrets Manager, never from a GitHub secret. `<id>` is the App ID step 1.6 noted, and `<app.pem>` the file step 1.7 saved. If you reuse an App instead of creating one in step 1, you have neither: the App ID is on the App's settings page, and for the key, generate a new one under the App's **Private keys** or use a copy of its key you already hold.
2. The claude.ai login: `node scripts/mint-claude-login.mjs --profile <p>`. It signs in under a throwaway directory, so the login your machine already holds is untouched. Sign in with the subscription account the sessions will run under. It prints the login's expiry; mint again before that date.
3. The address the alarms email, in Parameter Store: `aws ssm put-parameter --name /governor/alert-email --type String --value <address> --profile <p>`. The stack reads it there on every deploy, so it never passes through GitHub. To change it, put the new address with `--overwrite`, deploy, and confirm the subscription AWS emails to the new address.
4. Optional, with a drop box: the drop-box writer, `node scripts/save-secret.mjs session-log-writer --file <writer.txt> --profile <p>`. The file holds 32 or more lowercase hex digits.

### 5. Set the repository variables and secrets

Under the repo's **Settings → Secrets and variables → Actions**. Anyone can read a public repo's run logs, and Actions masks only secrets, so the deploy role's ARN and the drop box are secrets.

| Variable | Value |
|---|---|
| `AWS_REGION` | The region to deploy to, the bootstrap stack's. Default `us-east-1`. |
| `GOVERNOR_OWNERS` | The GitHub accounts whose installations are served, comma-separated. |
| `APP_ID` | The App's numeric ID. |
| `APP_SLUG` | The App's slug, for the deploy's check of its events. |
| `SELECT_LABELS` | The labels whose addition starts a selection at once, comma-separated, such as `mode: afk`. Empty means every label. |

| Secret | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | The deploy role's ARN, from step 3. It carries the AWS account id, so it is a secret. Until it is set, a push to `main` runs the gate and deploys nothing. |
| `DROP_BOX_URL` | Optional. An https URL that the PR review's transcripts are PUT under. Unset ships none. |

### 6. Run the first deploy

Run the **Deploy** workflow on `main` from the Actions tab, or merge to `main`. It applies the bootstrap stack, builds the image, and creates the main stack. Then it points the App's webhook at the receiver, checks the App's events and the receiver's URL, and runs the task's probe. A red probe prints the task's log, which says whether the task could not reach the network, hold a pseudo-terminal or find the CLI. A task that never ran its container, such as one whose image pull was refused, has no log, and the probe prints its stop reason instead.

If the first deploy fails while it creates the main stack, the stack is left in `ROLLBACK_COMPLETE`, and every later deploy refuses until it is gone. Delete it with `aws cloudformation delete-stack --stack-name governor`, and run the deploy again. The secrets are in the bootstrap stack, so the delete loses nothing you saved.

Confirm the alerts subscription from the email AWS sends to the alert address. Until you do, the alarms send nothing.

### 7. Read governor's logs

| Log group | What it holds |
|---|---|
| `/governor` | Each turn: one JSON line per decision, such as `dispatch-launch`, `dispatch-signoff`, `dispatch-review`, and `dispatch-failed` on a fault. The task's `fire-taken` line for each fire it takes, with the fire's message id, and `lane-idle` when it exits. Each task's ECS stop event, with its pull and start times. |
| `/aws/lambda/governor-webhook` | The receiver: `webhook-queued`, `webhook-ignored` with the reason, `webhook-refused`; for a hook, `hook-refused` with the reason, `hook-ignored`, `hook-key-stale`, `hook-table-unread` and `hook-table-uncounted`; `starter-poke-failed` when it could not call the starter. |
| `/aws/lambda/governor-starter` | The starter: `task-started` with the task and what called it, `start-failed` with why, `start-gave-up` after three failed starts in a row. |

The App's **Advanced → Recent Deliveries** shows each delivery's answer: `202` queued a fire, `200` queued nothing and says why, `401` is a key that does not match.

To start a turn by hand, `node scripts/run-turn.mjs --kind schedule` runs a sweep now, and `--kind probe` checks the runtime. [docs/how-it-works.md](docs/how-it-works.md#invoking-by-hand) has the rest, and the alarms.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
