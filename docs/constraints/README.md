# Constraints

The rules in force, one file per topic, written for whoever edits the code.
Each file says what the rule is, in a form short enough to read before
changing the code it covers. Why a rule changed lives in the issue where the
owner agreed it, linked from the file's History line.

There is no index table here, so two branches never conflict over one. The
`constraints` skill builds the index from each file's `Relevance:` line.

## Format

Every file has the same parts, in this order.

- **Relevance:** when to read the file, and the paths it covers.
- **Decision:** the rule in one line of 160 characters or fewer.
- **Why:** the reason, in a few lines.
- **Rules:** what must hold.
- **Examples:** optional. Where the rule shows in the code.
- **Do not:** the tempting alternatives that were rejected, each with its
  reason.
- **Judgment:** optional. What no automated check holds.
- **History:** where the rule came from, as issues of this repo.

A test that holds a rule is a fitness function: its describe name starts
`fitness:` and names the file in brackets, as in
`fitness: governor reads no old-prefix marker (dispatcher-repos.md)`.

## Changing a constraint

A change to what a rule means needs an issue the owner agrees to, linked
from the file's History line. A change of wording only needs none.
