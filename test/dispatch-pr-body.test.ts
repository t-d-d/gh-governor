/**
 * The PR body's grammar: the tickets a body closes, the owners its
 * Verification table and Left for later name, and the marker a review's
 * comment ends with. Pure and config-free: the review, the conflict turn
 * and the coverage plan import it, and none of them reads a file: a
 * review's lists are the repo's settings.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { bodyDigest, closingTickets, lastReview, namedOwners, proseClosings, reviewMarker } from '../dispatch/pr-body.mjs';

const REPO = 'acme/factory';
const HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const MOVED = 'ffffffffffffffffffffffffffffffffffffffff';
const BODY = 'Closes #748\n\nAdds the review fire.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_01OWNER';
const ROOT = new URL('..', import.meta.url);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

type Thread = { id: number; body: string; created_at: string; ours: boolean };

const marked = (text: string, head = HEAD, body = BODY) => `${text}\n\n${reviewMarker(head, bodyDigest(body))}`;

describe('the PR body\'s grammar', () => {
  test('closingTickets reads every closing keyword on a top line, once each, and nothing else', () => {
    assert.deepEqual(closingTickets('Closes #748'), [748]);
    assert.deepEqual(closingTickets('fixes #1, resolves #2 and Closed #1.\n\nRefs #3. See #4.'), [1, 2]);
    assert.deepEqual(closingTickets('Nothing here #12'), []);
    // GitHub reads a colon after the keyword too.
    assert.deepEqual(closingTickets('Closes: #748'), [748]);
    assert.deepEqual(closingTickets('FIXES:#7 and Resolves:  #8'), [7, 8]);
    // GitHub closes this repository's issue by its URL or owner/repo#N too;
    // another repository's issue is none of this one's.
    assert.deepEqual(closingTickets(`Closes https://github.com/${REPO}/issues/9 and fixes ${REPO}#10`, REPO), [9, 10]);
    assert.deepEqual(closingTickets('Closes https://github.com/other/repo/issues/9 and fixes other/repo#10', REPO), []);
  });

  test('closingTickets reads only the `Closes #N` lines at the top of the body, and on each only its leading run of references', () => {
    // Blank lines and a list marker aside, the top ends at the first line
    // that is not all references.
    assert.deepEqual(closingTickets('\nCloses #1\r\n- Closes #2\n\nCloses #3, closes #4\nAdds it.\n\nCloses #5'), [1, 2, 3, 4]);
    assert.deepEqual(closingTickets('Adds it.\n\nCloses #1'), []);
    // A hard-wrapped paragraph's next line is prose, whatever it opens with.
    assert.deepEqual(closingTickets('Closes #877\n\nThe marker is gone. #853\nfixed #840, but a later PR re-added it.'), [877]);
    // A line holding anything but references is below the top, its own
    // references included, and so is every line after it.
    assert.deepEqual(closingTickets('Closes #877\n\nFixed #840 in #853, but a later PR re-added it.'), [877]);
    assert.deepEqual(closingTickets('Closes #1; the old code fixed #2 before it regressed.\nCloses #3'), []);
    assert.deepEqual(closingTickets('Closes #1 (the review fire).\nCloses #2'), []);
  });

  test('an HTML comment holding no closing reference renders as nothing, so it does not end the top', () => {
    // The PR template's comments left in, and a subscribe line above the top.
    const body = '<!-- governor:subscribe https://claude.ai/code/session_01ABC events=comments -->\n<!-- The diff is the record.\n     Strip these comments. -->\n\n<!-- Closes #N on this line when the PR finishes an issue -->\nCloses #1\nCloses #2 <!-- the review fire -->\n\n## Outcome';
    assert.deepEqual(closingTickets(body), [1, 2]);
    assert.deepEqual(proseClosings(body), []);
    // One holding a closing reference is text GitHub may read: it ends the top.
    assert.deepEqual(closingTickets('<!-- fixes #3 -->\nCloses #1'), []);
    assert.deepEqual(proseClosings('<!-- fixes #3 -->\nCloses #1').map((r) => r.number), [3, 1]);
  });

  test('a closing keyword in code is read like any other: nothing says GitHub skips it', () => {
    const body = 'Closes #1\n\nThe regex now matches `fixes #2` only on its own line.\n\n```\nfixes #3\n```';
    assert.deepEqual(closingTickets(body), [1]);
    assert.deepEqual(proseClosings(body).map((r) => r.number), [2, 3]);
  });

  test('proseClosings reads each closing reference below the top lines, once each, as written, a ticket the top closes included', () => {
    assert.deepEqual(proseClosings('Closes #1\n\n#9 fixed #2, and this fixes #3 and fixes #2.\nIt also Closes #1.'), [{ number: 2, text: 'fixed #2' }, { number: 3, text: 'fixes #3' }, { number: 1, text: 'Closes #1' }]);
    assert.deepEqual(proseClosings('Closes #1; the old code fixed #2 before it regressed.'), [{ number: 1, text: 'Closes #1' }, { number: 2, text: 'fixed #2' }]);
    assert.deepEqual(proseClosings('Closes #877\n\nFixed #840 in #853.'), [{ number: 840, text: 'Fixed #840' }]);
    assert.deepEqual(proseClosings('Closes #1\n\nSee #2.'), []);
    assert.deepEqual(proseClosings(`It fixes ${REPO}#5 and fixes other/repo#6.`, REPO), [{ number: 5, text: `fixes ${REPO}#5` }]);
  });

  test('namedOwners reads the Verification table\'s Green at cells and each Left for later line\'s leading number', () => {
    const body = [
      'Closes #1. Builds on #2.',
      '## Verification',
      '| Criterion | Answered by | Green at |',
      '| --- | --- | --- |',
      '| a | after #3 | merge |',
      '| b | nothing | #4 |',
      '',
      '| Receipt | Seen in |',
      '|---|---|',
      '| a scrape | #13 |',
      '',
      '### Beyond the ticket',
      '| Check | Green at | Note |',
      '|:-|:-:|-|',
      '| sweep | **#5** | see #6 |',
      '',
      '**Beyond the ticket**',
      '| Check | Green at |',
      '|---|---|',
      '| log | #14 |',
      '',
      '### Criteria, continued',
      '| Criterion | Answered by | Green at |',
      '|---|---|---|',
      '| c | nothing | #15 |',
      '## Left for later',
      '- #7 the prod run, after #8.',
      '* **#9** waits.',
      '1. #10 too.',
      '- Declined: nothing to own, see #11.',
      '## Notes',
      '| x | Green at |',
      '|---|---|',
      '| y | #12 |',
    ].join('\n');
    // Beyond the ticket gates nothing (the skill's test 5), and a table with no Green at column names no owner.
    assert.deepEqual(namedOwners(body), { verification: [4, 15], later: [7, 9, 10] });
    assert.deepEqual(namedOwners('Closes #1'), { verification: [], later: [] });
  });

  test('lastReview is the newest comment of the dispatcher\'s App carrying a marker, its text without it', () => {
    const thread: Thread[] = [
      { id: 1, body: marked('Old.', MOVED), created_at: 'a', ours: true },
      { id: 2, body: 'A remark.', created_at: 'b', ours: false },
      { id: 3, body: marked('New.'), created_at: 'c', ours: true },
      { id: 4, body: 'Another bot, no marker.', created_at: 'd', ours: true },
    ];
    assert.deepEqual(lastReview(thread), { id: 3, headSha: HEAD, bodySha: sha256(BODY), text: 'New.' });
    assert.equal(lastReview([]), null);
  });


  test('the grammar reads no config, nor does any module importing it for the grammar alone; the checklist reads its lists from the repo\'s settings, never a file', () => {
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFileSync;
      fs.readFileSync = (path, ...rest) => {
        if (/(pr-review|dispatch)[.]json$|SKILL[.]md$/.test(String(path))) throw new Error('read ' + path);
        return read(path, ...rest);
      };
      syncBuiltinESMExports();
      const body = await import(${JSON.stringify(new URL('dispatch/pr-body.mjs', ROOT).href)});
      body.closingTickets('Closes #1'); body.closedBy('fixes #2'); body.proseClosings('x\\n\\nfixes #3'); body.namedOwners('## Left for later\\n\\n- #4 x');
      body.lastReview([{ id: 1, body: body.reviewMarker('a'.repeat(40), body.bodyDigest('b')), created_at: 'a', ours: true }]);
      for (const m of ['labels', 'conflicts', 'coverage', 'review', 'checklist']) await import(new URL('dispatch/' + m + '.mjs', ${JSON.stringify(ROOT.href)}).href);
      process.stdout.write('imported');
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(out, 'imported');
  });
});
