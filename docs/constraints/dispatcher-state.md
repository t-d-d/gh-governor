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
  read as a missing item. The one exception is the receiver's read of a
  repo's switches, ready labels, issue review labels and trust lists: a
  missing item, an item without them and a failed read all queue the fire, which leaves the task
  to decide, and judge a message by the default `trust.relay`; the failed
  read is logged at error.
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
  `list_append`) rather than read then written, expired by `ttl`. It holds
  who was told, each failed send, and the tickets a green deploy commented
  on, whose roles the range still owes the deploy.
- A PR told of the conflict a merge left it in: `conflicts#<repo>` /
  `<pr>#<merge sha>` in `dynamoState`, put only where none stands, before
  the send, so a merge tells each PR once (dispatch/conflicts.mjs).
- A periodic's last fire: `periodic#<repo>` / `<name>` in `dynamoState`,
  put only over the record the turn read, and never expired. A missing one
  is the baseline, and a failed read refuses the periodic
  (dispatch/periodics.mjs).
- A hook's last session: `hook#<repo>` / `<name>` in `dynamoState`, put
  after a launch that printed a session, only over the record the turn read,
  and never expired. A missing one starts a session, and a failed read
  refuses the fire (dispatch/hooks.mjs).
- A repo's last pickup sweep: `pickup#<repo>` / `sweep` in `dynamoState`,
  put only where none or an earlier sweep stands, and never expired. A
  missing one means sweep now, and a failed read refuses the repo's sweep
  (dispatch/pickup.mjs).
- A session governor started: `session#<session id>` / `started` in
  `dynamoState`, under no repo, put after every launch that printed one,
  and never expired. The PR review reads it, and a failed read fails the review. A
  lost item lets a ticket's mode label waive a human-only path, so the item
  outlasts every PR it guards (dispatcher-review.md).
- A session the sign-off sweep told it was held: `held#<session id>` /
  `told` in `dynamoState`, under no repo, put before the message only where
  none stands, and expired three months after its write, longer than a PR
  stays open. A standing item means the session was told, and it gets no
  second message; a put that fails sends nothing. A lost item costs one
  more message (session-signoff.md, scripts/lib/session-signoff.mjs).
- A PR review's verdict: `review#<repo>` / `<pr>` in `dynamoState`, the
  head, the body digest, the read digest and the model's pass the review
  relies on, and the owner's message the lane refused, if any, with its
  tries (dispatcher-review.md), put after the review's comment only where
  none or the item the review read stands, and expired three months after
  its write. The next review fire at the same head and body sends an owed
  message and writes the item again over the one it read. The review
  reads it in place of its comment's text, which a person can edit. A lost
  item costs a model call and no merge, and a failed read fails the review
  (dispatcher-review.md).
- A waiting ticket's date: `wait#<repo>` / `<issue>` in `dynamoState`, in
  a repo whose file turns `waits` on. The `wait` turn puts it only where
  none or the date it read stands, and deletes it only over that date; the
  bare schedule fire reads a repo's items in one query and deletes or
  rewrites each over the date it read. It expires a month after its date.
  The ticket's `Blocked until:` line stays the record people read and edit:
  the item only tells governor when to look. The one item with no line
  behind it is a ticket linked to the wait ticket by hand, with no line:
  the bare schedule fire tells it once and puts an item twenty years out,
  so later fires skip it unread. The person's link, not the item, holds
  that ticket, and a line written later takes the item over. A lost item
  costs that ticket's wait-ended comment and spec session, or for a
  hand-linked ticket one more read of it and its thread, and a failed read
  refuses the repo's ended waits for the turn (dispatch/waits.mjs).
- A ticket whose launch started nothing: `pickup-failed#<repo>` /
  `<issue>` in `dynamoState`, holding the time it holds the ticket until,
  put by the launch plan after a launch or claim that started nothing,
  before it puts the ready labels back, over any
  earlier one, and expired by `ttl` at that time, an hour on. The selection
  reads a repo's items in one query and skips each ticket whose time is
  still to come, logging `dispatch-pickup` with the reason. A missing item
  means pick up as before, and a failed read refuses the repo's pickup for
  the turn. A lost item lets one more launch go (dispatch/pickup.mjs,
  dispatch/launch-plan.mjs).

- What the receiver knows of a repo's hooks: `hooks#<repo>` / `listed` in
  the hook table (dispatch/webhook/hook-table.mjs), put by the task only
  over an item from an earlier read of the file, and never expired. A
  missing one queues the fire for the task to judge, and a failed read
  answers `503` (dispatch/webhook/route.mjs).
- What the receiver knows of a repo's switches: the same item's `switches`,
  each switch as `turnsOn` read it, written in the same `PutItem` as the
  hooks, before the turn refuses its fire. A GitHub delivery that would
  queue a fire reads it once and drops each fire whose switch it says is
  off (`droppedBy`, dispatch/webhook/switches.mjs). A missing item, one
  without `switches`, malformed switches and a failed read queue every
  fire; a failed read logs `webhook-switches-unread` at error and never
  answers `503`, since GitHub does not send a failed delivery again by
  itself. Each list is an attribute of its own, so another can join the
  item without reshaping it.
