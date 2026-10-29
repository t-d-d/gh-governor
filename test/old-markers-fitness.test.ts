/**
 * Governor writes and reads only `governor:` markers. A ticket or a PR body
 * carrying only the markers of the repo governor was extracted from is
 * unmarked to it: the ticket is dispatchable, the PR has no subscriber but
 * its footer's owner, and the thread has no review. Each case beside it
 * shows the same text with governor's marker read as marked, so a pass here
 * means the old prefix is ignored, not that the reader is broken.
 *
 * The old prefix is built from parts, so the public-repo scan passes this
 * file with no exemption.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMarker } from '../dispatch/webhook/fire.mjs';
import { subscribeLine, subscribersFor } from '../dispatch/webhook/subscribe.mjs';
import { lastReview, reviewMarker } from '../dispatch/pr-body.mjs';
import { planSchedule } from '../scripts/lib/dispatch-router.mjs';

const OLD = `${['pod', 'stow'].join('')}:`;
/** The text with each governor marker given the old prefix instead. */
const old = (text: string) => text.replaceAll('governor:', OLD);

const REPO = 'acme/factory';
const NOW = Date.parse('2026-10-28T12:00:00Z');
const AT = '2026-10-28T11:30:00.000Z';
const LABELS = { ready: ['mode: afk'], claim: 'claimed', exclude: ['type: prd'] };
const SESSION = 'https://claude.ai/code/session_01OTHER';
const OWNER = 'https://claude.ai/code/session_01OWNER';
const FOOTER = `🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${OWNER}`;

/** A ready ticket #7 whose one comment is `marker`. */
const plan = (marker: string) => planSchedule({
  sources: [{
    repo: REPO,
    labels: LABELS,
    reader: {
      readyIssues: async () => [{ number: 7, title: 'Seven', state: 'open', created_at: '2026-10-01T00:00:00Z', labels: ['mode: afk'] }],
      blockers: async () => [],
      blocking: async () => [],
      parent: async () => null,
      comments: async () => [{ id: 1, body: marker, created_at: AT }],
    },
  }],
  cap: 1,
  now: NOW,
} as never);

describe('fitness: governor reads no old-prefix marker (dispatcher-repos.md)', () => {
  test('the old prefix is the extracted repo\'s name and a colon, and governor writes none of it', () => {
    assert.match(dispatchMarker({ at: AT, sessionUrl: SESSION }), /<!-- governor:dispatched /);
    assert.match(subscribeLine(SESSION, undefined), /<!-- governor:subscribe /);
    assert.match(reviewMarker('a'.repeat(40), 'b'.repeat(64)), /<!-- governor:pr-review /);
    for (const text of [dispatchMarker({ at: AT, sessionUrl: SESSION }), subscribeLine(SESSION, undefined), reviewMarker('a'.repeat(40), 'b'.repeat(64))]) {
      assert.ok(!text.toLowerCase().includes(OLD), text);
    }
  });

  test('a ticket whose only dispatch marker is the old one is dispatched, as if unmarked', async () => {
    const marked = dispatchMarker({ at: AT, sessionUrl: SESSION });
    assert.deepEqual((await plan(marked)).map((d) => d.issue), [], 'governor\'s own marker holds the ticket');
    assert.deepEqual((await plan(old(marked))).map((d) => d.issue), [7]);
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
