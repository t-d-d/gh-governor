# Dispatcher repos
Relevance: The repo a fire or turn acts on, the owner list or a served repo's config file: dispatch/**, infra/governor.cfn.yml, scripts/{run-turn,point-app-webhook,lib/github-app}.mjs, or a new fire kind
Decision: Governor serves a repo only when an owner on its list installed its App there and the default branch carries a valid config file.

Why: A repo is onboarded by installing the App and merging a file, with no
deploy. The App is public, so anyone can install it, and every served repo
spends the one claude.ai login.

## Rules

- The owner list is the stack parameter `DispatchOwners` (`DISPATCH_OWNERS`,
  `ownersOf`), which the deploy reads from the `GOVERNOR_OWNERS` repository
  variable. It has no default. Changing it is a deploy.
- GitHub's events arrive through the App's own webhook, one URL for every
  installation. A hook fire arrives at the same receiver on its own path,
  `/hooks/<owner>/<repo>/<hook>`, signed with that hook's key instead of
  GitHub's secret (dispatch/webhook/hook.mjs). The receiver routes from the
  payload or the path and holds no token: the task reads the config file and
  its prompts, never the receiver or a fire. A hook fire carries the caller's
  text, never a prompt.
- A delivery or a signed hook for a repo whose owner is not on the list gets
  a 2xx, queues nothing, and is logged at info, never as an error: an
  outsider must not be able to page the operator.
- A label added to an issue queues a selection fire, whoever added it, a
  bot and governor's own App included, only if the repo's item in the hook
  table lists it as one of the repo's ready labels, or the receiver cannot
  read the item's ready labels (no item, one written before it held them, a
  malformed item, a failed read). A "blocked by" link removed from an issue
  (`issue_dependencies`, `blocked_by_removed`) queues the same selection
  fire for that issue, whoever removed it, only if the issue is the
  delivery's repo's, is open, and carries a label in the payload that the
  item lists, or any label where the receiver cannot read the item's ready
  labels; a link added queues nothing. The task writes the ready labels, as it
  read the file, each time it reads the repo's file (dispatcher-state.md).
  The receiver still holds no token and never reads the file. A new ready
  label needs no deploy: it reaches the item at the repo's next turn, and a
  ticket given it before then waits for its pickup sweep. The bare schedule
  fire sweeps a repo's ready tickets once the interval its file sets
  (`pickup.sweepHours`, dispatch/pickup.mjs), one hour when unset, has
  passed since that repo's last sweep. Onboarding needs no deploy.
- A launch that started nothing does not start its ticket again at once,
  whoever puts the ready labels back. Before governor puts back the labels
  the claim took off (`claimRemoves`), it puts the ticket's failed-launch
  record in the state table, expiring an hour later (dispatcher-state.md).
  A claim that fails part way puts it too, before its release.
  While it stands, the selection skips the ticket, takes no place under the
  cap for it, and logs `dispatch-pickup` with the reason
  (`failedLaunchesOf`, dispatch/pickup.mjs). The label webhook, the sweep
  and a blocker's ready row all read it. A missing record means pick up as
  before; a read that fails refuses the repo's pickup for the turn.
- The config file is `.github/governor.json` (`CONFIG_PATH`), read from the
  repo's default branch only, never from a PR head or another branch. With
  no file, the repo is not served, logged at info as `not served`, or at
  warn naming the file to add where the repo still has the older
  `.github/dispatch.json` (`OLD_CONFIG_PATH`), which governor no longer
  reads. A file
  that fails its schema (`configSchema`) skips the repo with an alarmed
  `dispatch-config-invalid` error naming the repo and the fault. A read that
  fails refuses that repo's part of the turn and is never taken for a
  missing file.
- The file has one rule for where a setting lives. `environment`, `trust`
  and `workflows` are the settings several features share, and `workflows`
  holds only `ci`. Every other top-level key is one feature's section
  (`SECTIONS`), holding every setting and prompt that feature reads. A
  section turns its feature on unless it sets `"enabled": false`; a feature
  with no settings is `{}`, and a feature with no section is off. A section
  that is off needs none of its required settings. A section's named
  entries are an object keyed by name, under a key beside `enabled`
  (`issueReviews.reviews`, `periodics.sessions`, `hooks.sessions`), and an
  entry does not set `name`; lists with no names stay arrays. A field
  holding text or `{ "file": "<path>" }` is `prompt`, and a section with
  more than one has `prompts`, keyed by kind with the feature's prefix
  dropped (`SECTION_PROMPTS`). The code reads the file into one shape
  (`toConfig`), so no feature reads the file's layout itself.
- The file names the repo's cloud environment, by name or ID, and pickup's
  section names its ready labels, its claim label and the labels that keep
  a ticket out (`pickup.exclude`, `type: prd` when unset). Those labels
  serve every feature whose code reads them (`LABEL_READERS`: `unblocked`,
  `waits`, `prReview`, `issueReviews`), so a file turning one of those on
  with no `pickup` section is invalid, and one with a `pickup` section needs
  `ready` and `claim` where pickup or one of them is on. That section may
  set `"enabled": false` to keep pickup itself off. The dispatcher claims a ticket with that label
  before it launches its session, and creates the label in a repo that
  lacks it. The file holds no secret: a served repo may be public.
- What keeps a ticket out of the selection, the claim's second read and the
  `unblocked` row's ready reading is what `ticketStatus`
  (scripts/lib/ready-work.mjs) reads, and no other file combines those
  checks. Two read one check alone: the PR review's test 1
  (dispatch/checklist.mjs) reads `labelRow`, and wait end
  (dispatch/waits.mjs) reads `isWaiting`. The checks are the claim label,
  `pickup.exclude`, an open blocker, and the ticket's own `Blocked until: <YYYY-MM-DD>` line,
  when it is the body's first non-empty line, in any case, and the date is
  still to come (`isWaiting`, scripts/lib/ready-work.mjs). The wait ends at
  00:00 UTC on that date. Text after the date is a reason and changes
  nothing. A line holding no date governor can read holds the ticket too,
  logs at warn and gets one comment under `<!-- governor:wait-unreadable -->`,
  which governor reads the thread for before it writes another
  (dispatch/waits.mjs). In the `unblocked` row the line holds only a
  ticket whose labels read ready or not ready (`waitHolds`), which reads as
  blocked: a claimed ticket's session still hears its blocker close, and an
  excluded ticket still reads excluded. The line may instead wait
  `<N> days after #<issue> closes`, on an issue that must be a declared
  blocker of the ticket. It holds the
  ticket until governor rewrites it, once, into its date at the issue's
  completed close; any other close leaves the line and comments once under
  `<!-- governor:wait-not-planned #<issue> -->`. A line governor cannot
  settle gets one comment under `<!-- governor:wait-relative #<issue> -->`,
  naming the issue the line waits on, so a line moved to another issue is
  told again.
