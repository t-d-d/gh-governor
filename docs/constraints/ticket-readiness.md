# What keeps a ticket from pickup
Relevance: What keeps a ticket out of pickup, or holds it: scripts/lib/{ready-work,dispatch-router}.mjs, dispatch/{pickup,launch-plan,waits,unblocked}.mjs, eslint-rules/no-readiness-checks.mjs
Decision: One function, `ticketStatus`, combines the checks that keep a ticket out of pickup, and a ticket's own `Blocked until:` line always holds it.

Why: Pickup, the claim's second read and a blocker's close each decided a
ticket's readiness once, and they drifted: a ticket read ready on one path
and blocked on another, and a session started on work a person had held.

## Rules

- What keeps a ticket out of the selection, the claim's second read and the
  `unblocked` row's ready reading is what `ticketStatus`
  (scripts/lib/ready-work.mjs) reads, and no other file combines those
  checks. Two callers read one check alone: the PR review's test 1 reads
  `labelRow`, and wait end reads `isWaiting`. Lint refuses any other caller
  (eslint-rules/no-readiness-checks.mjs).
- The checks are the claim label, `pickup.exclude`, an open blocker, and the
  ticket's own `Blocked until:` line. A ticket's labels meet the repo's
  labels in any case, as GitHub matches labels.
- A ticket's own `Blocked until:` line holds it whatever the switches say,
  and a line governor cannot read holds it too and gets one comment. A line
  a person wrote is never silently ignored.
- A launch that started nothing does not start its ticket again at once.
  Governor puts the ticket's failed-launch record in the state table before
  it puts back the labels the claim took off, and pickup skips the ticket
  while the record stands. A read of it that fails refuses the repo's pickup
  for the turn.

## Examples

- The lint rule and its fitness tests: `fitness: lint refuses a new caller of
  the readiness checks (ticket-readiness.md)` and its siblings in
  test/ready-work-lint-fitness.test.ts.
- The line: `isWaiting` in scripts/lib/ready-work.mjs; its comments in
  dispatch/waits.mjs.
- The failed-launch hold: `failedLaunchesOf` in dispatch/pickup.mjs.

## Do not

- Do not combine the readiness checks anywhere but `ticketStatus`: a second
  copy drifts, and a ticket reads ready on one path and held on another.
- Do not put a ticket's `Blocked until:` line behind a switch: a repo that
  turned the switch off would start work a person held.
- Do not put the ready labels back after a failed launch before the
  failed-launch record: the label's own fire would start the ticket again at
  once, and a broken environment would spend the login in a loop.

History: Split out of the dispatcher repos file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. A ticket's own `Blocked until:` line holds it whatever the file says, and joins what keeps a ticket out of the selection, since #186, under PRD #185. A ticket whose launch started nothing is held from pickup for an hour by its failed-launch record since #391. Pickup's labels match a ticket's labels in any case since #465.
