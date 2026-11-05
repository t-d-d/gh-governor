/**
 * What a PR or issue body says about who hears of it: the session
 * its Claude Code footer names, and every `governor:subscribe` line, each
 * with the events it asked for. Pure: the receiver and the task both read
 * bodies with it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SUBSCRIPTION_EVENTS } from '../dispatch/webhook/fire.mjs';
import {
  isSessionPost,
  ownSessionPost,
  postedBy,
  markOwnerUnknown,
  ownerUnknownSince,
  relinkSession,
  sameSession,
  sessionNamedIn,
  sessionsNamedIn,
  subscribeLine,
  subscribersFor,
  unsubscribe,
  unsignedPost,
  withoutQuotes,
  BODY_READ_LIMIT,
  NESTING_READ_LIMIT,
  pastReadingBound,
} from '../dispatch/webhook/subscribe.mjs';
import { mentions } from '../dispatch/webhook/mention.mjs';
import commonmark from '../dispatch/webhook/vendor/commonmark.cjs';

const OWNER = 'https://claude.ai/code/session_01OWNERAAA';
const REVIEWER = 'https://claude.ai/code/session_01REVIEWER';
const FILER = 'https://claude.ai/code/session_01FILERBBB';
const footer = `\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${OWNER}`;
/** What an issue's footer subscribes its filer to with no line. */
const FILER_EVENTS = SUBSCRIPTION_EVENTS.filter((event) => event !== 'labels' && event !== 'deploys');

/**
 * A takeover whose launch printed no session link leaves the archived
 * owner's link in place, so routing is unchanged, and adds one line saying
 * the PR's session is not known since when. The next relink removes it.
 */
describe('owner unknown', () => {
  const AT = '2026-11-05T09:12:00.000Z';
  const LATER = '2026-11-05T11:30:00.000Z';
  const body = `The change.${footer}`;

  test('the marker keeps the owner link, and is read back with its time', () => {
    const marked = markOwnerUnknown(body, AT);
    assert.equal(sessionNamedIn(marked), OWNER, 'routing still reaches the archived owner');
    assert.equal(ownerUnknownSince(marked), AT);
    assert.match(marked, /<!-- governor:owner-unknown 2026-11-05T09:12:00\.000Z -->$/m);
    assert.match(marked, /no session link/, 'a person reading the PR sees why');
    assert.equal(ownerUnknownSince(body), null);
  });

  test('marking again replaces the time; a relink removes the marker and names the new session', () => {
    const twice = markOwnerUnknown(markOwnerUnknown(body, AT), LATER);
    assert.equal(ownerUnknownSince(twice), LATER);
    assert.equal(twice.match(/governor:owner-unknown/g)?.length, 1);
    const relinked = relinkSession(twice, FILER);
    assert.equal(relinked, body.replace(OWNER, FILER));
    assert.equal(ownerUnknownSince(relinked), null);
  });

  test('an issue body ending in its link alone keeps that link its owner when marked', () => {
    const issue = `Filed.\n${FILER}`;
    const marked = markOwnerUnknown(issue, AT);
    assert.equal(sessionNamedIn(marked), FILER);
    assert.equal(ownerUnknownSince(marked), AT);
  });

  test('a marker above an owner link on the first line goes cleanly; the sentence comes before the comment, so GitHub renders it', () => {
    const marked = markOwnerUnknown(OWNER, AT);
    assert.equal(sessionNamedIn(marked), OWNER);
    assert.equal(relinkSession(marked, FILER), FILER);
    assert.match(marked, /^_Governor took this PR over/);
    const types: string[] = [];
    const walker = new commonmark.Parser().parse(marked).walker();
    for (let step = walker.next(); step !== null; step = walker.next()) if (step.entering) types.push(step.node.type);
    assert.ok(types.includes('emph') && !types.includes('html_block'), `the sentence renders as emphasis, not as a raw HTML block: ${types.join(' ')}`);
  });

  test('a body too long to read is not marked: nothing would read the line', () => {
    assert.throws(() => markOwnerUnknown(`${'x'.repeat(2 * BODY_READ_LIMIT + 1)}${footer}`, AT), /too long/);
  });

  test('a body naming no owner is marked at its end', () => {
    const marked = markOwnerUnknown('A person\'s PR.', AT);
    assert.equal(ownerUnknownSince(marked), AT);
    assert.equal(sessionNamedIn(marked), null);
  });

  test('a marker inside a quote, or one whose time does not parse, is not read', () => {
    const marked = markOwnerUnknown(body, AT);
    const quoted = `${marked.split('\n').map((l) => `> ${l}`).join('\n')}\n\nA reply.`;
    assert.equal(ownerUnknownSince(quoted), null);
    assert.equal(ownerUnknownSince(`${body}\n<!-- governor:owner-unknown yesterday -->`), null);
  });
});