- Governor writes a ticket's owner link (`sessionNamedIn`,
  dispatch/webhook/subscribe.mjs) in one more place: it writes a new spec
  session's link as the owner link whenever it starts
  one for a ticket, as the owner's fallback or because the body names none,
  and for the session a summons on an issue starts where no role on it is
  live (below) (`nameSpecSession`, dispatch/deliveries.mjs). The body's owner link is the
  ticket's spec session: a later close or ended wait reaches the session it
  names, and no timer decides it. A spec session posts no dispatch marker.
  Only a change of builder posts one, naming the builder (below), and the claim label,
  not the marker's age, keeps the ticket out of the selection. A write that
  fails logs `dispatch-spec-owner` at error. Governor makes no other
  rewrite in a ticket's body.
- Governor posts its dispatch comment on a ticket at each change of
  builder: pickup's launch; a takeover of a PR that closes the ticket,
  where governor starts a session on it or writes a branch session's link
  into a body that named another session (`announce`,
  dispatch/deliveries.mjs), posted on each issue the PR closes, open or
  closed, and never on a PR, which it reads each number to tell; and a PR by a session other than the ticket's
  builder, opened, reopened or edited to close a claimed open ticket, which
  queues a `closingPr` fire under `subscribeMessages` (`planClosingPr`,
  dispatch/ticket-fire.mjs), which reads the PR once. The receiver and
  `closedBy` read closing keywords by one grammar
  (dispatch/webhook/closing.mjs). The comment names the new builder, and, where
  it replaced one the newest dispatch comment or the owner link found, the
  builder it displaced. Where another open PR closes the ticket, nobody is
  displaced. The turn that posts the comment tells the spec owner, and
  the displaced builder where that is not the new one, which is asked to
  stop and sign off unless it knows a reason not to (`tellBuilderChange`,
  dispatch/told.mjs): pickup's launch under `pickup`, a takeover where
  the owner lookup runs, and a `closingPr` fire under `subscribeMessages`.
  It never tells the builder it names. A ready ticket picked up on its
  blocker's close, with `unblocked` on, tells its spec owner in the one
  notice of that close, which names the new builder, and not again for
  the comment. Only a comment governor's App posted counts in finding the
  builder a PR displaces: a marker in anyone else's comment displaces
  nobody.
- A comment governor posts on an issue or a PR is a record for people,
  and the relay sends it to nobody: the receiver drops every comment
  governor's App posts, read from the payload's `performed_via_github_app`
  (`governorComment`, dispatch/webhook/mention.mjs). The turn that posts
  it decides, once, which sessions should hear it, and messages them
  itself: an issue's roles, under the switch of the feature that posts it
  (dispatch/told.mjs), or a PR's owner. A
  blocker's not-planned close, and a relative line's comment on a close
  that was not completed, ask a claimed ticket's builders in the comment's
  words and send its spec owner a notice, and tell an unclaimed ticket's
  spec owner the comment. A relative line is settled whatever the switches
  say, so where no row acts on the close its comment still tells the spec
  owner. A `Blocked until:` line governor cannot read, a
  relative line it cannot settle, and a wait-ticket link with no line tell
  the spec owner once, when the comment is posted. An issue review's
  comment tells the spec owner. An ended wait's spec owner hears it once,
  in the schedule fire's message, or, with `unblocked` off, in the comment
  the schedule fire tells it; a deploy as dispatcher-workflows.md says. The wait ticket's full comment, an issue review's loop guard and
  a trust refusal, on an issue or a PR, are for people, and tell no
  session. A send that fails is logged at error, and the comment stands.
  On a PR, the PR review's turn messages the PR's owner itself, from its
  own verdict, under `prMessages` (dispatcher-review.md); a red CI run, a
  deploy and a conflict post nothing on the PR and message the owner
  directly.
- A PR's owner is found by one lookup wherever governor looks for it, for
  a remark, a CI or deploy message, a conflict, a close, a summons and the
  standing line (`ownerOf`, dispatch/deliveries.mjs). First, the session
  the PR body links, read through `relayedBody`, if it is live: a send it
  takes, even where a newer session holds the branch. Otherwise, the most
  recently updated live session holding the PR's head branch, local or
  cloud, by the sessions API's `updated_at`, neither kind preferred. A
  linked session that answers archived hands the message to that session.
  Governor writes the link of a session found on the branch into the PR
  body, so later events route by it. Only where both steps find nobody
  does a fresh session start, and only for an event that started one
  before. A branch lookup that fails starts nothing beside a session that
  may be live. Commit trailers are not read for this.
- A ticket's roles are found one way wherever governor looks for them, as
  a PR's owner is (`rolesOf`, dispatch/roles.mjs): by a ticket fire, a
  change of builder, a summons, a blocker's close, an ended wait, a
  deploy, and a comment governor posts on the ticket. It returns each
  session that holds a role once, with its roles (spec owner, builder, or
  both), the PRs it owns as a builder, and whether the PR it was found
  through has merged. The spec owner is the session the body's owner link
  names, read through `relayedBody`, with a ticket governor's App filed let
  in as the receiver lets it in (`ticketAuthor`, dispatch/trust.mjs). The
  builders are found by the lookup below, on a claimed ticket only. A
  caller that has read the ticket hands in the row, which is not read
  again. Every send carries the PRs the session owns, so a spec owner that
  also builds through its open PR, refusing as archived, hands the message
  to the live session on that PR's head branch, on every path. The "Roles
  on #N" lines and each role's wording come from one function
  (`rolesText`). A message to a builder whose PR has merged says so, and
  that it acts on the message only where it calls for new work; such a
  builder still hears the ticket's events, since a repo may keep a ticket
  open past a merge. The roles, a blocker's close, an ended wait, the
  issue reviews and a periodic's issue counts and listings judge a ticket
  governor's App filed as the receiver does.
- A ticket's builder is found by one lookup, called from `rolesOf` alone
  (`buildersOf`, dispatch/builders.mjs). First, the owner, as `ownerOf`
  finds it, of each open PR whose body closes the ticket by GitHub's
  closing keywords, taken from the open list the standing line reads
  (`openClosing`, scripts/lib/github-app.mjs). Where two open PRs close it,
  both owners are builders. Otherwise, where a merge closed the ticket, that
  PR's owner, found with `closure`. Otherwise, the session the newest
  dispatch marker names, read over the whole thread, however long, and only
  from comments governor's App posted (`ours`): anyone who can comment could
  copy a marker with a later time and another session's link. A newest
  dispatch comment that names no session, where pickup's launch printed
  none, leaves the builder unknown: the lookup stops there with no
  builder, and never goes on to the owner link, so no spec owner is named
  as displaced or messaged as a builder. Otherwise,
  on a claimed ticket, the session the body's owner link names, read through
  `relayedBody`. Otherwise, none. A read that fails fails the turn, and
  never reads as no builder. A blocker's close on a claimed ticket asks
  every builder this lookup finds, under `unblocked`.
