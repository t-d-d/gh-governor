# Dispatcher workflows
Relevance: How governor reads a served repo's CI and deploys: a shipping job's name, TICKET_LABEL_PATHS, the config file's `workflows` and `deployMessages`, workflow and merge routing: dispatch/**
Decision: Governor reads each served repo's CI, deploys and default branch from that repo's own workflows, config file and event payloads.

Why: Served repos name their workflows differently: one runs CI as
`ci.yml`, another as `gate.yml`, and none need be named `CI`. Code that
named one repo's CI, triage target and tags would tell no other repo's
sessions of a red CI run, a deploy or a merge that broke their PR.

## Rules

- **A job declares a deploy by its name.** A shipping job's name ends
  `at <sha> · deployed: <target>`, and governor labels on the `workflow_job`
  event from the payload's name alone (`shippingJob` in
  dispatch/webhook/fire.mjs). A run that ships nothing renames or skips its
  shipping job.
- **A workflow declares which merged PRs a target covers** in one top-level
  `TICKET_LABEL_PATHS`: `all`, `trigger` (its `on.push.paths`), or globs.
- **The config file's `workflows` section** (`workflowsSchema`,
  dispatch/repo-config.mjs), a setting several features share, names
  `ci`: the repo's CI workflow, a path under `.github/workflows/`. Without
  it, no run counts as CI. **Its `deployMessages` section**
  (`deployMessagesSchema`) names:
  - `triage`: the deploy targets whose failure gets one fresh triage session
    instead of messages to the merges' sessions.
  - `tags`: target to the tag its deploy moves. Without a target in `tags`,
    the message names the commit it built and no tag.
- **The shipping turn alone tells who hears a green deploy, each session
  once.** A green shipping job messages the session of each PR it shipped,
  and with `deployMessages.deployedLabels` on, comments on each ticket those
  PRs close the first time the ticket gets the label, and messages that
  ticket's spec owner and builders itself. The spec owner is the body's
  owner link read under the file's `trust.relay`, which lets in a ticket
  governor's App filed as the PR route lets in that App's PRs. The builders
  are, on a claimed ticket, those the one lookup finds
  (dispatch/builders.mjs), looked up once per turn. A session gets one
  message naming each PR and ticket it hears of and its role on each, and
  is asked to sign off where nothing else names it, whether the ticket is
  open or closed. These sends take the turn's retries from the held cursor
  and its record of who was told. The delivered record keeps the tickets
  commented on, written before the sends, so a later turn that finds the
  labels on still owes their roles the deploy. A lookup that fails fails
  the turn and holds the cursor. The comment is a record for people, and
  the receiver relays it to no session. With `deployedLabels` off there is
  no comment, and the PRs' sessions alone hear. A red deploy still goes to
  the PR's session, since governor posts nothing on a ticket for it.
- **The default branch comes from the event payload**
  (`repository.default_branch`), never from the literal `main`. Each
  workflow, job, scheduled and conflicts fire carries it, and the task reads
  runs and PRs on that branch. A delivery naming none routes no run and no
  merge.
- **No run but the PR's own CI run at its head holds a merge.** Where the
  file names `ci`, turns `prReview` on and does not set `prReview.waitForCi`
  to `false`, the latest run of that workflow at the PR's head is test 8's,
  as a required check is (dispatcher-review.md). A deploy, or any other run, holds no merge: the
  review merges a pass whatever else is running.
- **The receiver forwards, from every served repo:**
  - a completed red run on the default branch;
  - a red scheduled run;
  - a branch run dispatched by hand;
  - a successful shipping job;
  - a PR merged into the default branch, which queues the conflicts check.

  It routes on facts in the payload, then drops a fire whose switch the
  repo's item in the hook table says is off (dispatcher-state.md). It
  cannot tell CI from a deploy, so it drops a red run's fire only where
  `ciMessages` and `deployMessages` are both off (`deployMessages` alone
  for a run naming no workflow file, which is never CI), and never the
  conflicts check. The task still applies the repo's switches and
  `workflows` section, and refuses a CI run a push did not start.

