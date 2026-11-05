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
- A label added to an issue queues a selection fire only if no bot added it
  (the dispatcher's own claim or release), and the repo's item in the hook
  table lists it as one of the repo's ready labels, or the receiver cannot
  read the item's ready labels (no item, one written before it held them, a
  malformed item, a failed read). The task writes the ready labels, as it
  read the file, each time it reads the repo's file (dispatcher-state.md).
  The receiver still holds no token and never reads the file. A new ready
  label needs no deploy: it reaches the item at the repo's next turn, and a
  ticket given it before then waits for its pickup sweep. The bare schedule
  fire sweeps a repo's ready tickets once the interval its file sets
  (`pickup.sweepHours`, dispatch/pickup.mjs), one hour when unset, has
  passed since that repo's last sweep. Onboarding needs no deploy.
- The config file is `.github/dispatch.json` (`CONFIG_PATH`), read from the
  repo's default branch only, never from a PR head or another branch. With
  no file, the repo is not served, logged at info as `not served`. A file
  that fails its schema (`configSchema`) skips the repo with an alarmed
  `dispatch-config-invalid` error naming the repo and the fault. A read that
  fails refuses that repo's part of the turn and is never taken for a
  missing file.
- The file names the repo's cloud environment, by name or ID, its ready
  labels, its claim label and the labels that keep a ticket out
  (`labels.exclude`, `type: prd` when unset). The dispatcher claims a ticket with that label
  before it launches its session, and creates the label in a repo that
  lacks it. The file holds no secret: a served repo may be public.
- What keeps a ticket out of the selection, the claim's second read and the
  `unblocked` row's ready reading is what `ticketStatus`
  (scripts/lib/ready-work.mjs) reads, and no other file combines those
  checks. Two read one check alone: the PR review's test 1
  (dispatch/checklist.mjs) reads `labelRow`, and wait end
  (dispatch/waits.mjs) reads `isWaiting`. The checks are the claim label,
  `labels.exclude`, an open blocker, and the ticket's own `Blocked until: <YYYY-MM-DD>` line,
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
  one for a ticket, as the owner's fallback or because the body names none
  (`nameSpecSession`, dispatch/deliveries.mjs). The body's owner link is the
  ticket's spec session: a later close or ended wait reaches the session it
  names, and no timer decides it. A spec session posts no dispatch marker.
  Only a pickup launch posts one, naming the builder, and the claim label,
  not the marker's age, keeps the ticket out of the selection. A write that
  fails logs `dispatch-spec-owner` at error. Governor makes no other
  rewrite in a ticket's body.
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
  `auto`. The rule: a ticket review whose `by` reaches beyond `auto`, read
  and narrowed as `autoOf` reads it, names no ready label (`labels.ready`)
  in any conclusion, or the file is invalid (`configSchema`,
  dispatch/repo-config.mjs). It reads no `trust.task`. Governor's own
  config read refuses such a file, and the config check with it: a
  review readying a stranger's ticket would be governor setting work
  going by itself. The file is also invalid where one label appears
  under two conclusions of one review, or in two reviews' conclusions, or
  where a conclusion names a label a `types` entry matches on. Each rule
  reads a review's `conclusions` with every `types` entry's.
- `trust.task` is whose issue or PR may become work when a person sets it
  going (`taskOf`), `OWNER`, `MEMBER` and `COLLABORATOR` when unset
  (`PICKUP_BY`). Two routes read it: pickup, above, and a summons, which
  starts a session only where the author of the issue or PR it is on is in
  it. The receiver still drops a summons whose writer is outside the three,
  silently, and reads no `task`: a summons it would refuse for `task` comes
  from a writer with a say, who is told why. The summons fire names the
  issue or PR (`on`) and its author's kind (`author`), none for governor's
  own App, and the task refuses one the file's list leaves out
  (dispatch/dispatch-fire.mjs), at info. The schema refuses `BOT` in it.
  `pickup.by` is a retired key read as `trust.task`, and a file that sets
  both is invalid.
- `trust.start` is who may set work going (`startOf`), `OWNER`, `MEMBER`
  and `COLLABORATOR` when unset (`START`). The schema refuses any other
  value, `BOT` among them, and an empty list: a repo may narrow it, never
  widen it. It sits outside the chain below. A ready label counts only
  when its latest add was by someone in it, or by governor's App (below).
  A summons starts a session only when its writer is in it: the receiver
  keeps the three as the ceiling, the fire carries the writer's
  association (`writer`), or, for an issue assigned to the summons
  account, the assigner's login (`assigner`), and the task judges it
  (dispatch/dispatch-fire.mjs). At the default nothing is looked up.
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
  may hold `BOT`. The ticket reviews read a ticket only where its author is
  in it as well as in the review's own `by` (dispatch/ticket-review.mjs);
  the receiver queues the `ticketReview` fire whoever opened the issue,
  and the task judges the author.
