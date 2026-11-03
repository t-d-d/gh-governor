---
name: pr-review
description: The checklist governor's PR review reads for this repo's pull requests. Use to review a pull request here by hand.
---

# PR review

Read the pull request's description, its changed files and the tickets it
closes, then answer each test in order. The review sees no diff. The
description follows .github/pull_request_template.md, and the tests follow
its sections.

## The checklist

1. **Every ticket it closes is open, claimed and not a PRD.** A ticket
   labelled `type: prd` fails. One with neither `claimed` nor `mode: human`
   fails, and so does one another open pull request also closes. Governor
   checks this in code before the model reads anything.

2. **The Outcome is what the tickets it closes asked for.** It says what is
   true after the merge that was not before, and that is what each ticket's
   Change and acceptance criteria describe.

3. **Adds / removes names nothing only the owner can do.** That means a
   secret, a repository variable, the App's settings, the claude.ai login or
   an AWS setting. A line that needs one of them fails.

4. **Drift narrows the tickets, or says why it departs from them.** "Matches
   #N as written" passes when nothing departs. Work the tickets did not ask
   for, with no reason given, fails.

5. **The Verification table answers every acceptance criterion of every
   ticket it closes.** Each criterion has a row saying what answers it and
   where it is green. A criterion only the owner can check, after the merge,
   may say so.

6. **Left for later names an issue for each loose end, or says None.** A
   loose end with no issue number fails.

7. **No changed file is on the human-only list.** The list is
   `review.humanOnly` in `.github/dispatch.json`, and it is empty here. Governor
   checks this in code.

8. **No required status check is red on its head.** Governor checks this in
   code, and a push that turns the check green meets it.

## Dependabot

A pull request `dependabot[bot]` opened is held to test 7 alone, with the
Dependabot list (`review.dependabot` in `.github/dispatch.json`) in place of
the human-only list. That list is empty here, so every Dependabot pull request
waits for a person.

## The answer

`pass`, or `fail` with the first failed test's number, one sentence saying
what the description would need to state to meet it, and whether any edit to
the description can make the pull request pass.

## By hand

`/pr-review <number>` reads the pull request and reports the answer in the
chat. It posts nothing.
