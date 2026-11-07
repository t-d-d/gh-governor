# Dispatcher review
Relevance: The PR review governor runs over a served repo's PR, and the issue reviews it runs over a served repo's issues: dispatch/{review,checklist,cli-answer,issue-review}.mjs, the config file's `prReview` and `issueReviews` sections, dispatch/Dockerfile
Decision: Governor reviews a served repo's PRs from that repo's own `prReview` settings, and its issues from its own `issueReviews` settings, gives the model no tools, runs none of the repo's code, starts no session, and merges a pass only where `merge` is on.

Why: A review whose labels, globs and checklist sat in governor's code and
image would speak for one repo, and a change to it would need a deploy. Most
served repos have their owner merge, so a pass there must not merge.

## Rules

- The review runs where the repo's file turns `prReview` on. It reads a PR
  into the repo's default branch, opened, readied, pushed to or with its
  body edited, whose author `trust.review` lets in (`reviewOf`,
  dispatch/trust.mjs; dispatcher-repos.md), and again when a check on its
  head ends. Dependabot's PRs are read by the `dependabot` list whatever
  `trust.review` says. The receiver queues the fire from every served repo
  unless the repo's item in the hook table says `prReview` is off
  (dispatcher-state.md); the task still refuses it where the switch is off.
- The repo's `prReview` section (`prReviewSchema`, dispatch/repo-config.mjs)
  drives it:
  - `prompt`: the model's prompt, text or `{ "file": "<path>" }`
    (dispatcher-repos.md). Its tests 2 to 6 are the model's.
  - `humanOnly`: globs, each with a reason and optional `unless` labels. A
    PR changing a matching path waits for a person, unless every ticket it
    closes carries one of `unless` and meets test 1, and the session its
    body names is not one governor started. Governor records every session
    it starts (dispatcher-state.md); a body naming no session keeps the
    label's waiver.
  - `tickets`: label rules every ticket the PR closes meets. `require`: it
    carries one of `labels`; `forbid`: none. Either is waived by an `unless`
    label, such as `type: adr` forbidden unless `workflow: ready for
    development`. Both match the ticket's labels in any case, as GitHub
    matches them.
  - `quote`: globs of changed files the model gets whole, at the merge base
    and at the head, for test 7; a `!` entry takes a path back out. Only a
    modified file is quoted; one added, removed or renamed waits for a
    person.
  - `decides`: labels of a ticket whose body's first line, `Constraint now
    lives at <path>, …`, decides the quoted files it names: they pass
    unread.
  - `dependabot`: the manifests a Dependabot PR may change and pass with no
    model.
  - `requireChecks`: checks test 8 treats as required, beside those GitHub
    requires, each once: a name, met by a check run from any App or a
    status context, or a name and the slug of the App that must post it,
    met only by that App's check run of the name.
  - `waitForCi`: whether test 8 reads the `workflows.ci` run at the head.
    True unless set.
  - `merge`: whether a pass merges. True unless set.
- The settings checks run in code before the model is asked anything, and a
  PR that fails one never reaches it: the ticket rules, each closing ticket
  open, claimed with the repo's claim label or carrying one of its excluded
  labels (`labelRow`, scripts/lib/ready-work.mjs), and closed by no other open PR,
  and no closing reference below the body's top lines or to another repo's
  issue, which fail for an edit (test 1); the human-only globs (test 7); the Dependabot list. A required
  status check red on the head is test 8, for the author session's push. A
  check `requireChecks` lists is read as a required one. An entry naming
  its App reads only that App's check runs of the name: another App's run,
  such as a job of the same name a PR adds to its own workflow, and a
  status of the name, neither meet nor fail it, so with none from the App
  the review waits. A name GitHub requires reads every run and status of
  the name, as GitHub's own source check still holds the merge.
  Where the file names `workflows.ci` and `prReview.waitForCi` is not
  `false`, test 8 also reads the latest run of that workflow at the head,
  from the Actions API: one ended red, by the conclusions a red check has,
  fails it the same way, naming the file; one not finished, or none at the
  head, skips the review as an unfinished required check does; one ended
  green or skipped passes. No other workflow's run, and no CI run at
  another commit, counts. Where `waitForCi` is `false`, the review reads no
  workflow runs: the repo's CI runs only after the merge, and has no run at
  a PR's head. A required check not finished skips the review with no comment, and the check's end queues
  it again: a `check_run` completed, not from governor's own App, or a
  `status` that ended, at the head, or a `workflow_run` completed for the CI
  run. Each queues a fire carrying the commit and no PR, and the task
  reviews each open PR at that head. A test-8 fail is read again at the
  same head, except by a check's end where the verdict in the state table
  names a test-8 fail there with the same body, its comment names the same
  red checks, and governor's own latest
  `governor` run there is that test-8 fail, by its title: that fire posts
  no comment and no check. Test 8 leaves out the review's own `governor`
  check.
- The model answers under a fixed pass/fail schema. Its system prompt
  replaces Claude Code's own: governor's fixed frame (`PR_FRAME`,
  dispatch/checklist.mjs), then the repo's `prompt`, then a suffix
  naming what the code decided.
- Where the model was asked, the review comment's marker carries a digest
  of everything it read, the commits left out (`readDigest`,
  dispatch/checklist.mjs): the frame, the checklist with its suffix, the
  answer's schema, the PR's title and body, the closing tickets' text and
  labels, the changed-file lines, and the quoted files' text at the merge
  base and the head. At a new head whose digest
  matches the last review's, and where that review was the model's pass,
  the pass is posted again with no model call, naming the head it was given
  at. The settings checks and test 8 run first, as for any review. A fail is
  never reused, and a verdict with no digest offers nothing.
- The review reads its earlier verdict from the state table, never from
  comment text: the item `review#<repo>` / `<pr>` (dispatcher-state.md)
  holds the head, the body digest, the read digest and the model's pass
  with its reason, put after each review's comment. A person with write
  access can edit any comment, governor's included, so the comment is the
  record people read, and the review reads it only to edit it in place. A
  missing item means no reuse and no skip, so the model is asked again. A
  read that fails fails the review. A write that fails after the comment
  fails it too, and leaves the check the comment matches. A
  held pass from before no run held a merge merges nothing: its PR is
  judged again.
