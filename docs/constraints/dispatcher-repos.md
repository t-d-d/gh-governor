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
- Every feature is a switch, off unless the file turns it on, and a turn
  refuses a fire kind its repo's file does not turn on. The switches are
  pickup, summons, PR messages, subscribe messages, the red scheduled run,
  unblocked (what a blocker's close does to a ticket that is not ready to
  pick up), CI and deploy messages, branch-run messages, the
  conflicts check, deployed-label job fires, the PR review, the heartbeat,
  periodics and hooks (`GENERIC_SWITCHES`). A retired switch a file still
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
  fire's prompt, environment, source and connectors before each fire. The
  routine's own schedule never comes due: governor alone decides when a
  periodic is due. A named connector the account has not connected starts
  nothing and writes no record, as an alarmed `dispatch-connector-missing`
  error naming the repo, the periodic and the connector.
- A launch that started nothing skips its repo for the rest of the fire
  (`dispatch-repo-skipped`) only when it went through `claude --cloud`: a
  failed CLI launch points at the repo's environment or the login, so the
  repo's next launch would fail the same way. A routine the routines API
  refuses, before the fire or on it, stops only its own periodic. A fire is
  refused when it answers a 4xx other than 408 and 429, or throws before
  its request is sent; any other failed fire may have started a run. It starts nothing,
  writes no record, and logs an alarmed `dispatch-routine-refused` error
  naming the repo and the periodic, and the repo's tickets and other
  periodics in the fire still go.
- A file turning hooks on lists at least one hook, or is a schema fault.
  Each hook has a name unique in the file and safe in a URL path, a prompt,
  and a `keyVersion`. A hook's key is derived from one stack secret, its
  repo, its name and that version, so the file holds no key and governor
  stores none. The task refuses a hook fire whose hook the file does not
  list, at warn, and one signed with another key version, as an alarmed
  `hook-key-stale` error (dispatch/hooks.mjs).
- Every prompt value, each in `prompts`, the review's `checklist`, each
  periodic's `prompt` and each hook's, is the
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
  own repo only where its file turns both off (dispatch/unblocked.mjs).
- Governor writes and reads only `governor:` markers: the dispatch marker,
  the subscribe line, the review's marker and the heartbeat block's. A marker of any other prefix
  is text.
- A record the state table keeps per served repo carries the repo in its
  key, under the prefix rule in dispatcher-state.md: the workflow cursors
  and their delivered records (`workflow#<repo>#<file>`), the conflicts
  records (`conflicts#<repo>`), each periodic's record
  (`periodic#<repo>`), each hook's last session (`hook#<repo>`) and each
  repo's last pickup sweep (`pickup#<repo>`) among them.

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
- Do not let a periodic's routine keep a schedule that could come due, nor
  attach every connector the account has: the routine would fire outside
  governor's records, and a session would hold connectors its file never
  named.

Judgment: that a new per-repo table record keys on its repo, and that a config file holds no secret, no check sees: a key is a string no schema reads, and a secret has no shape the schema can refuse.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The periodics switch joined the list in #18, under PRD #17. A counted event's periodic check runs under the periodics switch on any turn since #19, under PRD #17. The heartbeat records every fire, one line each under governor's own marker, since #21, under PRD #17. A ready label `SelectLabels` does not list waits for the repo's pickup sweep, at the interval its file sets, since #22, under PRD #17. The file names the labels that keep a ticket out, and no type label orders the selection, since #28. A hook fire arrives at the receiver on its own path, signed with its hook key, and the switch list gains hooks, since #55, under PRD #53. A turn may queue a fire naming another repo, a blocker's close is handled in each blocked ticket's own repo, and `unblocked` replaces the merge hand-off, since #72. A periodic's baseline adds its heartbeat line, in the `not fired yet` state, where it has none, since #52. A periodic may name the claude.ai connectors its session needs, and then starts as a run of its own routine, since #89. A routine the routines API refuses before the fire stops only its periodic, and only a failed `claude --cloud` launch skips its repo, since #91. The schedule fire runs hourly, and the sweep interval is one hour when the file sets none, since #190. The receiver judges a label against the repo's ready labels in its hook-table item, and `SelectLabels` is gone, since #180. A fire the routines API refuses with a 4xx other than 408 and 429, or that throws before its request is sent, is a refusal, since #148.
