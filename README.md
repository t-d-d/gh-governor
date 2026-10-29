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

- **Pickup.** A ticket carrying the repo's ready labels, with no open blocker, gets a cloud session of its own. Governor claims the ticket with the repo's claim label first, and comments the session's link on it.
- **Summons.** `@claude` in an issue, a comment or a review, from someone with a say in the repo, starts a session on that remark.
- **PR messages.** A PR a session wrote names that session. Every comment, review, push, merge and close on it is sent into that session, and a fresh session takes the PR over if the first one is archived.
- **Subscriptions.** Any other session hears a PR or issue it is party to by adding a `<!-- governor:subscribe <session URL> events=… -->` line to its body.
- **CI and deploys.** A red CI run on the default branch tells the sessions whose merges may have broken it. A shipping job tells the sessions of the merges it shipped, and can label their tickets `deployed: <target>`.
- **The PR review.** A model reviews each PR against the repo's checklist. Paths on the repo's human-only list always wait for a person. A pass merges the PR, or, with `merge` off, approves it for the owner to merge.
- **Sign-off.** A session whose last reply ends `Signing off.` is archived by the next turn. No session writes anything for this.

How dark the factory runs is the repo's choice: with pickup and the review on and `merge` true, a ticket can go from label to merged commit with no person, except where its PR touches a human-only path.

[docs/how-it-works.md](docs/how-it-works.md) describes each feature in full. [docs/constraints/](docs/constraints/README.md) holds the rules the code keeps.

## How a repo opts in

