# Hooks and routines
Relevance: A hook a served repo's caller fires, or a periodic that runs as a routine with connectors: dispatch/{hooks,routines}.mjs, dispatch/webhook/hook.mjs, scripts/hook-key.mjs
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

## Do not

- Do not take a prompt from a hook fire: the caller is outside the repo, and
  its text would become a session's task.
- Do not put a hook's key in the config file or store one: the file may be
  public, and a stored key is one more secret to lose.
- Do not leave a periodic's routine enabled, nor give it a cron the routines
  API refuses, nor attach every connector the account has: an enabled
  routine fires outside governor's records, a refused cron starts no
  periodic, and a session would hold connectors its file never named.

History: Split out of the dispatcher repos file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. A hook fire arrives at the receiver on its own path, signed with its hook key, since #55, under PRD #53. A periodic may name the claude.ai connectors its session needs, and then starts as a run of its own routine, since #89. A routine the routines API refuses stops only its periodic since #91. A periodic's routine is kept disabled on a valid cron that fires once a year since #373.