- A blocker's close on a ready or claimed ticket asks one role and sends
  the spec owner, the session the body's owner link names through
  `relayedBody`, a notice under `unblocked` (`unblockedNotice`,
  dispatch/unblocked.mjs). On a ready ticket the builder pickup starts is
  asked, and the notice, sent once the launch started a session, names
  it. On a claimed ticket the builders are asked, and the notice names
  those that were. A notice says it asks for nothing and names the role
  that was asked. A spec owner that is also a builder gets the ask alone.
  A builder that refuses as archived leaves the role vacant: its ask goes
  to nobody, `dispatch-unblocked` logs it, and it never falls back to the
  spec owner. A not-ready ticket's spec owner is asked to rewrite the
  spec, as before.
- A claimed ticket's events reach its builders as well as its spec owner,
  the session its body's owner link names. A comment, a close and a reopen
  of an issue carrying the claim label go out as one `ticket` fire, under
  `subscribeMessages` (dispatch/ticket-fire.mjs). The receiver queues it in
  place of the spec owner's own message, and the task finds the builders by
  the lookup above. Each message names the spec owner and the builders, and
  says which role the recipient holds. A message to a builder says it
  builds the ticket and does not edit its body. A session never hears its
  own signed post. A builder whose PR's merge closed the ticket hears the
  close through its PR, and not again from the ticket. A comment
  governor's App posts is no ticket fire: the turn that posts it tells the
  roles (above). On an unclaimed ticket the spec owner hears what it did
  before, and the task reads nothing more from GitHub. A builder's standing line counts an open
  claimed ticket whose newest dispatch marker names it and that no open PR
  closes, so it is not asked to sign off before its PR exists.
- A ticket's body edit reaches both roles. An `issues` `edited` delivery
  that changes the body queues the spec owner's message, under
  `subscribeMessages`, and on a claimed ticket a `ticket` fire with the
  event `edit` in its place, settled by the claim label as a comment is.
  The delivery names only a login and sessions edit as the operator's, so
  the spec owner's message says the edit may be its own and asks it to
  read the body again before it next edits it. A builder's message says
  the spec changed, and to build against the body as it now reads. A
  title-only edit, and an edit whose sender is a bot, governor's own App
  included, reach neither role.
- Pickup starts a ticket only where its author's `author_association` is
  one `trust.task` lists (`authorPicked`, scripts/lib/ready-work.mjs;
  `byOf`, dispatch/pickup.mjs). An association not read is `NONE`. The
  selection (`planSchedule`, scripts/lib/dispatch-router.mjs) checks it on
  the ticket's row, before any other read, so such a ticket holds no place
  under the cap, and the claim's second read (dispatch/launch-plan.mjs)
  checks it again. Such a ticket is skipped, logged at info, and gets the
  refusal comment where a person readied it (`reportUntasked`,
  dispatch/uncounted.mjs).
- The file may carry a `trust` section (dispatch/trust.mjs), whose lists
  take GitHub's `author_association` values and `BOT`, which stands for any
  account GitHub marks as a bot (a `[bot]` login, or a user of type `Bot`).
  `trust.auto` is whose issues and PRs governor sets going by itself, with
  no person choosing the ticket (`autoOf`), `OWNER`, `MEMBER` and
  `COLLABORATOR` when unset (`AUTO`). Four routes and one config rule read
  it: the spec session or owner message after a blocker's close
  (dispatch/unblocked-fire.mjs) or an ended wait (`endedWaits`,
  dispatch/waits.mjs), a periodic's counts and listings of issues opened
  and closed (`windowOf`, dispatch/periodics.mjs), and the conflicts
  check's message and fallback session (`checkConflicts`,
  dispatch/conflicts.mjs). A merge a periodic counts is not judged. An
  author it does not let in gets nothing from these routes, logged at
  info; an ended wait's comment still goes. The schema refuses `BOT` in
  `auto`. The rule: an issue review whose `by`, narrowed by `trust.review`
  as `reviewOf` reads it, reaches beyond `auto`, read and narrowed as
  `autoOf` reads it, names no ready label (`pickup.ready`)
  in any conclusion, or the file is invalid (`configSchema`,
  dispatch/repo-config.mjs). It reads no `trust.task`. Governor's own
  config read refuses such a file, and the config check with it: a
  review readying a stranger's ticket would be governor setting work
  going by itself. The file is also invalid where one label appears
  under two conclusions of one review, or in two reviews' conclusions, or
  where a conclusion names a label a `byLabel` entry matches on, a label the
  same review's `when.labels` or `when.exclude` names, or `pickup.claim`,
  or a label that does not start with the review's name, a colon and a space, in
  any case (dispatcher-review.md). Each rule reads a review's `conclusions` with every `byLabel` entry's.
- `trust.task` is whose issue or PR may become work when a person sets it
  going (`taskOf`), `OWNER`, `MEMBER` and `COLLABORATOR` when unset
  (`PICKUP_BY`). Two routes read it: pickup, above, and a summons, which
  starts a session only where the author of the issue or PR it is on is in
  it. The receiver still drops a summons whose writer is outside the three,
  silently, and reads no `task`: a summons it would refuse for `task` comes
  from a writer with a say, who is told why. The summons fire names the
  issue or PR (`on`) and its author's kind (`author`), none for governor's
  own App, and the task refuses one the file's list leaves out
  (dispatch/dispatch-fire.mjs), at info. A summons on a PR a live session
  owns (below) reads no `trust.task`: with `prMessages` on, it goes to
  that session, judged by `trust.relay`, the session's link goes into the
  PR body, and no fresh session starts. A summons on an issue, an
  `@claude` remark or the ticket assigned to the summons account, reads no
  `trust.task` either where the ticket's spec owner or any of its builders
  is live: the receiver carries the ticket's state, labels and spec owner
  on the fire (`ticket`), read from the payload as for a ticket fire, and
  the task sends each role a notice, the spec owner and, on a claimed
  ticket, each builder the one lookup finds. A role that takes it starts
  nothing; the roles hear the remark itself as any remark on the ticket,
  or, where `subscribeMessages` is off, in the notice.
  Whether a role is live is learned by sending: one that refuses as
  archived leaves its role vacant. A writer `trust.relay` leaves out
  reaches no role, and nothing starts beside a role the ticket names. A
  builder lookup or a send that fails without a refusal starts nothing
  and fails the turn. `trust.task` judges a summons only where nobody
  owns the PR, or no role on the issue takes it, and the session that
  starts on an issue is its spec owner, written into the body as the
  owner link. A summons fire queued before the receiver named the ticket
  is judged as before. The schema refuses `BOT` in it, and refuses the
  older `pickup.by`.
