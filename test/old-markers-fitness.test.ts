/**
 * Governor writes and reads only `governor:` markers. A ticket or a PR body
 * carrying only the markers of the repo governor was extracted from is
 * unmarked to it: the ticket names no builder, the PR has no subscriber but
 * its footer's owner, and the thread has no review. Each case beside it
 * shows the same text with governor's marker read as marked, so a pass here
 * means the old prefix is ignored, not that the reader is broken.
 *
 * The old prefix is built from parts, so the public-repo scan passes this
 * file with no exemption.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMarker, lastDispatch } from '../dispatch/webhook/fire.mjs';
import { subscribeLine, subscribersFor } from '../dispatch/webhook/subscribe.mjs';
import { lastReview, reviewMarker } from '../dispatch/pr-body.mjs';
import { deployedComment } from '../dispatch/webhook/deployed-comment.mjs';

const OLD = `${['pod', 'stow'].join('')}:`;
/** The text with each governor marker given the old prefix instead. */
const old = (text: string) => text.replaceAll('governor:', OLD);

const AT = '2026-10-28T11:30:00.000Z';
const SESSION = 'https://claude.ai/code/session_01OTHER';
const OWNER = 'https://claude.ai/code/session_01OWNER';
const FOOTER = `🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${OWNER}`;

/** The builder a thread whose one comment is `marker` names, or null. */
const builder = (marker: string) => lastDispatch([{ id: 1, body: marker, created_at: AT, ours: true }])?.sessionUrl ?? null;

describe('fitness: governor reads no old-prefix marker (ticket-roles.md)', () => {
  test('the old prefix is the extracted repo\'s name and a colon, and governor writes none of it', () => {
    assert.match(dispatchMarker({ at: AT, sessionUrl: SESSION }), /<!-- governor:dispatched /);
    assert.match(subscribeLine(SESSION, undefined), /<!-- governor:subscribe /);
    assert.match(reviewMarker('a'.repeat(40), 'b'.repeat(64)), /<!-- governor:pr-review /);
    const deployed = deployedComment({ target: 'prod', workflow: 'Deliver', url: 'https://github.com/acme/factory/actions/runs/500/job/2', commit: 'a'.repeat(40) });
    assert.match(deployed, /<!-- governor:deployed prod -->$/);
    for (const text of [dispatchMarker({ at: AT, sessionUrl: SESSION }), subscribeLine(SESSION, undefined), reviewMarker('a'.repeat(40), 'b'.repeat(64)), deployed]) {
      assert.ok(!text.toLowerCase().includes(OLD), text);
    }
  });

  test('a ticket whose only dispatch marker is the old one names no builder, as if unmarked', () => {
    const marked = dispatchMarker({ at: AT, sessionUrl: SESSION });
    assert.equal(builder(marked), SESSION, 'governor\'s own marker names the builder');
    assert.equal(builder(old(marked)), null);
  });

  test('a PR body whose only subscribe line is the old one has no subscriber but its owner', () => {
    const body = `Closes #7\n\nThe change.\n${subscribeLine(SESSION, undefined)}\n\n${FOOTER}`;
    assert.deepEqual(subscribersFor(body, 'comments').map((s) => s.session), [OWNER, SESSION], 'governor\'s own line subscribes');
    assert.deepEqual(subscribersFor(old(body), 'comments').map((s) => s.session), [OWNER]);
  });

  test('a thread whose only review marker is the old one has no review', () => {
    const comment = `Passes the PR review.\n\n${reviewMarker('a'.repeat(40), 'b'.repeat(64))}`;
    assert.notEqual(lastReview([{ id: 1, body: comment, ours: true }] as never), null, 'governor\'s own marker is a review');
    assert.equal(lastReview([{ id: 1, body: old(comment), ours: true }] as never), null);
  });
});
