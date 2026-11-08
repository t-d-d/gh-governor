# Issue reviews
Relevance: The reviews governor runs over a served repo's issues, and the labels they write: dispatch/issue-review.mjs, the config file's `issueReviews` section
Decision: An issue review is one model call with no tools; governor applies its labels in code, each prefixed with the review's name, and stops one that keeps failing.

Why: A ticket's text is where a prompt injection comes in, so the model only
judges it. A review that removed labels it did not own took off a person's
`mode: human` hold, and pickup started the ticket. A checklist that never
concludes could keep a filer session and the review spending the login in
turn.

## Rules

- An issue review is one `claude -p` with no tools and no checkout, its
  system prompt governor's fixed frame and then the repo's settings. It
  answers `success`, `failure` or `neutral` under a schema.
- The model applies no label. Governor applies the labels the review's
  `conclusions` names for its answer, in code, before the comment, and
  removes the labels the other conclusions name. It touches no other label.
- Every label a review's conclusions name starts with the review's name, a
  colon and a space, in any case. A label belongs to one conclusion of one
  review, and is not one the review selects on, a `byLabel` entry matches
  on, or the claim label. The config read and the config check both refuse
  a file otherwise.
- A label write GitHub refuses posts no comment.
- A review whose `by` reaches beyond `trust.auto` names no ready label in
  any conclusion (trust.md). Reviews and pickup meet
  only through labels a repo's config names, and each works with the other
  off.
- The loop guard stops a review at its fifth `failure` in a row on one
  ticket, with one comment under `governor:issue-review-loop`. The limit is
  a constant, and no config key changes it.

## Examples

- Labels in code: `applyLabels` and `conclusionsFor` in
  dispatch/issue-review.mjs.
- The loop guard: `LOOP_LIMIT` in the same file.

## Do not

- Do not give an issue review tools or a checkout: a ticket's text is where
  a prompt injection comes in, and the review's answer is a judgement over
  that text.
- Do not post an issue review's comment after a label write GitHub refused:
  the comment would say a conclusion the labels do not show.
- Do not read a ticket's label events to decide what a review removes, and
  do not let a review's conclusions name a label without its prefix: a
  review owns the labels it writes, and the prefix keeps a person's labels
  out of them.
- Do not let an issue review read pickup's labels or checks, nor pickup read
  a review's markers: reviews and pickup meet only through labels.
- Do not let a config key raise or remove the loop guard: it is the guard
  on the login.

History: Split out of the dispatcher review file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. Governor runs ticket reviews since #426, and the loop guard stops one at its fifth failure in a row since #427, under PRD #390. A conclusion applies its labels in code before the comment since #428. Every conclusion label starts with the review's name, a colon and a space since #512, closing #448. Ticket reviews became issue reviews in one `issueReviews` section since #524.