- `trust.start` is who may set work going (`startOf`), `OWNER`, `MEMBER`
  and `COLLABORATOR` when unset (`START`). The schema refuses any other
  value, `BOT` among them, and an empty list: a repo may narrow it, never
  widen it. It sits outside the chain below. A ready label counts only
  when its latest add was by someone in it, or by governor's App (below).
  A summons starts a session only when its writer is in it: the receiver
  keeps the three as the ceiling, the fire carries the writer's
  association (`writer`), or, for an issue assigned to the summons
  account, the assigner's login (`assigner`), and the task judges it
  (dispatch/dispatch-fire.mjs) before anything else: a summons it refuses
  reaches no session, even where a live session owns the PR. At the
  default nothing is looked up.
  Where the file narrows it, governor looks a ready label's adder or an
  assigner up (`startKinds`, dispatch/start.mjs): the repo owner's login
  is `OWNER`, anyone else on a user's repo is `COLLABORATOR`, and on an
  org's repo the repo's outside-collaborator list tells `COLLABORATOR`
  from `MEMBER`, read with the App's `metadata` permission. A lookup that
  fails counts the act for nothing that turn, logged at warn, with no
  comment. A refusal for `start` logs at info and gets the one refusal
  comment.
- `trust.relay` is whose text may reach a session that is already running
  (`relayOf`), `OWNER`, `MEMBER`, `COLLABORATOR` and `BOT` when unset
  (`RELAY`, dispatch/webhook/fire.mjs). A comment or review reaches a
  session only where its author is in it. An event with no text, a label,
  a close, a reopen or a push, is judged by the author of the issue or PR
  it is on, since the payload carries no association for its sender. A
  session link or a `governor:subscribe` line in an issue's or PR's body
  names a session only where the body's author is in it, through the one
  gate `relayedBody` (dispatch/webhook/subscribe.mjs), wherever governor
  routes by it: the receiver, a message to a PR's owner and the owner
  found by head branch, CI and deploy messages, and the standing line.
  Governor's own App passes every list (`lets`, `own`), and `BOT` never
  stands for it. The receiver judges by the repo's hook-table item
  (dispatcher-state.md) and drops a message only where the refusal is
  silent: an author outside the three that the item's list, or the
  default where it has none or cannot be read, leaves out. Each message
  fire names the values it was judged by (`authors`), and the task
  refuses one the file's list leaves out, at info, before it sends.
- `trust.review` is whose PRs governor's PR review reads (`reviewOf`),
  `OWNER`, `MEMBER` and `COLLABORATOR` when unset (`REVIEW`). A PR whose
  author it leaves out is not read and gets a `neutral` check
  (dispatcher-review.md); Dependabot's PRs are read by the Dependabot list
  whatever it says. The receiver queues every review fire and the task
  judges the author: the refusal posts a check, so it is not silent. It
  may hold `BOT`. The issue reviews read a ticket only where its author is
  in it as well as in the review's own `by` (dispatch/issue-review.mjs);
  the receiver queues the `issueReview` fire whoever opened the issue,
  and the task judges the author.
- The lists form a chain, `auto` ⊆ `task` ⊆ `relay` ⊆ `review`, `BOT` left
  aside. Where the file sets two lists that break the chain, it is invalid.
  Where it leaves a list unset, that list is narrowed to fit the lists
  above it the file sets, never widened (`autoOf`, `taskOf`, `relayOf`,
  `narrowedLists`); an unset `relay` keeps `BOT`, and `review`, with
  nothing above it, is never narrowed. The config check warns, under
  its own title and wording, where a list the file sets reaches beyond
  the three (`trustExposures`), `BOT` in a `relay` among them, and notes
  each unset list it narrowed.
- A ready label counts only when its latest `labeled` event was by
  someone in the repo's `trust.start`, or by governor's own App
  (`postedByApp`); one a bot, a person `start` leaves out, or no event
  names does not count (`startRefused`, scripts/lib/ready-work.mjs;
  `judgeReady`, dispatch/start.mjs). Anyone may open an issue on a public
  repo, an issue template's `labels:` field adds its labels whoever opens
  it, and a labelling workflow or another App adds labels by rule. At the
  default `start` the events are read only where the ticket's author is
  not an owner, member or collaborator (`readsAdders`), and there a label
  the author added counts for nothing, as before `trust.start`. Once
  a repo narrows `start`, the events are read on every ready ticket, and
  a label no event names yet on a ticket whose author has a say counts
  for nothing that turn, logged at warn with no comment, since its event
  most likely lags the label.
  The rule sits beside `trust.task` and does not replace it: under the
  default `task` it decides only whether a stranger's ticket gets the
  refusal comment, and once a repo widens `task` it is what keeps
  anything but a person from readying a stranger's ticket. The selection
  checks it before the cap counts a ticket, so such a ticket holds no
  place under the cap, and the claim's second read checks it again after
  `ticketStatus`. The label webhook, the sweep and a blocker's ready row
  all pass through both. A ticket a template, a bot or no event readied
  is skipped, logged on
  `dispatch-pickup` at warn, never error, naming the labels and who added
  each, and gets one comment under `<!-- governor:uncounted-ready -->`,
  which governor reads the thread for before it writes another
  (dispatch/uncounted.mjs), whatever the switches say, since it reports a
  fault. That marker is governor's one refusal comment: a ticket
  `trust.task` refuses gets its comment under it too, so a ticket hears
  of a refusal once, whichever reason it gives. Where both lists refuse a
  readied ticket, `start` is judged first, as on a summons, and the ticket
  gets the `start` comment: restating the work in a ticket of one's own
  would be refused for the same act. An adder governor could not look up
  gets no comment that turn. It is picked up once someone with triage access takes the label
  off and puts it back: adding a label the ticket already carries records
  no event. A label the dispatcher puts back after a failed launch counts.
- The config check (checker/config-check.mjs) fails a pull request where
  an issue template names a ready label: an issue form's `labels:`, or a
  Markdown template's front matter `labels:`, under
  `.github/ISSUE_TEMPLATE/`, or a single `ISSUE_TEMPLATE.md` at the root,
  in `.github/` or in `docs/`. It does not read `trust.task`: readying is a
  decision about one ticket, whoever opened it.
