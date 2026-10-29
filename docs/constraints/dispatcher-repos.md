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
- Events arrive through the App's own webhook, one URL for every
  installation. The receiver routes from the payload and holds no token: the
  task reads the config file and its prompts, never the receiver or a fire.
- A delivery for a repo whose owner is not on the list gets a 2xx, queues
  nothing, and is logged at info, never as an error: an outsider must not be
  able to page the operator.
- A label added to an issue queues a selection fire only if the stack's
  `SelectLabels` (`selectLabelsOf`) lists it or is empty, and no bot added it
  (the dispatcher's own claim or release). A repo whose ready label is not
  listed waits for the two-hourly schedule fire. A new ready label needs
  adding to `SelectLabels`, a deploy, for immediate pickup; onboarding needs
  no deploy.
- The config file is `.github/dispatch.json` (`CONFIG_PATH`), read from the
  repo's default branch only, never from a PR head or another branch. With
  no file, the repo is not served, logged at info as `not served`. A file
  that fails its schema (`configSchema`) skips the repo with an alarmed
  `dispatch-config-invalid` error naming the repo and the fault. A read that
  fails refuses that repo's part of the turn and is never taken for a
  missing file.
- The file names the repo's cloud environment, by name or ID, its ready
  labels and its claim label. The dispatcher claims a ticket with that label
  before it launches its session, and creates the label in a repo that
  lacks it. The file holds no secret: a served repo may be public.
- Every feature is a switch, off unless the file turns it on, and a turn
  refuses a fire kind its repo's file does not turn on. The switches are
  pickup, summons, PR messages, subscribe messages, the red scheduled run,
  the merge hand-off, CI and deploy messages, branch-run messages, the
  conflicts check, deployed-label job fires, the PR review, the heartbeat
  and periodics (`GENERIC_SWITCHES`). What CI and a deploy are in a repo is
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
  off, the fire was held, or there was nothing to do. A line's fire time
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
- Every prompt value, each in `prompts`, the review's `checklist` and each
  periodic's `prompt`, is the
  text or `{ "file": "<path>" }`: a file in the repo, from its root, read
  from the default branch with the config file (`resolveFiles`). A missing
  or empty file, or one naming a fact its kind lacks, makes the config file
  invalid (`dispatch-config-invalid`, naming the key and path); a read that
  fails refuses the repo's part of the turn.
- Every fire names its repo, and a turn mints its GitHub token for that repo
  and calls no other. The one exception is the bare EventBridge schedule
  fire: it names no repo, lists the App's installations on listed owners,
  keeps the repos whose file reads valid, and sweeps every served repo's
  sessions. Nothing falls back to a default repo.
- Governor writes and reads only `governor:` markers: the dispatch marker,
  the subscribe line, the review's marker and the heartbeat block's. A marker of any other prefix
  is text.
- A record the state table keeps per served repo carries the repo in its
  key, under the prefix rule in dispatcher-state.md: the workflow cursors
  and their delivered records (`workflow#<repo>#<file>`), the conflicts
  records (`conflicts#<repo>`) and each periodic's record
  (`periodic#<repo>`) among them.

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
- A full config file, every feature on: test/fixtures/factory/.github/dispatch.json.

## Do not

- Do not default a fire's repo: a stale or default repo acts on, and spends
  the login for, a repo the fire was not for.
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

Judgment: that a new per-repo table record keys on its repo, and that a config file holds no secret, no check sees: a key is a string no schema reads, and a secret has no shape the schema can refuse.
History: Extracted into this repo, October 2026. Earlier decisions are in a private repo. The periodics switch joined the list in #18, under PRD #17. A counted event's periodic check runs under the periodics switch on any turn since #19, under PRD #17. The heartbeat records every fire, one line each under governor's own marker, since #21, under PRD #17.
