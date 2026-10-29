/**
 * A served repo's heartbeat issue (dispatch/heartbeat.mjs). In today's
 * `{ issue, marker }` shape governor keeps one `last-run:` line under the
 * repo's own marker. In the `{ issue }` shape it keeps its own block under
 * `<!-- governor:heartbeat -->`: one line for pickup and one per periodic,
 * which a check outside governor reads back. The turn that writes them is in
 * test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HEARTBEAT_END, HEARTBEAT_MARKER, readHeartbeat, readLastRun, stampHeartbeat, stampLastRun } from '../dispatch/heartbeat.mjs';

const AT = '2026-10-29T20:00:00.000Z';
const EARLIER = '2026-10-28T08:00:00.000Z';
const SESSION = 'https://claude.ai/code/session_01RUN';
const OTHER = 'https://claude.ai/code/session_01OTHER';
const BODY = `The operator's words.\n\n${HEARTBEAT_MARKER}\n\nKeep this issue open.\n`;

describe('the old shape: one last-run line under the repo\'s marker', () => {
  const MARKER = '<!-- factory:routine-heartbeat -->';

  test('adds the line after the marker, then moves it, keeping the rest of the body', () => {
    const once = stampLastRun(`${MARKER}\n\nKeep this closed.\n`, MARKER, AT);
    assert.equal(once, `${MARKER}\nlast-run: ${AT}\n\nKeep this closed.\n`);
    assert.equal(readLastRun(once, MARKER), AT);
    assert.equal(stampLastRun(once, MARKER, EARLIER), once.replace(AT, EARLIER));
  });

  test('a body without the marker is refused', () => {
    assert.throws(() => stampLastRun('someone\'s ticket', MARKER, AT), /marker/);
    assert.throws(() => readLastRun('someone\'s ticket', MARKER), /marker/);
  });
});

describe('the governor block: a line for pickup and one per periodic', () => {
  test('the marker is governor\'s own', () => {
    assert.equal(HEARTBEAT_MARKER, '<!-- governor:heartbeat -->');
    assert.match(HEARTBEAT_END, /^<!-- governor:/);
  });

  test('a body without the marker is refused, read or written', () => {
    assert.throws(() => stampHeartbeat('someone\'s ticket', { pickup: { at: AT, started: 1 } }), /governor:heartbeat/);
    assert.throws(() => readHeartbeat('someone\'s ticket'), /governor:heartbeat/);
  });

  test('a body with only the marker reads as nothing recorded', () => {
    assert.deepEqual(readHeartbeat(BODY), { periodics: [] });
  });

  test('pickup\'s line gives the last sweep\'s time and how many sessions it started', () => {
    const body = stampHeartbeat(BODY, { pickup: { at: AT, started: 2 } });
    assert.match(body, /^- pickup: last sweep 2026-10-29T20:00:00\.000Z, started 2 sessions$/m);
    assert.deepEqual(readHeartbeat(body).pickup, { at: AT, started: 2 });
    assert.match(stampHeartbeat(BODY, { pickup: { at: AT, started: 1 } }), /started 1 session$/m);
  });

  test('a periodic\'s line gives its last fire, the limit that fired it, the session and its state, and reads back', () => {
    const lines = [
      { name: 'Code review', at: AT, by: { count: 'merges', number: 20 }, session: SESSION, state: 'open' },
      { name: 'Ticket "triage"', at: AT, by: { count: 'issuesOpened', number: 5 }, session: SESSION, state: 'signed off' },
      { name: 'Closed', at: AT, by: { count: 'issuesClosed', number: 1 }, session: OTHER, state: 'held' },
      { name: 'Weekly retro', at: EARLIER, by: { days: 7 }, session: null, state: 'nothing to do' },
      { name: 'Daily', at: EARLIER, by: { days: 1 }, session: SESSION, state: 'open' },
    ];
    const body = stampHeartbeat(BODY, { periodics: lines as never });
    assert.match(body, /^- periodic "Code review": last fire 2026-10-29T20:00:00\.000Z, by 20 merges, session https:\/\/claude\.ai\/code\/session_01RUN, open$/m);
    assert.match(body, /^- periodic "Weekly retro": last fire 2026-10-28T08:00:00\.000Z, by its day limit of 7 days, session none, nothing to do$/m);
    assert.match(body, /by its day limit of 1 day, /);
    assert.match(body, /by 5 issues opened, .*, signed off$/m);
    assert.match(body, /by 1 issue closed, session https:\/\/claude\.ai\/code\/session_01OTHER, held while that session is open$/m);
    assert.deepEqual(readHeartbeat(body).periodics, lines);
  });

  test('governor changes nothing in the body outside its own block', () => {
    const first = stampHeartbeat(BODY, { pickup: { at: EARLIER, started: 0 } });
    const [before, after] = BODY.split(HEARTBEAT_MARKER);
    assert.ok(first.startsWith(`${before}${HEARTBEAT_MARKER}\n`), first);
    assert.ok(first.endsWith(`${HEARTBEAT_END}${after}`), first);
    const second = stampHeartbeat(first, { pickup: { at: AT, started: 3 } });
    assert.ok(second.startsWith(`${before}${HEARTBEAT_MARKER}\n`) && second.endsWith(`${HEARTBEAT_END}${after}`), second);
    assert.equal(second.split(HEARTBEAT_MARKER).length, 2, 'one block');
    assert.equal(second.split(HEARTBEAT_END).length, 2, 'one end');
  });

  test('a change leaves the lines it does not name, and a periodic\'s line keeps the fields it does not give', () => {
    const fired = stampHeartbeat(BODY, {
      pickup: { at: EARLIER, started: 1 },
      periodics: [{ name: 'Code review', at: EARLIER, by: { count: 'merges', number: 20 }, session: SESSION, state: 'open' }, { name: 'Weekly retro', at: EARLIER, by: { days: 7 }, session: OTHER, state: 'open' }],
    });
    const held = stampHeartbeat(fired, { periodics: [{ name: 'Code review', state: 'held' }] });
    assert.deepEqual(readHeartbeat(held), {
      pickup: { at: EARLIER, started: 1 },
      periodics: [
        { name: 'Code review', at: EARLIER, by: { count: 'merges', number: 20 }, session: SESSION, state: 'held' },
        { name: 'Weekly retro', at: EARLIER, by: { days: 7 }, session: OTHER, state: 'open' },
      ],
    });
  });

  test('a held fire with no line yet writes one at the open run\'s start, naming its session, with no limit', () => {
    const body = stampHeartbeat(BODY, { periodics: [{ name: 'Code review', at: EARLIER, session: SESSION, state: 'held' }] });
    assert.match(body, /^- periodic "Code review": last fire 2026-10-28T08:00:00\.000Z, session https:\/\/claude\.ai\/code\/session_01RUN, held while that session is open$/m);
    assert.deepEqual(readHeartbeat(body).periodics, [{ name: 'Code review', at: EARLIER, session: SESSION, state: 'held' }]);
  });

  test('a periodic change with no line and no fire time writes nothing', () => {
    assert.deepEqual(readHeartbeat(stampHeartbeat(BODY, { periodics: [{ name: 'Code review', state: 'held' }] })).periodics, []);
  });

  test('signed off marks the open or held line naming the session, and never moves its fire time', () => {
    const fired = stampHeartbeat(BODY, {
      periodics: [
        { name: 'Code review', at: EARLIER, by: { count: 'merges', number: 20 }, session: SESSION, state: 'open' },
        { name: 'Weekly retro', at: EARLIER, by: { days: 7 }, session: SESSION, state: 'held' },
        { name: 'Ticket review', at: EARLIER, by: { days: 3 }, session: OTHER, state: 'open' },
        { name: 'Daily', at: EARLIER, by: { days: 1 }, session: null, state: 'nothing to do' },
      ],
    });
    const marked = readHeartbeat(stampHeartbeat(fired, { signedOff: ['session_01RUN'] })).periodics;
    assert.deepEqual(marked.map((l) => [l.name, l.at, l.state]), [
      ['Code review', EARLIER, 'signed off'],
      ['Weekly retro', EARLIER, 'signed off'],
      ['Ticket review', EARLIER, 'open'],
      ['Daily', EARLIER, 'nothing to do'],
    ]);
  });

  test('pickup\'s line comes first, then the periodics in the order governor first wrote them', () => {
    let body = stampHeartbeat(BODY, { periodics: [{ name: 'B', at: AT, by: { days: 1 }, session: null, state: 'nothing to do' }] });
    body = stampHeartbeat(body, { pickup: { at: AT, started: 0 }, periodics: [{ name: 'A', at: AT, by: { days: 1 }, session: SESSION, state: 'open' }] });
    const block = body.slice(body.indexOf(HEARTBEAT_MARKER), body.indexOf(HEARTBEAT_END));
    assert.deepEqual(block.split('\n').slice(1, -1).map((l) => l.split(':')[0]), ['- pickup', '- periodic "B"', '- periodic "A"']);
  });

  test('a line in the block governor cannot read is dropped: the block is governor\'s', () => {
    const body = BODY.replace(HEARTBEAT_MARKER, `${HEARTBEAT_MARKER}\nsomething typed here\n- pickup: last sweep ${EARLIER}, started 1 session\n${HEARTBEAT_END}`);
    const stamped = stampHeartbeat(body, { periodics: [{ name: 'A', at: AT, by: { days: 1 }, session: SESSION, state: 'open' }] });
    assert.ok(!stamped.includes('something typed here'));
    assert.deepEqual(readHeartbeat(stamped).pickup, { at: EARLIER, started: 1 });
  });
});