- A pass merges, pinned to the head reviewed, only where `merge` is true.
  Where it is false, a pass is the marker comment, and nothing merges: the
  repo's owner merges. Governor approves nothing.
- Every review that answers posts a check run named `governor` on the head
  it read: `success` for a pass, `failure` for a conflict and for any fail
  the author session meets by an edit, a claim or a push, and `neutral`
  where only a person can act. A required check, or the CI run at the
  head where test 8 reads it, not finished posts it `in_progress`, an author `trust.review`
  leaves out gets `neutral`, and a review that does not finish gets
  `failure`, saying why. So does a PR a review of every open PR ran out of
  time before it reached, after the same skips as a review: past the
  window no review starts, and the check says the turn ran out of time.
  Those checks stop at a second limit inside the task's deadline, and the
  PRs past it are logged. Every other
  skip posts no check. Where governor's own latest `governor` run at the
  head is still in progress, the check updates that run, to new waiting
  text or to the verdict, so the head ends with one `governor` run; a
  completed run is a verdict, never edited, and a later review at the same
  head posts a new run. The check goes before the merge and the comment. A
  403 on its read or its write is logged and passed over; any other refusal
  fails the review.
- The review turn messages the PR's owner itself, under `prMessages`:
  each new review comment queues one `message` fire for the PR's owner, as
  `ownerOf` finds it when the fire runs (dispatch/deliveries.mjs), with the
  comment's words and no marker (`ownerMessage`, dispatch/review.mjs). The
  fire runs as a turn of its own, so its send and fallback keep their own
  deadline however late in a sweep the comment was posted. Only a verdict
  that asks the session for work (`asksOwner`, from the answer, never the
  words), a fail an edit, a claim or a push meets and a conflict, carries
  the fallback: an archived owner's message goes to the live session on
  the head branch, else a fresh session takes the PR over. A pass, or a
  wait on a person, reaches a live owner and starts nobody. No subscriber
  hears it, and the relay sends the comment itself to nobody
  (dispatcher-repos.md). A comment edited in place tells nobody again,
  unless it is at a new head or body while a message is owed.
  The owner's message is delivered at least once: a fire the lane refuses
  is owed on the PR's verdict (dispatcher-state.md), the comment stands,
  and the next review fire at the same head and body queues it, with no
  model and no comment, and clears it. An owed message is dropped only
  once a newer message to the owner is queued, or owed in its place. A
  review at a new head or body that posts a new comment queues its own
  message in place of the owed one. One that edits its comment in place
  while a message is owed sends the owner the comment as it now reads,
  by the same hand-off, in place of the owed one, carrying its tries. A
  message is tried on at most 3 review turns: a refusal before the last
  logs at warn, and the last logs at error, fails the turn and drops it. A
  message queued is never queued again.
