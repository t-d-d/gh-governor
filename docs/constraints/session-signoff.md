# Session sign-off
Relevance: Deciding a session signed off or archiving it: scripts/lib/session-{signoff,branch}.mjs, the sweep in dispatch/turn.mjs, or a new sign-off signal
Decision: Whether a session signed off is read from its own events over the sessions API; no session writes a sign-off record for governor.

Why: A served repo may have no hook and no writer credential, and a record
nothing withdraws goes stale when a prompt follows the sign-off. The
session's own last reply is current and needs nothing in the repo.

## Rules

- The sweep's candidates are the login's idle, unarchived sessions in a
  served repo whose file turns the `signOff` switch on (dispatcher-repos.md),
  the repo read from the list row's `config` (`sources[].url`,
  `outcomes[].git_info.repo`: `reposOf`), as the deployed list answers it. The list and record answer no `session_context`: the
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
  prompt. With the switch off, the standing line leaves the ask out.
- With `sessionRules` on as well, ownership of an issue lapses when its
  owner is archived, and the ask waits only on what the session is doing:
  an open PR it owns, by body link or head branch; a claimed ticket no
  open PR closes whose newest dispatch marker names it; and an open issue
  it owns that carries a ready label or the claim label. An issue it owns
  with none of those does not hold the ask: the line lists it and says
  signing off gives it up. This narrows #535's rule that a spec owner
  stays held while any of its tickets is open. With `sessionRules` off,
  every open item that names the session holds the ask, as before.
- A session that owns an open PR in a served repo is not archived, whatever
  its reply says. Before it archives a signed-off session, the sweep finds
  the open PRs in the served repos the session's row names whose body names
  the session, from the open list the standing line reads (`openNaming`,
  under the repo's `trust.relay`). Where one is open, the session is held:
  the sweep logs `dispatch-signoff` with the decision `held` and the PRs'
  numbers, and a later sweep archives it once no open PR names it and its
  newest reply signs off. A read of the open list that fails archives
  nothing (`holds`).
- A message telling a session it was held goes once per session, and only
  where a repo the session names sets `signOff.heldMessage`. Governor puts
  the session's held record (dispatcher-state.md) before the send, only
  where none stands, and sends nothing where one stood or the put failed.
  Any later hold is logged only, so the session and the sweep cannot answer
  each other in a loop (`onHeld`).
- The default pickup prompt asks for a sign-off only where the session
  stopped at the check without raising a PR, and tells a session with an
  open PR that it stays open until governor asks it to sign off. A repo's
  own `pickup` prompt is sent as it is.
- Once it has archived sessions, the sweep ends the claim of each claimed
  ticket in a repo turning pickup on whose newest dispatch comment names
  one of them and that no open PR closes (dispatch/stopped.mjs): one
  comment under `governor:stopped <session>`, then the ready labels and the
  claim off. It never holds or archives a session for that ticket.
- The archive reads the session's row again after its events, and archives
  only an idle one. A session the turn messaged is decided only by a
  `result` newer than the message.
- A read that fails, or an answer outside the schema, archives nothing.
- The reply's text is never logged: a sweep line carries the session id and
  the decision.
- Reading candidates' events to find an unsigned post's author, whatever
  `sessionRules` says (dispatcher-repos.md, dispatch/author.mjs), follows the
  rules for reading a reply: the same events endpoint and paging, newest
  first, up to `AUTHOR_PAGES` pages, a page that repeats an event or holds
  a newer one unreadable, and a read that fails or leaves the schema
  decides nothing. The candidates are the login's live sessions in the
  post's repo (`reposOf`), updated at or after ten minutes before the
  post. The events' text is never logged: a `dispatch-author` line names
  sessions, counts and reasons that quote no event. Reading the spec
  owner's events, and then the other candidates', to find who made a body
  edit (dispatch/editor.mjs) follows the same rules, in windows anchored on
  the edit's time, and a `dispatch-editor` line quotes no event either.

## Examples

- `sweepSignoffs` and `awaitReplies` in scripts/lib/session-signoff.mjs,
  wired by `run` in dispatch/turn.mjs with `repos` the served repos whose
  file turns `signOff` on: the fire's, or every one for the bare schedule
  fire (dispatch/repos.mjs).

## Do not

- Do not archive on the row's `status_bucket` or `post_turn_summary`: a
  summariser's judgement, not the session's declaration. A Remote Control
  session reads `SESSION_STATUS_BUCKET_COMPLETED` without having signed off.
- Do not base the sweep's decision on a session archiving itself: the
  claude.ai connectors reach only a turn a person typed.
- Do not archive a signed-off session because the open list could not be
  read: a session archived with its PR open leaves the PR's next event to a
  fresh session with none of its context.
- Do not ask a served repo for a sign-off hook, or a record a session
  writes: each repo then needs the hook and a credential, and the record
  goes stale.

History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The sweep and the standing line's ask run only where the repo's file turns the `signOff` switch on since #278. A session that owns an open PR is held from the archive, and told so once where the repo's file asks, since #594. With `sessionRules` on, ownership of an issue lapses at its owner's archive, and the ask waits only on the session's open PRs, its builds and the issues it owns that carry a ready or claim label, narrowing #535, since #612, under PRD #599. Reading candidates' events to find an unsigned post's author follows the rules for reading a reply, and their text is never logged, since #616, under PRD #599. Reading them to find who made a body edit follows the same rules, since #617, under PRD #599. A session the sweep archives with its ticket claimed and no PR has that claim ended, since #527. Reading candidates' events for an unsigned post's author or a body edit's editor runs whatever `sessionRules` says since #674.
