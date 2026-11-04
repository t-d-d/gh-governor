/**
 * What a dispatched session is told and called, and how the launcher's exit
 * status is read. The selection rule is `test/scripts/ready-work.test.ts`;
 * the plan is `test/scripts/dispatch-router.test.ts`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { launchOutcome, promptFor, sessionName } from '../../scripts/lib/dispatch-prompt.mjs';

describe('promptFor', () => {
  const TITLE = 'Article headline spoken twice when the body opens with its own title';

  test('names the issue, the repo, and the Closes trailer', () => {
    const prompt = promptFor(700, TITLE, 'acme/factory', 'workflow: under development');
    assert.match(prompt, /#700/);
    assert.match(prompt, /acme\/factory/);
    assert.match(prompt, /Closes #700/);
  });

  // The dispatcher claims the ticket before the launch, so the
  // session finds it under development and must proceed, not stop.
  test('tells the session the dispatcher claimed the issue for it', () => {
    assert.match(promptFor(700, TITLE, 'o/r', 'workflow: under development'), /dispatcher claimed #700 for this session/);
  });

  test('names the factory\'s claim label when the repo gives none', () => {
    assert.match(promptFor(700, TITLE, 'o/r', 'workflow: under development'), /`workflow: under development`/);
  });

  test('tells the session it is unattended', () => {
    assert.match(promptFor(1, TITLE, 'o/r', 'workflow: under development'), /[Uu]nattended/);
  });

  /**
   * The lead line is context, not naming: it puts the issue's title in front
   * of the session before it fetches anything. Naming is `sessionName` plus
   * the launcher's `--name`, because the namer summarises the prompt rather
   * than copying this line.
   */
  test('leads with the number and title', () => {
    const first = promptFor(700, TITLE, 'o/r', 'workflow: under development').split('\n')[0] ?? '';
    assert.match(first, /^Pickup #700 /);
    assert.ok(first.includes(TITLE), 'the title must survive into the first line');
  });

  test('keeps the lead on one line when the title carries newlines', () => {
    // A title pasted with a line break would otherwise push the number onto
    // its own line and hand the namer a fragment.
    const first = promptFor(7, 'Broken\n\ttitle   here', 'o/r', 'workflow: under development').split('\n')[0] ?? '';
    assert.equal(first, "Pickup #7 'Broken title here'");
  });

  test('survives an apostrophe in the title', () => {
    const first = promptFor(3317, "Nemo branch's artefact tag", 'o/r', 'workflow: under development').split('\n')[0] ?? '';
    assert.ok(first.includes("Nemo branch's artefact tag"));
  });

  test('still works when the title is missing', () => {
    const prompt = promptFor(7, undefined, 'o/r', 'workflow: under development');
    assert.match(prompt, /^Pickup #7\b/);
    assert.match(prompt, /Closes #7/);
  });
});

/**
 * The default pickup prompt checks the ticket against the code before it
 * builds. A ticket the code already settles, or one far larger than it reads,
 * gets a comment and no build, and keeps its claim so pickup does not start
 * it again. No PR closes to ask such a session to sign off, so where the repo
 * turns `signOff` on the stop asks it, in the repo's own words where it has
 * them. A repo's own `pickup` prompt is sent as it is.
 */
describe('promptFor: the check before building', () => {
  const CLAIM = 'workflow: under development';

  test('tells the session to read the ticket against the code first', () => {
    const prompt = promptFor(700, 'T', 'o/r', CLAIM);
    assert.match(prompt, /Before you build, read #700 against the code/);
    assert.ok(prompt.indexOf('against the code') < prompt.indexOf('Closes #700'), 'the check comes before the build');
  });

  test('on either finding, comments, stops without building and leaves the claim', () => {
    const prompt = promptFor(700, 'T', 'o/r', CLAIM);
    assert.match(prompt, /already does what it asks/);
    assert.match(prompt, /far larger than the ticket reads/);
    assert.match(prompt, /comment on #700/);
    assert.match(prompt, /stop without building/);
    assert.match(prompt, /Leave `workflow: under development` on #700/);
  });

  test('carries no ask to sign off where the switch is off', () => {
    assert.doesNotMatch(promptFor(700, 'T', 'o/r', CLAIM), /[Ss]ign(ing)? (this session )?off/);
    assert.doesNotMatch(promptFor(700, 'T', 'o/r', CLAIM, { signOff: 'Say goodbye.' }, { signOff: false }), /goodbye/);
  });

  test('asks the session that stopped to sign off where the switch is on', () => {
    const prompt = promptFor(700, 'T', 'o/r', CLAIM, {}, { signOff: true });
    assert.match(prompt, /If you stopped at the check, no pull request will close to ask you to sign off\. Sign this session off unless you know otherwise/);
    assert.match(prompt, /`Signing off\.`/);
  });

  test("asks in the repo's signOff prompt where it sets one", () => {
    const prompt = promptFor(700, 'T', 'o/r', CLAIM, { signOff: 'End with `Signing off.` and nothing after it.' }, { signOff: true });
    assert.match(prompt, /If you stopped at the check, no pull request will close to ask you to sign off\. End with `Signing off\.` and nothing after it\.$/);
    assert.doesNotMatch(prompt, /unless you know otherwise/);
  });

  test("sends a repo's own pickup prompt unchanged, whatever the switch says", () => {
    const own = 'Build #{issue} in {repo}.';
    for (const signOff of [true, false]) {
      assert.equal(promptFor(700, 'T', 'o/r', CLAIM, { pickup: own }, { signOff }), "Pickup #700 'T'\n\nBuild #700 in o/r.");
    }
  });
});

describe('sessionName', () => {
  /**
   * Set explicitly via the CLI's `--name` rather than left to the namer:
   * `Pickup #705 'A revocation parked after the purchase door's re-read is
   * still never routed'` came back as "Revocation routing after purchase door
   * re-read", a summary no backlog can be matched against.
   */
  test('is the number and title, as the sessions pane should read', () => {
    assert.equal(sessionName(705, 'A revocation parked'), '#705 A revocation parked');
  });

  test('flattens a title that spans lines', () => {
    assert.equal(sessionName(7, 'Broken\n  title'), '#7 Broken title');
  });

  test('falls back to the bare number when there is no title', () => {
    assert.equal(sessionName(7, undefined), '#7');
    assert.equal(sessionName(7, '   '), '#7');
  });
});

describe('launchOutcome', () => {
  test('a confirmed dispatch is a dispatch', () => {
    assert.equal(launchOutcome(0), 'dispatched');
  });

  test('an elapsed window is unconfirmed, not a failure', () => {
    assert.equal(launchOutcome(3), 'unconfirmed');
  });

  test('anything else is a failure the turn must report', () => {
    // 1 is the launcher's "nothing started"; null is a launcher killed by a
    // signal, which is equally not a dispatch.
    assert.equal(launchOutcome(1), null);
    assert.equal(launchOutcome(null), null);
  });

  /**
   * The status reaching this function is `python3`'s, not only the launcher's.
   * `python3` exits 2 of its own accord when it cannot open the script, which
   * is what a moved or unreadable `dispatch/launch-session.py` gives,
   * and no `claude` was spawned at all. Reading that as unconfirmed would send
   * someone to claude.ai/code after a run that never attempted anything.
   */
  test('the interpreter’s own failure status is a failure, not an unconfirmed dispatch', () => {
    assert.equal(launchOutcome(2), null);
  });
});
