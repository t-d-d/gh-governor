# GitHub calls
Relevance: Sending a call to GitHub, or resending one that failed: scripts/lib/github-app.mjs, dispatch/turn.mjs
Decision: Governor resends a GitHub call only where it is safe to repeat and the answer shows nothing changed, and a turn stops resending once one call spent its sends.

Why: A write resent after it landed acts twice: two comments, two claims, two
sessions. A turn that keeps resending through an outage runs past its
deadline and leaves its work half done.

## Rules

- Governor resends a call that is safe to repeat, a read or a write the
  caller marks so, only when the answer shows nothing changed: a dropped
  connection, a 500, 502, 503 or 504, or a rate limit whose `retry-after` is
  short. It sends a call a few times at most (`request`,
  scripts/lib/github-app.mjs).
- It never resends any other answer: a 404, a 422, a 403 for a missing
  permission, a rate limit that asks for a longer wait or names none, or a
  write not marked safe to repeat, which may have landed.
- Once one call has spent its sends on server errors or dropped connections,
  every later GitHub call in the same turn is sent once. A turn makes one
  switch (`turnResends`) and hands it to every GitHub client it builds
  (`realDeps`, dispatch/turn.mjs).

## Examples

- `fitness: a turn's GitHub clients share one resend switch
  (github-calls.md)`, and the resend cases in test/scripts/github-app.test.ts.

## Do not

- Do not resend a write the caller has not marked safe to repeat: it may
  have landed, and a second one acts twice.
- Do not build a GitHub client in a turn without the turn's switch: it would
  keep resending after the turn has stopped.

History: Split out of the dispatcher repos file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. Governor resends a safe call on a server error or a short rate limit, as it did a dropped connection, since #575. Once one call has spent its sends, every later call in the turn is sent once, since #576.
