/**
 * `trust.auto` (dispatch/trust.mjs): whose issues and PRs governor may set
 * going by itself, with no person choosing that ticket. Its routes are the
 * spec session or owner message after a blocker's close or an ended wait,
 * a periodic's issue counts and listings, and the conflicts check. What
 * each route does with it is test/dispatch-turn.test.ts and
 * test/dispatch-periodics.test.ts; this pins the list as the file sets it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_PATH, readConfig } from '../dispatch/repo-config.mjs';
import { AUTO, BOT, autoOf, lets, narrowedLists, trustExposures } from '../dispatch/trust.mjs';
import { factoryFile } from './helpers/factory.ts';

const BASE = { environment: 'my-env', labels: { ready: ['mode: afk'], claim: 'claimed' }, features: { pickup: true } };
const file = (over: Record<string, unknown>) => JSON.stringify({ ...BASE, ...over });
const config = (over: Record<string, unknown>) => {
  const read = readConfig(file(over));
  assert.ok(read.ok, JSON.stringify(read));
  return read.config;
};

describe('trust.auto in the config file', () => {
  test('unset, it is OWNER, MEMBER and COLLABORATOR', () => {
    assert.deepEqual([...AUTO], ['OWNER', 'MEMBER', 'COLLABORATOR']);
    for (const over of [{}, { trust: {} }, { pickup: { sweepHours: 3 } }]) assert.deepEqual(autoOf(config(over)), ['OWNER', 'MEMBER', 'COLLABORATOR'], JSON.stringify(over));
  });

  test('a file may set it, narrower or wider, by GitHub\'s author_association values', () => {
    assert.deepEqual(autoOf(config({ trust: { auto: ['OWNER'] } })), ['OWNER']);
    assert.deepEqual(autoOf(config({ trust: { auto: [] } })), [], 'an empty list: governor sets nothing going by itself');
    assert.deepEqual(autoOf(config({ trust: { auto: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'] }, pickup: { by: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'] } })), ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']);
    for (const auto of [['owner'], ['ANYONE'], 'OWNER', [1]]) assert.ok(!readConfig(file({ trust: { auto } })).ok, JSON.stringify(auto));
  });

  test('BOT in it is refused, saying why', () => {
    const read = readConfig(file({ trust: { auto: ['OWNER', 'BOT'] } }));
    assert.ok(!read.ok);
    assert.match(read.fault, /trust\.auto/);
    assert.match(read.fault, /BOT/);
  });

  test('a key trust does not know is refused', () => {
    assert.ok(!readConfig(file({ trust: { everyone: ['OWNER'] } })).ok);
  });

  test('set beside pickup.by, it must sit inside it: auto ⊆ task', () => {
    const read = readConfig(file({ trust: { auto: ['OWNER', 'MEMBER'] }, pickup: { by: ['OWNER'] } }));
    assert.ok(!read.ok);
    assert.match(read.fault, /trust\.auto/);
    assert.match(read.fault, /pickup\.by/);
    assert.match(read.fault, /MEMBER/);
    assert.deepEqual(autoOf(config({ trust: { auto: ['OWNER'] }, pickup: { by: ['OWNER', 'NONE'] } })), ['OWNER']);
  });

  test('unset, it is narrowed to fit a pickup.by the file sets, never widened', () => {
    assert.deepEqual(autoOf(config({ pickup: { by: ['OWNER'] } })), ['OWNER']);
    assert.deepEqual(narrowedLists(config({ pickup: { by: ['OWNER'] } })), [{ list: 'auto', to: ['OWNER'] }]);
    assert.deepEqual(autoOf(config({ pickup: { by: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE'] } })), ['OWNER', 'MEMBER', 'COLLABORATOR'], 'a wider pickup.by widens nothing');
    assert.deepEqual(narrowedLists(config({ pickup: { by: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE'] } })), []);
    assert.deepEqual(narrowedLists(config({ trust: { auto: ['OWNER'] }, pickup: { by: ['OWNER'] } })), [], 'a list the file sets is not narrowed');
  });

  test('a file valid before trust stays valid: the factory, and a narrow pickup.by', () => {
    assert.ok(readConfig(factoryFile(CONFIG_PATH)).ok);
    assert.ok(readConfig(file({ pickup: { by: ['OWNER'] } })).ok);
    assert.ok(readConfig(file({ pickup: { by: ['NONE'] } })).ok);
  });
});

describe('whose issue or PR a list lets in', () => {
  test('by its author\'s association, NONE where none was read', () => {
    assert.equal(lets(AUTO, { association: 'OWNER' }), true);
    assert.equal(lets(AUTO, { association: 'NONE' }), false);
    assert.equal(lets(AUTO, {}), false);
    assert.equal(lets(['NONE'], {}), true);
  });

  test('a bot\'s is judged as BOT, whatever association GitHub gave it', () => {
    assert.equal(lets(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'], { author: 'dependabot[bot]', association: 'CONTRIBUTOR' }), false);
    assert.equal(lets([BOT], { author: 'dependabot[bot]', association: 'NONE' }), true);
  });
});

describe('what a trust list the file widens exposes', () => {
  test('nothing at the defaults, nor where the file narrows', () => {
    assert.deepEqual(trustExposures(config({})), []);
    assert.deepEqual(trustExposures(config({ trust: { auto: ['OWNER'] } })), []);
  });

  test('auto beyond the three names the values and the routes it opens', () => {
    const [said, ...rest] = trustExposures(config({ trust: { auto: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'] }, pickup: { by: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'] } }));
    assert.deepEqual(rest, []);
    assert.match(String(said), /^trust\.auto: /);
    assert.match(String(said), /CONTRIBUTOR and NONE/);
    for (const route of [/wait ends/, /blocker closes/, /periodic/, /conflicts/]) assert.match(String(said), route);
    assert.doesNotMatch(String(said), /cannot work/);
  });
});