- What the receiver knows of a repo's ready labels: the same item's
  `ready`, the file's `pickup.ready`, written in the same `PutItem` as the
  hooks and switches and read in the same one read as the switches. A
  label that it does not list, whoever added it, queues no selection fire, and the
  delivery's reason says so. A missing item, one without `ready`, malformed
  labels and a failed read queue the selection fire, as for the switches
  (dispatch/webhook/route.mjs).
- What the receiver knows of a repo's claim label: the same item's
  `claim`, the file's `pickup.claim`, empty where no feature reads it,
  written in the same `PutItem` as the ready labels and read in the same
  one read. An issue's comment, close or reopen whose labels hold it
  queues a `ticket` fire in place of the spec owner's message, for the
  task to find the ticket's builders (dispatch/ticket-fire.mjs); one whose
  labels do not queues the spec owner's message as before. A missing item,
  one without `claim`, and a failed read queue the ticket fire, and the
  task decides from the labels the fire carries. A malformed `claim` is a
  failed read.
- What the receiver knows of the labels whose change can start an issue
  review: the same item's `reviewLabels`, one list for a label added (each
  review's `when.labels` and `byLabel` labels) and one for a label removed
  (each review's `when.exclude` and `byLabel` labels), lower-cased
  (`reviewLabelsOf`, dispatch/issue-review.mjs), written in the same
  `PutItem` as the ready labels and read in the same one read. A label
  change it does not list for that change queues no issue review fire, and
  the delivery's reason says so. A missing item, one without
  `reviewLabels`, malformed lists and a failed read queue the fire, as for
  the ready labels.
- What the receiver knows of whose text reaches a session: the same item's
  `trust`, a map from each list the receiver reads to its values,
  `relay` as governor reads the file (`relayOf`, dispatch/trust.mjs),
  written in the same `PutItem` as the switches and read in the same one
  read. The receiver drops a message only where its author, or the author
  of the body that named the session, is outside `OWNER`, `MEMBER` and
  `COLLABORATOR` and the list, a silent refusal. A missing item, one
  without `trust` and a failed read judge by the default list; malformed
  lists are a failed read. The task always judges each message again from
  the file (dispatch/turn.mjs), so an item the file has since narrowed
  past lets nothing through. Each list is a key of its own in the map, so
  another can join it without reshaping the item.
- A hook's fires this hour: `fires#<repo>#<hook>` / `<hour>` in the hook
  table, raised by the receiver in one `UpdateItem` conditioned on the count
  being under the hook's cap and the request's signature not yet in the
  item's set, never read then written, and expired by `ttl` when the hour
  ends. The refusal returns the old item: a signature already counted takes
  no place and is queued again, and a new one at the cap answers `429`. Any
  other failure answers `503`. The set holds at most `perHour` signatures,
  and `perHour` is at most 100. A lost item lets at most one more hour's
  cap through.

## Do not

- Do not read the log group back as state (`FilterLogEvents` on
  `dispatch-stale-runs`): retention drops it after 30 days and nothing can
  mark a line handled.
- Do not add a table per use. Every use would add a stack resource, a grant
  and a stack test. A different access boundary is the exception.
- Do not keep records in S3 objects under a prefix: a query becomes a list
  plus a get per object, and expiry is by prefix and age, not per record.

Judgment: whether a new record belongs on GitHub because a person or session reads it, or in the table, is a judgment no check sees.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The session record was added in #13. The hook table, the receiver's own, was added in #57, under PRD #53. The receiver's hourly count of each hook's fires joined it in #58, under PRD #53, and counts each signature once since #66, with `perHour` at most 100 since #138. The hook record was added in #56. The hook table's item holds the repo's switches, which the receiver drops fires by, and a failed read of them queues the fire, since #147. It holds the repo's ready labels, which the receiver queues a selection fire by, under the same fallback, since #180. A waiting ticket's item, which the bare schedule fire reads to find the waits that have ended, was added in #187, under PRD #185. The hook table's item holds the repo's `trust` section, written by the task and read by the receiver, which drops a message only where the refusal is silent and reads the defaults when the item lacks the section or the read fails, since #419, under PRD #396. A PR review's verdict, which the review reads in place of its marker comment's text, was added in #416. A ticket's failed-launch record, which holds it from pickup for an hour once a launch started nothing, was added in #391. A ticket linked to the wait ticket by hand keeps a wait item twenty years out, so the bare schedule fire stops reading it, since #233, under PRD #185. The hook table's item holds the labels whose change can start an issue review, which the receiver queues an issue review fire by, under the same fallback as the ready labels, since #524. It holds the repo's claim label, by which the receiver queues a claimed ticket's events for its builders, and an item without it queues them for the task to judge, since #538, under PRD #535. A held cursor's delivered record keeps the tickets a green deploy commented on, so a later turn still tells their roles, since #564, under PRD #535. A PR review's verdict may hold an owed message, which the next review fire at the same head and body sends, since #589. A session the sign-off sweep told it was held keeps an item, so it is told once, since #594.
