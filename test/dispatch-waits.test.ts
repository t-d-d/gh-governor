/**
 * The `waits` section. A `Blocked until:` line holds its ticket on every
 * pickup path whatever the file says (test/readiness-paths.test.ts). The
 * section only tells every session how to make a ticket wait, and, with
 * `label`, names the label the hourly fire takes off at the date
 * (test/dispatch-wait-label.test.ts). Governor keeps no state for a wait:
 * the receiver queues no fire for the line, and a `wait` fire is no kind.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { routeEvent } from '../dispatch/webhook/route.mjs';
import { parseFire } from '../dispatch/webhook/fire.mjs';
import { GENERIC_SWITCHES, RUN_SECTIONS, configSchema } from '../dispatch/repo-config.mjs';
import { PROMPTS } from '../dispatch/prompts.mjs';
import { WAIT_PROMPT, waitUnreadableComment } from '../dispatch/waits.mjs';

const REPO = 'acme/factory';
const OWNERS = ['acme'];

const issuesEvent = (action: string, body: string | null, over: Record<string, unknown> = {}) => ({
  action,
  issue: { number: 717, title: 'An issue', labels: [], html_url: `https://github.com/${REPO}/issues/717`, body, user: { login: 't-d-d', type: 'User' }, author_association: 'OWNER', assignees: [] },
  sender: { login: 't-d-d', type: 'User' },
  repository: { full_name: REPO },
  ...over,
});

describe('a `Blocked until:` line keeps no state of governor\'s', () => {
  test('an issue opened, reopened or edited with the line queues no wait fire', () => {
    for (const payload of [
      issuesEvent('opened', 'Blocked until: 2026-11-05'),
      issuesEvent('reopened', 'Blocked until: 2026-11-05'),
      issuesEvent('edited', 'Blocked until: 2026-11-05', { changes: { body: { from: 'Body.' } } }),
    ]) {
      const kinds = routeEvent({ event: 'issues', payload, owners: OWNERS }).fires.map((f) => f.fire.kind as string);
      assert.ok(!kinds.includes('wait'), JSON.stringify(kinds));
    }
  });

  test('a `wait` fire is no kind the task reads', () => {
    assert.throws(() => parseFire({ kind: 'wait', issue: 717, repo: REPO }), /no recognised kind/);
  });

  test('no wait-ended prompt kind is left for a repo to replace', () => {
    assert.equal(PROMPTS.waitEndedSpec, undefined);
    assert.equal(PROMPTS.waitEndedOwnerSpec, undefined);
  });
});

describe('the waits section', () => {
  const base = { environment: 'env_x', pickup: { enabled: false, ready: ['ready'], claim: 'claimed' } };

  test('is a generic switch, off unless the file has its section', () => {
    assert.ok(GENERIC_SWITCHES.includes('waits'));
    assert.equal(configSchema.parse(base).features.waits, false);
    assert.equal(configSchema.parse({ ...base, waits: {} }).features.waits, true);
    assert.equal(configSchema.parse({ ...base, waits: { enabled: false } }).features.waits, false);
  });

  test('needs no pickup labels: it reads none', () => {
    assert.equal(configSchema.safeParse({ environment: 'env_x', waits: {} }).success, true);
  });

  test('`label` is optional, and is a label', () => {
    assert.deepEqual(configSchema.parse({ ...base, waits: { label: 'waiting' } }).waits, { label: 'waiting' });
    assert.equal(configSchema.parse({ ...base, waits: {} }).waits, undefined);
    for (const bad of ['', 'a,b', 7]) {
      assert.equal(configSchema.safeParse({ ...base, waits: { label: bad } }).success, false, JSON.stringify(bad));
    }
  });

  test('the retired keys `issue`, `prompts`, `model` and `effort` make the file invalid', () => {
    for (const retired of [{ issue: 413 }, { prompts: { spec: 'x' } }, { model: 'opus' }, { effort: 'high' }]) {
      assert.equal(configSchema.safeParse({ ...base, waits: retired }).success, false, JSON.stringify(retired));
    }
    assert.ok(!RUN_SECTIONS.includes('waits'));
  });
});

describe('what governor says about a line', () => {
  test('the prompt line says how to make a ticket wait', () => {
    assert.match(WAIT_PROMPT, /`Blocked until: YYYY-MM-DD`/);
    assert.match(WAIT_PROMPT, /`Blocked until: YYYY-MM-DD HH:MM`, in UTC/);
  });

  test('the unreadable comment names the date form and the time form', () => {
    const body = waitUnreadableComment('2026-11-05 24:00');
    assert.match(body, /says `2026-11-05 24:00`/);
    assert.match(body, /`Blocked until: YYYY-MM-DD`/);
    assert.match(body, /`Blocked until: YYYY-MM-DD HH:MM`/);
    assert.match(body, /UTC/);
  });
});