- The lists form a chain, `auto` ⊆ `task` ⊆ `relay` ⊆ `review`, `BOT` left
  aside. Where the file sets two lists that break the chain, it is invalid.
  Where it leaves a list unset, that list is narrowed to fit the lists
  above it the file sets, never widened (`autoOf`, `taskOf`, `relayOf`,
  `narrowedLists`); an unset `relay` keeps `BOT`, and `review`, with
  nothing above it, is never narrowed. The config check warns, under
  its own title and wording, where a list the file sets reaches beyond
  the three (`trustExposures`), `BOT` in a `relay` among them, and notes
  each unset list it narrowed. A wide `pickup.by` gets no such warning,
  as before this rule.
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
  periodics, hooks, waits, sign-off and the ticket reviews
  (`GENERIC_SWITCHES`). A file turning `ticketReviews` on lists at least
  one review in `ticketReviews`, each with a name unique in the list and
  safe in a marker, and a selector whose `on` is `"opened"`; an issue
  opened, reopened or with its body edited queues its `ticketReview` fire
  (dispatcher-review.md). `waits` adds only
  governor's actions when a ticket's wait ends, the comment and the spec
  session, the prompt line, and, where the file names a wait ticket
  (`waits: { issue }`), the link that shows a wait in its ticket's sidebar;
  the hold on a ticket's line needs none. A retired switch a file still
  sets stays valid and reads as the switch that took its work over
  (`RETIRED_SWITCHES`): `mergeHandoff` reads as `unblocked`. What CI and a deploy are in a repo is
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
  may mark a line's session signed off, but never moves its fire time. The
  body outside the block keeps its owner's words.
- A file in the older shape, `heartbeat: { issue, marker }`, keeps its one
  `last-run: <ISO time>` line (`stampLastRun`), which only the bare schedule
  fire writes, after a sweep in which not every claim or launch failed, and
  only into a body already carrying the marker. That marker is the repo's,
  whatever its prefix.
- The file may carry a `prompts` map, keyed by message kind (`PROMPTS`,
  dispatch/prompts.mjs). Each key replaces the instruction in that kind of
  message, or the opening prompt of that kind of session. Every kind has a
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
- A file turning hooks on lists at least one hook, or is a schema fault.
  Each hook has a name unique in the file and safe in a URL path, a prompt,
  and a `keyVersion`. A hook's key is derived from one stack secret, its
  repo, its name and that version, so the file holds no key and governor
  stores none. The task refuses a hook fire whose hook the file does not
  list, at warn, and one signed with another key version, as an alarmed
  `hook-key-stale` error (dispatch/hooks.mjs).
- Every prompt value, each in `prompts`, the review's `checklist`, each
  periodic's `prompt` and each hook's, and a ticket review's `checklist`
  and each of its `types` entries' `checklist`, is the
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
  label's, each ticket review's, `governor:ticket-review`, which
  names the review, and its loop guard's, `governor:ticket-review-loop`,
  which names the review it stops. A marker of any other prefix
  is text.
- A record the state table keeps per served repo carries the repo in its
  key, under the prefix rule in dispatcher-state.md: the workflow cursors
  and their delivered records (`workflow#<repo>#<file>`), the conflicts
  records (`conflicts#<repo>`), each periodic's record
  (`periodic#<repo>`), each hook's last session (`hook#<repo>`), each
  repo's last pickup sweep (`pickup#<repo>`) and each waiting ticket's
  date (`wait#<repo>`) among them.

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
- A full config file, every feature on: test/fixtures/factory/.github/dispatch.json.
- A blocker's close: `closingFires` and `ticketRow` in dispatch/unblocked.mjs;
  `fitness: a turn calls GitHub only for its fire's repo` covers a close
  that blocks another repo's ticket, and an `unblocked` fire.

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

