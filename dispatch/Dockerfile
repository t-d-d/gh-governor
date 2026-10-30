# The task: starts Claude Code cloud sessions from a stored claude.ai login.
# Built from the repo root by .github/workflows/deploy.yml through
# .github/actions/image, arm64, for the Fargate task in the governor stack
# (infra/governor.cfn.yml). A plain node image, not a Lambda base: Lambda has
# no pseudo-terminal devices, and `claude --cloud` refuses to run without one.
#
# What it carries, and why each:
#   - python3 and git: the launcher (dispatch/launch-session.py) is Python
#     and allocates the pseudo-terminal `claude --cloud` needs; the CLI reads
#     `git remote get-url origin` off the working directory.
#   - the Claude Code CLI, pinned: what the launcher runs. An npm install,
#     which fetches the platform binary in its postinstall.
#   - the scripts/ modules the entrypoint imports, transitively: the
#     selection, the GitHub client, the login helpers, unbundled. Only that
#     closure, file by file, so a change elsewhere in scripts/ does not
#     rebuild the image; test/dispatch-stack.test.ts holds the list equal to
#     the closure.
#
# No served repo's checklist, lists or code: each review turn reads the
# repo's own review settings and checklist from its default branch
# (docs/constraints/dispatcher-review.md), and each repo's file names the
# issue its heartbeat goes into (docs/constraints/dispatcher-repos.md).
#
# Runs as its own user: the CLI writes its config and the login under HOME,
# and nothing here needs root. The entrypoint reads the event from
# DISPATCH_EVENT, which every run overrides (dispatch/cli.mjs).

FROM public.ecr.aws/docker/library/node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@2.1.282

RUN useradd --create-home --shell /bin/sh dispatch

WORKDIR /app

COPY dispatch/package.json dispatch/package-lock.json ./
RUN npm ci --omit=dev

COPY scripts/lib/claude-login.mjs scripts/lib/cli-entry.mjs scripts/lib/dispatch-prompt.mjs scripts/lib/dispatch-router.mjs scripts/lib/error-message.mjs scripts/lib/github-app.mjs scripts/lib/ready-work.mjs scripts/lib/session-branch.mjs scripts/lib/session-signoff.mjs ./scripts/lib/
COPY dispatch/launch-session.py ./dispatch/launch-session.py
COPY dispatch/turn.mjs dispatch/deliveries.mjs dispatch/unblocked.mjs dispatch/cli.mjs dispatch/workflow.mjs dispatch/runs.mjs dispatch/coverage.mjs dispatch/labels.mjs dispatch/branch-run.mjs dispatch/review.mjs dispatch/checklist.mjs dispatch/pr-body.mjs dispatch/conflicts.mjs dispatch/prompts.mjs dispatch/repo-config.mjs dispatch/repos.mjs dispatch/heartbeat.mjs dispatch/periodics.mjs dispatch/pickup.mjs dispatch/hooks.mjs ./dispatch/
# The fire the receiver builds and the task parses (fire.mjs), and the bodies
# the turn reads the way the receiver does.
COPY dispatch/webhook/fire.mjs dispatch/webhook/mention.mjs dispatch/webhook/subscribe.mjs dispatch/webhook/review-comment.mjs dispatch/webhook/hook-table.mjs ./dispatch/webhook/

USER dispatch
ENV HOME=/home/dispatch

CMD ["node", "dispatch/cli.mjs"]