- Every feature governor adds is a switch, off unless the file turns it on,
  and a turn refuses a fire kind its repo's file does not turn on. The one
  exception is a ticket's own `Blocked until:` line, which is always
  honoured, with its comment on a line governor cannot read, and the
  rewrite or comment at the close a relative line waits on: a line a person
  wrote must never be silently ignored. The comment on a ticket whose ready
  labels do not count reports a fault too, and is posted whatever the
  switches say. The switches are
  pickup, summons, PR messages, subscribe messages, the red scheduled run,
  unblocked (what a blocker's close does to a ticket that is not ready to
  pick up), CI and deploy messages, branch-run messages, the
  conflicts check, deployed-label job fires, the PR review, the heartbeat,
  periodics, hooks, waits, sign-off and the session rules
  (`GENERIC_SWITCHES`), and the issue
  reviews (`SECTION_SWITCHES`). Each is its own section, on where the file
  has it and its `enabled` is not `false` (`turnsOn`), but deployed-label
  job fires, which are `deployMessages.deployedLabels`, on where the deploy
  messages are on and it is `true`. The issue reviews' `reviews` holds
  at least one review, each keyed by a name safe in a marker; an issue
  opened, reopened or with its body edited, or a label change a review
  names, queues its `issueReview` fire (dispatcher-review.md). `waits` adds only
  governor's actions when a ticket's wait ends, the comment and the spec
  session, the prompt line, and, where the file names a wait ticket
  (`waits: { issue }`), the link that shows a wait in its ticket's sidebar;
  the hold on a ticket's line needs none.
  `sessionRules` ends every launch's prompt with the three rules
  (dispatch/session-rules.mjs) in place of `SIGN_POSTS`, rule 1 being the
  signing rule; with it off the prompt ends with `SIGN_POSTS` as before.
  The config check, where the file turns it on, warns on a pull request
  whose `CLAUDE.md`, or the file `sessionRules.file` names, lacks the
  current block, and the bare schedule fire checks the same file on the
  default branch (the heartbeat rule below). A key the file no longer has is
  invalid like any unknown key: `features` and its retired
  `mergeHandoff` and `ticketReviews`, `labels`, `prompts` and its retired
  `mergeHandoff` and `mergeHandoffUnread`, `review`, `pickup.by`, and the
  heartbeat's own `marker`. What CI and a deploy are in a repo is
  dispatcher-workflows.md's, and the review's settings dispatcher-review.md's.
  The schema accepts no switch by repo.
- A fire that counts an event for the periodics (`counted`: a merge into the
  default branch, an issue opened or closed) has the repo's periodics
  checked after its own work, under the periodics switch, whatever its own
  kind's switch says. The check is the periodics switch's work, not the
  carrying fire's, as the sign-off sweep runs on every turn. An event that
  queues no other fire queues a `periodics` fire of its own.
- A file turning the heartbeat on names one heartbeat issue,
  `heartbeat: { issue }`, or is a schema fault. Governor writes only into a
  body already carrying `<!-- governor:heartbeat -->`; otherwise it logs an
  error naming the repo and issue, so a wrong number never overwrites a
  ticket. Under that marker it keeps its own block (`stampHeartbeat`,
  dispatch/heartbeat.mjs): one line for pickup and one per periodic, each
  saying when it last fired, the session, and whether that session signed
  off, the fire was held, or there was nothing to do. A periodic governor
  has read but not fired yet has a line from its baseline instead: the
  baseline's time, no session, and `not fired yet`. A baseline only adds a
  line where none exists, and never replaces one. A line's fire time
  changes only on the fire that line reports: pickup's on the bare schedule
  fire's sweep in which not every claim or launch failed, a periodic's on
  its own fire, whichever turn makes it. A held fire leaves it at the open
  run's start, and a fire whose launches all failed leaves it where it was. The sign-off sweep, on any turn,
  may mark a line's session signed off, but never moves its fire time.
  Where the file turns `sessionRules` on, the bare schedule fire reads
  `CLAUDE.md`, or the file `sessionRules.file` names, from the default
  branch, and a missing or old block logs `dispatch-session-rules` at warn,
  naming the repo, the file and which, and sets one session rules line in
  the block saying the same. A current block clears the line, and so does
  `sessionRules` turned off, at the next bare fire. Every write keeps the
  line, and a checker that does not know it skips it, as any line it does
  not know. A read that fails logs `dispatch-session-rules-unread` at warn
  and changes nothing, the line included. None of it stops the repo being
  served, fails the turn, or pages anyone. The
  body outside the block keeps its owner's words.
- The heartbeat's older shape, `heartbeat: { issue, marker }`, with its one
  `last-run:` line under the repo's own marker, is gone: the schema refuses
  a `marker`.
- Each message kind (`PROMPTS`, dispatch/prompts.mjs) has one prompt key,
  in the section of the feature that sends it (`PROMPT_KEYS`): `pickup`,
  `signOff`, `redScheduledRun`, `subscribeMessages` (`subscribed`) and
  `conflicts` each have a `prompt`; `unblocked.prompts` has `ready`,
  `spec`, `ownerSpec`, `claimed` and `notPlanned`; `waits.prompts` has
  `spec` and `ownerSpec`; `ciMessages.prompts` has `breaker`, `triage` and
  `bumpTriage`; `deployMessages.prompts` has `triage` (`prodTriage`),
  `green`, `greenMany`, `red` and `redMany`. Each key replaces the
  instruction in that kind of message, or the opening prompt of that kind of session. Every kind has a
  generic default, and a kind the file leaves out gets it. A key the schema
  does not know makes the file invalid (`dispatch-config-invalid`), so a
  typo pages rather than falling back quietly.
- A prompt replaces only the instruction. The dispatcher writes the facts
  itself: what happened, the PR or issue, the run and commit, the session's
  standing line. No repo can drop or reword them. A prompt may name a fact
  its kind has (`{pr}`), and the dispatcher writes it in.
- A periodic may list `connectors`: the claude.ai connectors its session
  needs, each by its name in the account's connector list, never an id or
  URL. One that names any starts as a run of its routine, with those
  connectors attached and no others (dispatch/routines.mjs); one that names
  none starts with `claude --cloud`. Governor keeps one routine per such
  periodic, named after the repo and the periodic, and updates it to the
  fire's prompt, environment, source and connectors before each fire, and
  fires it with `POST /v1/code/triggers/<id>/run`. The create and every
  update set the routine disabled, on a valid cron at least an hour apart
  that fires rarely (`ROUTINE_SCHEDULE`, once a year), so its own schedule
  never starts a run: governor alone decides when a periodic is due. A
  named connector the account has not connected starts nothing and writes
  no record, as an alarmed `dispatch-connector-missing` error naming the
  repo, the periodic and the connector.
- A launch that started nothing skips its repo for the rest of the fire
  (`dispatch-repo-skipped`) only when it went through `claude --cloud`: a
  failed CLI launch points at the repo's environment or the login, so the
  repo's next launch would fail the same way. A routine the routines API
  refuses, before the fire or on it, stops only its own periodic. It starts
  nothing, writes no record, and logs an alarmed `dispatch-routine-refused`
  error naming the repo and the periodic, and the repo's tickets and other
  periodics in the fire still go. A fire is refused when it answers a 4xx
  other than 408 and 429, or throws before its request is sent; any other
  failed fire may have started a run.
