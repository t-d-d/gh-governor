# Trust
Relevance: Whose text or act governor trusts, the config file's `trust` section, or what makes a ready label count: dispatch/{trust,start,uncounted}.mjs, dispatch/webhook/{subscribe,fire}.mjs, scripts/lib/ready-work.mjs
Decision: Every route that sets work going or reaches a session answers to one of the repo's `trust` lists, and a missing association is `NONE`.

Why: Anyone may open an issue or comment on a public repo, and session links
are public on every PR a session wrote. A session that takes a stranger's
text as its task works with push access on the operator's login.

## Rules

- The `trust` section's lists take GitHub's `author_association` values and
  `BOT`. Each has a default of `OWNER`, `MEMBER` and `COLLABORATOR`, `relay`
  adding `BOT`:
  - `auto`: whose issues and PRs governor sets going by itself, with no
    person choosing the ticket (`autoOf`).
  - `task`: whose issue or PR may become work when a person sets it going,
    by pickup or a summons (`taskOf`).
  - `start`: who may set work going, by readying a ticket or writing a
    summons (`startOf`). A repo may narrow it, never widen it.
  - `relay`: whose text may reach a running session (`relayOf`).
  - `review`: whose PRs and issues governor's reviews read (`reviewOf`).
- The lists form a chain, `auto` ⊆ `task` ⊆ `relay` ⊆ `review`, `BOT` left
  aside. A file that sets two lists breaking it is invalid. An unset list is
  narrowed to fit the lists set above it, never widened.
- No route keeps its own rule. A route that reads an author judges it by its
  list, and an association not read is `NONE`. Governor's own App passes
  every list, and `BOT` never stands for it.
- A session link or a `governor:subscribe` line in a body names a session
  only where the body's author is in `trust.relay`, through the one gate
  `relayedBody` (dispatch/webhook/subscribe.mjs), wherever governor routes
  by it.
- The receiver drops a message only where the refusal is silent; the task
  judges every message again from the file before it sends.
- A ready label counts only when its latest `labeled` event was by someone
  in `trust.start`, or by governor's own App. A label a template, another
  bot or no event added does not count. A failed lookup of who added it
  counts it for nothing that turn.
- An uncounted or refused readying logs at warn, never error, and gets one
  comment under `<!-- governor:uncounted-ready -->`, governor's one refusal
  comment, posted whatever the switches say. A ticket only its own template,
  a bot or nobody readied gets no `trust.task` refusal.
- An issue review whose `by` reaches beyond `auto` names no ready label in
  any conclusion, or the file is invalid (issue-reviews.md).

## Examples

- The lists and their narrowing: `autoOf`, `taskOf`, `relayOf`, `reviewOf`
  and `narrowedLists` in dispatch/trust.mjs.
- Counting a ready label: `startRefused` in scripts/lib/ready-work.mjs and
  `judgeReady` in dispatch/start.mjs.
- The config check warns where a list reaches beyond the three
  (`trustExposures`).

## Do not

- Do not count a ready label because a ticket carries it: a stranger's issue
  template can add every ready label, and the session would take the
  stranger's issue body as its task.
- Do not count a ready label a bot other than governor's App added last on a
  stranger's ticket, nor on any ticket once `trust.start` is narrowed: a
  labelling workflow acts on rules, not on someone reading the ticket.
- Do not let `trust.start` hold anything beyond `OWNER`, `MEMBER` and
  `COLLABORATOR`: only someone with a say may set work going.
- Do not take a failed lookup of who readied or assigned a ticket for
  someone in `trust.start`: the act counts for nothing that turn.
- Do not let a missing association count as trusted: a fake or a lost field
  would then open the route to anyone.
- Do not read a session out of a body to route by it except through
  `relayedBody`: anyone can open an issue that ends in a session link.
- Do not post the `trust.task` refusal on a ticket only its own template, a
  bot or nobody readied: a stranger would then make governor write on every
  issue they open.
- Do not log an uncounted ready label at error: a stranger opening issues
  must not be able to page the operator.

History: Split out of the dispatcher repos file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. A ready label counts only where someone with a say added it since #380 and #392. The `trust` lists came in under PRD #396: `auto` in #418, `relay` in #419, `task` in #420, `start` in #421 and `review` in #422. An issue review whose `by` reaches beyond `auto` names no ready label since #428.
