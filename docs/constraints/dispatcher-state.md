# Dispatcher state
Relevance: State a turn keeps for a later turn, a cursor, record or lease it reads back: dispatch/**, infra/governor.cfn.yml, or a new store for the dispatcher
Decision: A record one turn writes for a later turn lives in the stack's one DynamoDB table, keyed pk/sk; logs are never read back as state.

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
- A session governor started: `session#<session id>` / `started` in
  `dynamoState`, under no repo, put after every launch that printed one,
  and never expired. The PR review reads it, and a failed read fails the review. A
  lost item lets a ticket's mode label waive a human-only path, so the item
  outlasts every PR it guards (dispatcher-review.md).

## Do not

- Do not read the log group back as state (`FilterLogEvents` on
  `dispatch-stale-runs`): retention drops it after 30 days and nothing can
  mark a line handled.
- Do not add a table per use. Every use would add a stack resource, a grant
  and a stack test. A different access boundary is the exception.
- Do not keep records in S3 objects under a prefix: a query becomes a list
  plus a get per object, and expiry is by prefix and age, not per record.

Judgment: whether a new record belongs on GitHub because a person or session reads it, or in the table, is a judgment no check sees.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The session record was added in #13.
