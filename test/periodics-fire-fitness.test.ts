/**
 * A counted event queues a `periodics` fire of its own, and that fire's
 * periodics start through the one launch path, `launchPlan`. No other fire
 * carries `counted`, and nothing in the turn builds a periodic's launch but
 * the one function the sweep and the periodics fire share.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { routeEvent } from '../dispatch/webhook/route.mjs';

const REPO = 'acme/factory';
const OWNERS = ['acme'];
const SHA = '3333333333333333333333333333333333333333';
const member = { login: 't-d-d', type: 'User' };
const repository = { full_name: REPO, default_branch: 'main' };
const issue = { number: 717, title: 'A ticket', body: 'The work.', user: member, author_association: 'OWNER', labels: [], state: 'open', html_url: `https://github.com/${REPO}/issues/717` };

describe('fitness: a counted event queues a periodics fire of its own, started through launchPlan (hooks-and-routines.md)', () => {
  test('a merge, an issue opened and an issue closed each queue one periodics fire, and no other fire carries counted', () => {
    const deliveries: Array<[string, unknown, string]> = [
      ['pull_request', { action: 'closed', pull_request: { number: 724, title: 'A change', body: 'x', user: member, author_association: 'OWNER', merged: true, merge_commit_sha: SHA, base: { ref: 'main' }, head: { ref: 'claude/x', sha: 'a'.repeat(40) } }, sender: member, repository }, 'merges'],
      ['issues', { action: 'opened', issue, sender: member, repository }, 'issuesOpened'],
      ['issues', { action: 'opened', issue: { ...issue, body: '@claude look at this' }, sender: member, repository }, 'issuesOpened'],
      ['issues', { action: 'closed', issue: { ...issue, state: 'closed' }, sender: member, repository }, 'issuesClosed'],
    ];
    for (const [event, payload, kind] of deliveries) {
      const { fires } = routeEvent({ event, payload, owners: OWNERS });
      const marked = fires.filter((f) => 'counted' in f.fire);
      assert.deepEqual(marked.map((f) => [f.fire.kind, (f.fire as { counted?: string }).counted]), [['periodics', kind]], `${event} ${JSON.stringify((payload as { action: string }).action)}`);
    }
  });

  test('only dispatch/periodics.mjs builds a periodic\'s launch prompt, and dispatch/turn.mjs holds no launch loop for periodics', () => {
    const dir = 'dispatch';
    const callers = readdirSync(dir).filter((f) => f.endsWith('.mjs')).filter((f) => /\bperiodicPrompt\(/.test(readFileSync(join(dir, f), 'utf8')));
    assert.deepEqual(callers, ['periodics.mjs']);
    const turn = readFileSync(join(dir, 'turn.mjs'), 'utf8');
    for (const gone of ['eventPeriodics', 'startPeriodics', 'EVENT_PERIODIC_WINDOW_MS', 'invocation.counted']) assert.ok(!turn.includes(gone), gone);
    assert.match(turn, /planPeriodics\(invocation, ctx\)/, 'the periodics fire has a planner, whose plan launchPlan starts');
  });
});
