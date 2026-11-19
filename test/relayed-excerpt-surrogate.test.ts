/**
 * A relayed body cut to fit is cut on a character. A cut that would land
 * between the two halves of a surrogate pair, such as an emoji, steps back
 * before the pair, so the excerpt never ends in a lone surrogate.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { routeEvent } from '../dispatch/webhook/route.mjs';

const REPO = 'acme/factory';
const SESSION = 'https://claude.ai/code/session_01PRSESSIONXYZ';
const footer = `\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${SESSION}`;
const alice = { login: 'alice', type: 'User' };
const prIssue = { number: 12, user: alice, author_association: 'OWNER', title: 'Add the retry', html_url: `https://github.com/${REPO}/pull/12`, body: `The change.${footer}`, pull_request: { url: 'x' } };

/** The cap on a relayed body, from dispatch/webhook/mention.mjs. */
const EXCERPT_CHARS = 1500;
const EMOJI = '😀';

const messageFor = (body: string) => {
  const fires = routeEvent({
    event: 'issue_comment',
    payload: { repository: { full_name: REPO }, action: 'created', issue: prIssue, comment: { id: 1, body, html_url: `${prIssue.html_url}#issuecomment-1`, user: alice, author_association: 'OWNER' } },
    owners: ['acme'],
    appId: 5075844,
  }).fires.map((f) => f.fire as { kind: string, session?: string, text?: string });
  const fire = fires.find((f) => f.kind === 'message' && f.session === SESSION);
  assert.ok(fire, `a message to ${SESSION}`);
  return String(fire.text);
};

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('a relayed body is cut on a character, not inside a surrogate pair', () => {
  test('a cut that lands inside a pair leaves no lone surrogate', () => {
    // The cut at EXCERPT_CHARS units falls between the halves of the first emoji.
    const body = `${'x'.repeat(EXCERPT_CHARS - 1)}${EMOJI.repeat(20)}`;
    const message = messageFor(body);
    assert.doesNotMatch(message, LONE);
    assert.match(message, new RegExp(`> ${'x'.repeat(EXCERPT_CHARS - 1)}\\n> \\[… ${body.length - (EXCERPT_CHARS - 1)} more characters at the URL above\\]`));
  });

  test('a quote cut to make room for the reply leaves no lone surrogate', () => {
    const reply = 'r'.repeat(100);
    const room = EXCERPT_CHARS - reply.length - 2;
    // The quote's cut at `room` units falls between the halves of the first emoji.
    const quote = `> ${'x'.repeat(room - 3)}${EMOJI.repeat(400)}`;
    const message = messageFor(`${quote}\n\n${reply}`);
    assert.doesNotMatch(message, LONE);
    assert.match(message, /more characters of the quote at the URL above/);
    assert.ok(message.includes(reply), 'the reply is kept whole');
  });
});