describe('subscribersFor', () => {
  test('a PR\'s footer is its owner, subscribed to every event; a line adds a subscriber to the events it names', () => {
    const body = `The change.\n\n<!-- governor:subscribe ${REVIEWER} events=comments,pushes -->${footer}`;
    assert.deepEqual(subscribersFor(body, 'comments'), [{ session: OWNER, owner: true }, { session: REVIEWER, owner: false }]);
    assert.deepEqual(subscribersFor(body, 'pushes'), [{ session: OWNER, owner: true }, { session: REVIEWER, owner: false }]);
    assert.deepEqual(subscribersFor(body, 'reviews'), [{ session: OWNER, owner: true }]);
    assert.deepEqual(subscribersFor(body, 'deploys'), [{ session: OWNER, owner: true }]);
  });

  test('a line added below the footer is a subscriber, never the owner, and a relink leaves it be', () => {
    const body = `The change.${footer}\n\n${subscribeLine(REVIEWER, ['comments'])}\n`;
    assert.equal(sessionNamedIn(body), OWNER);
    assert.deepEqual(subscribersFor(body, 'comments'), [{ session: OWNER, owner: true }, { session: REVIEWER, owner: false }]);
    const relinked = relinkSession(body, FILER);
    assert.equal(relinked, body.replace(OWNER, FILER));
    assert.equal(sessionNamedIn(`${subscribeLine(REVIEWER)}\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`), null);
  });

  test('a footer naming no session, appended below the owner\'s by the tool that added a line, leaves the owner the owner', () => {
    const body = `The change.${footer}\n\n${subscribeLine(REVIEWER, ['comments'])}\n\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n`;
    assert.equal(sessionNamedIn(body), OWNER);
    assert.deepEqual(subscribersFor(body, 'comments'), [{ session: OWNER, owner: true }, { session: REVIEWER, owner: false }]);
    assert.equal(relinkSession(body, FILER), body.replace(OWNER, FILER));
    assert.equal(sessionNamedIn(`Cites ${OWNER}.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`), null, 'a link above every footer is a citation');
  });

  test('only a trailing footer naming no session is passed over: a "[Claude Code]" in the text does not make a citation below it the owner', () => {
    const prose = `@claude the [Claude Code] session ${OWNER} stalled; the [Claude Code] docs say why.`;
    assert.equal(sessionNamedIn(prose), null);
    assert.equal(isSessionPost(prose), false, 'a person\'s summons stays a summons');
    const tool = '\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n';
    const OLD = 'https://claude.ai/code/session_01OLDERONE';
    const body = `Built with [Claude Code]; supersedes ${OLD}.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)${tool}`;
    assert.equal(sessionNamedIn(body), null, 'the owner footer names nobody; the citation above it is not the owner');
    const relinked = relinkSession(body, FILER);
    assert.ok(relinked.includes(`supersedes ${OLD}.`), `a relink leaves a citation be: ${relinked}`);
    assert.equal(sessionNamedIn(relinked), FILER);
  });

  // `mcp__github__issue_write` strips the footer from an issue body and puts
  // none back, leaving the filer's link as the body's last line: fourteen
  // issues once closed with nobody told.
  test('an issue body the GitHub tool left with no footer, ending in the filer\'s link, names the filer its owner', () => {
    const body = `## What is verified\n\nThe sweep.\n\n## Cost of not doing\n\nNobody notices.\n${FILER}`;
    assert.equal(sessionNamedIn(body), FILER);
    for (const event of FILER_EVENTS) assert.deepEqual(subscribersFor(body, event), [{ session: FILER, owner: true }], event);
    const subscribed = `${body}\n\n${subscribeLine(REVIEWER, ['close'])}\n`;
    assert.equal(sessionNamedIn(subscribed), FILER, 'a line added below is a subscriber, never the owner');
    assert.deepEqual(subscribersFor(subscribed, 'close'), [{ session: FILER, owner: true }, { session: REVIEWER, owner: false }]);
    assert.equal(sessionNamedIn(`${body}\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n`), FILER, 'a trailing footer naming nobody is passed over, as ever');
    assert.equal(relinkSession(body, OWNER), body.replace(FILER, OWNER));
  });

  test('with no footer, a link names the owner only as the whole of the last line: a citation in a sentence is a citation', () => {
    assert.equal(sessionNamedIn(`Filed by a person. See ${FILER}.`), null);
    assert.equal(sessionNamedIn(`Filed.\n\nRelated: ${FILER}`), null);
    assert.equal(sessionNamedIn(`${FILER}\n\nFiled by a person.`), null, 'a link above the last line is a citation');
    assert.equal(sessionNamedIn(`Filed.\n  ${FILER}  \n\n`), FILER, 'space around it is still the whole line');
  });

  test('a member\'s body ending in a quoted session footer and link names no owner; a session\'s own body still does', () => {
    const quote = (post: string) => post.split('\n').map((l) => `> ${l}`).join('\n');
    const footerLine = '---\n_Generated by [Claude Code](https://claude.ai/code)_';
    const quotedPr = `Seen this?\n\n${quote(`Fixed.${footer}`)}`;
    const quotedComment = `As the session said:\n\n${quote(`Fixed.\n\n${FILER}\n\n${footerLine}`)}`;
    const quotedLink = `As the session said:\n\n${quote(`Fixed.\n\n${FILER}`)}`;
    for (const body of [quotedPr, quotedComment, quotedLink]) {
      assert.equal(sessionNamedIn(body), null, body);
      assert.deepEqual(subscribersFor(body, 'comments', { issue: true }), [], body);
    }
    assert.equal(sessionNamedIn(`${quote(`Fixed by ${FILER}.`)}\n\nFiled.${footer}`), OWNER, 'a session quoting another is still the owner');
    assert.equal(sessionNamedIn(`${quote('A person wrote this.')}\n\nFiled.\n\n${FILER}`), FILER, 'the filer\'s link alone on the last line still names it');
    const relinked = relinkSession(quotedPr, FILER);
    assert.equal(sessionNamedIn(relinked), FILER, 'a handoff onto a body quoting a footer names the new owner');
    assert.match(relinked, /^> /m, 'the quote is kept');
  });

  test('a link a member cites on a line of its own, with a quote below it, is a citation, not the owner', () => {
    const cited = `Seen this from the session:\n\n${FILER}\n\n> Fixed.\n> It was the cache.`;
    assert.equal(sessionNamedIn(cited), null, 'a quote under the link is more than a rule');
    assert.deepEqual(subscribersFor(cited, 'comments', { issue: true }), []);
    assert.equal(sessionNamedIn(relinkSession(cited, OWNER)), OWNER, 'a handoff appends the new owner');
  });

  test('a person\'s summons whose last line is a session link stays a summons', () => {
    assert.equal(isSessionPost(`@claude this one stalled, can you look?\n${FILER}`), false);
  });

  test('a line with no events asks for all of them', () => {
    const body = `An issue.\n\n${subscribeLine(FILER)}\n`;
    for (const event of SUBSCRIPTION_EVENTS) {
      assert.deepEqual(subscribersFor(body, event), [{ session: FILER, owner: false }], event);
    }
  });

  test('an issue\'s footer is its owner, as a PR\'s is: the session the standing search counts hears every event but labels and deploys', () => {
    for (const event of FILER_EVENTS) assert.deepEqual(subscribersFor(`Filed.${footer}`, event, { issue: true }), [{ session: OWNER, owner: true }], event);
    assert.deepEqual(subscribersFor(`Filed.${footer}\n${subscribeLine(FILER, ['close'])}`, 'close'), [{ session: OWNER, owner: true }, { session: FILER, owner: false }]);
    assert.deepEqual(subscribersFor(`Filed.${footer}\n${subscribeLine(FILER, ['close'])}`, 'labels'), []);
  });

  // A label carries no text, so nothing names the session that set it: a
  // filer that labels its own issue would be told of its own labels.
  test('the owner hears of labels only through a line of its own', () => {
    assert.deepEqual(subscribersFor(`Filed.${footer}`, 'labels'), []);
    assert.deepEqual(subscribersFor(`Filed.${footer}\n${subscribeLine(FILER)}`, 'labels'), [{ session: FILER, owner: false }]);
    assert.deepEqual(subscribersFor(`Filed.${footer}\n${subscribeLine(OWNER, ['labels'])}`, 'labels'), [{ session: OWNER, owner: true }], 'still the owner');
    assert.deepEqual(subscribersFor(`Filed.${footer}\n${subscribeLine(OWNER, ['labels'])}`, 'close'), [{ session: OWNER, owner: true }], 'once');
  });

  // Most filers sign off when the issue closes at merge, so each deployed:
  // label would reach an archived session by default.
  test('an issue\'s owner hears of deploys only through a line of its own; a PR\'s owner hears them by default', () => {
    assert.deepEqual(subscribersFor(`Filed.${footer}`, 'deploys', { issue: true }), []);
    assert.deepEqual(subscribersFor(`Filed.${footer}\n${subscribeLine(FILER)}`, 'deploys', { issue: true }), [{ session: FILER, owner: false }]);
    assert.deepEqual(subscribersFor(`Filed.${footer}\n${subscribeLine(OWNER, ['deploys'])}`, 'deploys', { issue: true }), [{ session: OWNER, owner: true }], 'still the owner');
    assert.deepEqual(subscribersFor(`Filed.${footer}`, 'close', { issue: true }), [{ session: OWNER, owner: true }], 'every other event as before');
    assert.deepEqual(subscribersFor(`The change.${footer}`, 'deploys'), [{ session: OWNER, owner: true }]);
    assert.deepEqual(subscribersFor(`The change.${footer}`, 'deploys', { issue: false }), [{ session: OWNER, owner: true }]);
  });

  test('the owner named again in a line is still one subscriber, the owner; a session named twice is one, its events joined', () => {
    const body = `${subscribeLine(OWNER, ['close'])}\n${subscribeLine(REVIEWER, ['comments'])}\n${subscribeLine(REVIEWER, ['reviews'])}${footer}`;
    assert.deepEqual(subscribersFor(body, 'comments'), [{ session: OWNER, owner: true }, { session: REVIEWER, owner: false }]);
    assert.deepEqual(subscribersFor(body, 'reviews'), [{ session: OWNER, owner: true }, { session: REVIEWER, owner: false }]);
  });

  test('the vocabulary is closed: an event it does not know subscribes to nothing, and a malformed line is no line', () => {
    const body = [
      `<!-- governor:subscribe ${REVIEWER} events=everything -->`,
      '<!-- governor:subscribe https://claude.ai/code/session_01 -->',
      `<!-- governor:subscribe ${FILER}-older -->`,
      `<!-- governor:subscribe https://example.com/session_01ELSEWHERE -->`,
    ].join('\n');
    for (const event of SUBSCRIPTION_EVENTS) assert.deepEqual(subscribersFor(body, event), [], event);
    assert.deepEqual(subscribersFor(`<!-- governor:subscribe ${REVIEWER} events=comments,everything -->`, 'comments'), [{ session: REVIEWER, owner: false }]);
  });

  test('a body that is not a string subscribes nobody', () => {
    assert.deepEqual(subscribersFor(null, 'comments'), []);
    assert.deepEqual(subscribersFor(undefined, 'close'), []);
  });
});

