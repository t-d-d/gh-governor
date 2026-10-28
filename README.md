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
| `heartbeat` | when `heartbeat` is on | `{ "issue": <number>, "marker": "<!-- … -->" }`: the issue whose `last-run:` line the two-hourly sweep updates. |
| `prompts` | no | Replacement wording for the instruction in each kind of message, keyed by kind. |

The switches in `features`:

| Switch | What it turns on |
|---|---|
| `pickup` | A session per ready ticket. |
| `summons` | A session per `@claude` remark, and a dispatch started by hand. |
| `prMessages` | Messages into the session a PR names, or the local session holding its branch. |
| `subscribeMessages` | Messages to sessions subscribed by a `governor:subscribe` line, and to an issue's filer. |
| `redScheduledRun` | A fresh session on a scheduled run on the default branch that went red. |
| `mergeHandoff` | A merge's message lists the open tickets that the PR's closed issues blocked. |
| `ciMessages` | A red CI run tells the sessions of the merges it may blame. Needs `workflows.ci`. |
| `deployMessages` | A shipping job, or a red deploy, tells the sessions of the merges it shipped. |
| `branchRunMessages` | A run dispatched on a branch tells the session that wrote its commit. |
| `conflicts` | A merge into the default branch tells each PR it left conflicted. |
| `deployedLabels` | A shipping job labels the tickets it shipped `deployed: <target>`. |
| `prReview` | The PR review, run from the `review` section. |
| `heartbeat` | The two-hourly sweep stamps the issue `heartbeat` names. |

`workflows`:

- `ci`: the CI workflow's file, under `.github/workflows/`. Without it, no run is CI.
- `triage`: the deploy targets whose failure starts one fresh session, rather than messages to the sessions of the merges it shipped.
- `tags`: the tag each target's deploy moves, which messages name.

A deploy is seen only if the repo's workflow declares it: the shipping job's name ends `at <sha> · deployed: <target>`, and the workflow sets a top-level `TICKET_LABEL_PATHS` env (`all`, `trigger`, or globs).

`review`:

- `checklist` (required): the model's system prompt, as text or `{ "file": "<path>" }`.
- `humanOnly`: `{ "glob", "reason", "unless" }` entries. A PR changing a matching path waits for a person, unless every ticket it closes carries one of the `unless` labels.
- `tickets`: `require` and `forbid` lists of `{ "labels", "unless" }` rules that every ticket the PR closes must meet.
- `quote`: globs of changed files the model reads whole. A `!` entry takes a path back out.
- `decides`: labels of a ticket that may decide a quoted file's change.
- `dependabot`: the manifests a Dependabot PR may change and pass with no model.
- `merge`: whether a pass merges. Default `true`. With `false`, a pass approves and the owner merges.

