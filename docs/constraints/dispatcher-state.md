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
  (`workflow#<repo>#<file>` / `cursor`), not a new table.
- The task role holds only the item actions its uses call, on that table
  only. The task finds it through `DISPATCH_STATE_TABLE`.
- The one other table is `DispatchHookTable`, under the different-access-
  boundary exception below: the webhook receiver is internet-facing, and
  the state table holds records other checks trust. It is built the same
  way. It holds only what the receiver reads and counts: one item per served
  repo, `hooks#<repo>` / `listed`, each hook's name, `keyVersion` and
  `perHour`, each of the repo's switches, its ready labels, its issue
  review labels and its `trust` lists as the task read them, which the task puts in one write each time
  it reads the repo's file; and one
  item per hook and clock hour, `fires#<repo>#<hook>` / `<hour>`, the
  receiver's count of that hook's fires and the signatures it counted,
  raised by one conditional `UpdateItem` while under the cap and only for a
  signature the hour has not counted, and expired by `ttl`. The receiver holds
  `GetItem` and `UpdateItem` on it and nothing on the state table; the task
  holds only the item actions it calls on it. The receiver finds it through `HOOK_TABLE`,
  the task through `DISPATCH_HOOK_TABLE`.
- A record two turns can race is written conditionally
  (`ConditionExpression`), never read then written.
- A missing item means the use's fallback (the first turn after a deploy, a
  lost item); a read that fails means the turn refuses. Never treat a failed
  read as a missing item. There are two exceptions. The receiver's read of a
  repo's switches, ready labels, issue review labels and trust lists: a
  missing item, an item without them and a failed read all queue the fire, which leaves the task
  to decide, and judge a message by the default `trust.relay`; the failed
  read is logged at error. And the count of a session's messages about one
  subject: a count that cannot be read or raised lets the send go, logged
  at warn, since the ceiling guards against a loop and must not stop a
  message.
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
  `delivered#<run>`, merged by one `UpdateItem` (`ADD`, `list_append`)
  rather than read then written, expired by `ttl`.
- A session governor started: `session#<session id>` / `started`, under no
  repo, put after every launch that printed one, and never expired. The PR
  review reads it, and a failed read fails the review. A lost item lets a
  ticket's mode label waive a human-only path, so the item outlasts every PR
  it guards (pr-review.md).
- A PR review's verdict: `review#<repo>` / `<pr>`, which the review reads in
  place of its comment's text, which a person can edit. A lost item costs a
  model call and no merge, and a failed read fails the review (pr-review.md).
- What the receiver knows of a repo: `hooks#<repo>` / `listed` in the hook
  table (dispatch/webhook/hook-table.mjs), put by the task only over an item
  from an earlier read of the file, and never expired.
- A hook's fires this hour: `fires#<repo>#<hook>` / `<hour>` in the hook
  table, raised in one `UpdateItem` conditioned on the count being under the
  hook's cap and the request's signature not yet counted, and expired by
  `ttl` when the hour ends.
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

Judgment: whether a new record belongs on GitHub because a person or session reads it, or in the table, is a judgment no check sees.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The session record was added in #13. The hook table, the receiver's own, was added in #57, under PRD #53. The receiver's hourly count of each hook's fires joined it in #58, under PRD #53, and counts each signature once since #66, with `perHour` at most 100 since #138. The hook record was added in #56. The hook table's item holds the repo's switches, which the receiver drops fires by, and a failed read of them queues the fire, since #147. It holds the repo's ready labels, which the receiver queues a selection fire by, under the same fallback, since #180. A waiting ticket's item, which the bare schedule fire reads to find the waits that have ended, was added in #187, under PRD #185. The hook table's item holds the repo's `trust` section, written by the task and read by the receiver, which drops a message only where the refusal is silent and reads the defaults when the item lacks the section or the read fails, since #419, under PRD #396. A PR review's verdict, which the review reads in place of its marker comment's text, was added in #416. A ticket's failed-launch record, which holds it from pickup for an hour once a launch started nothing, was added in #391. A ticket linked to the wait ticket by hand keeps a wait item twenty years out, so the bare schedule fire stops reading it, since #233, under PRD #185. The hook table's item holds the labels whose change can start an issue review, which the receiver queues an issue review fire by, under the same fallback as the ready labels, since #524. It holds the repo's claim label, by which the receiver queues a claimed ticket's events for its builders, and an item without it queues them for the task to judge, since #538, under PRD #535. A held cursor's delivered record keeps the tickets a green deploy commented on, so a later turn still tells their roles, since #564, under PRD #535. A PR review's verdict may hold an owed message, which the next review fire at the same head and body sends, since #589. A session the sign-off sweep told it was held keeps an item, so it is told once, since #594. One item per session, subject and clock hour counts governor's messages under the stack's ceiling, and a count that fails lets the send go, since #602. A session governor told of a correction keeps one item per kind, so it is told once, since #614, under PRD #599. A PR body edit's correction is one more kind, `edit-pr`, since #615, under PRD #599. The `unsigned` and `unsigned-maybe` corrections joined the told record since #616, under PRD #599. The `edit-unsigned` and `edit-unsigned-maybe` corrections joined it since #617, under PRD #599. The Examples were cut to fit the size cap in #698, a change of wording: each record's fields and expiry are held by its tests.
