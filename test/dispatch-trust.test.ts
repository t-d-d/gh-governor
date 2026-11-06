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
import { AUTO, BOT, RELAY, REVIEW, START, autoOf, fitsInside, lets, narrowedLists, relayOf, reviewOf, startNarrowed, startOf, taskOf, trustExposures } from '../dispatch/trust.mjs';
import { factoryFile } from './helpers/factory.ts';

const BASE = { environment: 'my-env', pickup: { ready: ['mode: afk'], claim: 'claimed' } };
const file = (over: Record<string, unknown>) => JSON.stringify({ ...BASE, ...over, pickup: { ...BASE.pickup, ...(over.pickup as Record<string, unknown> | undefined) } });
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
    assert.deepEqual(autoOf(config({ trust: { auto: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'], task: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'] } })), ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']);
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

  test('set beside trust.task, it must sit inside it: auto ⊆ task', () => {
    const read = readConfig(file({ trust: { auto: ['OWNER', 'MEMBER'], task: ['OWNER'] } }));
    assert.ok(!read.ok);
    assert.match(read.fault, /trust\.auto/);
    assert.match(read.fault, /trust\.task/);
    assert.match(read.fault, /MEMBER/);
    assert.deepEqual(autoOf(config({ trust: { auto: ['OWNER'], task: ['OWNER', 'NONE'] } })), ['OWNER']);
  });

  test('unset, it is narrowed to fit a trust.task the file sets, never widened', () => {
    assert.deepEqual(autoOf(config({ trust: { task: ['OWNER'] } })), ['OWNER']);
    assert.deepEqual(narrowedLists(config({ trust: { task: ['OWNER'] } })), [{ list: 'auto', to: ['OWNER'] }]);
    assert.deepEqual(autoOf(config({ trust: { task: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE'] } })), ['OWNER', 'MEMBER', 'COLLABORATOR'], 'a wider trust.task widens nothing');
    assert.deepEqual(narrowedLists(config({ trust: { task: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE'] } })), []);
    assert.deepEqual(narrowedLists(config({ trust: { auto: ['OWNER'], task: ['OWNER'] } })), [], 'a list the file sets is not narrowed');
  });

  test('the factory is valid, and the retired pickup.by is refused as a key pickup does not know', () => {
    assert.ok(readConfig(factoryFile(CONFIG_PATH)).ok);
    for (const by of [['OWNER'], ['NONE']]) {
      const read = readConfig(file({ pickup: { by } }));
      assert.ok(!read.ok, JSON.stringify(by));
      assert.match(read.fault, /pickup: Unrecognized key: "by"/);
    }
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
    const [said, ...rest] = trustExposures(config({ trust: { auto: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'], task: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'] } }));
    // auto must sit inside task, so the task list the file widens says what it opens too.
    assert.equal(rest.length, 1);
    assert.match(String(rest[0]), /^trust\.task: /);
    assert.match(String(said), /^trust\.auto: /);
    assert.match(String(said), /CONTRIBUTOR and NONE/);
    for (const route of [/wait ends/, /blocker closes/, /periodic/, /conflicts/]) assert.match(String(said), route);
    assert.doesNotMatch(String(said), /cannot work/);
  });
});

describe('trust.relay in the config file', () => {
  test('unset, it is OWNER, MEMBER, COLLABORATOR and BOT', () => {
    assert.deepEqual([...RELAY], ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT']);
    for (const over of [{}, { trust: {} }, { trust: { auto: ['OWNER'] } }, { trust: { task: ['OWNER'] } }]) assert.deepEqual(relayOf(config(over)), ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT'], JSON.stringify(over));
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

  test('task and relay both set, task wider, is refused: task within relay', () => {
    const read = readConfig(file({ trust: { relay: ['OWNER'], task: ['OWNER', 'NONE'] } }));
    assert.ok(!read.ok);
    assert.match(read.fault, /trust\.task/);
    assert.match(read.fault, /trust\.relay/);
    assert.match(read.fault, /NONE/);
  });

  test('BOT in relay breaks no chain: it is left aside', () => {
    assert.ok(readConfig(file({ trust: { auto: ['OWNER'], relay: ['OWNER', 'BOT'], task: ['OWNER'] } })).ok);
  });

  test('auto set wider than an unset relay narrows nothing and is valid', () => {
    const wide = config({ trust: { auto: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'], task: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'] } });
    assert.deepEqual(relayOf(wide), [...RELAY]);
    assert.deepEqual(autoOf(wide), ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']);
    assert.deepEqual(narrowedLists(wide), []);
  });

  test('a relay the file sets narrows an unset auto and an unset task, never widens them', () => {
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

  test('trust.task the file sets is the task list', () => {
    assert.deepEqual(taskOf(config({ trust: { task: ['OWNER', 'NONE'] } })), ['OWNER', 'NONE']);
    assert.deepEqual(taskOf(config({})), ['OWNER', 'MEMBER', 'COLLABORATOR']);
    assert.deepEqual(fitsInside(config({ trust: { task: ['OWNER'] } }), 'auto'), ['trust.task']);
  });

  test('a file valid before relay stays valid', () => {
    for (const over of [{}, { trust: { task: ['NONE'] } }, { trust: { auto: ['OWNER'], task: ['OWNER', 'CONTRIBUTOR'] } }]) assert.ok(readConfig(file(over)).ok, JSON.stringify(over));
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

describe('trust.task in the config file', () => {
  test('unset, it is OWNER, MEMBER and COLLABORATOR', () => {
    for (const over of [{}, { trust: {} }, { trust: { auto: ['OWNER'] } }]) assert.deepEqual(taskOf(config(over)), ['OWNER', 'MEMBER', 'COLLABORATOR'], JSON.stringify(over));
  });

  test('a file may set it, narrower or wider', () => {
    assert.deepEqual(taskOf(config({ trust: { task: ['OWNER'] } })), ['OWNER']);
    assert.deepEqual(taskOf(config({ trust: { task: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'] } })), ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']);
    for (const task of [['owner'], ['ANYONE'], 'OWNER', [1]]) assert.ok(!readConfig(file({ trust: { task } })).ok, JSON.stringify(task));
  });

  test('BOT in it is refused, saying why', () => {
    const read = readConfig(file({ trust: { task: ['OWNER', 'BOT'] } }));
    assert.ok(!read.ok);
    assert.match(read.fault, /trust\.task/);
    assert.match(read.fault, /BOT/);
  });

  test('pickup.by, the retired name of trust.task, is refused, alone or beside it', () => {
    for (const over of [{ pickup: { by: ['OWNER'] } }, { trust: { task: ['OWNER'] }, pickup: { by: ['OWNER'] } }]) {
      const read = readConfig(file(over));
      assert.ok(!read.ok, JSON.stringify(over));
      assert.match(read.fault, /pickup: Unrecognized key: "by"/, JSON.stringify(over));
    }
  });

  test('a trust.task the file sets, wider or narrower, stays valid and fits auto inside it', () => {
    for (const task of [['OWNER', 'CONTRIBUTOR', 'NONE'], ['OWNER']]) {
      const read = config({ trust: { task } });
      assert.deepEqual(taskOf(read), task);
      assert.deepEqual(fitsInside(read, 'auto'), ['trust.task']);
    }
  });

  test('set beside auto and relay, it holds the chain auto ⊆ task ⊆ relay', () => {
    const wideAuto = readConfig(file({ trust: { auto: ['OWNER', 'MEMBER'], task: ['OWNER'] } }));
    assert.ok(!wideAuto.ok);
    assert.match(wideAuto.fault, /trust\.auto/);
    assert.match(wideAuto.fault, /trust\.task/);
    const wideTask = readConfig(file({ trust: { task: ['OWNER', 'NONE'], relay: ['OWNER', 'BOT'] } }));
    assert.ok(!wideTask.ok);
    assert.match(wideTask.fault, /trust\.task/);
    assert.match(wideTask.fault, /trust\.relay/);
    assert.match(wideTask.fault, /NONE/);
    assert.ok(readConfig(file({ trust: { auto: ['OWNER'], task: ['OWNER', 'MEMBER'], relay: ['OWNER', 'MEMBER', 'BOT'] } })).ok);
  });

  test('a task the file sets narrows an unset auto, and an unset task is narrowed to fit a set relay', () => {
    const narrow = config({ trust: { task: ['OWNER'] } });
    assert.deepEqual(autoOf(narrow), ['OWNER']);
    assert.deepEqual(fitsInside(narrow, 'auto'), ['trust.task']);
    assert.deepEqual(narrowedLists(narrow), [{ list: 'auto', to: ['OWNER'] }]);
    assert.deepEqual(narrowedLists(config({ trust: { task: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE'] } })), [], 'a wider task widens nothing');
    assert.deepEqual(narrowedLists(config({ trust: { relay: ['OWNER'] } })).find((n) => n.list === 'task'), { list: 'task', to: ['OWNER'] });
  });
});

describe('what a task the file widens exposes', () => {
  test('nothing for the default nor a narrower list', () => {
    assert.deepEqual(trustExposures(config({ trust: { task: ['OWNER'] } })), []);
    assert.deepEqual(trustExposures(config({ trust: { task: ['OWNER', 'MEMBER', 'COLLABORATOR'] } })), []);
  });

  test('task beyond the three says whose issues and PRs work may be about', () => {
    const [said, ...rest] = trustExposures(config({ trust: { task: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'] } }));
    assert.deepEqual(rest, []);
    assert.match(String(said), /^trust\.task: lets in CONTRIBUTOR authors/);
    assert.match(String(said), /ready/);
    assert.match(String(said), /@claude/);
    assert.doesNotMatch(String(said), /cannot work/);
  });
});

describe('trust.start in the config file', () => {
  test('unset, it is OWNER, MEMBER and COLLABORATOR, and not narrowed', () => {
    assert.deepEqual([...START], ['OWNER', 'MEMBER', 'COLLABORATOR']);
    for (const over of [{}, { trust: {} }, { trust: { relay: ['OWNER'] } }, { trust: { task: ['OWNER'] } }]) {
      assert.deepEqual(startOf(config(over)), ['OWNER', 'MEMBER', 'COLLABORATOR'], JSON.stringify(over));
      assert.equal(startNarrowed(config(over)), false, JSON.stringify(over));
    }
  });

  test('a file may narrow it', () => {
    assert.deepEqual(startOf(config({ trust: { start: ['OWNER'] } })), ['OWNER']);
    assert.equal(startNarrowed(config({ trust: { start: ['OWNER'] } })), true);
    assert.equal(startNarrowed(config({ trust: { start: ['COLLABORATOR', 'MEMBER', 'OWNER'] } })), false, 'the three in any order narrow nothing');
  });

  test('any value beyond the three is refused, saying why', () => {
    for (const value of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE', 'BOT']) {
      const read = readConfig(file({ trust: { start: ['OWNER', value] } }));
      assert.ok(!read.ok, value);
      assert.match(read.fault, /trust\.start/, value);
      assert.match(read.fault, /OWNER, MEMBER and COLLABORATOR/, value);
    }
  });

  test('an empty start is refused: nobody could set work going', () => {
    assert.ok(!readConfig(file({ trust: { start: [] } })).ok);
  });

  test('start sits outside the chain: it narrows no other list, and the check warns of nothing', () => {
    const narrowed = config({ trust: { start: ['OWNER'] } });
    assert.deepEqual([autoOf(narrowed), taskOf(narrowed), relayOf(narrowed)], [['OWNER', 'MEMBER', 'COLLABORATOR'], ['OWNER', 'MEMBER', 'COLLABORATOR'], [...RELAY]]);
    assert.deepEqual(narrowedLists(narrowed), []);
    assert.deepEqual(trustExposures(narrowed), []);
  });
});

describe('trust.review in the config file', () => {
  test('unset, it is OWNER, MEMBER and COLLABORATOR, whatever the other lists say', () => {
    assert.deepEqual([...REVIEW], ['OWNER', 'MEMBER', 'COLLABORATOR']);
    for (const over of [{}, { trust: {} }, { trust: { relay: ['OWNER'] } }, { trust: { relay: ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT', 'NONE'] } }, { trust: { task: ['OWNER', 'NONE'] } }]) {
      assert.deepEqual(reviewOf(config(over)), ['OWNER', 'MEMBER', 'COLLABORATOR'], JSON.stringify(over));
    }
  });

  test('a file may set it, narrower or wider, BOT included or not', () => {
    assert.deepEqual(reviewOf(config({ trust: { review: ['OWNER'] } })), ['OWNER']);
    assert.deepEqual(reviewOf(config({ trust: { review: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE', 'BOT'] } })), ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE', 'BOT']);
    for (const review of [['owner'], ['ANYONE'], 'OWNER', [1]]) assert.ok(!readConfig(file({ trust: { review } })).ok, JSON.stringify(review));
  });

  test('relay and review both set, relay wider, is refused, saying why', () => {
    const read = readConfig(file({ trust: { relay: ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT', 'NONE'], review: ['OWNER', 'MEMBER', 'COLLABORATOR'] } }));
    assert.ok(!read.ok);
    assert.match(read.fault, /trust\.relay/);
    assert.match(read.fault, /trust\.review/);
    assert.match(read.fault, /NONE/);
  });

  test('task or auto set wider than a set review is refused too: the chain runs to review', () => {
    for (const over of [{ trust: { task: ['OWNER', 'NONE'], review: ['OWNER'] } }, { trust: { task: ['OWNER', 'NONE'], review: ['OWNER'] } }, { trust: { auto: ['OWNER', 'MEMBER'], review: ['OWNER'] } }]) {
      const read = readConfig(file(over));
      assert.ok(!read.ok, JSON.stringify(over));
      assert.match(read.fault, /trust\.review/, JSON.stringify(over));
    }
  });

  test('BOT in relay breaks no chain with review: it is left aside', () => {
    assert.ok(readConfig(file({ trust: { relay: ['OWNER', 'BOT'], review: ['OWNER'] } })).ok);
  });

  test('a review the file sets narrows an unset relay, task and auto, keeping BOT in relay, and never widens them', () => {
    const narrow = config({ trust: { review: ['OWNER'] } });
    assert.deepEqual(relayOf(narrow), ['OWNER', 'BOT']);
    assert.deepEqual(taskOf(narrow), ['OWNER']);
    assert.deepEqual(autoOf(narrow), ['OWNER']);
    assert.deepEqual(narrowedLists(narrow), [{ list: 'auto', to: ['OWNER'] }, { list: 'task', to: ['OWNER'] }, { list: 'relay', to: ['OWNER', 'BOT'] }]);
    assert.deepEqual(fitsInside(narrow, 'relay'), ['trust.review']);
    assert.deepEqual(fitsInside(narrow, 'task'), ['trust.review']);
    assert.deepEqual(fitsInside(narrow, 'auto'), ['trust.review']);
    const wide = config({ trust: { review: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE'] } });
    assert.deepEqual(relayOf(wide), [...RELAY]);
    assert.deepEqual(taskOf(wide), ['OWNER', 'MEMBER', 'COLLABORATOR']);
    assert.deepEqual(autoOf(wide), [...AUTO]);
    assert.deepEqual(narrowedLists(wide), []);
  });

  test('a relay set wider than an unset review narrows nothing and is valid', () => {
    const wide = config({ trust: { relay: ['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT', 'NONE'] } });
    assert.deepEqual(reviewOf(wide), [...REVIEW]);
    assert.deepEqual(narrowedLists(wide), []);
  });

  test('a file valid before review stays valid', () => {
    for (const over of [{}, { trust: { task: ['NONE'] } }, { trust: { auto: ['OWNER'], task: ['OWNER', 'CONTRIBUTOR'], relay: ['OWNER', 'CONTRIBUTOR', 'NONE', 'BOT'] } }, { trust: { start: ['OWNER'] } }]) {
      assert.ok(readConfig(file(over)).ok, JSON.stringify(over));
    }
  });
});

describe('what a review the file widens exposes', () => {
  test('nothing for the default nor a narrower list', () => {
    assert.deepEqual(trustExposures(config({ trust: { review: ['OWNER'] } })), []);
    assert.deepEqual(trustExposures(config({ trust: { review: ['OWNER', 'MEMBER', 'COLLABORATOR'] } })), []);
  });

  test('review beyond the three says whose pull requests the PR review reads, and that a pass may merge them', () => {
    const [said, ...rest] = trustExposures(config({ trust: { review: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE'] } }));
    assert.deepEqual(rest, []);
    assert.match(String(said), /^trust\.review: lets in NONE authors/);
    assert.match(String(said), /PR review/);
    assert.match(String(said), /merge/);
    assert.doesNotMatch(String(said), /cannot work/);
  });
});
