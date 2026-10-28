# A public repo
Relevance: Any file that could hold a value: code, tests, fixtures, docs, the stack, workflows, examples, scripts/**
Decision: The repo is public, so no file names the repo governor came from, holds an account, environment, session or installation id, or cites another repo's issue.

Why: Anyone can read and fork the repo. An account, environment or
installation id is a foothold, and an issue number from another repo points
a reader at a ticket they cannot open, or at the wrong one here.

## Rules

- No file, and no file's path, names the private repo governor was
  extracted from, in any case. Governor writes and reads only `governor:`
  markers.
- No file holds an AWS account id, a claude.ai environment or session id,
  or a GitHub App installation id. Tests use AWS's documented example
  account, 123456789012, and short fake ids: `env_01FACTORY`,
  `session_01OWNER`.
- No issue or pull request reference has four or more digits. A comment
  that needs a reason writes the reason, not a number. A test's fixture
  issues and pull requests have three digits or fewer, and are fakes.
- The stack takes the operator's values as parameters: the owner list, the
  App ID, `SelectLabels`, the alert email and the optional drop box. The
  deploy reads the owner list, the App ID and `SelectLabels` from repository
  variables, and the alert email and the drop box from repository secrets.
  Anyone can read a public repo's run logs, a step prints each value its
  env block is given, and Actions masks only secrets.
- The App key, the claude.ai login and the drop-box writer live in AWS
  Secrets Manager under `governor/`, in the bootstrap stack
  (infra/bootstrap.cfn.yml). The operator writes them with
  scripts/mint-claude-login.mjs and scripts/save-secret.mjs. Nothing reads
  them from GitHub.
- scripts/public-repo-scan.mjs refuses each of the above, in every tracked
  file and path, with no file exempted. A file that has to spell a refused
  word to test the scan builds it from parts.

## Examples

- The scan: `npm run scan`, the first step of `npm run gate`, and
  `fitness: no file names the old home, holds an id, or cites an issue of
  four or more digits (public-repo.md)` in test/public-repo-fitness.test.ts.
- The deploy's values: `fitness: the deploy reads the alert email and the
  drop box from repository secrets (public-repo.md)`, in the same file.
- A fixture repo shaped like a real served repo: test/fixtures/factory/,
  `acme/factory`.

## Do not

- Exempt a file from the scan: the exemption list becomes the place a real
  value hides.
- Read an address, a URL or another value a reader could use from a
  repository variable: the deploy's log prints it for anyone to read.
- Keep an operator's value in a workflow or the stack's defaults "to save
  looking it up": a fork deploys it.
- Map another repo's issue numbers onto this repo's: the number then points
  at an unrelated issue here.

History: Set when governor's code was extracted into this repo, October 2026. Earlier decisions are in a private repo. The alert email and the drop box moved from repository variables to secrets in #3.
