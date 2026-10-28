---
name: constraints
description: Check the architectural-constraint catalogue before changing code. Must run before making or planning any code or test edit, however small. Not needed for docs-only edits. Config, the deployment definition and package.json count as code.
allowed-tools: Bash(grep *), Bash(echo *)
---

# Constraints

`docs/constraints/` holds the architectural decisions in force, written as
instructions to whoever edits the code. Where a file there matches your
task, it is authoritative. The format is in `docs/constraints/README.md`.

## The catalogue

!`grep -H --exclude=README.md '^Relevance:' docs/constraints/*.md || echo "(catalogue empty or unreadable: run from the repo root and check with ls docs/constraints/)"`

The block above is the index: one `file:Relevance:` line per constraint
file. If you see anything else there, such as a placeholder or an error,
the command did not run. Run it yourself from the repo root.

## Procedure

1. A file matches if its `Relevance:` line names the kind of change you
   are making, or a path you will touch. When unsure whether a file
   matches, it matches. If no file matches, the set has no opinion on
   this change, so proceed.

2. Read every matching file completely before editing that area. Its
   `Rules` and `Do not` sections bind your change. Its `Judgment:` line,
   if it has one, names what no automated check holds.

3. If the task conflicts with a matching constraint, stop. That means the
   issue asks for something a rule forbids, or the natural implementation
   is listed under `Do not`. Tell the user, or say so in the pull request
   or the issue if you are working unattended. Do not quietly follow the
   issue, and do not quietly "improve" past the constraint. Changing a
   constraint takes an issue the owner agrees to, linked from the
   file's History line.

4. A sub-agent sees this text only if it invokes the skill itself. When
   you hand edits to a sub-agent, tell it in its prompt to invoke this
   skill before its first edit.
