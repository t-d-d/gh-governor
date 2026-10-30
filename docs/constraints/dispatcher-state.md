# Dispatcher state
Relevance: State a turn keeps for a later turn, a cursor, record or lease it reads back: dispatch/**, infra/governor.cfn.yml, or a new store for the dispatcher
Decision: A turn's record for a later turn lives in the stack's one DynamoDB table, keyed pk/sk; the receiver reads and counts only in its own hook table; logs are not state.

Why: A refused workflow turn left nothing behind, so the next turn could not
tell its merges were untold. Reading the refusal back from the log group was
rejected: lines expire, cannot be marked handled, and the read grows with the
group.

## Rules

- One table, `DispatchStateTable` in infra/governor.cfn.yml: on demand, keyed
  `pk`/`sk`, a `ttl` attribute, no `TableName`. A new use takes a key prefix
  (`workflow#<repo>#<file>` / `cursor`), not a new table.
- The task role holds only the item actions its uses call, on that table
  only. The task finds it through `DISPATCH_STATE_TABLE`.
- The one other table is `DispatchHookTable`, under the different-access-
  boundary exception below: the webhook receiver is internet-facing, and
  the state table holds records other checks trust. It is built the same
  way. It holds only what the receiver reads and counts: one item per served
  repo, `hooks#<repo>` / `listed`, each hook's name, `keyVersion` and
  `perHour`, which the task puts each time it reads the repo's file; and one
  item per hook and clock hour, `fires#<repo>#<hook>` / `<hour>`, the
  receiver's count of that hook's fires, raised by one conditional
  `UpdateItem` while under the cap and expired by `ttl`. The receiver holds
  `GetItem` and `UpdateItem` on it and nothing on the state table; the task
  holds only the item actions it calls on it. The receiver finds it through `HOOK_TABLE`,
  the task through `DISPATCH_HOOK_TABLE`.
- A record two turns can race is written conditionally
  (`ConditionExpression`), never read then written.
- A missing item means the use's fallback (the first turn after a deploy, a
  lost item); a read that fails means the turn refuses. Never treat a failed
  read as a missing item.
- Every use survives a lost item: there is no point-in-time recovery. A new
  deployment starts with an empty table, and every workflow finds its
  baseline in its runs list.
- What stays elsewhere: files, and records an outside writer drops off with
  its own credential (transcripts), stay in S3. Records people or sessions
  read (marker comments, labels, PR bodies) stay on GitHub.

## Examples

- Each workflow's cursor: `dynamoState` in dispatch/turn.mjs, read through
  `coverageOf` (dispatch/coverage.mjs), moved forward after a turn's sends,
  keyed by its repo and file.
- What a held cursor's range delivered: `workflow#<repo>#<file>` /
  `delivered#<run>` in `dynamoState`, merged by one `UpdateItem` (`ADD`,
  `list_append`) rather than read then written, expired by `ttl`.
- A PR told of the conflict a merge left it in: `conflicts#<repo>` /
  `<pr>#<merge sha>` in `dynamoState`, put only where none stands, before
  the send, so a merge tells each PR once (dispatch/conflicts.mjs).
- A periodic's last fire: `periodic#<repo>` / `<name>` in `dynamoState`,
  put only over the record the turn read, and never expired. A missing one
  is the baseline, and a failed read refuses the periodic
  (dispatch/periodics.mjs).
- A repo's last pickup sweep: `pickup#<repo>` / `sweep` in `dynamoState`,
  put only where none or an earlier sweep stands, and never expired. A
  missing one means sweep now, and a failed read refuses the repo's sweep
  (dispatch/pickup.mjs).
- A session governor started: `session#<session id>` / `started` in
  `dynamoState`, under no repo, put after every launch that printed one,
  and never expired. The PR review reads it, and a failed read fails the review. A
  lost item lets a ticket's mode label waive a human-only path, so the item
  outlasts every PR it guards (dispatcher-review.md).

- What the receiver knows of a repo's hooks: `hooks#<repo>` / `listed` in
  the hook table (dispatch/webhook/hook-table.mjs), put by the task only
  over an item from an earlier read of the file, and never expired. A
  missing one queues the fire for the task to judge, and a failed read
  answers `503` (dispatch/webhook/route.mjs).
- A hook's fires this hour: `fires#<repo>#<hook>` / `<hour>` in the hook
  table, raised by the receiver in one `UpdateItem` conditioned on the count
  being under the hook's cap, never read then written, and expired by `ttl`
  when the hour ends. A count at the cap answers `429`; any other failure
  answers `503`. A lost item lets at most one more hour's cap through.

## Do not

- Do not read the log group back as state (`FilterLogEvents` on
  `dispatch-stale-runs`): retention drops it after 30 days and nothing can
  mark a line handled.
- Do not add a table per use. Every use would add a stack resource, a grant
  and a stack test. A different access boundary is the exception.
- Do not keep records in S3 objects under a prefix: a query becomes a list
  plus a get per object, and expiry is by prefix and age, not per record.

Judgment: whether a new record belongs on GitHub because a person or session reads it, or in the table, is a judgment no check sees.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The session record was added in #13. The hook table, the receiver's own, was added in #57, under PRD #53. The receiver's hourly count of each hook's fires joined it in #58, under PRD #53.
