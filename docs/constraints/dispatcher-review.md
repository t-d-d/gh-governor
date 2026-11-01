# Dispatcher review
Relevance: The PR review governor runs over a served repo's PR: dispatch/{review,checklist}.mjs, the config file's `review` section, dispatch/Dockerfile
Decision: Governor reviews a served repo's PRs from that repo's own `review` settings, runs none of its code, and merges a pass only where `merge` is on.

Why: A review whose labels, globs and checklist sat in governor's code and
image would speak for one repo, and a change to it would need a deploy. Most
served repos have their owner merge, so a pass there must not merge.

## Rules

- The review runs where the repo's file turns `prReview` on. It reads a PR
  into the repo's default branch, opened, readied, pushed to or with its
  body edited, whose author may summon governor, and again when a run on
  its head finishes. The receiver queues the fire from every served repo;
  the task refuses it where the switch is off.
- The repo's `review` section (`reviewSchema`, dispatch/repo-config.mjs)
  drives it:
  - `checklist`: the model's prompt, text or `{ "file": "<path>" }`
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
    development`.
  - `quote`: globs of changed files the model gets whole, at the merge base
    and at the head, for test 7; a `!` entry takes a path back out. Only a
    modified file is quoted; one added, removed or renamed waits for a
    person.
  - `decides`: labels of a ticket whose body's first line, `Constraint now
    lives at <path>, …`, decides the quoted files it names: they pass
    unread.
  - `dependabot`: the manifests a Dependabot PR may change and pass with no
    model.
  - `merge`: whether a pass merges. True unless set.
- The settings checks run in code before the model is asked anything, and a
  PR that fails one never reaches it: the ticket rules, each closing ticket
  open, claimed with the repo's claim label or carrying one of its excluded
  labels (`labelRow`, scripts/lib/ready-work.mjs), and closed by no other open PR,
  and no closing reference below the body's top lines or to another repo's
  issue, which fail for an edit (test 1); the human-only globs (test 7); the Dependabot list. A required
  status check red on the head is test 8, for the author session's push. A
  required check not finished skips the review with no comment, and a test-8
  fail is read again at the same head.
- The model answers under a fixed pass/fail schema. Its prompt is the repo's
  `checklist` plus a suffix naming what the code decided.
- A pass merges, pinned to the head reviewed, only where `merge` is true.
  Where it is false, a pass is an approving review pinned to that head and
  the marker comment, and nothing merges: the repo's owner merges. A later
  head that does not pass dismisses governor's earlier approval.
- The review never runs code from the served repo. A check settings cannot
  express belongs in the repo's own CI, which the review reads as a required
  status check.

## Examples

- A full section: test/fixtures/factory/.github/dispatch.json, with its
  checklist in test/fixtures/factory/.claude/skills/pr-review/SKILL.md.
- A repo whose owner merges: `"review": { "checklist": "…", "merge": false }`.
- The decision in code: `decideInCode` in dispatch/checklist.mjs; the merge
  or approval in `reviewPull`, dispatch/review.mjs.

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

Judgment: that a repo's checklist numbers its model tests 2 to 6, and that a `quote` glob reaches only rule files, no check sees: both are the repo's prose.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. An `unless` label stopped waiving a path for a session governor started in #13. A PR closing another repo's issue fails test 1 in #73: a PR closes tickets in its own repo only, and work spanning repos uses `blocked by`. A closing ticket carrying an excluded label passes test 1 unclaimed in #145: it is not pickup's, so nobody claims it, and a repo that forbids closing one says so in its ticket rules.
