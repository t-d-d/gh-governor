---
name: fetch-ticket
description: "Gather everything needed to work on a GitHub issue: its body, labels, blockers, the PRD issue and the issues it points to, and the constraint files that bind it. Run first whenever given an issue number."
argument-hint: "<issue-number>"
---

# Fetch a ticket

Gather context for issue $ARGUMENTS. Read the `github-tooling` skill first
if you have not used GitHub this session.

1. **Fetch the issue**: title, body, state and labels.
   `gh api repos/{owner}/{repo}/issues/<number>`.
2. **Stop if it is not yours to start.** That means it is closed, it is
   labelled `mode: human`, or another session's pull request for it is
   already open. Say which in a comment on the issue, and stop. If the
   open pull request is your own, carry on with it.
3. **Check the blockers.** The issue's dependencies list them
   (`gh api repos/{owner}/{repo}/issues/<number>/dependencies/blocked_by`),
   and so does a `Blocked by:` line in the body. Fetch each one's state. If any is open, say so in a comment on the issue and stop. A closed
   Human chore records its result in its closing comment. Read it when the
   issue says it needs that result.
4. **Read the comments** for anything the body does not already say. A
   well-written issue has nothing new there.
5. **Follow the links.** Read the PRD the body names (`Parent PRD: #N`),
   which is an issue labelled `type: prd`, and every issue it cites.
   Decisions live in issues, not in the repo.
6. **Run the `constraints` skill** and read every constraint file that
   matches the work.

Then state, before writing any code:

- what the issue delivers, in one or two sentences
- its acceptance criteria, copied exactly
- the constraint files that bind it
- anything in the issue that conflicts with a constraint or with the PRD.
  If there is a conflict, report it in a comment on the issue and stop.
