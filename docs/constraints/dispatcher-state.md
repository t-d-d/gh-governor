# Dispatcher state
Relevance: State a turn keeps for a later turn, a cursor, record or lease it reads back: dispatch/**, infra/governor.cfn.yml, or a new store for the dispatcher
Decision: A turn's record for a later turn lives in the stack's one DynamoDB table, keyed pk/sk; the receiver keeps only its own hook table; logs are not state.

Why: A refused workflow turn left nothing behind, so the next turn could not
tell its merges were untold. Reading the refusal back from the log group was
rejected: lines expire, cannot be marked handled, and the read grows with the
group.

## Rules

- One table, `DispatchStateTable` in infra/governor.cfn.yml: on demand, keyed
  `pk`/`sk`, a `ttl` attribute, no `TableName`. A new use takes a key prefix
  (`workflow#<repo>#<file>` / `cursor`), not a new table. A per-repo record
  carries its repo in its key.
- The task role holds only the item actions its uses call, on that table
  only. The task finds it through `DISPATCH_STATE_TABLE`.
- The one other table is `DispatchHookTable`, under the different-access-
  boundary exception below: the webhook receiver is internet-facing, and the
  state table holds records other checks trust. It is built the same way and
  holds only what the receiver reads and counts: one item per served repo,
  `hooks#<repo>` / `listed`, which the task writes each time it reads the
  repo's file, and one item per hook and clock hour counting that hook's
  fires. The receiver holds `GetItem` and `UpdateItem` on it and nothing on
  the state table. It finds it through `HOOK_TABLE`, the task through
  `DISPATCH_HOOK_TABLE`.
- A record two turns can race is written conditionally
  (`ConditionExpression`), never read then written.
- A missing item means the use's fallback (the first turn after a deploy, a
  lost item); a read that fails means the turn refuses. Never treat a failed
  read as a missing item. There are two exceptions. The receiver's read of a
  repo's item: a missing item, an item without the field and a failed read
  all queue the fire, which leaves the task to decide. And the count of a
  session's messages about one subject: a count that cannot be read or
  raised lets the send go, since the ceiling guards against a loop and must
  not stop a message.
- Every use survives a lost item: there is no point-in-time recovery. A new
  deployment starts with an empty table, and every workflow finds its
  baseline in its runs list.
- A record whose loss would let a check pass that should fail is never
  expired. A session governor started (`session#<id>` / `started`) is one:
  a lost item would let a ticket's mode label waive a human-only path
  (pr-review.md).
- What stays elsewhere: files, and records an outside writer drops off with
  its own credential (transcripts), stay in S3. Records people or sessions
  read (marker comments, labels, PR bodies) stay on GitHub.

## Examples

- Each workflow's cursor: `dynamoState` in dispatch/turn.mjs, read through
  `coverageOf` (dispatch/coverage.mjs), moved forward after a turn's sends.
- What a held cursor's range delivered: `workflow#<repo>#<file>` /
  `delivered#<run>`, merged by one `UpdateItem` (`ADD`, `list_append`)
  rather than read then written, expired by `ttl`.
- A PR review's verdict: `review#<repo>` / `<pr>`, which the review reads in
  place of its comment's text, which a person can edit (pr-review.md).
- A hook's fires this hour: `fires#<repo>#<hook>` / `<hour>` in the hook
  table, raised in one `UpdateItem` conditioned on the count being under the
  hook's cap, and expired by `ttl` when the hour ends.
- Every key prefix in use: the `pk` values built in dispatch/turn.mjs and
  dispatch/webhook/hook-table.mjs.

## Do not

- Do not read the log group back as state (`FilterLogEvents` on
  `dispatch-stale-runs`): retention drops it after 30 days and nothing can
  mark a line handled.
- Do not add a table per use. Every use would add a stack resource, a grant
  and a stack test. A different access boundary is the exception.
- Do not keep records in S3 objects under a prefix: a query becomes a list
  plus a get per object, and expiry is by prefix and age, not per record.
- Do not read a failed read as a missing item: the fallback then runs on an
  outage, and a turn acts as if nothing had happened before.

Judgment: whether a new record belongs on GitHub because a person or session reads it, or in the table, is a judgment no check sees.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The session record was added in #13. The hook table, the receiver's own, was added in #57, under PRD #53, and its hourly count of each hook's fires in #58. The hook table's item holds the repo's switches since #147, its ready labels since #180, its `trust` section since #419, its issue review labels since #524 and its claim label since #538, each under the same fallback. A PR review's verdict was added in #416. One item per session, subject and clock hour counts governor's messages under the stack's ceiling since #602. The record catalogue in Examples was cut to the records that show a rule in #698: each record's fields and expiry are held by its tests.
