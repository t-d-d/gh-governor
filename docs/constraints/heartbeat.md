# The heartbeat
Relevance: The heartbeat issue governor writes each fire into, or a line on it: dispatch/heartbeat.mjs, the config file's `heartbeat` section
Decision: Governor writes only into the heartbeat issue the repo names, under its own marker, and a line's time moves only on the fire that line reports.

Why: The heartbeat is how an operator sees that pickup and each periodic
still run. A line kept fresh by an unrelated fire would hide one that had
stopped, and a wrong issue number must never overwrite a ticket.

## Rules

- A file turning the heartbeat on names one heartbeat issue,
  `heartbeat: { issue }`. Governor writes only into a body already carrying
  `<!-- governor:heartbeat -->`; otherwise it logs an error naming the repo
  and issue, and writes nothing.
- Under that marker governor keeps its own block (`stampHeartbeat`). The body
  outside the block keeps its owner's words.
- A line's fire time changes only on the fire that line reports: pickup's on
  the bare schedule fire's sweep, a periodic's on its own fire. The sign-off
  sweep may mark a line's session signed off, but never moves its time.
- Where the file turns `sessionRules` on, the bare schedule fire checks the
  repo's session rules block on its default branch, and a missing or old
  block sets a line on the heartbeat. None of it stops the repo being
  served, fails the turn, or pages anyone.

## Examples

- `fitness: the heartbeat writes only the issue the repo names, on the
  schedule fire (heartbeat.md)` and `fitness: every fire is recorded on the
  governor heartbeat, and only by the fire it reports (heartbeat.md)`.

## Do not

- Do not write into a heartbeat issue that lacks the marker: a wrong number
  in the file would overwrite a ticket.
- Do not move a line's fire time on any fire but the one it reports: a
  label, a merge or a sign-off would keep a line fresh while the thing it
  reports had stopped.
- Do not page on a missing session rules block: a served repo's own file is
  the repo's business, and a page would wake the operator over it.

History: Split out of the dispatcher repos file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. The heartbeat records every fire, one line each under governor's own marker, since #21, under PRD #17. The bare schedule fire checks each served repo's session rules block and keeps a line on the heartbeat while it is missing or old since #611, under PRD #599.