// The standing line counts a body for the sessions on it: its owner and
// each session a line subscribes, whatever events. A session a member's
// text cites or quotes is not on it.
describe('sessionsNamedIn', () => {
  test('is the ids of the owner and every subscriber, once each, and no session only cited or quoted', () => {
    const body = `Cites ${FILER}.\n\n> ${REVIEWER}\n${subscribeLine(REVIEWER, ['labels'])}${subscribeLine(OWNER)}${footer}`;
    assert.deepEqual([...sessionsNamedIn(body)].sort(), ['session_01OWNERAAA', 'session_01REVIEWER']);
    assert.deepEqual([...sessionsNamedIn(`Cites ${FILER}.\n\n> ${OWNER}`)], []);
    assert.deepEqual([...sessionsNamedIn(null)], []);
  });
});

describe('unsubscribe', () => {
  test('drops every line naming the session, and nothing else', () => {
    const body = `Top.\n\n${subscribeLine(REVIEWER, ['comments'])}\n${subscribeLine(FILER)}\n${subscribeLine(REVIEWER, ['close'])}${footer}`;
    const after = unsubscribe(body, 'session_01REVIEWER');
    assert.deepEqual(subscribersFor(after, 'comments'), [{ session: OWNER, owner: true }, { session: FILER, owner: false }]);
    assert.deepEqual(subscribersFor(after, 'close'), [{ session: OWNER, owner: true }, { session: FILER, owner: false }]);
    assert.equal(after, `Top.\n\n${subscribeLine(FILER)}${footer}`);
  });

  test('a body with no line for the session is returned as it was: the owner\'s footer is not a line', () => {
    const body = `Top.${footer}`;
    assert.equal(unsubscribe(body, OWNER), body);
  });
});