`prompts`: each value is text, or `{ "file": "<path>" }` read from the default branch. The kinds, and the facts each may name as `{fact}`, are in [docs/how-it-works.md](docs/how-it-works.md#prompts).

[test/fixtures/factory/.github/dispatch.json](test/fixtures/factory/.github/dispatch.json) is a full file with every feature on.

### Immediate pickup needs the ready label in `SelectLabels`

A label added to an issue starts a selection at once only if the deployment's `SelectLabels` parameter lists it, or is empty. A repo whose ready label is not listed is still served: its tickets wait for the two-hourly sweep. To have a new ready label picked up at once, add it to `SelectLabels` (the `SELECT_LABELS` repository variable) and deploy.

## How governor runs

- **One task on AWS.** Each turn is one ECS Fargate task, arm64, half a vCPU and a gigabyte, for a few minutes. It needs a pseudo-terminal to start a cloud session, which Lambda cannot give. Only one task runs at a time.
- **A webhook receiver.** The App's webhook posts every installation's events to one Lambda Function URL. The receiver checks the signature, routes the event from its payload, and queues a fire on a FIFO queue. A starter Lambda drains the queue and runs one task per fire, never two at once.
- **One claude.ai login.** The task creates sessions with a stored claude.ai login, kept in Secrets Manager. Each turn refreshes it and writes it back. The login's refresh expiry is fixed when it is minted, about two weeks on, so it must be minted again before then; an alarm warns three days ahead.
- **A two-hourly schedule.** EventBridge fires the receiver every two hours. That fire sweeps every served repo: it picks up ready tickets, writes heartbeats, and archives signed-off sessions.

Everything lives in one CloudFormation stack, `governor` ([infra/governor.cfn.yml](infra/governor.cfn.yml)), applied by [.github/workflows/deploy.yml](.github/workflows/deploy.yml) on a green push to `main`. A fire costs a fraction of a cent, and no GitHub Actions minutes.

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

### 3. Create an AWS account and a deploy role

1. Create an AWS account, or pick one.
2. Make sure the region you deploy to has a default VPC. If not, run `aws ec2 create-default-vpc` once.
3. Add GitHub's OIDC identity provider to the account: URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
4. Create the deploy role. The repo ships no template for it.

   Its trust policy lets GitHub's OIDC provider assume it from your repo's `main` branch only:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": {
           "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
           "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:ref:refs/heads/main"
         }
       }
     }]
   }
   ```

   Its permissions must allow it to:

   - apply and package the `governor` stack: CloudFormation on that stack; IAM roles named `governor-*`, including passing them to ECS, Lambda and EventBridge; ECS; Lambda; SQS; DynamoDB; EventBridge; CloudWatch alarms and logs; SNS; Secrets Manager on secrets under `governor/`; and reading the default VPC's subnets;
   - create and push to the `governor` ECR repository, and get ECR Public's authorisation token (`ecr-public:GetAuthorizationToken` and `sts:GetServiceBearerToken`);
   - create the `governor-build-<account>-<region>` bucket and write to it;
   - read the values of `governor/webhook-secret` and `governor/github-app`;
   - run the probe task and read its logs.

### 4. Set the stack parameters as repository variables

Under the repo's **Settings → Secrets and variables → Actions → Variables**. None of these is a secret.

| Variable | Value |
|---|---|
| `AWS_REGION` | The region to deploy to. Default `us-east-1`. |
| `GOVERNOR_OWNERS` | The GitHub accounts whose installations are served, comma-separated. |
| `APP_ID` | The App's numeric ID. |
| `APP_SLUG` | The App's slug, for the deploy's check of its events. |
| `SELECT_LABELS` | The labels whose addition starts a selection at once, comma-separated, such as `mode: afk`. Empty means every label. |
| `ALERT_EMAIL` | Where the alarms send email. |
| `DROP_BOX_URL` | Optional. An https URL that the PR review's transcripts are PUT under. Empty ships none. |

Leave `AWS_DEPLOY_ROLE_ARN` unset for now. While it is unset, a push to `main` runs the gate and deploys nothing.

### 5. Set the deploy-role variable and run the first deploy

1. Set the repository variable `AWS_DEPLOY_ROLE_ARN` to the deploy role's ARN.
2. Run the **Deploy** workflow on `main` from the Actions tab, or merge to `main`.

The first deploy builds the image and creates the stack, its three empty secrets (`governor/claude-login`, `governor/github-app`, `governor/session-log-writer`) and its webhook key. It then stops red at **Point the App's webhook at the receiver**, because `governor/github-app` holds no key yet. Step 6 fills the secrets.

### 6. Save the secrets, and deploy again

From a machine with the AWS CLI signed in as an identity that may write the secrets (`--profile` names an AWS CLI profile; leave it out in CloudShell), in a checkout of your repo:

1. The App key: `node scripts/save-secret.mjs github-app --app-id <id> --file <app.pem> --profile <p>`. The deploy and the task read the App key from Secrets Manager, never from a GitHub secret.
2. The claude.ai login: `node scripts/mint-claude-login.mjs --profile <p>`. It signs in under a throwaway directory, so the login your machine already holds is untouched. Sign in with the subscription account the sessions will run under. It prints the login's expiry; mint again before that date.
3. Optional, with `DROP_BOX_URL`: the drop-box writer, `node scripts/save-secret.mjs session-log-writer --file <writer.txt> --profile <p>`. The file holds 32 or more lowercase hex digits.

Then re-run the **Deploy** workflow. It points the App's webhook at the receiver, checks the App's events and the receiver's URL, and runs the task's probe. A red probe prints the task's log, which says whether the task could not pull its image, reach the network, hold a pseudo-terminal or find the CLI.

Confirm the alerts subscription from the email AWS sends to `ALERT_EMAIL`. Until you do, the alarms send nothing.

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