- A file turning hooks on lists at least one hook in `hooks.sessions`, or
  is a schema fault. Each hook is keyed by its name, safe in a URL path,
  and has a prompt
  and a `keyVersion`. A hook's key is derived from one stack secret, its
  repo, its name and that version, so the file holds no key and governor
  stores none. The task refuses a hook fire whose hook the file does not
  list, at warn, and one signed with another key version, as an alarmed
  `hook-key-stale` error (dispatch/hooks.mjs).
- Every prompt value, a section's `prompt` and each of its `prompts`, the
  PR review's `prompt`, each periodic's `prompt` and each hook's, and an issue review's `prompt`
  and each of its `byLabel` entries' `prompt`, is the
  text or `{ "file": "<path>" }`: a file in the repo, from its root, read
  from the default branch with the config file (`resolveFiles`). A missing
  or empty file, or one naming a fact its kind lacks, makes the config file
  invalid (`dispatch-config-invalid`, naming the key and path); a read that
  fails refuses the repo's part of the turn.
- Every fire names its repo, and nothing falls back to a default repo. The
  one exception is the bare EventBridge schedule fire: it names no repo,
  lists the App's installations on listed owners, keeps the repos whose
  file reads valid, and sweeps every served repo's sessions.
- Every repo governor acts on has passed the served check (`repoServed`,
  `servedRepos`).
- Each repo's tickets are judged by its own config and recorded on its own
  records: its labels, switches and prompts, its issues and comments.
- A turn calls GitHub only for its fire's repo, under a token minted for
  that repo, and may queue a fire that names another repo. An issue
  closing queues one `unblocked` fire for each open ticket it blocked, in
  every repo whose owner is listed, its own included, and starts nothing
  itself. The ticket's own repo's turn reads the ticket and acts on it
  under that repo's switches (`pickup` for a ready ticket, `unblocked` for
  the rest), so the closing turn needs no switch, and skips a fire for its
  own repo only where its file turns both off and the ticket's line does
  not wait on the close (dispatch/unblocked.mjs). With both off, the
  ticket's turn reads the ticket once, settles a relative line, and refuses.
- Governor writes and reads only `governor:` markers: the dispatch marker,
  the subscribe line, the review's marker, the heartbeat block's, the
  unreadable wait's, the ended wait's, the relative wait's two, the
  wait ticket's two, on a ticket linked with no line and on one the wait
  ticket had no room for, the unreadied ticket's, on a not-planned
  comment that says a ready label came off, the uncounted ready
  label's, each issue review's, `governor:issue-review`, which
  names the review, its loop guard's, `governor:issue-review-loop`,
  which names the review it stops, and the deploy comment's,
  `governor:deployed`, which names the target a shipping job first
  labelled a ticket with, and the session rules block's two,
  `governor:session-rules v<n>` and `governor:session-rules-end`, which
  only the config check and the bare schedule fire's check read, in the
  file `sessionRules` names. A marker
  of any other prefix is text.
- A record the state table keeps per served repo carries the repo in its
  key, under the prefix rule in dispatcher-state.md: the workflow cursors
  and their delivered records (`workflow#<repo>#<file>`), the conflicts
  records (`conflicts#<repo>`), each periodic's record
  (`periodic#<repo>`), each hook's last session (`hook#<repo>`), each
  repo's last pickup sweep (`pickup#<repo>`) and each waiting ticket's
  date (`wait#<repo>`) among them.
- Governor resends a GitHub call that is safe to repeat, a read or a write
  the caller marks so (the token mint is one), when the answer shows nothing
  changed: a dropped connection, a 500, 502, 503 or 504, or a rate limit
  whose `retry-after` is 10 seconds or less. It sends at most 3 times,
  pausing 1 and then 2 seconds, or the `retry-after` where GitHub gives one,
  and does not resend a server error whose `retry-after` asks for longer,
  and logs `dispatch-github-retry` at info for each resend
  (`request`, scripts/lib/github-app.mjs). It never resends any other answer:
  a 404, a 422, a 403 for a missing permission, a rate limit that asks for a
  longer wait or names none, or a write not marked safe to repeat, which may
  have landed. Each still fails with its status and `rateLimited`.
  Once one call has spent its 3 sends on server errors or dropped
  connections, every later GitHub call in the same turn is sent once, and the call that spent them logs
  `dispatch-github-resends-off` at warn. A turn makes one switch
  (`turnResends`) and hands it to every GitHub client it builds (`realDeps`,
  dispatch/turn.mjs).
- Governor sends a session at most the stack's `MessageCeiling` messages,
  20 by default, about one issue or PR, its subject, in a clock hour, and
  pages where a pair reaches it. Every message into a running session
  counts, of any kind: a relayed remark or event, a notice, an ask, a CI
  or deploy note, the PR review's message to a PR's owner. A launch's
  prompt does not. Every send goes through one check, `countAgainst`
  (dispatch/deliveries.mjs): a delivery's `send`, where each caller names
  its message's kind, and the sign-off sweep's held message, which counts
  after its held record is put, so a session held again is not counted
  again. A message about several subjects counts against each and is held
  where any is at the ceiling; one about none counts against the
  session's pair with no subject. A held send is no refusal and no fault:
  it starts nothing, drops no subscriber and does not fail the turn. The
  first held send of a pair in an hour logs `dispatch-message-capped` at
  error, with its counts by kind, which `governor-session-loop` pages on;
  later ones log `dispatch-message-held` at info. A count that cannot be
  read or raised lets the send go, logged at warn. No repo switch turns
  the ceiling off.

## Examples

- The owner gate: `routeEvent` in dispatch/webhook/route.mjs refuses an
  unlisted owner before routing; `handle` answers it 2xx.
- Which repos are served: `servedRepos` (the bare schedule fire) and
  `repoServed` (a fire naming its repo) in dispatch/repos.mjs, over
  `readConfig` in dispatch/repo-config.mjs. `DispatchConfigInvalidAlarm` in
  infra/governor.cfn.yml pages on the invalid file.
- The App's webhook: scripts/point-app-webhook.mjs sets its URL, content
  type and secret at deploy; the deploy's `app-events` check
  (scripts/conformance.mjs) reads back that its events cover `HOOK_EVENTS`.
- Prompts: `instruction` in dispatch/prompts.mjs, called by each text's
  builder; the red scheduled run's fire carries its facts and the task adds
  the instruction (`redRunPrompt`, dispatch/workflow.mjs).
- A hook: `handleHook` in dispatch/webhook/route.mjs checks the signature
  and queues the fire; `hookFor` in dispatch/hooks.mjs checks it against the
  file; `HookKeyStaleAlarm` in infra/governor.cfn.yml pages on a stale key.
- A full config file, every feature on: test/fixtures/factory/.github/governor.json.
- A blocker's close: `closingFires` and `ticketRow` in dispatch/unblocked.mjs;
  `fitness: a turn calls GitHub only for its fire's repo` covers a close
  that blocks another repo's ticket, and an `unblocked` fire.