describe('the poster', () => {
  test('postedBy is the session a post names, above or below the footer; a person\'s post, citing one or not, is nobody\'s', () => {
    const footerLine = '---\n_Generated by [Claude Code](https://claude.ai/code)_';
    assert.equal(postedBy(`Fixed.\n\n${footerLine}\n\n${REVIEWER}`), REVIEWER);
    assert.equal(postedBy(`Fixed.\n\n${REVIEWER}\n\n${footerLine}`), REVIEWER);
    assert.equal(postedBy(`Handed to ${FILER}.\n\n${REVIEWER}\n\n${footerLine}`), REVIEWER, 'its own URL, the last one, not one it cites');
    assert.equal(postedBy(`Fixed.\n\n${footerLine}`), null);
    assert.equal(postedBy(`A person citing ${REVIEWER}.`), null);
  });

  test('postedBy names no session a post only cites or quotes: a footer with no URL of its own, a reply quoting a session\'s post', () => {
    const footerLine = '---\n_Generated by [Claude Code](https://claude.ai/code)_';
    assert.equal(postedBy(`Handed to ${FILER}.\n\n${footerLine}`), null, 'a citation above the footer is not the poster');
    assert.equal(postedBy(`The [Claude Code] footer names ${FILER}, not this post's author.\n\n${footerLine}`), null, 'nor one below "[Claude Code]" in the text');
    const quote = (post: string) => post.split('\n').map((l) => `> ${l}`).join('\n');
    assert.equal(postedBy(`${quote(`Fixed.\n\n${REVIEWER}\n\n${footerLine}`)}\n\nNot fixed: the test still fails.`), null);
    assert.equal(postedBy(`${quote(`Fixed.\n\n${footerLine}\n\n${REVIEWER}`)}\n\nNot fixed.`), null);
    assert.equal(postedBy(`Not fixed.\n\n${quote(`Fixed.\n\n${REVIEWER}\n\n${footerLine}`)}`), null);
    assert.equal(postedBy(`${quote(`Fixed by ${FILER}.`)}\n\nAgreed.\n\n${REVIEWER}\n\n${footerLine}`), REVIEWER, 'a session quoting another is still the poster');
  });

  test('a session\'s post ends with the footer and its URL; the footer alone is still a session\'s post, naming none', () => {
    const own = `Fixed.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n\n${REVIEWER}`;
    assert.equal(sessionNamedIn(own), REVIEWER);
    assert.equal(isSessionPost(own), true);
    const anonymous = 'Fixed.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_';
    assert.equal(sessionNamedIn(anonymous), null);
    assert.equal(isSessionPost(anonymous), true);
    assert.equal(isSessionPost(`A person citing ${REVIEWER}.`), false);
  });

  test('ownSessionPost reads the footer outside quotes: a person\'s reply quoting a session\'s post is the person\'s', () => {
    const footerLine = '---\n_Generated by [Claude Code](https://claude.ai/code)_';
    const quote = (post: string) => post.split('\n').map((l) => `> ${l}`).join('\n');
    assert.equal(ownSessionPost(`Fixed.\n\n${footerLine}`), true);
    assert.equal(ownSessionPost(`Fixed.\n\n${footerLine}\n\n${REVIEWER}`), true);
    assert.equal(ownSessionPost(`${quote(`Fixed.\n\n${footerLine}`)}\n\nNot fixed.`), false);
    assert.equal(ownSessionPost(`${quote(`Fixed.\n\n${footerLine}\n\n${REVIEWER}`)}\n\nNot fixed.`), false);
    assert.equal(ownSessionPost(`${quote('Not fixed.')}\n\nFixed now.\n\n${footerLine}`), true, 'a session quoting a person is still a session');
  });

  test('sameSession compares ids, a URL or a bare id', () => {
    assert.equal(sameSession(REVIEWER, 'session_01REVIEWER'), true);
    assert.equal(sameSession(REVIEWER, OWNER), false);
  });
});