- The review never runs code from the served repo. A check settings cannot
  express belongs in the repo's own CI, which the review reads as a required
  status check, and, unless `prReview.waitForCi` is `false`, as its
  `workflows.ci` run at the head.

- The issue reviews (dispatch/issue-review.mjs) run where the repo's
  file has an `issueReviews` section whose `enabled` is not `false`, from
  its `reviews`, each keyed by its name. An issue opened, reopened, or with
  its body edited by anyone but a bot, queues an `issueReview` fire; the
  receiver drops it where the repo's hook-table item says the switch is
  off, and the task refuses it where the file does.
- A label change queues the same fire, whoever made it, where it can bring
  the issue into a review or change its key: a label added that a review's
  `when.labels` or a `byLabel` entry's `labels` names, or a label removed
  that a review's `when.exclude` or a `byLabel` entry's `labels` names
  (`reviewLabelsOf`, dispatch/issue-review.mjs). The receiver drops the
  fire for any other label change, naming the label in its reason, so a
  review's conclusion labels and the claim label start nothing. Where the
  hook-table item cannot say, it queues the fire and the task decides
  (dispatcher-state.md).
- The task reads the issue and reviews nothing for a closed issue, a
  pull request, the heartbeat issue or the wait ticket, nor for a ticket
  whose author `trust.review` leaves out (`reviewOf`, dispatch/trust.mjs;
  dispatcher-repos.md). It runs, in the order of the reviews' keys, each review whose
  selector (`when`: `labels`, `exclude`, `by`, its labels matched in any
  case, as GitHub matches them; every issue its default `by` lets in where
  unset) the ticket meets now and whose
  newest marker, read only from comments governor's App posted, does not
  carry the ticket's key (`keyFor`): the body's digest (`bodyDigest`), and
  where the review has `byLabel`, the body with the ticket's labels its
  entries name, lower-cased and sorted, so a ticket whose matching entries
  changed is reviewed again, and a label change that leaves the key as it
  was makes no model call.
- The config check (checker/config-check.mjs) warns, and does not fail,
  where an issue review's `by`, or its default, shares no value with the
  repo's `trust.review` as governor reads it (`reviewOf`). Such a review
  never runs, since `trust.review` refuses every ticket it could select. The
  warning names the review, its `by` and `trust.review`. Governor still reads
  the file: the review is dead but harmless, and refusing the file would
  leave the repo unserved over it.
- An issue review is one `claude -p` with no tools, its system prompt
  replaced by governor's fixed frame and then the repo's settings: the
  review's `prompt`, governor's default prompt where it has none, then the
  `prompt` of each `byLabel` entry the ticket matches, in list order
  (`promptFor`). An entry matches a ticket carrying any of its
  `labels`, in any case. A ticket matching no entry gets the base alone,
  and no entry drops the base. The answer
  held to a schema: `success`, `failure` or `neutral`, and its text. The
  model reads the ticket, its same-repo parent and links, the repo's open
  issues and its round, one more than the review's own markers. Each run
  posts a new comment ending `<!-- governor:issue-review <name>
  <conclusion> <key> -->`. A run that fails or answers outside the schema,
  a refused label write and a refused comment post no marker and fail the
  turn; the session limit is `limited`, and stops the turn's later reviews.
- An issue review's labels are applied in code from the conclusion, before
  the comment (`applyLabels`, dispatch/issue-review.mjs), and the model
  applies none. The review's `conclusions` names the labels each of
  `success`, `failure` and `neutral` adds, and a `byLabel` entry may
  override any of them: for each conclusion the labels come from the first
  matching entry that names it, and otherwise from the review's
  (`conclusionsFor`). A run removes each label the other two conclusions
  name, in the review's `conclusions` or any entry's, that the ticket
  carries, leaving every label its own conclusion names in any of them,
  then creates and adds its own conclusion's labels the ticket lacks, then
  posts its comment. It touches no other label and reads no other part of the
  config to decide. Every label a review's conclusions name, in its
  `conclusions` and in each `byLabel` entry's, starts with the review's name, a colon
  and a space, in any case, such as `triage: build` for a review named
  `triage`. Governor's config read and the config check both refuse a file
  otherwise, naming the review and the label. A review's labels are its own,
  so a run never adds or removes a label a person uses, such as a
  `mode: human` hold. A label write GitHub refuses posts no comment, so a
  ticket never keeps a ready label from an earlier `success` under a later
  `failure` with nobody told. A review queues no pickup fire of its own: a
  ticket it readies is picked up by its ready label's own fire, as a person's
  label is.