- Governor's comments on an issue or a PR: `governorComment` in
  dispatch/webhook/mention.mjs drops them in the receiver, the posting
  turns tell an issue's roles through dispatch/told.mjs, and the PR review
  tells the PR's owner (`ownerMessage`, dispatch/review.mjs). `fitness: the
  receiver relays no comment governor's App posts (dispatcher-repos.md)`
  holds it for every kind governor posts, on an issue and on a PR, and for
  one not written yet.

## Do not

- Do not default a fire's repo: a stale or default repo acts on, and spends
  the login for, a repo the fire was not for.
- Do not judge another repo's ticket in the turn of the repo whose issue
  closed: that turn cannot read the other repo's config, and the
  installation-wide token would let it act there unchecked. Queue the
  ticket's repo a fire of its own.
- Do not read the config file from any ref but the default branch: a PR head
  is unreviewed, and anyone who can open a PR could turn features on.
- Do not put a secret in the config file: the repo may be public.
- Do not alarm on an unlisted owner's delivery or on a repo with no file:
  either lets someone outside the operator's accounts page the operator.
- Do not drop the owner check because the App's privacy seems to cover it:
  the App is public, so the owner list is the only guard on the login.
- Do not list served repos in a stack parameter or the state table:
  onboarding then needs a deploy, or a write the repo's reviewers cannot see.
- Do not register a repository webhook per repo: the App's webhook already
  reaches every installation.
- Do not point a default prompt at a repo's CLAUDE.md, its skills or its
  conventions: repos share none, and every message would send the session
  to look something up.
- Do not read a prompt file from any ref but the default branch, nor from a
  path outside the repo: either lets a PR or a link write the prompt.
- Do not take a template that rewrites the facts: a repo could drop the PR
  number or the standing line, and no test could pin what a message holds.
- Do not add a switch whose only job is to add or remove a sentence: that is
  a prompt.
- Do not move a heartbeat line's fire time on any fire but the one it
  reports, nor pickup's line or a `last-run:` line on any turn but the bare
  schedule fire's sweep: a label, a merge or a sign-off would keep a line
  fresh while the thing it reports had stopped.
- Do not read a marker of another prefix as governor's: a repo's text would
  then hold or redirect a dispatch.
- Do not count a ready label because a ticket carries it: a stranger's issue
  template can add every ready label, and the session would take the
  stranger's issue body as its task, with push access, on the operator's
  login.
- Do not count a ready label a bot other than governor's App added last on
  a stranger's ticket, nor on any ticket once `trust.start` is narrowed: a
  labelling workflow acts on rules, not on someone reading the ticket.
- Do not let `trust.start` hold anything beyond `OWNER`, `MEMBER` and
  `COLLABORATOR`: only someone with a say may set work going.
- Do not take a failed lookup of who readied or assigned a ticket for
  someone in `trust.start`: the label or the assignment counts for nothing
  that turn.
- Do not let a missing association count as trusted on a `trust` route: a
  fake or a lost field would then open the route to anyone. Read it as
  `NONE`.
- Do not read a session out of an issue's or PR's body to route by it
  except through `relayedBody`: session links are public on every PR a
  session wrote, and anyone can open an issue that ends in one.
- Do not post the `trust.task` refusal on a ticket only its own template, a
  bot or nobody readied: a stranger would then make governor write on
  every issue they open.
- Do not log an uncounted ready label at error: a stranger opening issues
  must not be able to page the operator.
- Do not leave a periodic's routine enabled, nor give it a cron the routines
  API refuses (one with no firing time, or less than an hour apart), nor
  attach every connector the account has: an enabled routine would fire
  outside governor's records, a refused cron starts no periodic at all, and
  a session would hold connectors its file never named.
- Do not relay a comment governor's App posts on an issue or a PR, and do
  not have the turn that posts one leave a session to the relay: two turns deciding
  who hears one fact can disagree, and a session misses it or hears it
  twice.

