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
import { AUTO, BOT, RELAY, autoOf, fitsInside, lets, narrowedLists, relayOf, taskOf, trustExposures } from '../dispatch/trust.mjs';
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

describe('trust.relay in the config file', () => {
  test('unset, it is OWNER, MEMBER, COLLABORATOR and BOT', () => {
    assert.deepEqual([...RELAY], ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT']);
    for (const over of [{}, { trust: {} }, { trust: { auto: ['OWNER'] } }, { pickup: { by: ['OWNER'] } }]) assert.deepEqual(relayOf(config(over)), ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT'], JSON.stringify(over));
  });

  test('a file may set it, narrower or wider, BOT included or not', () => {
    assert.deepEqual(relayOf(config({ trust: { relay: ['OWNER', 'MEMBER', 'COLLABORATOR'] } })), ['OWNER', 'MEMBER', 'COLLABORATOR']);
    assert.deepEqual(relayOf(config({ trust: { relay: ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT', 'NONE'] } })), ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT', 'NONE']);
    for (const relay of [['owner'], ['ANYONE'], 'OWNER', [1]]) assert.ok(!readConfig(file({ trust: { relay } })).ok, JSON.stringify(relay));
  });

  test('auto and relay both set, auto wider, is refused, saying why', () => {
    const read = readConfig(file({ trust: { auto: ['OWNER', 'MEMBER', 'COLLABORATOR'], relay: ['OWNER', 'BOT'] } }));
    assert.ok(!read.ok);
    assert.match(read.fault, /trust\.auto/);
    assert.match(read.fault, /trust\.relay/);
    assert.match(read.fault, /MEMBER, COLLABORATOR/);
  });

  test('pickup.by and relay both set, pickup.by wider, is refused: task within relay', () => {
    const read = readConfig(file({ trust: { relay: ['OWNER'] }, pickup: { by: ['OWNER', 'NONE'] } }));
    assert.ok(!read.ok);
    assert.match(read.fault, /pickup\.by/);
    assert.match(read.fault, /trust\.relay/);
    assert.match(read.fault, /NONE/);
  });

  test('BOT in relay breaks no chain: it is left aside', () => {
    assert.ok(readConfig(file({ trust: { auto: ['OWNER'], relay: ['OWNER', 'BOT'] }, pickup: { by: ['OWNER'] } })).ok);
  });

  test('auto set wider than an unset relay narrows nothing and is valid', () => {
    const wide = config({ trust: { auto: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'] }, pickup: { by: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'] } });
    assert.deepEqual(relayOf(wide), [...RELAY]);
    assert.deepEqual(autoOf(wide), ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']);
    assert.deepEqual(narrowedLists(wide), []);
  });

  test('a relay the file sets narrows an unset auto and an unset pickup.by, never widens them', () => {
    const narrow = config({ trust: { relay: ['OWNER', 'BOT'] } });
    assert.deepEqual(autoOf(narrow), ['OWNER']);
    assert.deepEqual(taskOf(narrow), ['OWNER']);
    assert.deepEqual(narrowedLists(narrow), [{ list: 'auto', to: ['OWNER'] }, { list: 'task', to: ['OWNER'] }]);
    assert.deepEqual(fitsInside(narrow, 'auto'), ['trust.relay']);
    assert.deepEqual(fitsInside(narrow, 'task'), ['trust.relay']);
    const wide = config({ trust: { relay: ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT', 'NONE'] } });
    assert.deepEqual(autoOf(wide), [...AUTO]);
    assert.deepEqual(taskOf(wide), ['OWNER', 'MEMBER', 'COLLABORATOR']);
    assert.deepEqual(narrowedLists(wide), []);
  });

  test('pickup.by the file sets is the task list, as before', () => {
    assert.deepEqual(taskOf(config({ pickup: { by: ['OWNER', 'NONE'] } })), ['OWNER', 'NONE']);
    assert.deepEqual(taskOf(config({})), ['OWNER', 'MEMBER', 'COLLABORATOR']);
    assert.deepEqual(fitsInside(config({ pickup: { by: ['OWNER'] } }), 'auto'), ['pickup.by']);
  });

  test('a file valid before relay stays valid', () => {
    for (const over of [{}, { pickup: { by: ['NONE'] } }, { trust: { auto: ['OWNER'] }, pickup: { by: ['OWNER', 'CONTRIBUTOR'] } }]) assert.ok(readConfig(file(over)).ok, JSON.stringify(over));
  });
});

describe('governor\'s own App', () => {
  test('passes every list, BOT or no BOT', () => {
    const own = { author: 'governor-app[bot]', association: 'NONE', bot: true, own: true };
    for (const list of [[], ['OWNER'], [...RELAY], [...AUTO]]) assert.equal(lets(list, own), true, JSON.stringify(list));
    assert.equal(lets(['OWNER'], { ...own, own: false }), false);
  });
});

describe('what a relay the file widens exposes', () => {
  test('nothing for the default, BOT among it, nor a narrower list', () => {
    assert.deepEqual(trustExposures(config({ trust: { relay: ['OWNER'] } })), []);
  });

  test('relay beyond the three says whose text reaches a running session', () => {
    const [said, ...rest] = trustExposures(config({ trust: { relay: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE'] } }));
    assert.deepEqual(rest, []);
    assert.match(String(said), /^trust\.relay: /);
    assert.match(String(said), /NONE/);
    assert.match(String(said), /running session/);
    assert.match(String(said), /session link/);
    assert.doesNotMatch(String(said), /cannot work/);
  });

  test('BOT in a relay the file sets warns of a bot that quotes strangers\' issues', () => {
    const [said] = trustExposures(config({ trust: { relay: ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT'] } }));
    assert.match(String(said), /^trust\.relay: /);
    assert.match(String(said), /BOT/);
    assert.match(String(said), /quotes? .*strangers?'? issues/i);
  });
});
