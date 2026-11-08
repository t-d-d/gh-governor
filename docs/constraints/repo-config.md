# A served repo's config file
Relevance: A served repo's config file, its schema, a switch or a prompt: dispatch/{repo-config,prompts}.mjs, checker/config-check.mjs, test/fixtures/factory/.github/governor.json
Decision: Each feature is one section of the repo's config file, off unless the file turns it on; a repo's prompt replaces an instruction, never the facts.

Why: One rule for where a setting lives lets a repo owner read the file
without reading governor's code. A feature that ran by default would spend
the login in repos that never asked for it. A prompt that could rewrite the
facts could drop the PR number or the standing line, and no test could pin
what a message holds.

## Rules

- `environment`, `trust` and `workflows` are the settings several features
  share. Every other top-level key is one feature's section (`SECTIONS`),
  holding every setting and prompt that feature reads. The code reads the
  file into one shape (`toConfig`), so no feature reads the file's layout.
- Every feature is a switch, off unless the file turns it on, and a turn
  refuses a fire kind its repo's file does not turn on. A section turns its
  feature on unless it sets `"enabled": false`. The schema accepts no switch
  by repo.
- Two things run whatever the switches say, because ignoring them would be
  silent: a ticket's own `Blocked until:` line (ticket-readiness.md), and
  the comment on a ticket whose ready labels do not count (trust.md).
- A key the schema does not know makes the file invalid, so a typo pages
  rather than falling back quietly. A retired key is invalid like any other.
- Each message kind has one prompt key, in the section of the feature that
  sends it. A prompt replaces only the instruction. The dispatcher writes the
  facts itself: what happened, the PR or issue, the run and commit, the
  session's standing line. A prompt may name a fact its kind has (`{pr}`),
  and the dispatcher writes it in.
- Every kind has a generic default, and a kind the file leaves out gets it.
- Every prompt value is text or `{ "file": "<path>" }`, a file in the repo
  read from the default branch with the config file. A missing or empty
  file, or one naming a fact its kind lacks, makes the config invalid.

## Examples

- A full config file, every feature on:
  test/fixtures/factory/.github/governor.json, held to the committed schema
  by `fitness: the factory's config file, shaped like a served repo's,
  passes the committed schema (repo-config.md)`.
- Prompts: `instruction` in dispatch/prompts.mjs, called by each text's
  builder; `resolveFiles` in dispatch/repo-config.mjs reads prompt files.
- The switch list: `GENERIC_SWITCHES` and `SECTION_SWITCHES`, read by
  `turnsOn`, in dispatch/repo-config.mjs.

## Do not

- Do not point a default prompt at a repo's CLAUDE.md, its skills or its
  conventions: repos share none, and every message would send the session
  to look something up.
- Do not read a prompt file from any ref but the default branch, nor from a
  path outside the repo: either lets a PR or a link write the prompt.
- Do not take a template that rewrites the facts: a repo could drop the PR
  number or the standing line, and no test could pin what a message holds.
- Do not add a switch whose only job is to add or remove a sentence: that is
  a prompt.
- Do not turn a feature on by default: a repo that never asked would spend
  the login on it.

History: Split out of the dispatcher repos file in #698, which kept only the rules that pass the admission test; that file's history, with every earlier decision, is in git. A ticket's own `Blocked until:` line holds it whatever the file says since #186. The config file is `.github/governor.json` since #525, one section per feature: a section turns its feature on unless it sets `"enabled": false`, and each setting and prompt sits in the section of the feature it serves.
