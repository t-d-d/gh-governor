# Working in this repo

Governor starts Claude Code cloud sessions for GitHub repos that install its App: it picks up ready tickets, relays a PR's comments, reviews and CI to the session that owns it, reviews PRs, and archives a session once it signs off. It runs as one task in AWS behind a webhook receiver, on one claude.ai login.

- PRDs are issues labelled `type: prd`. There is no PRD file. A PRD's "Non-goals" list is binding: do not build one.
- [docs/constraints/](docs/constraints/README.md) holds the rules in force. Decisions and their reasons live in issues.

## Scope

- Work you find in passing becomes an issue. Do not fix it in the branch you are on.

## Before any code edit

- Run the `constraints` skill. The stack, the workflows, the Dockerfile and `package.json` count as code.
- If the task conflicts with a constraint, stop and say so. Do not work around the rule, and do not quietly follow the task.
- A change to what a constraint means needs an issue the owner agrees to, linked from the file's History line.

## Tests first

- Write the failing test first. Watch it fail for the reason you expect, then write the code.
- Tests are `test/**/*.test.ts`, run by `node --test`. They touch memory, temporary folders, and node, python3 and git run on them. No test reaches the network or AWS.
- A fitness function's describe name starts `fitness:` and names its constraint file.
- A test's fixture repo is `acme/factory` (test/fixtures/factory/), shaped like a served repo with every feature on.
- Never weaken or delete a test to get the gate green.

## The gate

- `npm run gate` runs everything: the public-repo scan, lint, types and the tests. It is the same command in CI, on every push and pull request.
- The gate is offline and holds no secrets.

## Branches and pull requests

- Never push to main. One branch per issue.
- Run the `pre-push` skill before every push. It ends by raising the pull request.
- The pull request body follows the `pr-description` skill.
- Nothing deploys except a green merge to main. Never deploy by hand.
- The owner merges. Do not merge your own pull request. Governor does not review this repo's pull requests: every file here is its own code.

## Issues

- Given an issue number, run the `fetch-ticket` skill first.
- An issue is picked up as soon as it is labelled `mode: afk`, and goes from its text to a pull request without stopping to ask.
- Anything only the owner can do is not yours: a secret, a repository variable, the App's settings, the claude.ai login, an AWS setting. Say what is needed and stop.
- When your pull request has merged or closed, or you are done and have none, make the last line of your reply `Signing off.` or `Signing off: <reason>`. That archives the session. Do not sign off while the owner is working with you.

## GitHub from a cloud session

- Read the `github-tooling` skill before any `gh` command.
- A session has no cloud credentials and cannot read the AWS account. If a task needs a value, stop and say so.

## The repo is public

- No file names the private repo governor was extracted from, and none holds an account, environment, session or installation id ([public-repo.md](docs/constraints/public-repo.md)). Tests use fakes.
- No issue reference has four or more digits. A comment that needs a reason writes the reason, not an issue number.

## Writing

- Plain words and whole sentences. No em dashes.
- Run the `unslop` skill over anything a person will read: pull request bodies, issues, docs, the README, and the messages governor sends.
