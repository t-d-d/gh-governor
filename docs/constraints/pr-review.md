# The PR review
Relevance: The review governor runs over a served repo's PR, its check or its merge: dispatch/{review,checklist,cli-answer,launcher}.mjs, dispatch/Dockerfile, the config file's `prReview` section
Decision: Governor reviews a PR from the repo's own `prReview` settings, runs none of its code, gives the model no tools, and merges a pass only where `merge` is on.

Why: A review whose labels, globs and checklist sat in governor's code and
image would speak for one repo, and a change to it would need a deploy.
Governor holds the App's token over every served repo, so it runs none of
their code. Most served repos have their owner merge, so a pass there must
not merge.

## Rules

- The repo's `prReview` section drives the review: its prompt, its
  human-only globs, its ticket rules, the files it quotes and the checks it
  requires. Nothing of one repo's review lives in governor's image.
- The review never runs code from the served repo. A check settings cannot
  express belongs in the repo's own CI, which the review reads as a required
  check.
- The review starts no session. The model is one `claude -p` inside the
  turn, with no tools, answering under a fixed pass/fail schema. Its system prompt replaces Claude Code's own: governor's
  fixed frame, then the repo's `prompt`, then a suffix naming what the code
  decided.
- The settings checks run in code before the model is asked anything, and a
  PR that fails one never reaches it. A decided-in-code test is never
  numbered into the model's schema.
- An `unless` label waives a human-only path only for a session governor did
  not start. Governor records every session it starts (dispatcher-state.md),
  and every launch goes through the launcher that records it.
- The review reads its earlier verdict from the state table, never from a
  comment's text. A fail is never reused, and a pass is reused only where
  nothing the model reads has changed.
- A pass merges, pinned to the head reviewed, only where `merge` is true.
  Governor approves nothing.
- Every review that answers posts a check run named `governor` on the head:
  `success` for a pass; `failure` for a fail the author session can meet, and
  for a review that did not finish, a PR a review turn ran out of time for
  included; `neutral` where only a person can act.

## Examples

- A full section: test/fixtures/factory/.github/governor.json, with its
  checklist in test/fixtures/factory/.claude/skills/pr-review/SKILL.md.
- The decision in code: `decideInCode` in dispatch/checklist.mjs; the check
  and the merge in `reviewPull`, dispatch/review.mjs.
- Test 8 reads only the CI run at the PR's head: dispatcher-workflows.md.

## Do not

- Do not run a repo-supplied script or hook in governor: it holds the App's
  token over every served repo, and some are public.
- Do not copy any repo's checklist or lists into governor's image: the image
  then speaks for one repo, and a change there needs a deploy.
- Do not merge where `merge` is false: that repo's owner merges.
- Do not read branch protection's admin endpoints for the required checks:
  that needs Administration permission on every installation.
- Do not number a decided-in-code test into the model's schema: the model
  answering it would overrule the code.
- Do not let an `unless` label waive a path for a PR whose session governor
  started: the label says who should work the ticket, not who did, and
  nobody watched that session.
- Do not reuse a fail, nor a pass across any change to what the model reads:
  a fail costs the author a turn, and an edit may have changed the answer.
- Do not read a verdict back from a comment's text, governor's own included:
  anyone with write access can edit it into a pass.
- Do not approve a pass, nor ask a repo to require approvals: the author,
  usually the owner, cannot approve their own pull request.
- Do not post `neutral` for a fail the author session can meet: GitHub
  counts it as passing a required check.
- Do not post `failure` where a pull request waits for a person: the person
  could then not merge it without a bypass.
- Do not post `neutral`, or no check, where the review does not finish: a
  gate fails loudly, and the owner can bypass it.

Judgment: that a repo's checklist numbers its model tests apart from those decided in code, and that a `quote` glob reaches only rule files, no check sees: both are the repo's prose.
History: Split out of the dispatcher review file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. An `unless` label stopped waiving a path for a session governor started in #13. A pass posts the `governor` check and no approval since #388. A PR a review turn ran out of time before it reached gets a `failure` check since #403. A pass is reused at a new head where nothing the model reads has changed since #415. The review reads its earlier verdict from the state table since #416. The review's run replaces Claude Code's system prompt with governor's frame, the repo's checklist and the suffix since #432. The section is `prReview` since #525.