describe('quotes as GitHub renders them', () => {
  const footerLine = '---\n_Generated by [Claude Code](https://claude.ai/code)_';
  const quoted = (text: string, line: string) => withoutQuotes(text).split('\n')[text.split('\n').indexOf(line)]?.trim() === '';

  test('a lazy continuation, a line with no > under a quoted paragraph, is quoted', () => {
    const body = `> Fixed.\n${FILER}`;
    assert.equal(quoted(body, FILER), true);
    assert.equal(sessionNamedIn(body), null, 'a pasted quote and link under it name no owner');
    assert.equal(postedBy(`> Fixed.\n${REVIEWER}\n\n${footerLine}`), null, 'the link is in the quote, not above the footer');
    assert.equal(ownSessionPost(`> Fixed.\n${footerLine.split('\n')[1]}\n\nNot fixed.`), false);
    assert.equal(unsignedPost(`> Fixed.\n${footerLine.split('\n')[1]}\n\nNot fixed.`), false);
    assert.equal(mentions('> Ask\n@claude about it.\n\nNo.'), false);
    assert.equal(mentions('> Ask\n    @claude about it.'), false, 'an indented line under a quote is lazy too, not code');
  });

  test('a blank line, a heading, a rule, a list item, a fence or an HTML comment ends the quote', () => {
    for (const between of ['\n', '# Heading\n', '---\n', '- item\n', '```\n```\n', '<!-- note -->\n']) {
      const body = `> Fixed.\n${between}${FILER}`;
      assert.equal(quoted(body, FILER), false, JSON.stringify(between));
    }
    assert.equal(quoted(`>\n${FILER}`, FILER), false, 'an empty quote line opens no paragraph');
    assert.equal(quoted(`> # Fixed\n${FILER}`, FILER), false, 'a quoted heading opens no paragraph');
    assert.equal(quoted(`> \`\`\`\n${FILER}`, FILER), false, 'a quoted fence takes no lazy line');
    assert.equal(sessionNamedIn(`Filed.\n\n> Fixed.\n\n${FILER}`), FILER);
  });

  test('a quote in a list item is quoted, and so is its lazy continuation', () => {
    assert.equal(quoted(`- > Fixed by ${FILER}`, `- > Fixed by ${FILER}`), true);
    assert.equal(quoted(`1. > Fixed by ${FILER}`, `1. > Fixed by ${FILER}`), true);
    assert.equal(quoted(`- a\n  > Fixed by ${FILER}`, `  > Fixed by ${FILER}`), true, 'under an item, at its indent');
    assert.equal(sessionNamedIn(`Seen this?\n\n- > Fixed.\n  >\n  > ${FILER}`), null);
    assert.equal(sessionNamedIn(`- > Fixed.\n${FILER}`), null);
    assert.equal(postedBy(`- > Fixed.\n  > ${REVIEWER}\n  > ${footerLine.split('\n')[1]}\n\nNot fixed.`), null);
    assert.equal(mentions('- > @claude said so.'), false);
  });

  test('a > line in a fenced or indented code block is code, not a quote', () => {
    const fenced = `Run this:\n\n\`\`\`\n> ${FILER}\n\`\`\`\n\nDone.`;
    assert.equal(quoted(fenced, `> ${FILER}`), false);
    assert.equal(quoted(`~~~~\n> a\n~~~\n> b\n~~~~\n`, '> b'), false, 'a shorter fence does not close it');
    assert.equal(quoted(`\`\`\`\n\`\`\`\n> b`, '> b'), true, 'after the fence closes, a quote is a quote');
    assert.equal(quoted(`Run this:\n\n    > ${FILER}\n`, `    > ${FILER}`), false, 'indented four spaces after a blank line');
    assert.equal(quoted(`\t> ${FILER}`, `\t> ${FILER}`), false, 'a tab indents four');
    assert.equal(quoted(`Text\n    > ${FILER}`, `    > ${FILER}`), false, 'four spaces under a paragraph continue it, and start no quote');
    assert.equal(quoted(`   > ${FILER}`, `   > ${FILER}`), true, 'three spaces still quote');
    assert.equal(postedBy(`Fixed.\n\n\`\`\`\n> ${REVIEWER}\n\`\`\`\n\n${REVIEWER}\n\n${footerLine}`), REVIEWER);
    assert.equal(ownSessionPost(`Fixed.\n\n\`\`\`\n> x\n\`\`\`\n\n${footerLine}`), true);
    assert.equal(mentions('```\n> @claude\n```'), false, 'code, still no mention');
    assert.equal(sessionNamedIn(`Filed.\n\n\`\`\`\n> ${FILER}\n\`\`\`\n\n${OWNER}`), OWNER);
  });

  test('a body with CRLF line ends reads as one with LF: a rule or an empty heading still ends the quote', () => {
    for (const between of ['---\r\n', '#\r\n', '# Heading\r\n']) {
      const body = `> Fixed.\r\n${between}${FILER}`;
      assert.equal(quoted(body, FILER), false, JSON.stringify(between));
    }
    assert.equal(mentions('> Ask\r\n---\r\n@claude about it.'), true);
  });

  test('a fence in a list item closes at the item\'s indent, and with the item', () => {
    const nested = '1. a\n   - b\n     ```\n     x\n     ```\n';
    assert.equal(quoted(`${nested}> ${FILER}`, `> ${FILER}`), true, 'closed at the nested item\'s indent');
    assert.equal(mentions(`${nested}> @claude`), false);
    assert.equal(quoted(`- \`\`\`\n> ${FILER}`, `> ${FILER}`), true, 'a line left of the item ends it, and its fence');
    assert.equal(quoted(`- \`\`\`\n\n  > ${FILER}`, `  > ${FILER}`), false, 'a blank line inside the fence keeps it open');
  });

  test('a tab after a list marker counts toward its width, so a quote after it is quoted', () => {
    assert.equal(quoted(`-\t> ${FILER}`, `-\t> ${FILER}`), true);
    assert.equal(quoted(`1.\t> ${FILER}`, `1.\t> ${FILER}`), true);
    assert.equal(sessionNamedIn(`Seen this?\n\n-\t> Fixed.\n\n\t> ${FILER}`), null, 'the tab-indented line is in the item, quoted');
    assert.equal(mentions('-\t> @claude said so.'), false);
  });

  test('list items nest, and a line is read in the deepest item it is indented into', () => {
    assert.equal(quoted(`- a\n  - b\n\n  c\n\n     > ${FILER}`, `     > ${FILER}`), true, 'three in from the outer item, once the inner one closed');
    assert.equal(quoted(`- a\n  - b\n\n  c\n\n      > ${FILER}`, `      > ${FILER}`), false, 'four in from the outer item is code');
    assert.equal(quoted(`- a\n  - b\n\n      > ${FILER}`, `      > ${FILER}`), true, 'two in from the inner item');
    assert.equal(quoted(`- a\n    - b\n  c\n\n      > ${FILER}`, `      > ${FILER}`), true, 'a lazy line keeps the inner item open');
    assert.equal(mentions('- a\n  - b\n\n  c\n\n     > @claude'), false);
  });

  test('an HTML block\'s lines are raw text, not quotes, until the block ends', () => {
    assert.equal(quoted(`<details>\n> ${FILER}\n</details>`, `> ${FILER}`), false);
    assert.equal(mentions('<details>\n> @claude look at this\n</details>'), true);
    assert.equal(quoted(`<!--\n> a\n-->\n> ${FILER}`, '> a'), false, 'a comment over several lines');
    assert.equal(quoted(`<!--\n> a\n-->\n> ${FILER}`, `> ${FILER}`), true, 'after the comment ends, a quote is a quote');
    assert.equal(quoted(`<details>\n\n> ${FILER}`, `> ${FILER}`), true, 'a blank line ends a block tag\'s block');
    assert.equal(quoted(`<script>\n\n> a\n</script>\n> ${FILER}`, '> a'), false, 'a blank line does not end a script');
    assert.equal(quoted(`Text\n<details>\n> ${FILER}`, `> ${FILER}`), false, 'a block tag interrupts a paragraph');
    assert.equal(quoted(`<span>\n> ${FILER}`, `> ${FILER}`), false, 'a lone inline tag starts a block');
    assert.equal(quoted(`Text\n<span>\n> ${FILER}`, `> ${FILER}`), true, 'but cannot interrupt a paragraph');
    assert.equal(quoted(`- <details>\n  > ${FILER}`, `  > ${FILER}`), false, 'in a list item');
    assert.equal(quoted(`- <details>\n> ${FILER}`, `> ${FILER}`), true, 'a line left of the item ends it, and its block');
    assert.equal(quoted('> <span>\nfoo', 'foo'), false, 'a quoted HTML block takes no lazy line');
    assert.equal(quoted('> <details>\n> text\nfoo', 'foo'), false, 'nor after a later line of the block');
    assert.equal(quoted('> <!--\n> a\n> -->\n> b\nfoo', 'foo'), true, 'once the quoted block ends, a quoted paragraph takes one');
    assert.equal(quoted('> a\n> <span>\nfoo', 'foo'), true, 'a lone inline tag in a quoted paragraph does not end it');
    assert.equal(quoted(`<?>\n> ${FILER}`, `> ${FILER}`), true, 'a processing instruction can end on the line it opens');
    assert.equal(quoted('a\n-     x\n<span>\n  > y', '  > y'), false, 'a new item opens no paragraph, so a lone tag after its code starts a block');
    assert.equal(quoted('> <div>\n- > x\nfoo', 'foo'), true, 'a quote in a new item is a new quote, outside the block above');
    assert.equal(quoted('> ```\n- > x\nfoo', 'foo'), true, 'and outside the fence above');
  });

  test('a quote in a fenced block inside a quote stays quoted, and the quote ends with the fence\'s quote', () => {
    assert.equal(quoted('> ```\n> > x\n> ```', '> > x'), true);
    assert.equal(sessionNamedIn(`> \`\`\`\n> ${FILER}\n> \`\`\``), null);
  });

  /** The 1-based numbers of the lines `withoutQuotes` blanks, of those with text. */
  const quotedNumbers = (text: string): number[] => {
    const blanked = withoutQuotes(text).split('\n');
    return text.split('\n').flatMap((line, i) => (line.trim() !== '' && blanked[i]?.trim() === '' ? [i + 1] : []));
  };

  // Each body with the lines cmark-gfm, GitHub's own parser, renders in a quote.
  const GITHUB_QUOTES: Array<[string, number[]]> = [
    ['-\n  > x', [2]],
    ['1.\n    > x', [2]],
    ['> x\n-', [1]],
    ['1. a\n2. > x', [2]],
    ['> x\n10) a', [1]],
    ['> - a\n- b', [1]],
    ['> a\n>     b\nfoo', [1, 2, 3]],
    ['-\t> link', [1]],
    ['- a\n  - b\n\n      > x', [4]],
    ['<details>\n> x\n</details>', []],
  ];

  test('each case the spike compared with GitHub is quoted on the lines GitHub quotes', () => {
    for (const [body, lines] of GITHUB_QUOTES) assert.deepEqual(quotedNumbers(body), lines, JSON.stringify(body));
  });

  test('a lone carriage return ends a line, as it does on GitHub, and the result keeps every index', () => {
    const body = '> a\r\rb';
    assert.equal(withoutQuotes(body), '   \r\rb');
    assert.equal(mentions('> a\r\r@claude look'), true);
    assert.equal(mentions('> a\r@claude look'), false, 'a lazy line after a lone carriage return');
  });
});

