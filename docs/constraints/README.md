# Constraints

The rules in force, one file per topic, written for whoever edits the code.
Each file says what the rule is, in a form short enough to read before
changing the code it covers. Why a rule changed lives in the issue where the
owner agreed it, linked from the file's History line.

There is no index table here, so two branches never conflict over one. The
`constraints` skill builds the index from each file's `Relevance:` line.

## Format

Every file has the same parts, in this order.

- **Relevance:** when to read the file, and the file globs it covers.
- **Decision:** the rule in one line.
- **Why:** the reason, in a few lines.
- **Rules:** what must hold.
- **Examples:** optional. Where the rule shows in the code.
- **Do not:** the tempting alternatives that were rejected, each with its
  reason.
- **Judgment:** optional. What no automated check holds.
- **History:** where the rule came from, as issues of this repo.

A test that holds a rule is a fitness function: its describe name starts
`fitness:` and names the file in brackets, as in
`fitness: governor reads no old-prefix marker (ticket-roles.md)`.

## Caps

`npm run constraints`, a step of `npm run gate`, holds every file to these
(scripts/constraints-check.mjs):

- `Relevance:` is exactly one line of at most 240 characters after the
  label, and names file globs.
- `Decision:` is exactly one line of at most 160 characters after the label.
- A whole file is at most 120 lines. A file that cannot fit is split by
  topic.
- Every file is cited by a `fitness:` test the gate runs, or its `Judgment:`
  line says what no check can see.
- Every constraint path cited anywhere in the repo resolves. A test's full
  `docs/constraints/` path is a fixture, not a citation.
- Every path a `Relevance:` line names matches a tracked file, and every
  file it matches is under a code tree in the `paths:` list of
  `.claude/rules/constraints.md`.
- No file describes unbuilt work, such as "not yet built" or "lands with".
  Decided work that is not built lives in its ticket.

## What belongs here

A rule belongs in a constraint file when breaking it would be costly or hard
to undo, and a reader of the code would not notice. A leaked token, a
session started on a stranger's text, a merge nobody looked at and a loop
that spends the login are costly. A rule the code shows plainly, or one a
test fails on the moment it breaks, needs no file.

Behaviour detail belongs in code and tests: message wording, retry counts,
timing, which row of a decision table does what, a parser's grammar.

## Changing a constraint

A change to what a rule means needs an issue the owner agrees to, linked
from the file's History line. A change of wording only needs none.

A change of meaning changes what a compliant implementation looks like.
Adding an example, sharpening a `Relevance:` glob or splitting a file is
wording. A split must keep the new `Relevance:` lines matching every task
the old one matched.
