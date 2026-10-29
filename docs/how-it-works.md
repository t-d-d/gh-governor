# How governor works

The README says what governor does, how a repo opts in, and how to deploy it. This page is the detail: what each fire does, what each message says, and what each alarm means. The rules the code keeps are in [constraints/](constraints/README.md); where this page and a constraint file disagree, the constraint file is right and this page is the bug.

- [Why a task and a stored login](#why-a-task-and-a-stored-login)
- [A turn](#a-turn)
- [Triggers](#triggers)
- [Who a PR or issue belongs to](#who-a-pr-or-issue-belongs-to)
- [Signing off](#signing-off)
- [CI and deploys](#ci-and-deploys)
- [Conflicts after a merge](#conflicts-after-a-merge)
- [The PR review](#the-pr-review)
- [Prompts](#prompts)
- [When a repo's file goes wrong](#when-a-repos-file-goes-wrong)
- [The webhook](#the-webhook)
- [Invoking by hand](#invoking-by-hand)
- [Minting the login](#minting-the-login)
- [Alarms](#alarms)
- [Troubleshooting](#troubleshooting)

## Why a task and a stored login

Governor starts a session with `claude --cloud "<task>"`, through `dispatch/launch-session.py`, which runs the CLI in a pseudo-terminal.

- **A login, not a token.** Creating a cloud session sends the stored login's access token, and needs the `user:sessions:claude_code` scope and the organisation's UUID. `claude setup-token` grants inference alone, which the session-create endpoint refuses. So a headless machine can start sessions only with a copy of an interactive login, refresh token included. `scripts/mint-claude-login.mjs` makes that copy ([Minting the login](#minting-the-login)).
- **A task, not a Lambda.** The CLI refuses `--cloud` without a terminal, and the Lambda sandbox has no pseudo-terminal devices. A Fargate task has them.
- **One task at a time.** Every turn refreshes the one stored login, and a refresh rotates the refresh token. Two turns at once would leave one holding a dead login. So every fire goes through one FIFO queue, and the starter runs one task per fire, never beside a running one.

## A turn

A turn is one task, started for one fire (`dispatch/turn.mjs`, run by `dispatch/cli.mjs`). It:

1. restores the login from Secrets Manager into the CLI's credential file;
2. reads the fire's repo's config file, or, for the bare schedule fire, lists the App's installations on listed owners and keeps the repos whose file reads valid;
3. does what the fire asks, if the repo's file turns that feature on, and otherwise logs `dispatch-refused` at info;
4. writes the login back if the CLI refreshed it;
5. archives the sessions that signed off ([Signing off](#signing-off));
6. exits.

A task has no timeout of its own, so the entrypoint ends the turn after eighteen minutes and logs `dispatch-failed` with the reason `deadline`.

**Pickup.** The selection (`scripts/lib/ready-work.mjs`) takes open tickets carrying the repo's ready labels, with no open blocker and no parked parent, and orders them bugs first, then by type, then oldest first. It skips a ticket dispatched within the last two hours. Every served repo's tickets go into one queue, under the stack's `DispatchCap` (two by default). For each ticket governor adds the claim label, takes off `claimRemoves`, starts the session, and comments a `<!-- governor:dispatched <session URL> -->` marker with the session's link. If the launch started nothing, it puts the labels back. A schedule fire starts no launch past seven minutes into the turn, and logs the rest as `undispatched` for the next fire.

**Which fire picks up what.** A ready label added by a person, and listed in `SelectLabels`, queues a fire for that one issue. An issue closing queues a fire for the issues it directly blocked, up to the cap: a close never runs the whole selection, so one finished session cannot start a cascade. The two-hourly fire runs the whole selection over every served repo whose sweep is due. Only that sweep writes pickup's heartbeat line ([The heartbeat](#the-heartbeat)).

**Pickup's sweep interval.** A repo's file may set `"pickup": { "sweepHours": <n> }`, whole hours of at least one; unset is two (`dispatch/pickup.mjs`). Governor keeps each repo's last sweep in the state table, under `pickup#<repo>` / `sweep`. The two-hourly fire sweeps a repo once its interval has passed since that time, and records the sweep after its launches, unless the repo's backlog could not be read, every claim or launch failed, or a failed launch or the launch window left some of its planned tickets, so the next fire tries again. The fire's clock is the stack's `ScheduleExpression`, which the file cannot see, so the turn applies the floor: the first fire at or after the interval sweeps, and an interval shorter than the tick sweeps at every fire. The record holds the time the turn ran, which can lag its fire when the fire waited behind another turn, so a sweep up to half an hour short of its interval still counts as due. A repo not yet due logs `dispatch-pickup` with outcome `not due`. A missing record, for a new repo or a lost item, means sweep now. A record that cannot be read refuses the repo's sweep for the turn (`dispatch-pickup-unread`, and the turn exits 1), and one that cannot be written logs `dispatch-pickup-unrecorded` and exits 1. A label or a close picks up at once whatever the interval, so a repo whose ready label `SelectLabels` does not list waits for its sweep.

**Periodics.** The two-hourly fire also starts each periodic that is due, ahead of the tickets. A merge, an issue opened or an issue closed can bring one due too ([Periodics](#periodics)).

**Each repo on its own.** Each served repo gets its own installation token, workspace and cloud environment. A repo whose launch fails is skipped for the rest of the fire (`dispatch-repo-skipped`), and the other repos still go.

## Triggers

The receiver (`dispatch/webhook/route.mjs`, `mention.mjs`, `subscribe.mjs`) queues a fire for each of these, and the task checks the repo's switch before acting.

| Event | Condition | What happens | Switch |
|---|---|---|---|
| Issue labelled | A ready label, added by a person, listed in `SelectLabels` | That issue is picked up, if the selection would take it | `pickup` |
| Issue closed | It blocked open ready tickets | Those tickets are picked up, up to the cap | `pickup` |
| Two-hourly schedule | Always; pickup once the repo's sweep interval has passed | Every served repo: pickup, heartbeat, sign-off sweep | `pickup`, `heartbeat` |
| Two-hourly schedule | A periodic's day limit has passed since its last fire, or one of its counts is reached, and its last run's session is not open | One session on the periodic's prompt, or none and a "nothing to do" record when its counts counted nothing | `periodics` |
| PR merged into the default branch, issue opened, issue closed | A periodic counts that kind, and its count since its last fire is reached, and its last run's session is not open | One session on the periodic's prompt, after the carrying turn's own work | `periodics` |
| Comment, issue or review with `@claude` | By an owner, member or collaborator; no session owns the PR | One session, pointed at the remark | `summons` |
| Comment, review, push, merge or close on a PR | The PR names a session, or a local session holds its branch | A message into that session | `prMessages` |
| Comment, label, close or reopen on an issue | The issue's filer, or a subscribed session | A message into each | `subscribeMessages` |
| Any event on a PR or issue | A `governor:subscribe` line names a session for that event | A message into it | `subscribeMessages` |
| PR merged | Its closed issues blocked open tickets | The owner's message lists them, with what to do | `mergeHandoff` |
| PR merged | Other open PRs into the default branch are now conflicted | A message to each one's session | `conflicts` |
| CI run on the default branch went red | Started by a push; the run before it was green | Messages to the suspect merges' sessions, or one fresh session | `ciMessages` |
| Shipping job on the default branch succeeded | Its name ends `· deployed: <target>` | Messages to the sessions of the merges it shipped; labels their tickets | `deployMessages`, `deployedLabels` |
| Deploy run on the default branch went red | Its workflow marks a shipping job | Messages, or one fresh session for a `triage` target | `deployMessages` |
| Scheduled run on the default branch went red | First attempt | One fresh session on the run | `redScheduledRun` |
| Dispatched run on another branch finished | Any outcome | A message to the session that wrote its commit | `branchRunMessages` |
| PR opened, ready, pushed to, or its body or base edited | Not a draft; by an owner, member or collaborator | The PR review | `prReview` |
| Workflow run finished on a PR's head | The PR is open | The PR review, at that head | `prReview` |

A mention starts a session only from someone with a say in the repo. A bot cannot, and neither can a session, whose posts end in the Claude Code footer. On a PR a session owns, a mention starts nobody: the owner is messaged instead.

Everything governor sends into a session starts with one line, `[governor] Automated message from the governor dispatcher, relaying GitHub activity; …`, so the session knows it is reading a report and weighs each quoted remark by who wrote it. A prompt that a person or the schedule starts a session on carries no such line.

Every message ends with the session's standing: the other open PRs and issues that name it, or "No other open PR or issue names this session". When nothing else is open, an issue's close, a PR closed unmerged, or a green deploy also asks the session to sign off, unless it knows a reason not to. A merge does not ask, because CI and the deploy are still to come.

## Who a PR or issue belongs to

**A PR a cloud session wrote** names it: the last `claude.ai/code/session_…` link under the Claude Code footer in its body. Every comment, review comment and review on it goes to that session, mention or not, review bots included. What does not reach it: its own posts, a stranger's comment, and a review with neither text nor a verdict.

**When the owner is archived**, the message is refused, and governor starts a fresh session on the same text, told to take the PR over. It rewrites the PR body's session link to the fresh session, so later remarks go straight to it, and leaves a dispatch marker on the PR. If the rewrite failed, a refusal within the next two hours forwards to the session the marker names rather than starting a third.

Only one answer counts as a refusal: `cloud session <id> is archived`. Any other failure says nothing about the session, which may be live. Governor sends once more five seconds later; if that fails too, it starts no fallback, drops nothing, and fails the turn.

**A PR raised from a local session** (the CLI, or the desktop app with Remote Control on) names no session. Governor reads the PR's head branch and asks the sessions API for the most recently updated local session holding that branch, not archived. A cloud session on the branch does not count: it checked the branch out to review or fix it. With none found, nobody is told.

**An issue a session filed** names it the same way, and the filer hears every event on it but labels: comments, the close, and a `deployed:` label only if it subscribed to `deploys`. A session link that is the whole of the body's last line also counts, since some tools strip the footer from an issue body.

**Any other session** subscribes to a PR or issue it is party to by adding one line to its body, and unsubscribes by removing it:

```
<!-- governor:subscribe https://claude.ai/code/session_… events=comments,reviews,pushes,close -->
```

`events` is a closed list. Absent means all.

| Event | What it covers |
|---|---|
| `comments` | Issue comments and review comments |
| `reviews` | Submitted reviews |
| `pushes` | A push to the PR |
| `close` | A PR closed, merged or not; an issue closed or reopened |
| `labels` | An issue labelled or unlabelled, except a `deployed:` label added |
| `ci` | A red CI run on the default branch that this PR may have caused |
| `deploys` | A shipping job or a red deploy that shipped this PR; on an issue, a `deployed:` label added |

A PR's owner is implicitly subscribed to everything but `labels`; an issue's filer to everything but `labels` and `deploys`. A subscriber that refuses is dropped from the body (`dispatch-unsubscribe`). Nobody hears of its own post: every post a session makes ends with the Claude Code footer and its own session URL, and the receiver skips that session. A push names its commit, and the session its `Claude-Session` trailer names is skipped.

## Signing off

A session cannot archive itself unattended: the archive tool reaches a session only on a turn the operator typed. So a finished session signs off in words, by making `Signing off.` the last line of its reply, and every turn but a probe sweeps (`sweepSignoffs`, `scripts/lib/session-signoff.mjs`, [constraints/session-signoff.md](constraints/session-signoff.md)).

The candidates are the login's sessions that are idle, not archived, and name a served repo. The sweep reads them most recently updated first, for up to a minute, and leaves the rest for the next turn. For each, it reads the session's newest events and takes the reply: the newest `result` text, or the nearest assistant text before it. A reply whose last line starts `Signing off` signs the session off. The sweep reads the session again, so a prompt that landed meanwhile keeps it open, and archives it. Each candidate logs one `dispatch-signoff` line with the decision, never the reply's text.

A session's sign-off is usually its reply to a message the same turn sent. So a turn that messaged sessions, with nothing else queued, re-reads those sessions every 15 seconds for up to three minutes, until each has replied or a fire is waiting (`dispatch-signoff-wait`).

The sessions API is not a documented one. If it changes, the sweep logs the refusal and archives nothing, and the sessions stay open until archived by hand.

A local session with Remote Control on is listed and swept like a cloud one. The archive ends its Remote Control link, but the desktop app keeps its window. A served repo that wants local sessions to close themselves can add a Stop hook that asks the session to call the desktop app's archive tool on its sign-off turn.

## CI and deploys

**CI.** The repo's `workflows.ci` names its CI workflow. Only a run started by a push counts: a run dispatched by hand tested no merge. A red run whose previous run was green blames the merges between them.

- One suspect PR: its session is told the run, the failed jobs and the PR, and asked to fix it on a new branch if its change caused it. If that session is archived, a fresh session starts on the same text.
- Several suspects: none of their sessions is told. One fresh session gets the run and the suspects, finds the culprit, and fixes it.
- One suspect Dependabot opened: one fresh session, to fix forward or revert the bump.

A red run after a red run tells nobody: its breakers were already told.

**Deploy targets.** A shipping job's name ends `· deployed: <target>` (a middle dot, one space each side), optionally with `at <sha>`, the commit it built, before it. The workflow file declares a top-level `TICKET_LABEL_PATHS`: `all`, `trigger` (the workflow's own push paths), or globs. Governor reads both at the run's commit; no list of workflow names picks them.

- A green shipping job tells each PR it shipped that its change is on the target, naming the job and the target's tag from `workflows.tags`. With `deployedLabels` on, it labels each ticket those PRs closed `deployed: <target>`.
- A red run of a deploy a merge starts (a workflow on `push` or `workflow_run`) tells each PR it shipped that the deploy failed, and asks for a fix only if its change caused it.
- A red run of a `triage` target starts one fresh session over every merge it shipped instead, since those sessions have usually signed off.
- A red release dispatched by hand tells nobody: whoever dispatched it is watching it.

A session hears of a run once, however many of its PRs the run covers.

**Cursors.** A job or run covers every PR merged since its baseline. Each label has a cursor in the state table: the newest run a turn planned. A turn moves it forward after its sends, and never back. A refused turn leaves it, so the next job's range tells and labels the refused job's merges too. A note the turn could not send holds the cursor, and the turn records which sessions it did tell, so the next job tells only the rest. A session that fails three turns running is given up on.

GitHub's runs list can lag. A list missing the run is read again after 10, 30, 60 and 90 seconds; still missing, the turn tells nobody and logs `dispatch-stale-runs`, which raises an alarm.

## Conflicts after a merge

GitHub has no event for a PR that a merge leaves conflicted. So a PR merged into the default branch queues a `conflicts` fire (`dispatch/conflicts.mjs`), whose turn reads each open, non-draft PR's `mergeable`. A `null` starts GitHub's computation, so those are read again three seconds later, up to five reads. A PR still `null` is never taken for a conflict.

Each conflicted PR's owner session is told the PR, the merge that moved the base and the base's new commit, and asked to merge the base in, resolve, check and push. An archived owner gets a fresh session told to take the PR over. Nothing is posted on the PR. Each PR is told of each merge once, recorded in the state table. A PR with no owner session is told nothing.

## The PR review

The review runs in each served repo whose file turns `prReview` on, from that repo's `review` section ([constraints/dispatcher-review.md](constraints/dispatcher-review.md)). The image carries no repo's checklist: each review reads the repo's own, from its default branch. The review turn (`dispatch/review.mjs`) reads the PR, the tickets its body closes and the last review marker, then runs `claude -p` under the stored login with the checklist appended to the system prompt, the PR's facts on stdin, no tools, and the answer held to a JSON schema. The review starts no session.

**Decided in code.** Three tests are decided before the model is asked, and a PR failing one is commented on without a model run:

- Test 1, the tickets: each ticket the PR closes is open, meets `review.tickets`, and carries the claim label. A ticket not yet claimed gets a comment the author session hears.
- Test 7, the human-only list: no changed path, or path a rename left, matches `review.humanOnly`, unless every ticket carries one of the entry's `unless` labels. A modified file matching `review.quote` goes to the model instead, quoted whole at the merge base and at the head. A `decides` ticket's first line, `Constraint now lives at <path>, …`, passes the quoted files it names.
- Test 8, required checks: no status check the default branch requires is red on the head. A check still running skips the review; the run finishing queues a new one.

So a checklist numbers its own tests 2 to 6. Code also fails tests 5 and 6 when the PR body's Verification table or Left for later names a ticket that is closed or does not exist; the rest of those tests are the model's.

**Pass.** Governor waits for GitHub to compute the PR's mergeable state, merges with a merge commit pinned to the head it reviewed, and comments `Passes the PR review: <reason>.` With `review.merge` false, it merges nothing: it posts an approving review pinned to that head as well as the comment, and the owner merges. A later head that does not pass dismisses that approval. A conflict is a comment telling the author session to merge the base in.

**Fail.** A comment naming the first failed test: `Waits for a description edit: …` where an edit to the PR body would pass it, or `Waits for a person: …` where none can. A fail on the same test as the last review edits that comment in place rather than posting again.

**Who hears it.** Every comment ends with `<!-- governor:pr-review <head sha> <body sha256> -->`. The receiver takes a comment for the review's only when it carries that marker and the stack's own App posted it. The owner session is messaged only when the review asks something of it: an edit, a ticket to claim, a red required check, or a conflict. A pass queues nothing, since the merge's own message follows. A fail only a person can clear queues nothing. Subscribers are not messaged.

**Skipped.** A PR whose head and body the last marker names, a draft, a closed PR, a PR into any branch but the default, and a PR by someone not an owner, member or collaborator.

**Dependabot.** A PR `dependabot[bot]` opened is held to tests 7 and 8 alone, with no model run, using `review.dependabot` in place of the human-only list. It passes when every changed file is on that list and modified, and every commit's author is `dependabot[bot]` and was committed and signed by GitHub. Anything else waits for a person. A pass merges, or with `merge` false is approved. A conflict posts nothing: Dependabot rebases its own PRs.

**Limits.** A review of every open PR starts no review past five minutes into the turn; the rest are reviewed on their next push or edit. A model run refused by the login's session limit is `limited`, not a failure. A failed review (a merge GitHub refused, an answer outside the schema) exits 1.

**Transcripts.** With `DropBoxUrl` set and the writer saved, each review's transcript is redacted, gzipped and PUT to `<DropBoxUrl>/<date>/pr-review-<PR>-<session>.jsonl.gz` (`dispatch-review-transcript`).

## Prompts

A repo's `prompts` map replaces the instruction in a kind of message, or the opening prompt of a kind of session. Governor still writes the facts itself: what happened, the PR or issue, the run and commit, and the standing line. A prompt may name its kind's facts as `{fact}`. A kind the file leaves out gets the default in `dispatch/prompts.mjs`, which names no repo's skill or file.

| Key | Replaces | Facts |
|---|---|---|
| `pickup` | A pickup session's opening prompt, below `Pickup #N 'title'` | `{issue}`, `{repo}`, `{claim}` |
| `signOff` | The standing line's ask to sign off | |
| `mergeHandoff` | The steps after a merge's blocked-ticket lists | |
| `mergeHandoffUnread` | What to do when those lists could not be read | |
| `redScheduledRun` | A red scheduled run's session prompt, below the run | |
| `ciBreaker` | A red CI's ask to its one suspect's session | `{pr}` |
| `ciTriage` | A red CI's fresh session over several suspects | |
| `ciBumpTriage` | A red CI's fresh session over a Dependabot bump | `{pr}` |
| `prodTriage` | A failed `triage` target's fresh session | |
| `deployGreen`, `deployGreenMany` | A green deploy's ask, for one PR or several | `{pr}` (the newest), `{target}` |
| `deployRed`, `deployRedMany` | A red deploy's ask, for one PR or several | `{pr}` (the newest) |
| `subscribed` | A CI or deploy notice's ask to a subscriber | |
| `conflicts` | A conflicted PR's ask, to its session or the fallback's | `{base}` |

A value is the text, or `{ "file": "<path>" }`, read from the default branch beside the config file. A skill file's frontmatter is dropped. An unknown key, a fact the kind lacks, or a missing or empty file makes the config invalid.

## Periodics

A periodic is a recurring session a repo lists in its config file, with a name, a prompt and a day limit in whole days (`dispatch/periodics.mjs`). It may add counts of merges into the default branch, issues opened and issues closed, and a minimum gap in hours. The bare two-hourly fire starts one on its day limit or its counts; an event it counts can start one too.

- **When it is due.** Governor keeps each periodic's record in the state table, under `periodic#<repo>` / `<name>`: the time of its last fire, and the session it started, or none for an unconfirmed launch. A periodic is due once its day limit has passed since that time, or will within the hour: the record holds the launch's time, a little after the sweep read it, so the sweep nearest the limit fires it rather than every run slipping a sweep. One with counts is also due once any count since that time reaches its number.
- **Counting.** Governor keeps no running total. When a counted event arrives, governor reads that kind's count since each periodic's last fire afresh from GitHub, so a lost webhook only delays a fire to the next event or sweep. Merges are pull requests closed into the default branch, counted by merge time, never by comparing commits: a compare stops at 250 commits, and a busy week passes that. Issues opened and closed are counted by when they were opened or closed, pull requests left out. The sweep reads every count it keeps.
- **The fire's time.** A periodic with counts is recorded as of the moment its counts were read, not its launch, so a merge or issue that lands in between is in the next window. One with only a day limit records its launch's time.
- **The carrying turn.** The receiver reads no config file, so it marks every merge into the default branch, issue opened and issue closed in a listed repo as `counted` on a fire. A merge rides its `conflicts` fire, and a close rides the fire that frees what it blocked. An issue opened rides its summons, if it is one, and otherwise queues a `periodics` fire of its own. After the turn's own work, the turn checks the periodics that count that kind, under the `periodics` switch, whatever switch its own work needed; a turn refused for its own switch still checks them. A periodic starts no later than seven minutes into the turn (`EVENT_PERIODIC_WINDOW_MS`), so its launch ends inside the task's deadline; one left unstarted stays due. If the turn's own launch in the repo started nothing, its periodics wait too, since their launch would fail the same way. A record or count that cannot be read there fails the turn, and the sign-off sweep still runs.
- **Nothing to do.** At its day limit, a periodic with counts whose counts counted nothing starts no session. Governor records "nothing to do" as its fire, so its next day limit counts from then. A periodic with only a day limit always starts a session.
- **The minimum gap.** A periodic never fires inside `gapHours` of its last run. A count reached inside the gap fires on the first event or sweep after it. A baseline ran nothing, so it opens no gap; a "nothing to do" record keeps the time of the run before it, and the gap runs from that.
- **The hold.** A periodic never overlaps itself. When one comes due, by count or by day limit, and the session its last fire started is still open, governor starts nothing and logs `dispatch-periodic` with outcome `held`, naming that session. It writes nothing, so the last fire's time stays put, the count keeps growing from it, and the first check after the run ends fires the periodic over the whole window. A day limit whose counts counted nothing is held the same way, since its "nothing to do" record would name no session and the next count would start a second run over the open one. Governor reads the session's own record over the sessions API, under the login's token, refreshed first if it has expired. The sign-off sweep only reads idle, unarchived sessions, so the hold does not wait for it to report. A run is finished once its session is archived, by the sweep or by hand, signed off or not, or once the API no longer has it. A record with no session, from an unconfirmed launch, is a finished run. A session that cannot be read, or whose record carries no status, refuses the periodic for the turn (`dispatch-periodic-unread`, and the turn exits 1); it is never taken for a finished run.
- **No record.** A new periodic, or one whose record was lost, has none. The fire writes now as the baseline and starts nothing, so the first run comes one day limit later. A lost record costs at most one late run, never a burst of runs.
- **The launch.** Due periodics go into the fire's launch plan ahead of the tickets, the one that came due first going first. They do not count against `DispatchCap`, but a cap of 0 still starts nothing. They share the fire's seven-minute launch window, and one left unlaunched stays due for the next fire.
- **The session.** It is named after the periodic, in the repo's environment. Its prompt is the periodic's, then a line governor writes: `This periodic last fired at <time>.`, `This is the first run of this periodic that governor has a record of.` after a baseline, or that its last day limit found nothing to do. For a periodic with counts, governor then lists what each count counted since that time, each item by number and title, up to a hundred of each kind. No repo can drop or reword these lines.
- **The record.** A launch that started, or may have, writes the new record, and only over the record the fire read, so two turns never both record one fire. The write comes after the launch, so it is the one task at a time that keeps two turns from both starting a periodic. A failed launch writes nothing, the periodic stays due, and the rest of its repo waits for the next fire (`dispatch-repo-skipped`), as after a ticket's failed launch.
- **A failed read.** A record or a count that cannot be read refuses that periodic for the turn, and is never taken for a missing record or an empty count. The turn logs `dispatch-periodic-unread` and exits 1. A record that could not be written after a launch logs `dispatch-periodic-unrecorded` and exits 1, since the next fire may start the periodic again.

## The heartbeat

A repo turns the heartbeat on and names one issue, `"heartbeat": { "issue": <number> }`, so a check outside governor can read when each thing governor runs for it last ran and how it ended (`dispatch/heartbeat.mjs`). The issue's body must already carry `<!-- governor:heartbeat -->`. Governor keeps its own block under that marker, ended by `<!-- governor:heartbeat-end -->`, and changes nothing else in the body:

```
<!-- governor:heartbeat -->
- pickup: last sweep 2026-10-29T20:00:00.000Z, started 2 sessions
- periodic "Code review": last fire 2026-10-29T18:04:11.000Z, by 20 merges, session https://claude.ai/code/session_…, open
- periodic "Weekly retro": last fire 2026-10-27T20:00:00.000Z, by its day limit of 7 days, session none, nothing to do
<!-- governor:heartbeat-end -->
```

- **Pickup's line** gives the last sweep's time and how many ticket sessions it started. Only the bare two-hourly fire writes it, on a fire that swept the repo at its interval, in a repo whose file turns pickup on, whose backlog it read, and where not every claim or launch failed. A label or a close never freshens it.
- **A periodic's line** gives its last fire's time, which limit fired it (its day limit, or the count that reached its number), the session, and its state: `open`, `signed off`, `held while that session is open`, or `nothing to do`. Its own fire writes it, on the two-hourly fire or on the event that brought it due. A held fire leaves the time at the open run's start and names that session. A failed launch leaves the line where it was.
- **Signed off.** When the sign-off sweep, on any turn, archives the session an open or held line names, it marks that line `signed off`. It never moves the line's fire time.
- **A wrong issue.** A body without the marker gets no write, and `dispatch-heartbeat-refused` names the repo and issue. A read or write that fails logs `dispatch-heartbeat-unwritten` and the turn exits 1.

A file in the older shape, `"heartbeat": { "issue": <number>, "marker": "<!-- … -->" }`, keeps what it had: the two-hourly sweep adds or updates one `last-run: <time>` line under the repo's own marker, after a sweep in which not every claim or launch failed. Nothing writes a line per periodic there.

## When a repo's file goes wrong

| What | Logged | Alarm |
|---|---|---|
| No file | `dispatch-not-served`, at info | none |
| A file that fails the schema, or names an environment that matches none or several | `dispatch-config-invalid`, naming the repo and the fault | `governor-config-invalid` |
| A file that could not be read (anything but a 404) | `dispatch-config-unread`; the repo is left out and the turn exits 1 | `governor-errors` |
| The login's environment list could not be read | `dispatch-environments-unread`, after one refresh attempt | `governor-errors` |
| A repo's launch started nothing | `dispatch-repo-skipped` | `governor-repo-skipped` |
| A periodic's record, or its last run's session, could not be read, or its baseline written | `dispatch-periodic-unread` or `dispatch-periodic-unrecorded`; that periodic waits and the turn exits 1 | `governor-errors` |
| The installation list or a token mint failed | `dispatch-failed` | `governor-errors` |

## The webhook

GitHub posts every installation's events to one Lambda Function URL (`governor-webhook`) through the App's own webhook. The events are those in `HOOK_EVENTS` (`dispatch/webhook/route.mjs`). A delivery whose signature matches the stack's key (`governor/webhook-secret`) is routed from its payload alone: the receiver holds no GitHub token and reads no config file.

- A repo whose owner is not on `DispatchOwners` queues nothing: `200`, and `webhook-ignored` at info. An outsider who installs the public App can page nobody.
- Every fire names the repo its delivery came from. The task reads that repo's file and refuses a fire its switches do not turn on.
- Workflow and merge events are routed by the default branch the payload names, never by `main`.
- A label added by a bot queues no selection, since governor's own claim and release are a bot's. Subscribers still hear it.
- A delivery's id is its deduplication id on the queue, so a redelivery is not a second fire.

Every fire, the schedule's included, goes on `governor-fires.fifo`. The starter (`governor-starter`, `dispatch/webhook/starter.mjs`) runs one task per fire, never beside a running one. A fire that finds a task running goes back on the queue for ten seconds. After half an hour of attempts it goes to the dead-letter queue, and `governor-fires-dead` pages. A task that fails to start (an image pull refused, no placement) is put back on the queue by `governor-retrier`, for three attempts in all.

After every apply, the deploy runs `scripts/point-app-webhook.mjs`, which writes the receiver's URL and the stack's key to the App's webhook config, as the App. It first reads the App's events, and writes nothing while one the receiver routes is unticked. The deploy's conformance checks (`scripts/conformance.mjs`) then read back the App's events and post once, unsigned, to the receiver, failing on anything but its own `401`.

The App's **Advanced → Recent Deliveries** shows each answer:

| Answer | Meaning |
|---|---|
| `202` | A fire was queued. |
| `200` | Nothing was queued; the body says why (an unlisted owner, a stranger's mention, a bot, a session's own post). |
| `401` | The signature does not match the stack's key. |
| `403` with no receiver log line | AWS refused the URL before the receiver ran. The stack grants both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`. |
| `502` | The receiver threw, or the queue refused the fire. Redeliver retries it. |

## Invoking by hand

```bash
node scripts/run-turn.mjs --kind probe                                     # check the runtime; exits with what it proved
node scripts/run-turn.mjs --kind schedule                                  # a sweep of every served repo whose interval has passed, now
node scripts/run-turn.mjs --kind schedule --repo owner/name                # one repo's pickup and sweep
node scripts/run-turn.mjs --kind dispatch --repo owner/name --prompt '…' --session-name '…'   # one session, no ticket
node scripts/run-turn.mjs --kind message --repo owner/name --session <session_… or URL> --text '…'  # text into a session
```

Every kind but `probe` and a bare `schedule` needs `--repo`: nothing falls back to a default repo. It needs the AWS CLI as an identity that may run the task and send to the queue.

A probe starts its own task, since it touches no login. Every other kind queues on the fire queue and waits behind whatever is running, then finds its task by the `fire-started` line in `/aws/lambda/governor-starter`. Each waits, prints the task's log and exits with its exit code; `--no-wait` returns at once. Start a task any other way only when `aws ecs list-tasks --cluster governor` shows none and the queue is empty.

A message needs no pseudo-terminal: the turn runs `claude -p --cloud <session> --output-format json` with the text on stdin, and an archived session refuses it. A message wakes an idle session within seconds.

When governor is down, open a session by hand from the claude.ai app or `claude --cloud`.

## Minting the login

On a laptop or in CloudShell, with `claude` and the AWS CLI signed in as an identity that may write `governor/claude-login`:

```bash
node scripts/mint-claude-login.mjs --profile <p>   # laptop
node scripts/mint-claude-login.mjs                 # CloudShell
```

It first checks that the AWS identity can reach the secret, and stops there if not. Then it starts the sign-in under a throwaway `CLAUDE_CONFIG_DIR`, which also namespaces the macOS keychain item, so the login the machine already holds is never read or written. Pick the subscription option and sign in as the account the sessions will run under. It refuses a setup-token, writes the secret, removes the throwaway directory, and prints the scopes and both expiries.

The secret holds `{ credentials, account }`: the CLI's `.credentials.json` text verbatim, and the account and organisation UUIDs. Not the email address. The turn names the organisation to every CLI call it spawns, so none depends on the CLI's profile fetch.

Never sign that login out: a revoke would kill the stored copy. A refresh rotates both tokens and moves the access expiry, but not the refresh expiry, which is fixed about two weeks after the mint. Past it, the refresh fails and governor stops. So mint again before then. Within three days of it, each turn logs `dispatch-login-expiring` and `governor-login-expiring` pages.

## Alarms

Every alarm publishes to the `governor-alerts` topic, which emails the address in Parameter Store under `/governor/alert-email` once the subscription is confirmed.

| Alarm | Fires on |
|---|---|
| `governor-errors` | A `dispatch-failed` line in `/governor`: a dead login, a GitHub read refused, a launcher that cannot start, every launch failed, the deadline. |
| `governor-stale-runs` | `dispatch-stale-runs`: the runs list still lacked a run, or a cursor could not be read. The next run of the same workflow catches up. |
| `governor-login-expiring` | The stored login is within three days of its refresh expiry. Mint again. |
| `governor-claim-stranded` | A ticket was claimed but no marker names its session. It stays claimed; if no session is working on it, put the ready label back. |
| `governor-config-invalid` | A served repo's file fails the schema. |
| `governor-repo-skipped` | A repo's launch started nothing; its tickets wait for the next fire. |
| `governor-not-started` | EventBridge could not invoke the receiver on the schedule. |
| `governor-not-run` | Tasks repeatedly failed to start their container. The stop event in `/governor` says why. |
| `governor-not-run-undelivered` | A stop event could not reach the retrier. Its fire needs sending again by hand. |
| `governor-retrier-errors` | The retrier failed. Its fire needs sending again by hand. |
| `governor-fires-dead` | A fire reached the dead-letter queue. |
| `governor-webhook-errors` | The receiver threw. |

A message an archived session refused, with no fallback tried, is not an error. Neither is a review the login's session limit refused.

## Troubleshooting

**A mention did nothing.** Read the App's Recent Deliveries. `200` carries the reason. `202` queued a fire: then `/aws/lambda/governor-starter` has `fire-deferred` (a task was running, and the fire is offered again ten seconds later) or `fire-started` with the task, whose log is in `/governor`. No delivery at all means the App is not subscribed to that event: tick it in the App's settings.

**A ready ticket was not picked up.** Check that the repo's file turns `pickup` on and lists the ticket's labels as ready, that the ticket has no open blocker and no claim label, and that it was not dispatched in the last two hours. A label not in `SelectLabels` waits for the two-hourly sweep. `dispatch-plan` in `/governor` says what the fire planned and why.

**A session was not archived.** Its last reply's last line must start `Signing off`, and the session must be idle. `dispatch-signoff` in `/governor` names each candidate and the decision.

**The deploy's probe is red.** The probe prints the task's log, which says whether the task could not reach the network, hold a pseudo-terminal or find the CLI. A task that never ran its container, such as one whose image pull was refused, has no log, and the probe prints its stop reason instead.