- The loop guard (`LOOP_LIMIT`, dispatch/issue-review.mjs) stops an issue
  review at its fifth `failure` in a row on one ticket. Where a run's
  comment posts `failure`, governor counts that review's markers back from
  the newest, the new one included, while they conclude `failure`. Where
  the count is a multiple of five, it posts one comment ending
  `<!-- governor:issue-review-loop <name> -->` and logs
  `dispatch-issue-review-loop` at error. While a comment governor's App
  posted ends in that marker, the review is skipped on the ticket, after
  the selector and key checks; other reviews still run. Deleting the
  comment lets the review run again, and the next guard comes at the tenth
  failure in a row. The guard's marker is never read as a review's, so it
  spends no round. A guard comment GitHub refuses leaves the review
  standing and makes the turn exit 1. The limit is a constant, and no
  config key changes it.

## Examples

- A full section: test/fixtures/factory/.github/governor.json, with its
  checklist in test/fixtures/factory/.claude/skills/pr-review/SKILL.md.
- A repo whose owner merges: `"review": { "checklist": "…", "merge": false }`.
- The decision in code: `decideInCode` in dispatch/checklist.mjs; the
  check and the merge in `reviewPull`, dispatch/review.mjs.

## Do not

- Do not run a repo-supplied script or hook in governor: it holds the App's
  token over every served repo, and some are public.
- Do not copy any repo's checklist or lists into governor's image: the image
  then speaks for one repo, and a change there needs a deploy.
- Do not merge where `merge` is false: that repo's owner merges.
- Do not read branch protection's admin endpoints for the required checks:
  that needs Administration permission on every installation.
- Do not number a decided-in-code test into the model's schema: the model
  answering test 1 or 8 would overrule the code.
- Do not let an `unless` label waive a path for a PR whose session
  governor started: the label says who should work the ticket, not who did,
  and nobody watched that session.
- Do not reuse a fail, nor a pass across any change to what the model
  reads: a fail costs the author a turn, and an edit or a person may have
  changed the answer.
- Do not read a verdict back from a comment's text, governor's own
  included: anyone with write access can edit it into a pass.
- Do not approve a pass, nor ask a repo to require approvals: approvals
  assume a second person, and the author, usually the owner, cannot
  approve their own pull request.
- Do not post `neutral` for a fail the author session can meet: GitHub
  counts it as passing a required check.
- Do not post `failure` where a pull request waits for a person: the person
  it waits for could then not merge it without a bypass.
- Do not post `neutral`, or no check, where the review does not finish: a
  gate fails loudly, and the owner can bypass it.
- Do not give an issue review tools or a checkout: a ticket's text is
  where a prompt injection comes in, and the review's answer is a
  judgement over that text.
- Do not post an issue review's comment after a label write GitHub
  refused: the comment would say a conclusion the labels do not show.
- Do not read a ticket's label events to decide what an issue review
  removes, and do not let a review's conclusions name a label without its
  prefix: a review owns the labels it writes, and the prefix is how a repo
  keeps a person's labels out of them.
- Do not let an issue review read pickup's labels or checks
  (scripts/lib/ready-work.mjs), nor pickup read a review's markers:
  reviews and pickup meet only through labels a repo's config names, and
  each works with the other off.

