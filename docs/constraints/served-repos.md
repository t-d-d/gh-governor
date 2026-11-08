# Served repos
Relevance: Which repo a fire or turn acts on, the owner list, the receiver's routing, or a new fire kind: dispatch/{repos,repo-config}.mjs, dispatch/webhook/**, infra/governor.cfn.yml, scripts/{run-turn,point-app-webhook}.mjs
Decision: Governor serves a repo only when an owner on its list installed its App there and the default branch carries a valid config file.

Why: A repo is onboarded by installing the App and merging a file, with no
deploy. The App is public, so anyone can install it, and every served repo
spends the one claude.ai login.

## Rules

- The owner list is the stack parameter `DispatchOwners`, read by the deploy
  from the `GOVERNOR_OWNERS` repository variable, with no default. Changing
  it is a deploy. Nothing else lists served repos: not a stack parameter,
  not the state table.
- GitHub's events arrive through the App's one webhook. A delivery or a
  signed hook for an owner not on the list gets a 2xx, queues nothing, and
  logs at info, never as an error.
- The receiver is internet-facing and holds no token. It routes from the
  payload, the request path and the repo's item in the hook table
  (dispatcher-state.md), and never reads a config file. Where the item drops
  a fire, it drops it only where the item says so; where the item cannot be
  read, is missing or is malformed, the fire is queued and the task decides
  from the file.
- The config file is `.github/governor.json`, read from the default branch
  only, never from a PR head or another branch. No file means not served,
  logged at info. A file that fails its schema skips the repo with an
  alarmed `dispatch-config-invalid` error. A read that fails refuses the
  repo's part of the turn, and is never taken for a missing file.
- The file holds no secret: a served repo may be public.
- Every fire names its repo, and nothing falls back to a default repo. The
  one exception is the bare schedule fire, which lists the App's
  installations on listed owners and keeps the repos whose file reads valid.
  Every repo governor acts on has passed the served check (`repoServed`,
  `servedRepos`).
- A turn calls GitHub only for its fire's repo, under a token minted for that
  repo. Work in another repo is a fire queued for that repo, judged by that
  repo's own file and recorded on its own issues. An issue closing queues
  one `unblocked` fire per open ticket it blocked, in that ticket's repo.
- A record the state table keeps per served repo carries the repo in its key.

## Examples

- The owner gate: `routeEvent` in dispatch/webhook/route.mjs refuses an
  unlisted owner before routing; `handle` answers it 2xx.
- Which repos are served: `servedRepos` and `repoServed` in dispatch/repos.mjs,
  over `readConfig` in dispatch/repo-config.mjs. `DispatchConfigInvalidAlarm`
  in infra/governor.cfn.yml pages on an invalid file.
- The receiver's fallback: a ready label queues a selection fire where the
  item lists it or cannot say (`fitness: a label queues a selection fire ...`
  in test/dispatch-webhook.test.ts).
- A blocker's close: `closingFires` and `ticketRow` in dispatch/unblocked.mjs.

## Do not

- Do not default a fire's repo: a stale or default repo acts on, and spends
  the login for, a repo the fire was not for.
- Do not judge another repo's ticket in the turn of the repo whose issue
  closed: that turn cannot read the other repo's config, and the
  installation-wide token would let it act there unchecked.
- Do not read the config file from any ref but the default branch: a PR head
  is unreviewed, and anyone who can open a PR could turn features on.
- Do not alarm on an unlisted owner's delivery or on a repo with no file:
  either lets someone outside the operator's accounts page the operator.
- Do not drop the owner check because the App's privacy seems to cover it:
  the App is public, so the owner list is the only guard on the login.
- Do not list served repos in a stack parameter or the state table:
  onboarding then needs a deploy, or a write the repo's reviewers cannot see.
- Do not register a repository webhook per repo: the App's webhook already
  reaches every installation.
- Do not give the receiver a token or have it read a config file: it answers
  the internet, and a token there reaches every installation.

Judgment: that a new per-repo table record keys on its repo, and that a config file holds no secret, no check sees: a key is a string no schema reads, and a secret has no shape the schema can refuse.
History: Split out of the dispatcher repos file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. Extracted into this repo, October 2026. A turn may queue a fire naming another repo, and a blocker's close is handled in each blocked ticket's own repo, since #72. The receiver judges a label against the repo's ready labels in its hook-table item since #180. The config file is `.github/governor.json` since #525.