Judgment: that a new per-repo table record keys on its repo, and that a config file holds no secret, no check sees: a key is a string no schema reads, and a secret has no shape the schema can refuse.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The periodics switch joined the list in #18, under PRD #17. A counted event's periodic check runs under the periodics switch on any turn since #19, under PRD #17. The heartbeat records every fire, one line each under governor's own marker, since #21, under PRD #17. A ready label `SelectLabels` does not list waits for the repo's pickup sweep, at the interval its file sets, since #22, under PRD #17. The file names the labels that keep a ticket out, and no type label orders the selection, since #28. A hook fire arrives at the receiver on its own path, signed with its hook key, and the switch list gains hooks, since #55, under PRD #53. A turn may queue a fire naming another repo, a blocker's close is handled in each blocked ticket's own repo, and `unblocked` replaces the merge hand-off, since #72. A periodic's baseline adds its heartbeat line, in the `not fired yet` state, where it has none, since #52. A periodic may name the claude.ai connectors its session needs, and then starts as a run of its own routine, since #89. A routine the routines API refuses before the fire stops only its periodic, and only a failed `claude --cloud` launch skips its repo, since #91. The schedule fire runs hourly, and the sweep interval is one hour when the file sets none, since #190. The receiver judges a label against the repo's ready labels in its hook-table item, and `SelectLabels` is gone, since #180. A fire the routines API refuses with a 4xx other than 408 and 429, or that throws before its request is sent, is a refusal, since #148. A ticket's own `Blocked until:` line holds it whatever the file says, the one behaviour behind no switch, and joins what keeps a ticket out of the selection, since #186, under PRD #185. The `waits` switch, the ended wait's marker and the per-repo wait record joined in #187, under PRD #185. A relative line, rewritten once into its date at its blocker's close whatever the switches say, and its two markers, joined in #189, under PRD #185. The wait ticket's sidebar link and its two markers joined in #188, under PRD #185. The cannot-settle marker names the issue the line waits on since #234, under PRD #185. The unreadied ticket's marker joined in #208: a later close starts no spec session for that ticket until a person answers. In the `unblocked` row the line holds only a ticket ready or not ready by its labels, so a claimed ticket's session still hears its blocker close, since #212, under PRD #185. Sign-off joined the switch list in #278, off unless the file turns it on. A periodic's routine is kept disabled on a valid cron that fires once a year, since the routines API refuses a cron with no firing time, and governor still fires it with `/run`, since #373. A ready label counts only where someone with a say in the repo added it, so an outsider's issue template cannot make a ticket ready, since #380. Pickup starts only tickets whose author `pickup.by` lists, `OWNER`, `MEMBER` and `COLLABORATOR` by default; a ready label a bot other than governor's App added does not count; an uncounted ready label logs at warn and comments once under its own marker; and the config check fails an issue template that names a ready label, since #392. A repo's `trust.auto` decides whose issues and PRs governor sets going by itself, a spec session or owner message after a blocker's close or an ended wait, a periodic's issue counts and listings, and the conflicts check, in place of no check or the fixed set, since #418, under PRD #396. A repo's `trust.relay` decides whose comments and reviews reach a running session, and whose body's session link or subscribe line names a session, in place of the fixed set, and the lists form the chain `auto` ⊆ `task` ⊆ `relay`, since #419, under PRD #396. A repo's `trust.task` decides whose issue or PR pickup and a summons may start work on, `pickup.by` is a retired key read as it, and a refused readying or summons by someone with a say gets the one refusal comment under the uncounted-ready marker, since #420, under PRD #396. A repo's `trust.start` decides who may set work going, by readying a ticket or writing a summons; a narrowed one looks the adder or assigner up, and a refusal for it gets the same one comment, since #421, under PRD #396. A repo's `trust.review` decides whose PRs the PR review reads, in place of the fixed set, and tops the chain `auto` ⊆ `task` ⊆ `relay` ⊆ `review`, since #422, under PRD #396. The ticket reviews joined the switch list, with their `ticketReviews` list, their `ticketReview` fire and their `governor:ticket-review` marker, and read `trust.review`, since #426, under PRD #390. The loop guard's `governor:ticket-review-loop` marker joined in #427, under PRD #390. A ticket review whose `by` reaches beyond `trust.auto` names no ready label in its conclusions, and a conclusion label belongs to one conclusion of one review, since #428, under PRD #390. Governor writes a new spec session's link into a ticket's body as its owner link, a spec session posts no dispatch marker, and no dispatch marker's age holds a ticket from pickup or spec work, since #442. A message to an archived owner with no fallback leaves the owner link, so a ticket names the last session that owned it, since #447. A ticket review's `checklist` and each `types` entry's are prompt values, and the conclusion rules read each entry's `conclusions` with the review's and refuse a conclusion naming a type label, since #429, under PRD #390. A readied ticket both `trust.task` and `trust.start` refuse gets the `start` comment, judged first as on a summons, since #437.