describe('parsing a body', () => {
  /** Runs `read` with every Parser made counted: its parses, and the paragraphs and headings it read inline. */
  const counting = (read: () => void): { parses: number, inlines: number } => {
    const { Parser } = commonmark;
    const counts = { parses: 0, inlines: 0 };
    // A Parser is a plain object with its own parse, so the count wraps each one made.
    commonmark.Parser = function (...args: ConstructorParameters<typeof Parser>) {
      const parser = new Parser(...args) as InstanceType<typeof Parser> & { inlineParser: { parse: (node: unknown) => void } };
      const parse = parser.parse.bind(parser);
      parser.parse = (input: string) => {
        counts.parses += 1;
        return parse(input);
      };
      const inline = parser.inlineParser.parse.bind(parser.inlineParser);
      parser.inlineParser.parse = (node: unknown) => {
        counts.inlines += 1;
        inline(node);
      };
      return parser;
    } as unknown as typeof Parser;
    try {
      read();
    } finally {
      commonmark.Parser = Parser;
    }
    return counts;
  };

  test('reads a body once, however many readers ask', () => {
    const body = `> Fixed.\n${REVIEWER}\n\n@claude look\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_ ${Date.now()}`;
    const { parses } = counting(() => {
      postedBy(body);
      unsignedPost(body);
      ownSessionPost(body);
      mentions(body);
    });
    assert.equal(parses, 1);
  });

  // The receiver reads a remark and the PR it is on in turn (mention.mjs).
  test('reads a remark and its PR\'s body once each, though the readers take them in turn', () => {
    const pr = `The change.${footer} ${Date.now()}`;
    const remark = `> Fixed.\n\n@claude look ${Date.now()}`;
    const { parses } = counting(() => {
      sessionNamedIn(pr);
      mentions(remark);
      sessionNamedIn(pr);
      subscribersFor(pr, 'comments');
      postedBy(remark);
      ownSessionPost(remark);
      unsignedPost(remark);
      subscribersFor(pr, 'comments');
    });
    assert.equal(parses, 2);
  });

  test('reads only where the quotes are, not the text inside each paragraph', () => {
    const { inlines } = counting(() => withoutQuotes(`> *a* [b](c)\n\n# d\n\ne ${Date.now()}`));
    assert.equal(inlines, 0);
  });

  // A quote nested deep, with many lazy lines under it, puts each line in
  // the source range of every quote around it.
  test('reads a deeply nested quote with many lazy lines in time linear in the body', () => {
    const depth = 20000;
    const body = `${'>'.repeat(depth)} a\n${'b\n'.repeat(depth)}`;
    const started = performance.now();
    const blanked = withoutQuotes(body);
    const took = performance.now() - started;
    assert.equal(blanked.trim(), '');
    assert.ok(took < 2000, `${took} ms for ${body.length} characters`);
  });
});