Judgment: that a repo's checklist numbers its model tests 2 to 6, and that a `quote` glob reaches only rule files, no check sees: both are the repo's prose.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. An `unless` label stopped waiving a path for a session governor started in #13. A PR closing another repo's issue fails test 1 in #73: a PR closes tickets in its own repo only, and work spanning repos uses `blocked by`. A closing ticket carrying an excluded label passes test 1 unclaimed in #145: it is not pickup's, so nobody claims it, and a repo that forbids closing one says so in its ticket rules. The receiver drops the review fire where the repo's hook-table item says `prReview` is off since #147. A pass posts the `governor` check and no approval, and every review comment reaches the session the PR names, since #388. Test 8 reads the `workflows.ci` run at the head beside the required checks since #398: a private repo on a free plan has no required checks, and merged a pass on red CI. A PR a review turn ran out of time before it reached gets a `failure` check since #403. A required check's end queues the review again, by a `check_run` completed or a final `status` at the head beside `workflow_run` completed, with the fire carrying the commit so a fork's PR is read too, since #406. The check updates governor's own `governor` run at the head while it is in progress, rather than leaving a waiting run in progress under the verdict, since #407. A repo's `review.requireChecks` names checks test 8 reads as required, beside those GitHub requires, since #399: a plan that cannot require a check otherwise left only the CI workflow gating the review. A `requireChecks` entry may name the App that must post its check, and test 8 then reads only that App's runs of the name, since #412: a PR could add a workflow job with a listed name, and its green run met the entry before the real check posted. A pass is reused at a new head where nothing the model reads has changed since #415: a push that only merges the base branch asked the model the question it had answered. The review reads a PR whose author `trust.review` lets in, in place of the fixed owners, members and collaborators, since #422, under PRD #396: an open-source repo could not have strangers' PRs reviewed. Governor runs ticket reviews, each a named review with its selector, posting one comment with its conclusion under the default checklist, for authors `trust.review` lets in, since #426, under PRD #390. The loop guard stops a review at its fifth failure in a row on one ticket since #427, under PRD #390: a checklist that never concludes `neutral` could keep a filer session and the review spending the login in turn. The PR review's run replaces Claude Code's system prompt with governor's frame, the repo's checklist and the suffix, rather than appending to it, since #432: the default prompt is written for a coding agent with tools, and the review has none. A conclusion applies the labels the review's `conclusions` names, in code and before the comment, and removes the other two conclusions' labels, since #428, under PRD #390: a repo gates pickup on a review by listing its `success` label among its ready labels. A ticket review reads the repo's own `checklist` after governor's frame, adds each matching `types` entry's checklist after it, takes each conclusion's labels from the first matching entry that names it, and keys on the ticket's type labels where it has `types`, since #429, under PRD #390: a bug can be readied on `success` while an enhancement that passes waits for a person. Test 8 reads the `workflows.ci` run at the head only where `prReview.waitForCi` is not `false` since #459, reversing #398's non-goal of a switch to turn it off: a repo whose CI runs only after the merge has no run at a PR's head, and every PR waited forever. A selector's `labels` and `exclude` match the ticket's labels in any case since #453, under PRD #390: an `exclude` written in another case let through tickets it was meant to leave out. The config check warns of a ticket review whose `by` shares no value with `trust.review` since #440, under PRD #390: such a review never comments, and the owner saw only silence. The PR review's ticket rules match `labels` and `unless` in any case since #465: a rule forbidding `type: adr` passed a ticket labelled `Type: ADR`. A check's end skips a head whose last review failed test 8 on the same red checks since #410: another App answering the `governor` check with a check of its own would queue the same fail again without end. The review reads its earlier verdict from the state table, not its last marker comment's text, since #416: a person with write access could edit governor's fail comment into a pass the next review merged or reused unjudged. A ticket a review readies is picked up by its ready label's own fire, not at the next pickup sweep, since #391: the label queues a selection fire whoever added it, governor's own App included. This records that change and does not change the rule. Every label a ticket review's conclusions name starts with the review's name, a colon and a space since #512, closing #448: a conclusion removed the other conclusions' labels, so a `success` took off a `mode: human` hold a member added and pickup started the ticket. Ticket reviews became issue reviews in one `issueReviews` section, with `enabled` and `reviews` keyed by name, a review's text its `prompt` and its per-label entries `byLabel`, and a label change a review's selector or `byLabel` names queues the review at once, since #524: a review with `when.labels` never read an issue labelled after it opened. The PR review's section is `prReview` and its text is `prompt`, since #525, which gave every feature one section in `.github/governor.json`. The review turn messages the PR's owner itself, deciding the fallback from its own verdict, and the relay sends the review comment to nobody, since #566, under PRD #535: the receiver read the verdict back from the comment's words, so two turns decided one thing. The owner's message of a review comment is delivered at least once, owed on the verdict where the lane refuses it and sent by the next review fire at the same head and body, since #589: a refused message was never retried, and the owner heard nothing until its next push. A review that edits its comment in place at a new head or body, while a message is owed, sends the comment as it now reads in place of the owed one, since #592: the edit dropped the owed message and told nobody. A check's end skips a test-8 fail only where governor's own latest `governor` run at the head is that fail, by its title, since #481: a review that threw or ran out of time at the head posted the "did not run" failure, and the next check's end skipped while the check said the review runs again.
