/**
 * A served repo's heartbeat issue (dispatch/heartbeat.mjs). Governor keeps
 * its own block under `<!-- governor:heartbeat -->`: one line for pickup and
 * one per periodic, which a check outside governor reads back. The turn that writes them is in
 * test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HEARTBEAT_END, HEARTBEAT_MARKER, HEARTBEAT_REFUSED, HEARTBEAT_UNWRITTEN, readHeartbeat, stampHeartbeat, writeHeartbeatIssue } from '../dispatch/heartbeat.mjs';
import * as heartbeat from '../dispatch/heartbeat.mjs';

const AT = '2026-10-29T20:00:00.000Z';
const EARLIER = '2026-10-28T08:00:00.000Z';
const SESSION = 'https://claude.ai/code/session_01RUN';
const OTHER = 'https://claude.ai/code/session_01OTHER';
const BODY = `The operator's words.\n\n${HEARTBEAT_MARKER}\n\nKeep this issue open.\n`;

describe('the older shape is gone', () => {
  test('nothing reads or stamps a last-run line under a repo\'s own marker', () => {
    assert.equal('readLastRun' in heartbeat, false);
    assert.equal('stampLastRun' in heartbeat, false);
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

  test('a periodic governor has read but not fired gets a first-read line, with no session, and reads back', () => {
    const body = stampHeartbeat(BODY, { periodics: [{ name: 'Weekly retro', at: EARLIER, session: null, state: 'not fired' }] });
    assert.match(body, /^- periodic "Weekly retro": first read 2026-10-28T08:00:00\.000Z, session none, not fired yet$/m);
    assert.deepEqual(readHeartbeat(body).periodics, [{ name: 'Weekly retro', at: EARLIER, session: null, state: 'not fired' }]);
  });

  test('a first read only adds a missing line, and never replaces one', () => {
    const fired = stampHeartbeat(BODY, { periodics: [{ name: 'Weekly retro', at: EARLIER, by: { days: 7 }, session: SESSION, state: 'signed off' }] });
    assert.equal(stampHeartbeat(fired, { periodics: [{ name: 'Weekly retro', at: AT, session: null, state: 'not fired' }] }), fired);
    const read = stampHeartbeat(BODY, { periodics: [{ name: 'Weekly retro', at: EARLIER, session: null, state: 'not fired' }] });
    assert.equal(stampHeartbeat(read, { periodics: [{ name: 'Weekly retro', at: AT, session: null, state: 'not fired' }] }), read, 'a second first read keeps the first');
  });

  test('the first real fire replaces a first-read line', () => {
    const read = stampHeartbeat(BODY, { periodics: [{ name: 'Weekly retro', at: EARLIER, session: null, state: 'not fired' }] });
    const fired = stampHeartbeat(read, { periodics: [{ name: 'Weekly retro', at: AT, by: { days: 7 }, session: SESSION, state: 'open' }] });
    assert.deepEqual(readHeartbeat(fired).periodics, [{ name: 'Weekly retro', at: AT, by: { days: 7 }, session: SESSION, state: 'open' }]);
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

  test('a first read pairs only with not fired yet, and a last fire never with it: a mixed line is not governor\'s', () => {
    const body = BODY.replace(HEARTBEAT_MARKER, `${HEARTBEAT_MARKER}\n- periodic "A": first read ${EARLIER}, session ${SESSION}, open\n- periodic "B": last fire ${EARLIER}, session none, not fired yet\n${HEARTBEAT_END}`);
    assert.deepEqual(readHeartbeat(body).periodics, []);
  });
});

describe('the session rules line: which file lacks the current block (#611)', () => {
  test('a missing block and an old one each get a line naming the file, and read back', () => {
    const missing = stampHeartbeat(BODY, { rules: { file: 'CLAUDE.md', block: 'missing' } });
    assert.match(missing, /^- session rules: "CLAUDE\.md" has no session rules block$/m);
    assert.deepEqual(readHeartbeat(missing).rules, { file: 'CLAUDE.md', block: 'missing' });
    const old = stampHeartbeat(BODY, { rules: { file: 'docs/AGENTS.md', block: 'old' } });
    assert.match(old, /^- session rules: "docs\/AGENTS\.md" has an old session rules block$/m);
    assert.deepEqual(readHeartbeat(old).rules, { file: 'docs/AGENTS.md', block: 'old' });
  });

  test('a later pickup or periodic write keeps the line, after the others', () => {
    let body = stampHeartbeat(BODY, { rules: { file: 'CLAUDE.md', block: 'missing' } });
    body = stampHeartbeat(body, { pickup: { at: AT, started: 1 } });
    body = stampHeartbeat(body, { periodics: [{ name: 'A', at: AT, by: { days: 1 }, session: SESSION, state: 'open' }], signedOff: ['session_01RUN'] });
    assert.deepEqual(readHeartbeat(body).rules, { file: 'CLAUDE.md', block: 'missing' });
    const block = body.slice(body.indexOf(HEARTBEAT_MARKER), body.indexOf(HEARTBEAT_END));
    assert.deepEqual(block.split('\n').slice(1, -1).map((l) => l.split(':')[0]), ['- pickup', '- periodic "A"', '- session rules']);
  });

  test('a current block, given as null, clears the line, and a body with none has nothing to clear', () => {
    const body = stampHeartbeat(BODY, { pickup: { at: AT, started: 1 }, rules: { file: 'CLAUDE.md', block: 'old' } });
    const cleared = stampHeartbeat(body, { rules: null });
    assert.equal(readHeartbeat(cleared).rules, undefined);
    assert.ok(!cleared.includes('session rules'), cleared);
    assert.deepEqual(readHeartbeat(cleared).pickup, { at: AT, started: 1 });
    assert.deepEqual(readHeartbeat(stampHeartbeat(BODY, { rules: null })), { periodics: [] });
  });

  test('a body with no rules line reads with no rules key', () => {
    assert.equal('rules' in readHeartbeat(stampHeartbeat(BODY, { pickup: { at: AT, started: 0 } })), false);
  });
});

describe('writing a heartbeat issue: one helper reads it, checks governor\'s marker and writes it', () => {
  const MARKER = HEARTBEAT_MARKER;
  const stamp = (b: string) => stampHeartbeat(b, { pickup: { at: AT, started: 1 } });
  /** A reader over one issue body, recording each write. */
  const fakeReader = (body: string, fail?: 'read' | 'write') => {
    const writes: string[] = [];
    return {
      writes,
      issue: async () => { if (fail === 'read') throw new Error('read refused'); return { body }; },
      updateIssue: async (_n: number, { body: next }: { body: string }) => { if (fail === 'write') throw new Error('write refused'); writes.push(next); },
    };
  };
  const logs = () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    return { lines, log: (event: string, fields: Record<string, unknown>) => { lines.push([event, fields]); } };
  };

  test('writes the stamped body into a body carrying the marker', async () => {
    const github = fakeReader(`${MARKER}\n`);
    const { lines, log } = logs();
    const outcome = await writeHeartbeatIssue({ reader: async () => github, repo: 'acme/factory', issue: 7, refusal: 'no marker', stamp, log });
    assert.equal(outcome, 'written');
    assert.deepEqual(github.writes, [stamp(`${MARKER}\n`)]);
    assert.deepEqual(lines, []);
  });

  test('a body carrying only some other marker is refused and never written', async () => {
    const github = fakeReader('Someone\'s ticket.\n<!-- factory:routine-heartbeat -->\n');
    const { lines, log } = logs();
    const outcome = await writeHeartbeatIssue({ reader: async () => github, repo: 'acme/factory', issue: 7, refusal: 'no marker', stamp: () => 'overwritten', log });
    assert.equal(outcome, 'refused');
    assert.deepEqual(github.writes, []);
    assert.deepEqual(lines, [[HEARTBEAT_REFUSED, { level: 'error', repo: 'acme/factory', issue: 7, marker: MARKER, reason: 'no marker' }]]);
  });

  test('a stamp that changes nothing writes nothing', async () => {
    const github = fakeReader(`${MARKER}\n`);
    const { lines, log } = logs();
    assert.equal(await writeHeartbeatIssue({ reader: async () => github, repo: 'acme/factory', issue: 7, refusal: 'no marker', stamp: () => undefined, log }), 'unchanged');
    assert.deepEqual(github.writes, []);
    assert.deepEqual(lines, []);
  });

  for (const fail of ['reader', 'read', 'write'] as const) {
    test(`a failed ${fail} is logged and comes back unwritten`, async () => {
      const github = fakeReader(`${MARKER}\n`, fail === 'reader' ? undefined : fail);
      const { lines, log } = logs();
      const reader = fail === 'reader' ? async () => { throw new Error('no token'); } : async () => github;
      const outcome = await writeHeartbeatIssue({ reader, repo: 'acme/factory', issue: 7, refusal: 'no marker', stamp, log });
      const error = fail === 'reader' ? 'no token' : `${fail} refused`;
      assert.deepEqual(outcome, { unwritten: `acme/factory#7: ${error}` });
      assert.deepEqual(lines, [[HEARTBEAT_UNWRITTEN, { level: 'error', repo: 'acme/factory', issue: 7, error }]]);
    });
  }

  test('turn.mjs writes a heartbeat issue only through it, and sweep.mjs leaves the write to the turn', async () => {
    const { readFile } = await import('node:fs/promises');
    const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const turn = await read('dispatch/turn.mjs');
    const sweep = await read('dispatch/sweep.mjs');
    assert.match(turn, /writeHeartbeatIssue\(/, 'turn.mjs calls the helper');
    assert.doesNotMatch(sweep, /writeHeartbeatIssue|last-run/, 'sweep.mjs writes no heartbeat issue');
    for (const [file, text] of [['dispatch/turn.mjs', turn], ['dispatch/sweep.mjs', sweep]] as const) {
      assert.doesNotMatch(text, /HEARTBEAT_REFUSED|HEARTBEAT_UNWRITTEN|dispatch-heartbeat-refused|dispatch-heartbeat-unwritten/, `${file} logs no heartbeat refusal or failed write of its own`);
    }
  });
});