1. Install the App (`governor-app`, or your fork's own) on the repo. The account that installs it must be on the deployment's owner list.
2. Give the Claude GitHub App access to the repo, so the cloud sessions can push and comment.
3. Commit `.github/dispatch.json` to the default branch.

The next fire serves the repo. No deploy is needed. Deleting the file or uninstalling the App stops it at the next fire.

Governor reads the file from the default branch only. A file that fails the schema skips the repo and raises the `governor-config-invalid` alarm. The file holds no secret: a served repo may be public.

The smallest useful file:

```json
{
  "environment": "my-env",
  "labels": { "ready": ["mode: afk"], "claim": "claimed" },
  "features": { "pickup": true, "summons": true, "prMessages": true, "subscribeMessages": true }
}
```

### The schema

The schema is `configSchema` in [dispatch/repo-config.mjs](dispatch/repo-config.mjs). An unknown key anywhere is a fault.

| Key | Required | What it holds |
|---|---|---|
| `environment` | yes | The claude.ai cloud environment the repo's sessions start in: its name as `/remote-env` lists it, or its ID. A public repo should use the name. |
| `labels.ready` | yes | Every label a ready ticket carries. |
| `labels.claim` | yes | The label governor claims a ticket with before its session starts. It is created in a repo that lacks it. A ticket carrying it is never picked up. |
| `labels.claimRemoves` | no | The ready labels the claim takes off, and a failed launch puts back. Default none. |
| `features` | yes | The switches below, each `true` or `false`. A switch left out is off. |
| `workflows` | no | What the repo's workflows are to governor: `ci`, `triage` and `tags`. |
| `review` | when `prReview` is on | The PR review's settings. |
| `heartbeat` | when `heartbeat` is on | `{ "issue": <number> }`: the issue governor records every fire on, under the `<!-- governor:heartbeat -->` marker its body must carry. The older `{ "issue": <number>, "marker": "<!-- … -->" }` keeps one `last-run:` line under the repo's own marker, which the two-hourly sweep updates. |
| `pickup` | no | `{ "sweepHours": <number> }`: how many whole hours the two-hourly fire leaves between two sweeps of the repo's ready tickets, at least one. Default two, which sweeps at every fire. |
| `prompts` | no | Replacement wording for the instruction in each kind of message, keyed by kind. |
| `periodics` | when `periodics` is on | The recurring sessions governor starts on a day limit, or on a count of merges, issues opened or issues closed. At least one when the switch is on. |

The switches in `features`:

| Switch | What it turns on |
|---|---|
| `pickup` | A session per ready ticket, picked up on its label, on the close that frees it, and on the sweep at the interval `pickup.sweepHours` sets. |
| `summons` | A session per `@claude` remark, and a dispatch started by hand. |
| `prMessages` | Messages into the session a PR names, or the local session holding its branch. |
| `subscribeMessages` | Messages to sessions subscribed by a `governor:subscribe` line, and to an issue's filer. |
| `redScheduledRun` | A fresh session on a scheduled run on the default branch that went red. |
| `mergeHandoff` | A merge's message lists the open tickets that the PR's closed issues blocked. |
| `ciMessages` | A red CI run tells the sessions of the merges it may blame. Needs `workflows.ci`. |
| `deployMessages` | A shipping job, or a red deploy, tells the sessions of the merges it shipped. |
| `branchRunMessages` | A run dispatched on a branch tells the session that wrote its commit. |
| `conflicts` | A merge into the default branch tells each PR it left conflicted. |
| `deployedLabels` | A shipping job labels the tickets it shipped `deployed: <target>`. Needs `deployMessages`. |
| `prReview` | The PR review, run from the `review` section. |
| `heartbeat` | Governor records each fire on the issue `heartbeat` names: a line for pickup and one per periodic. In the older shape with a `marker`, the two-hourly sweep stamps the issue's `last-run:` line instead. |
| `periodics` | A session per periodic in the `periodics` list, each time its day limit passes or one of its counts is reached. |

`workflows`:

- `ci`: the CI workflow's file, under `.github/workflows/`. Without it, no run is CI.
- `triage`: the deploy targets whose failure starts one fresh session, rather than messages to the sessions of the merges it shipped.
- `tags`: the tag each target's deploy moves, which messages name.

A deploy is seen only if the repo's workflow declares it: the shipping job's name ends `at <sha> · deployed: <target>`, and the workflow sets a top-level `TICKET_LABEL_PATHS` env (`all`, `trigger`, or globs).

`review`:

- `checklist` (required): what is appended to the model's system prompt, as text or `{ "file": "<path>" }`.
- `humanOnly`: `{ "glob", "reason", "unless" }` entries. A PR changing a matching path waits for a person, unless every ticket it closes carries one of the `unless` labels.
- `tickets`: `require` and `forbid` lists of `{ "labels", "unless" }` rules that every ticket the PR closes must meet.
- `quote`: globs of changed files the model reads whole. A `!` entry takes a path back out.
- `decides`: labels of a ticket that may decide a quoted file's change.
- `dependabot`: the manifests a Dependabot PR may change and pass with no model.
- `merge`: whether a pass merges. Default `true`. With `false`, a pass approves and the owner merges.

`periodics`: a list of recurring sessions, each `{ "name", "prompt", "days" }`, with `counts` and `gapHours` if wanted.

- `name`: one line, unique in the file. The session is named after it.
- `prompt`: what the session runs, as text or `{ "file": "<path>" }` read from the default branch. Governor adds a line under it giving the last fire's time, or saying this is the first run, and lists what each count counted since then, by number and title.
- `days` (required): the day limit, in whole days, at least one. The periodic is due on the sweep nearest that many days after its last fire.
- `counts`: any of `merges` (pull requests merged into the default branch), `issuesOpened` and `issuesClosed`, each a whole number of at least one. The periodic is also due once that many have happened since its last fire, whichever limit comes first. At its day limit, a periodic with counts that counted nothing starts no session, and its next day limit counts from then.
- `gapHours`: the fewest whole hours between two runs, at least one. A count reached inside the gap fires on the first event or sweep after it.

```json
{ "name": "Code review", "prompt": "Review what merged since the last review.", "days": 7, "counts": { "merges": 20 }, "gapHours": 4 }
```

A new periodic starts its first session one day limit, or one count, after the first fire that reads it. A periodic never overlaps itself: while the session its last fire started is still open, a due periodic is held. Governor starts nothing, logs the fire as held with that session's link, and leaves the last fire's time alone, so the count keeps growing and the first check after the session is archived fires it. Archived by the sign-off sweep or by hand, or deleted, the run is finished. How governor keeps each one's record is in [docs/how-it-works.md](docs/how-it-works.md#periodics).

`prompts`: each value is text, or `{ "file": "<path>" }` read from the default branch. The kinds, and the facts each may name as `{fact}`, are in [docs/how-it-works.md](docs/how-it-works.md#prompts).

[test/fixtures/factory/.github/dispatch.json](test/fixtures/factory/.github/dispatch.json) is a full file with every feature on.

### Immediate pickup needs the ready label in `SelectLabels`

A label added to an issue starts a selection at once only if the deployment's `SelectLabels` parameter lists it, or is empty. A repo whose ready label is not listed is still served: its tickets wait for the repo's pickup sweep. To have a new ready label picked up at once, add it to `SelectLabels` (the `SELECT_LABELS` repository variable) and deploy.

### Pickup's sweep interval

A ready label listed in `SelectLabels`, and a close that frees tickets, pick a ticket up at once. The sweep catches what those miss: a lost event, a close that freed more tickets than the cap, a label `SelectLabels` does not list. It runs at the two-hourly fire, once `pickup.sweepHours` have passed since the repo's last sweep, and every two hours when the file sets none. A repo that trusts its events can sweep less often:

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
- When `.github/dispatch.json` last changed, only for a pickup sweep or periodic that has no line yet.

The inputs:

- `tolerance-hours`: how far past its limit a line may run before the check opens an issue. Default 3. Governor's schedule fires every two hours, so a line can run up to two hours past its limit when nothing is wrong. Set the tolerance above that.
- `labels`: the labels the check's issues carry, separated by commas or new lines. Default none.

What its issues say:

- **Pickup's sweep is overdue.** Pickup's last sweep is older than `pickup.sweepHours`, or two hours when unset, plus the tolerance. The issue gives the last sweep's time.
- **A periodic is overdue.** Its last fire is older than its `days` plus the tolerance. The issue names the periodic, gives its last fire time and state, and says whether governor holds it for an open session, with that session's link.
- **No line.** The file lists pickup or a periodic with no line on the heartbeat issue, and the file last changed longer ago than its limit plus the tolerance.
- **The heartbeat could not be read.** The config file is missing, unreadable, does not parse, or does not turn the heartbeat on in the `{ "issue": <number> }` shape, or the heartbeat issue cannot be read or lacks governor's marker. The issue says which.

The check keeps one issue open for each of these and updates it on each run. It closes the issue, with a comment, once the line is fresh again or the heartbeat reads again. While the heartbeat cannot be read, it leaves the other issues as they are. Runs in a repo queue rather than overlap, so two never open the same issue. A failure to list, open or close its issues fails the run.

It runs on the caller's own token, `contents: read` and `issues: write`, and holds no secret or id. It uses no action. The step carries [checker/heartbeat-check.mjs](checker/heartbeat-check.mjs) and runs it on the runner's node.

## How governor runs

- **One task on AWS.** Each turn is one ECS Fargate task, arm64, half a vCPU and a gigabyte, for a few minutes. It needs a pseudo-terminal to start a cloud session, which Lambda cannot give. Only one task runs at a time.
- **A webhook receiver.** The App's webhook posts every installation's events to one Lambda Function URL. The receiver checks the signature, routes the event from its payload, and queues a fire on a FIFO queue. A starter Lambda drains the queue and runs one task per fire, never two at once.
- **One claude.ai login.** The task creates sessions with a stored claude.ai login, kept in Secrets Manager. Each turn refreshes it and writes it back. The login's refresh expiry is fixed when it is minted, about two weeks on, so it must be minted again before then; an alarm warns three days ahead.
- **A two-hourly schedule.** EventBridge fires the receiver every two hours. That fire sweeps every served repo: it starts due periodics, picks up ready tickets in each repo whose pickup interval has passed, writes heartbeats, and archives signed-off sessions.

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

### 5. Set the repository variables and secret

Under the repo's **Settings → Secrets and variables → Actions**. Anyone can read a public repo's run logs, and Actions masks only secrets, so the drop box is a secret.

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | The deploy role's ARN, from step 3. Until it is set, a push to `main` runs the gate and deploys nothing. |
| `AWS_REGION` | The region to deploy to, the bootstrap stack's. Default `us-east-1`. |
| `GOVERNOR_OWNERS` | The GitHub accounts whose installations are served, comma-separated. |
| `APP_ID` | The App's numeric ID. |
| `APP_SLUG` | The App's slug, for the deploy's check of its events. |
| `SELECT_LABELS` | The labels whose addition starts a selection at once, comma-separated, such as `mode: afk`. Empty means every label. |

| Secret | Value |
|---|---|
| `DROP_BOX_URL` | Optional. An https URL that the PR review's transcripts are PUT under. Unset ships none. |

### 6. Run the first deploy

Run the **Deploy** workflow on `main` from the Actions tab, or merge to `main`. It applies the bootstrap stack, builds the image, and creates the main stack. Then it points the App's webhook at the receiver, checks the App's events and the receiver's URL, and runs the task's probe. A red probe prints the task's log, which says whether the task could not reach the network, hold a pseudo-terminal or find the CLI. A task that never ran its container, such as one whose image pull was refused, has no log, and the probe prints its stop reason instead.

If the first deploy fails while it creates the main stack, the stack is left in `ROLLBACK_COMPLETE`, and every later deploy refuses until it is gone. Delete it with `aws cloudformation delete-stack --stack-name governor`, and run the deploy again. The secrets are in the bootstrap stack, so the delete loses nothing you saved.

Confirm the alerts subscription from the email AWS sends to the alert address. Until you do, the alarms send nothing.

### 7. Read governor's logs

| Log group | What it holds |
|---|---|
| `/governor` | Each turn: one JSON line per decision, such as `dispatch-launch`, `dispatch-signoff`, `dispatch-review`, and `dispatch-failed` on a fault. |
| `/aws/lambda/governor-webhook` | The receiver: `webhook-queued`, `webhook-ignored` with the reason, `webhook-refused`. |
| `/aws/lambda/governor-starter` | The starter: `fire-started` with the task, `fire-deferred` while a task runs, `fire-failed`. |

The App's **Advanced → Recent Deliveries** shows each delivery's answer: `202` queued a fire, `200` queued nothing and says why, `401` is a key that does not match.

To start a turn by hand, `node scripts/run-turn.mjs --kind schedule` runs a sweep now, and `--kind probe` checks the runtime. [docs/how-it-works.md](docs/how-it-works.md#invoking-by-hand) has the rest, and the alarms.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
