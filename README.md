# governor

A software factory for your GitHub repos, in which each repo sets how dark its factory runs: whether a passing review merges, and which paths always wait for a person.

Governor starts Claude Code cloud sessions for the repos that install its GitHub App and commit a `.github/dispatch.json`. It picks up tickets labelled ready, relays each PR's comments, reviews and CI to the session that owns it, reviews PRs against the repo's own checklist, and archives a session once it signs off. It runs as one task in AWS behind a webhook receiver, on one claude.ai login.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