describe('a body too large or too deeply nested to read in time', () => {
  // A list opened in a list on one line costs the parser time that grows
  // with the square of the depth: this body took seconds on a dev machine.
  const nested = (link: string) => `${'- '.repeat(16000)}@claude look\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n${link}`;

  test('the nested-list body is read in time, and read as all quoted', () => {
    const body = nested(REVIEWER);
    const started = performance.now();
    const blanked = withoutQuotes(body);
    const took = performance.now() - started;
    assert.ok(took < 200, `${took} ms for ${body.length} characters`);
    assert.equal(blanked.trim(), '');
    assert.equal(pastReadingBound(body), true);
  });

  test('nothing in it summons or names a session', () => {
    const body = `${nested(REVIEWER)}\n\n${OWNER}`;
    assert.equal(mentions(body), false);
    assert.equal(postedBy(body), null);
    assert.equal(sessionNamedIn(body), null);
    assert.equal(ownSessionPost(body), false);
    assert.equal(unsignedPost(body), false);
  });

  test('a body longer than the limit is read as all quoted', () => {
    const body = `@claude look\n${'a'.repeat(BODY_READ_LIMIT)}${footer}`;
    assert.equal(pastReadingBound(body), true);
    assert.equal(mentions(body), false);
    assert.equal(sessionNamedIn(body), null);
  });

  test('a body at the limit is read as written', () => {
    const head = '@claude look\n';
    const body = `${head}${'a'.repeat(BODY_READ_LIMIT - head.length - footer.length)}${footer}`;
    assert.equal(body.length, BODY_READ_LIMIT);
    assert.equal(pastReadingBound(body), false);
    assert.equal(mentions(body), true);
    assert.equal(sessionNamedIn(body), OWNER);
  });

  test('a line opening as many lists as the limit is read as written; one more is past it', () => {
    const within = `${'- 1) + '.repeat(Math.floor(NESTING_READ_LIMIT / 3))}${'* '.repeat(NESTING_READ_LIMIT % 3)}@claude look`;
    assert.equal(pastReadingBound(within), false);
    assert.equal(mentions(within), true);
    const past = `${within.slice(0, -'@claude look'.length)}+ @claude look`;
    assert.equal(pastReadingBound(past), true);
    assert.equal(mentions(past), false);
  });

  test('a body of ordinary depth, however many lines, is read as written', () => {
    const body = `${'- a\n  - b\n    > c\n'.repeat(500)}\n@claude look${footer}`;
    assert.equal(pastReadingBound(body), false);
    assert.equal(mentions(body), true);
    assert.equal(sessionNamedIn(body), OWNER);
  });

  test('a quote opened on a line counts toward the limit as a list does', () => {
    assert.equal(pastReadingBound(`${'> '.repeat(NESTING_READ_LIMIT)}a`), false);
    assert.equal(pastReadingBound(`${'> - '.repeat(NESTING_READ_LIMIT / 2)}>a`), true);
  });

  test('a rule of spaced dashes or stars, however long, opens nothing', () => {
    const body = `${'- '.repeat(40)}\n${' * '.repeat(40)}\n\n@claude look`;
    assert.equal(pastReadingBound(body), false);
    assert.equal(mentions(body), true);
  });

  test('the limit counts characters, not UTF-16 code units', () => {
    const body = `@claude look\n${'😀'.repeat(BODY_READ_LIMIT / 2 + 100)}`;
    assert.ok(body.length > BODY_READ_LIMIT);
    assert.equal(pastReadingBound(body), false);
    assert.equal(mentions(body), true);
  });

  test('relinking a body past the bound refuses, rather than writing a link nothing reads', () => {
    assert.throws(() => relinkSession(nested(OWNER), REVIEWER), /too long or too deeply nested/);
  });

  test('a rule or an emphasis is no list', () => {
    assert.equal(pastReadingBound(`${'-'.repeat(40)}\n${'* '.repeat(2)}*${'*'.repeat(40)}\n${'-x '.repeat(40)}`), false);
  });
});
