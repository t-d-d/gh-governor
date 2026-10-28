---
name: pre-push
description: "Catch up to origin/main, run the gate on the merged tree, review the diff with code-review, then push and raise or update the pull request. Run before every push."
---

# Pre-push

Order: catch up, check, review, push. A check only counts against the merged tree.

## 1. Catch up

`git fetch origin main`, merge it in, and resolve conflicts until
`git diff --check` is clean.

## 2. Run the gate on the merged tree

- `npm run gate` if you touched code. For a docs-only change, skip it.
- Re-read each constraint file whose `Relevance:` line matches a path in
  your diff (`git diff --name-only origin/main...HEAD`). Confirm the diff
  keeps every rule in it.
- If the diff changes what a rule in `docs/constraints/` means, the pull
  request must link the issue where the owner agreed the change, and
  update the file's History line. A rule's meaning does not change
  without one. A change of wording only needs none.

## 3. Review the diff

Run the `code-review` skill at `high --fix`, and tell it to review
`git diff origin/main...HEAD`. Without that range the skill reviews only
the commits since the last push, or compares against a local `main` that
step 1 did not update.

At high effort the skill also reports findings it is unsure of, and
`--fix` applies them all to the working tree before you judge them. It
reads neither the issue nor `docs/constraints/`. Judge each finding
against both, then read `git diff` and revert every fix you dismiss or
file.

If the skill is not available, start two sub-agents with a fresh context
over the same range, one for correctness and one for conventions and test
quality. Give both the issue text and the constraint files from step 2.
Judge their findings and apply the ones you fix yourself.

Every finding ends one of three ways:

- **Dismissed** as wrong. Dismiss a finding that names a failure only
  after you have traced it through the code or run it, and it did not
  happen. Saying it is wrong, or pointing at a line, is not enough.
- **Fixed** in this branch.
- **Filed** as an issue, when it is real but the branch did not cause it,
  or it is too big for a review fix. File it before pushing and link it
  under *Left for later*, saying that it is real and why it waits, so
  nobody reads it as declined. A finding that exists only in a pull
  request body is lost at merge.

If the review changed code, commit the fixes and run `npm run gate`
again.

## 4. Push

Fetch `origin/main` again. If it moved and touches anything your diff
touches, go back to step 1. Then push the branch. Never push to main.

## 5. Raise the pull request

- Ready for review, not draft.
- Title and body: the `pr-description` skill. On an existing pull request,
  run it again over the final diff.
- Confirm the pull request is mergeable, then wait for the `gate` check.
  If it is red, fix it and push again. Finish only on a green gate.
- Do not merge it. The owner merges.