Judgment: that a new per-repo table record keys on its repo, and that a config file holds no secret, no check sees: a key is a string no schema reads, and a secret has no shape the schema can refuse. That a new kind of governor comment on an issue or a PR comes with the posting turn's messages to the sessions that should hear it, no check sees either: the fitness function holds only that the relay drops it.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The periodics switch joined the list in #18, under PRD #17. A counted event's periodic check runs under the periodics switch on any turn since #19, under PRD #17. The heartbeat records every fire, one line each under governor's own marker, since #21, under PRD #17. A ready label `SelectLabels` does not list waits for the repo's pickup sweep, at the interval its file sets, since #22, under PRD #17. The file names the labels that keep a ticket out, and no type label orders the selection, since #28. A hook fire arrives at the receiver on its own path, signed with its hook key, and the switch list gains hooks, since #55, under PRD #53. A turn may queue a fire naming another repo, a blocker's close is handled in each blocked ticket's own repo, and `unblocked` replaces the merge hand-off, since #72. A periodic's baseline adds its heartbeat line, in the `not fired yet` state, where it has none, since #52. A periodic may name the claude.ai connectors its session needs, and then starts as a run of its own routine, since #89. A routine the routines API refuses before the fire stops only its periodic, and only a failed `claude --cloud` launch skips its repo, since #91. The schedule fire runs hourly, and the sweep interval is one hour when the file sets none, since #190. The receiver judges a label against the repo's ready labels in its hook-table item, and `SelectLabels` is gone, since #180. A fire the routines API refuses with a 4xx other than 408 and 429, or that throws before its request is sent, is a refusal, since #148. A ticket's own `Blocked until:` line holds it whatever the file says, the one behaviour behind no switch, and joins what keeps a ticket out of the selection, since #186, under PRD #185. The `waits` switch, the ended wait's marker and the per-repo wait record joined in #187, under PRD #185. A relative line, rewritten once into its date at its blocker's close whatever the switches say, and its two markers, joined in #189, under PRD #185. The wait ticket's sidebar link and its two markers joined in #188, under PRD #185. The cannot-settle marker names the issue the line waits on since #234, under PRD #185. The unreadied ticket's marker joined in #208: a later close starts no spec session for that ticket until a person answers. In the `unblocked` row the line holds only a ticket ready or not ready by its labels, so a claimed ticket's session still hears its blocker close, since #212, under PRD #185. Sign-off joined the switch list in #278, off unless the file turns it on. A periodic's routine is kept disabled on a valid cron that fires once a year, since the routines API refuses a cron with no firing time, and governor still fires it with `/run`, since #373. A ready label counts only where someone with a say in the repo added it, so an outsider's issue template cannot make a ticket ready, since #380. Pickup starts only tickets whose author `pickup.by` lists, `OWNER`, `MEMBER` and `COLLABORATOR` by default; a ready label a bot other than governor's App added does not count; an uncounted ready label logs at warn and comments once under its own marker; and the config check fails an issue template that names a ready label, since #392. A repo's `trust.auto` decides whose issues and PRs governor sets going by itself, a spec session or owner message after a blocker's close or an ended wait, a periodic's issue counts and listings, and the conflicts check, in place of no check or the fixed set, since #418, under PRD #396. A repo's `trust.relay` decides whose comments and reviews reach a running session, and whose body's session link or subscribe line names a session, in place of the fixed set, and the lists form the chain `auto` ⊆ `task` ⊆ `relay`, since #419, under PRD #396. A repo's `trust.task` decides whose issue or PR pickup and a summons may start work on, `pickup.by` is a retired key read as it, and a refused readying or summons by someone with a say gets the one refusal comment under the uncounted-ready marker, since #420, under PRD #396. A repo's `trust.start` decides who may set work going, by readying a ticket or writing a summons; a narrowed one looks the adder or assigner up, and a refusal for it gets the same one comment, since #421, under PRD #396. A repo's `trust.review` decides whose PRs the PR review reads, in place of the fixed set, and tops the chain `auto` ⊆ `task` ⊆ `relay` ⊆ `review`, since #422, under PRD #396. The ticket reviews joined the switch list, with their `ticketReviews` list, their `ticketReview` fire and their `governor:ticket-review` marker, and read `trust.review`, since #426, under PRD #390. The loop guard's `governor:ticket-review-loop` marker joined in #427, under PRD #390. A ticket review whose `by` reaches beyond `trust.auto` names no ready label in its conclusions, and a conclusion label belongs to one conclusion of one review, since #428, under PRD #390. Governor writes a new spec session's link into a ticket's body as its owner link, a spec session posts no dispatch marker, and no dispatch marker's age holds a ticket from pickup or spec work, since #442. A message to an archived owner with no fallback leaves the owner link, so a ticket names the last session that owned it, since #447. A ticket review's `checklist` and each `types` entry's are prompt values, and the conclusion rules read each entry's `conclusions` with the review's and refuse a conclusion naming a type label, since #429, under PRD #390. The ready-label rule reads a review's `by` narrowed by `trust.review`, and a conclusion may not name a label its own review's `when` selects on or the claim label, since #449, under PRD #390. A readied ticket both `trust.task` and `trust.start` refuse gets the `start` comment, judged first as on a summons, since #437. A ready label queues a selection fire whoever added it, governor's own App included, and a ticket whose launch started nothing is held from pickup for an hour by its failed-launch record instead, since #391. A summons `trust.task` refuses on a PR whose body names no session goes to the live session on the PR's head branch, and is refused on the PR only where none takes it, since #435. A ticket review's conclusion labels start with the review's name, a colon and a space since #512, closing #448: a run removed a label a person also used, such as a `mode: human` hold. A PR's owner is the live session its body links, else the most recently updated live session, local or cloud, holding its head branch, written into the body once found; a summons `trust.start` lets in goes to a PR's live owner without reading `trust.task`, and one `trust.start` refuses reaches no session, since #515. A "blocked by" link removed from a ticket carrying a ready label queues its selection fire, as a ready label does, since #519. A shipping job comments once on each ticket it first labels `deployed: <target>`, under the `governor:deployed` marker, and the issue's owner hears the comment, since #518. Ticket reviews became issue reviews since #524: a review's text is its `prompt` and its per-label entries `byLabel`, the `issueReviews` section and its `enabled` turn the reviews on in place of a switch in `features`, `features.ticketReviews` is a retired key read as nothing, and the markers are `governor:issue-review` and `governor:issue-review-loop`. The config file is `.github/governor.json` since #525, one section per feature: a section turns its feature on unless it sets `"enabled": false`, `features` is gone, each setting and prompt sits in the section of the feature it serves, the periodics and hooks are keyed by name, pickup's labels serve the features that read them, and governor no longer reads `.github/dispatch.json`. A ticket's builder is found by one lookup, the owner of each open PR that closes it, else the merged PR's owner, else the newest dispatch marker's session, else a claimed ticket's owner link, and a blocker's close on a claimed ticket reaches every builder it finds, since #537, under PRD #535. A claimed ticket's comments, closes and reopens reach its builders as well as its spec owner, each told both roles, a builder's standing counts its claimed ticket, and governor's own comment at a blocker's close reaches a claimed ticket's builders once, since #538, under PRD #535. A ticket's body edit reaches its spec owner, told the edit may be its own, and on a claimed ticket its builders, told the spec changed, and a bot's edit reaches neither role, since #539, under PRD #535. A blocker's close on a ready or claimed ticket sends its spec owner a notice naming the builder asked, and a refused builder's ask goes to nobody in place of the owner link, since #542, under PRD #535. A dispatch marker names a builder only in a comment governor's App posted, since #546. Governor posts its dispatch comment at each change of builder, a takeover of a ticket's PR and a PR by another session that closes a claimed ticket, and relays it to the spec owner and to the builder it displaced, which is asked to stop and sign off, since #540, under PRD #535. An `@claude` remark on an issue, or the issue assigned to the summons account, starts nothing where its spec owner or a builder is live, each live role gets a notice, and where none is live the session that starts becomes the spec owner, written into the body as the owner link, since #541, under PRD #535. Governor's deploy comment reaches a claimed ticket's builders as well as its spec owner, since #543, under PRD #535. A comment governor's App posts on an issue is a record for people that the relay sends to nobody, and the turn that posts it messages the roles that should hear it, since #565, under PRD #535. Governor resends a GitHub call that is safe to repeat when its answer is a server error or a rate limit of 10 seconds or less, as it did a dropped connection, and never any other answer, since #575. Once one call has spent its sends on server errors or dropped connections, every later GitHub call in the turn is sent once, since #576. A ticket's roles are found one way (`rolesOf`), every send carries the PRs a builder owns, the roles lines come from one function, a builder whose PR has merged is told so, and every path judges a ticket governor's App filed as the receiver does, since #570, under PRD #535. The rule covers a PR too: the relay drops the PR review's comment and the trust refusal on a PR, and the review turn messages the PR's owner itself, since #566, under PRD #535. A dispatch comment that names no session leaves the builder unknown, a takeover announces its new builder on each issue its PR closes and on no PR, and one closing-keyword grammar serves the receiver and `closedBy`, since #571, under PRD #535. A periodic's issue counts and listings let in an issue governor's App filed, as the receiver does, since #581. Governor sends a session at most the stack's `MessageCeiling` messages about one issue or PR in a clock hour, and pages where a pair reaches it, since #602. The session rules joined the switch list as `sessionRules`, ending every launch's prompt with the three rules in place of `SIGN_POSTS`, and the session rules block's markers joined the list, since #609, under PRD #599. The bare schedule fire checks each served repo's session rules block on its default branch, logs a missing or old one at warn, and keeps a session rules line on the heartbeat while it is, since #611, under PRD #599.
