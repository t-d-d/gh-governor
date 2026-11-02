# Running your own governor

What governor runs on, and the steps to deploy your own. Once it runs, [Serving a repo](serving-a-repo.md) says how a repo opts in. [How governor works](how-it-works.md) covers each fire, the alarms and troubleshooting.

- [How governor runs](#how-governor-runs)
- [Fork and deploy](#fork-and-deploy)

## How governor runs

- **One task on AWS.** The turns run in one ECS Fargate task, arm64, half a vCPU and a gigabyte. It needs a pseudo-terminal to start a cloud session, which Lambda cannot give. The task takes each fire off the queue and runs it as its own turn, one at a time, and exits once the queue has been empty for a minute. Only one task runs at a time.
- **A webhook receiver.** The App's webhook posts every installation's events to one Lambda Function URL. The receiver checks the signature, routes the event from its payload, queues a fire on a FIFO queue, and calls a starter Lambda. The starter starts the task when a fire waits and none runs, never two at once. It also hears every task's stop, and runs every minute as a backstop.
- **One claude.ai login.** The task creates sessions with a stored claude.ai login, kept in Secrets Manager. Each turn refreshes it and writes it back. The login's refresh expiry is fixed when it is minted, about two weeks on, so it must be minted again before then; an alarm warns three days ahead.
- **An hourly schedule.** EventBridge fires the receiver every hour. That fire sweeps every served repo: it starts due periodics, picks up ready tickets in each repo whose pickup interval has passed, writes heartbeats, and archives signed-off sessions.

Governor runs from one CloudFormation stack, `governor` ([infra/governor.cfn.yml](../infra/governor.cfn.yml)). A second stack, `governor-bootstrap` ([infra/bootstrap.cfn.yml](../infra/bootstrap.cfn.yml)), holds the deploy's role and the secrets the operator writes. [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) applies both on a green push to `main`. A fire costs a fraction of a cent, and no GitHub Actions minutes.

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

To start a turn by hand, `node scripts/run-turn.mjs --kind schedule` runs a sweep now, and `--kind probe` checks the runtime. [docs/how-it-works.md](how-it-works.md#invoking-by-hand) has the rest, and the alarms.