## Examples

- Routing: `workflowRunFire`, `jobFire` and `mergedFire` in
  dispatch/webhook/route.mjs, each given the payload's default branch.
- CI and triage: `isCi` in dispatch/repo-config.mjs, which `switchOf` also
  reads; the tags and triage targets in dispatch/workflow.mjs, read from the
  fire's repo's config.
- Full sections: `"workflows": { "ci": ".github/workflows/ci.yml" }` and
  `"deployMessages": { "triage": ["prod"], "tags": { "dev": "deploy/dev",
  "prod": "deploy/prod" }, "deployedLabels": true }` in
  test/fixtures/factory/.github/governor.json.
- Governor's own shipping job: the deploy job in .github/workflows/deploy.yml.
- Who hears a green deploy: `rolesOf` in dispatch/turn.mjs finds each
  commented ticket's roles, and `withTickets` (dispatch/workflow.mjs) adds
  them to the PRs' notes, one per session. The receiver's drop of the
  deploy comment is `deployComment` in dispatch/webhook/mention.mjs.
- test/dispatch-webhook.test.ts pins the receiver's payload-only routing, a
  `trunk` repo's included, and the drop by the repo's switches after it, in
  `fitness: the receiver drops a fire only where the repo's hook-table item
  says its switch is off (dispatcher-workflows.md)`;
  test/dispatch-turn.test.ts a cursor per repo, file and label.
- The drop: `droppedBy` in dispatch/webhook/switches.mjs, which also holds
  `switchOf`, called by `handle` in dispatch/webhook/route.mjs.
- test/dispatch-review.test.ts pins that the review reads only the CI
  workflow's runs at the PR's head, and none where the file names no `ci`
  or sets `prReview.waitForCi` to `false`,
  in the `fitness:` block that names this file.

## Do not

- Do not recognise CI by a workflow's name: a repo may name its gate
  `gate.yml`, and may have a non-CI workflow named `CI`.
- Do not recognise CI by the default branch's required status checks:
  reading branch protection needs Administration permission on every
  installation.
- Do not assume `main`: a repo whose default branch is `trunk` would route
  nothing, or route runs on a branch that is not its default.
- Do not keep a list of repos with CI in a stack parameter: onboarding then
  needs a deploy, which dispatcher-repos.md rules out.
- Do not gate workflow or merge events in the receiver by a list of repos,
  nor read a config file there: the task reads the file and writes the
  switches the receiver drops by to the hook table.
- Do not declare CI, triage or tags in the workflow files: whether a red run
  is CI, or gets a triage session, is a choice about governor's behaviour,
  which the config file holds.
- Do not declare a label in a variable the receiver cannot see: the
  `workflow_job` payload carries the job's name and no file.
- Do not hold a merge while any run but the CI run at the PR's head is
  unfinished: a PR then waits on a sweep that may never come. The CI run at
  the head is the one exception, because its end queues the review again.

Judgment: that a served repo's workflows write the job-name suffix and `TICKET_LABEL_PATHS`, no check here sees: governor cannot read another repo's files at that repo's merge time.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The receiver drops a fire whose switch the repo's hook-table item says is off, the conflicts check never, since #147. The PR's own CI run at its head holds its merge, as test 8, since #398: a repo whose plan cannot require a check would otherwise merge a pass on red CI. The CI run at the head holds a merge only where `prReview.waitForCi` is not `false` since #459: a repo whose CI runs only after the merge has no run at a PR's head, so every PR waited forever. The deploy targets and tags moved from `workflows` to the `deployMessages` section, and `workflows` keeps only `ci`, since #525. The shipping turn alone tells every session that hears a green deploy, the ticket's roles included, and the receiver relays governor's deploy comment to no session, since #564, under PRD #535: two turns deciding could lose a deploy or tell it twice (#558).
