# Dispatcher workflows
Relevance: How governor reads a served repo's CI and deploys: a shipping job's name, TICKET_LABEL_PATHS, the config file's `workflows`, workflow and merge routing: dispatch/**
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
  dispatch/repo-config.mjs) names:
  - `ci`: the repo's CI workflow, a path under `.github/workflows/`. Without
    it, no run counts as CI.
  - `triage`: the deploy targets whose failure gets one fresh triage session
    instead of messages to the merges' sessions.
  - `tags`: target to the tag its deploy moves. Without a target in `tags`,
    the message names the commit it built and no tag.
- **The default branch comes from the event payload**
  (`repository.default_branch`), never from the literal `main`. Each
  workflow, job, scheduled and conflicts fire carries it, and the task reads
  runs and PRs on that branch. A delivery naming none routes no run and no
  merge.
- **No run holds a merge.** The review merges a pass whatever workflow is
  running.
- **The receiver forwards, from every served repo:**
  - a completed red run on the default branch;
  - a red scheduled run;
  - a branch run dispatched by hand;
  - a successful shipping job;
  - a PR merged into the default branch, which queues the conflicts check.

  It routes on facts in the payload, then drops a fire whose switch the
  repo's item in the hook table says is off (dispatcher-state.md). It
  cannot tell CI from a deploy, so it drops a red run's fire only where
  `ciMessages` and `deployMessages` are both off, and it never drops the
  conflicts check. The task still applies the repo's switches and
  `workflows` section, and refuses a CI run a push did not start.

## Examples

- Routing: `workflowRunFire`, `jobFire` and `mergedFire` in
  dispatch/webhook/route.mjs, each given the payload's default branch.
- CI and triage: `isCi` in dispatch/repo-config.mjs, which `switchOf` also
  reads; the tags and triage targets in dispatch/workflow.mjs, read from the
  fire's repo's config.
- A full section: `"workflows": { "ci": ".github/workflows/ci.yml",
  "triage": ["prod"], "tags": { "dev": "deploy/dev", "prod": "deploy/prod" } }`
  in test/fixtures/factory/.github/dispatch.json.
- Governor's own shipping job: the deploy job in .github/workflows/deploy.yml.
- test/dispatch-webhook.test.ts pins the receiver's payload-only routing, a
  `trunk` repo's included, and the drop by the repo's switches after it, in
  `fitness: the receiver drops a fire only where the repo's hook-table item
  says its switch is off (dispatcher-workflows.md)`;
  test/dispatch-turn.test.ts a cursor per repo, file and label.
- The drop: `droppedBy` in dispatch/webhook/switches.mjs, which also holds
  `switchOf`, called by `handle` in dispatch/webhook/route.mjs.

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
- Do not gate workflow or merge events by repo in the receiver, nor read a
  config file there: the task reads the file and writes the switches the
  receiver drops by to the hook table.
- Do not declare CI, triage or tags in the workflow files: whether a red run
  is CI, or gets a triage session, is a choice about governor's behaviour,
  which the config file holds.
- Do not declare a label in a variable the receiver cannot see: the
  `workflow_job` payload carries the job's name and no file.
- Do not hold a merge while a run is unfinished: a PR then waits on a sweep
  that may never come.

Judgment: that a served repo's workflows write the job-name suffix and `TICKET_LABEL_PATHS`, no check here sees: governor cannot read another repo's files at that repo's merge time.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The receiver drops a fire whose switch the repo's hook-table item says is off, the conflicts check never, since #147.
