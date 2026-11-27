# Hooks and routines
Relevance: A hook a served repo's caller fires, a periodic, how a counted event reaches it, or one run as a routine: dispatch/{hooks,routines,periodics,periodics-fire,sweep}.mjs, dispatch/webhook/{hook,route,measures}.mjs, scripts/hook-key.mjs
Decision: A hook is signed with a key derived from one stack secret and carries data, never a prompt; a periodic's routine stays disabled, so governor alone fires it.

Why: A hook's caller is outside the repo, so its text is data, and a key in
the config file would be public. A routine that fired on its own schedule
would start sessions outside governor's records, and a session holding every
connector the account has would hold more than its file named.

## Rules

- A hook fire arrives at the receiver on its own path,
  `/hooks/<owner>/<repo>/<hook>`, signed with that hook's key instead of
  GitHub's secret. It carries the caller's text, never a prompt: the task
  reads the hook's prompt from the repo's file.
- A hook's key is derived from one stack secret, its repo, its name and its
  `keyVersion`, so the file holds no key and governor stores none. A fire
  signed with another key version is an alarmed `hook-key-stale` error.
- A periodic that names `connectors` starts as a run of its own routine,
  with those connectors attached and no others, each named as in the
  account's connector list. Governor keeps the routine disabled, on a valid
  cron that fires rarely, and fires it itself.
- A periodic's open session does not hold its next fire: a routine run's
  session is never in the sessions list, so the sign-off sweep reaches only
  the one its periodic's record names, and a run's session may stay open
  for good where its last reply does not sign off. Only a
  session in the middle of a turn holds the fire, until that turn ends. A
  hook's open session still takes its next fire as a message.
- Each delivery a measure wakes on, such as a merge into the default
  branch, an issue opened or an issue closed, queues a `periodics` fire of
  its own, naming the measure as `counted`, beside whatever else the
  delivery queues (`counting`, dispatch/webhook/route.mjs), unless the
  repo's hook-table item lists the measures its limits name and not this
  one (dispatcher-state.md). No other fire carries `counted`, and a turn
  ignores one that does, logged at info.
- A measure is one entry in `MEASURES` (dispatch/webhook/measures.mjs):
  its name in `when`, the events that wake it, its window read, its
  wording under the prompt and on the heartbeat, and its filters. The
  schema, the receiver, the fire's parser, the window reads and the prompt
  read the table, and no other list names a measure.
- A check reads each measure's list once, from the oldest last fire among
  the periodics it reads, and each limit counts the rows after its own
  last fire (`sharedWindow`, dispatch/periodics.mjs).
- A filter narrows its own limit's rows of that shared list, never the
  list itself, by its entry's `keep` (`narrowOf`, dispatch/periodics.mjs).
  A check reads one pull request's files once, however many limits with
  `paths` ask for them, and a files read that fails refuses each periodic
  that asked, as any window read does. A merge whose files GitHub cut
  short counts as a match.
- A filter may wake its measure on deliveries of its own (`wakes` on the
  filter's entry). `labels` on `issuesOpened` and `issuesClosed` wakes them
  on a label added to an issue or taken off one, and an open issue wakes
  no `issuesClosed`. The receiver queues a `periodics` fire a filter woke
  only for a measure the repo's hook-table item lists under that filter
  (dispatcher-state.md). `labels` keeps an issue that carries every label
  listed, in any case, by the labels the window's read gave.
- A periodic starts only through `launchPlan` (dispatch/launch-plan.mjs),
  from the sweep's plan or the periodics fire's (`planPeriodics`,
  dispatch/periodics-fire.mjs), each launch built by `periodicLaunch`
  (dispatch/periodics.mjs). The turn holds no launch loop of its own for
  periodics.
- A named connector the account has not connected starts nothing, as an
  alarmed `dispatch-connector-missing` error. A routine the routines API
  refuses stops only its own periodic, as an alarmed
  `dispatch-routine-refused` error.

## Examples

- `fitness: a hook fire arrives on its own path, signed with its hook key,
  and carries data, never a prompt (hooks-and-routines.md)`.
- `handleHook` in dispatch/webhook/route.mjs checks the signature; `hookFor`
  in dispatch/hooks.mjs checks it against the file; `HookKeyStaleAlarm` in
  infra/governor.cfn.yml pages on a stale key.

- `fitness: a counted event queues a periodics fire of its own, started
  through launchPlan (hooks-and-routines.md)` in
  test/periodics-fire-fitness.test.ts.
- `fitness: a measure is one entry in the measures table, and nothing else
  names one (hooks-and-routines.md)` in test/periodics-measures.test.ts.

## Do not

- Do not take a prompt from a hook fire: the caller is outside the repo, and
  its text would become a session's task.
- Do not put a hook's key in the config file or store one: the file may be
  public, and a stored key is one more secret to lose.
- Do not mark a count on another kind's fire, nor start a periodic outside
  `launchPlan`: a second launch loop keeps its own window, cap rule and
  failure handling, which drift from the plan's, and a check riding another
  fire is lost when that fire fails or its switch is off.
- Do not name a measure outside its table entry: a second list drifts,
  and a measure the receiver wakes on but the parser refuses is lost.
- Do not leave a periodic's routine enabled, nor give it a cron the routines
  API refuses, nor attach every connector the account has: an enabled
  routine fires outside governor's records, a refused cron starts no
  periodic, and a session would hold connectors its file never named.

History: Split out of the dispatcher repos file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. A hook fire arrives at the receiver on its own path, signed with its hook key, since #55, under PRD #53. A periodic may name the claude.ai connectors its session needs, and then starts as a run of its own routine, since #89. A routine the routines API refuses stops only its periodic since #91. A periodic's routine is kept disabled on a valid cron that fires once a year since #373. A periodic is held only while its last session is in the middle of a turn, not while it is open, since #752. A counted event queues a `periodics` fire of its own, and a periodic starts only through `launchPlan`, since #774, under PRD #772. A measure is one entry in one table, and a check reads each measure's list once, since #777, under PRD #772. The receiver queues a `periodics` fire only where a limit in the repo's file wakes on the event, since #778, under PRD #772. `merges` takes `paths`, the first filter, declared in its entry and applied to each limit's share of the list, since #780, under PRD #772. `issuesOpened` and `issuesClosed` take `labels`, the first filter that wakes its measure, on a label change, since #784, under PRD #772.
