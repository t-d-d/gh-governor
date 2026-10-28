---
name: pr-review
description: The checklist a served repo's PR review reads. A fixture, shaped like a real repo's.
---

# PR review

Read the PR's description and the tickets it closes, then answer each test
in order.

## The checklist

1. **Every ticket it closes is an implementation ticket with a `mode:`
   label.** A PRD fails. An ADR fails unless it is readied.

2. **It says what the change buys, and that is what the tickets it closes
   asked for.**

3. **It says what the change costs, and the cost is nothing a person should
   decide.** An IAM grant, a new paid service or a dropped safety check
   fails.

4. **Where it departs from a ticket it closes, it narrows.**

5. **Every acceptance criterion of every ticket it closes is answered.**

6. **Every loose end is closed.**

7. **No file is on the human-only list.** The list is `review.humanOnly` in
   `.github/dispatch.json`: each entry a glob and the reason its paths wait
   for a person. A changed file matching any entry fails, whatever the
   description says, and so does a rename away from one.

## Dependabot

A PR `dependabot[bot]` opened is held to test 7 alone, with the Dependabot
list (`review.dependabot` in `.github/dispatch.json`) in place of the
human-only list.

## The answer

`pass`, or `fail` with the first failed test's number, one sentence saying
what the description would need to state to meet it, and whether any edit to
the description can make the PR pass.

## By hand

`/pr-review <number>` reads the PR and reports the answer in the chat.
It posts nothing. For test 7, read `review.humanOnly` in
`.github/dispatch.json` and match every changed path against its globs.
