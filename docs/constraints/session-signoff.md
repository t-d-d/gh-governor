# Session sign-off
Relevance: Deciding a session signed off or archiving it: scripts/lib/session-{signoff,branch}.mjs, the sweep in dispatch/turn.mjs, or a new sign-off signal
Decision: Whether a session signed off is read from its own events over the sessions API; no session writes a sign-off record for governor.

Why: A served repo may have no hook and no writer credential, and a record
nothing withdraws goes stale when a prompt follows the sign-off. The
session's own last reply is current and needs nothing in the repo.

## Rules

- The sweep's candidates are the login's idle, unarchived sessions in a
  served repo, the repo read from the list row's `config`
  (`sources[].url`, `outcomes[].git_info.repo`: `reposOf`), as the deployed
  list answers it. The list and record answer no `session_context`: the
  account tools' `session_context` reshapes these fields. A turn that names
  a repo sweeps that repo's sessions; the bare schedule fire sweeps every
  served repo's.
- A session's reply is read from
  `GET /v1/code/sessions/cse_<id>/events?limit=100&sort_order=desc`:
  `{data, next_cursor}`, the newest events, newest first, each `{event_id,
  event_type, payload, created_at, …}`. Where the reply is not on the events
  read, the next read adds `&cursor=<next_cursor>` of the last page, as the
  CLI pages it, up to `SIGNOFF_PAGES` pages, whose reads fit the sweep's
  window. A page with no `next_cursor`, or an empty page, is the start of
  the session. The endpoint ignores `before_id`; a page that repeats an
  event or holds a newer one is unreadable. The reply is the newest
  `result` payload's `result`. Where that is empty (every Remote Control
  session) or absent (an error result), it is the nearest assistant text
  before it in the same turn. A turn begins after the previous `result` or
  at a person's prompt (a user message that is not tool results). A
  person's prompt newer than the newest `result` reads as not signed off.
  This is `readReply`.
- The sign-off rule: the reply's last line, emphasis stripped, starts
  `Signing off` followed by `.`, `:`, `!` or the end of the line
  (`signsOff`). A served repo's sessions are told the line by the standing
  line governor writes under each message, or by the repo's own `signOff`
  prompt.
- The archive reads the session's row again after its events, and archives
  only an idle one. A session the turn messaged is decided only by a
  `result` newer than the message.
- A read that fails, or an answer outside the schema, archives nothing.
- The reply's text is never logged: a sweep line carries the session id and
  the decision.

## Examples

- `sweepSignoffs` and `awaitReplies` in scripts/lib/session-signoff.mjs,
  wired by `run` in dispatch/turn.mjs with `repos` the served repos: the
  fire's, or every one for the bare schedule fire (dispatch/repos.mjs).

## Do not

- Do not archive on the row's `status_bucket` or `post_turn_summary`: a
  summariser's judgement, not the session's declaration. A Remote Control
  session reads `SESSION_STATUS_BUCKET_COMPLETED` without having signed off.
- Do not base the sweep's decision on a session archiving itself: the
  claude.ai connectors reach only a turn a person typed.
- Do not ask a served repo for a sign-off hook, or a record a session
  writes: each repo then needs the hook and a credential, and the record
  goes stale.

History: Extracted into this repo, October 2026. Earlier decisions are in a private repo.
