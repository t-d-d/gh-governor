# Who hears an event
Relevance: A PR's owner, a ticket's roles, a message to a session, or a comment or marker governor writes: dispatch/{deliveries,roles,builders,told,take,editor}.mjs, dispatch/webhook/{mention,roles-text}.mjs
Decision: A PR's owner and a ticket's roles are each found by one lookup, and the turn that posts a governor comment tells the sessions that should hear it.

Why: Two lookups, or two turns deciding who hears one fact, can disagree, and
then a session misses a fact or hears it twice. A session that hears every
event in a loop spends the login with nobody watching.

## Rules

- A PR's owner is found by one lookup wherever governor looks for it
  (`ownerOf`, dispatch/deliveries.mjs).
- A ticket's roles, its spec owner and its builders, are found by one lookup
  wherever governor looks for them (`rolesOf`, dispatch/roles.mjs). Its
  builders are found by one lookup called from `rolesOf` alone (`buildersOf`,
  dispatch/builders.mjs). A read that fails fails the turn, and never reads
  as no builder.
- A ticket's spec owner is the session its body's owner link names. The body
  is the spec owner's: governor rewrites only the owner link, and no other
  part of a ticket's body.
- A comment governor posts on an issue or a PR is a record for people, and
  the relay sends it to nobody: the receiver drops every comment governor's
  App posts (`governorComment`, dispatch/webhook/mention.mjs). The turn that
  posts it decides, once, which sessions should hear it, and messages them
  itself.
- Governor writes and reads only `governor:` markers, and reads a marker that
  names a session, such as the dispatch marker, only from a comment
  governor's App posted. A marker of any other prefix, or in anyone else's
  comment, is text.
- Governor sends a session at most the stack's `MessageCeiling` messages
  about one issue or PR in a clock hour, and pages where a pair reaches it.
  Every message into a running session counts, through one check
  (`countAgainst`, dispatch/deliveries.mjs). A held send is no fault. A count
  that cannot be read or raised lets the send go. No repo switch turns the
  ceiling off.

## Examples

- `fitness: a ticket's roles are found one way (ticket-roles.md)` and
  `fitness: the receiver relays no comment governor's App posts
  (ticket-roles.md)`, the latter for every kind governor posts and for one
  not written yet.
- The role lines and each role's wording come from one function,
  `rolesText` in dispatch/webhook/roles-text.mjs.

## Do not

- Do not find a PR's owner or a ticket's roles with a lookup of your own: it
  will disagree with the one every other path uses.
- Do not relay a comment governor's App posts, and do not have the turn that
  posts one leave a session to the relay: two turns deciding who hears one
  fact can disagree.
- Do not read a marker of another prefix as governor's, nor a dispatch
  marker from a comment governor's App did not post: anyone who can comment
  could copy a marker with a later time and another session's link.
- Do not rewrite a ticket's body beyond its owner link: the spec is its
  owner's.
- Do not let a repo turn the message ceiling off: it is the guard against a
  loop that spends the login.

Judgment: that a new kind of governor comment comes with the posting turn's messages to the sessions that should hear it, no check sees: the fitness function holds only that the relay drops it.
History: Split out of the dispatcher repos file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. A ticket's builder is found by one lookup since #537, and a ticket's roles since #570, under PRD #535. A dispatch marker names a builder only in a comment governor's App posted since #546. A comment governor's App posts is relayed to nobody, and the posting turn messages the roles, since #565 and #566. A PR's owner is found by one lookup since #515. The message ceiling came in #602.
