/**
 * Pickup's sweep interval: a repo's config file may set how often the bare
 * schedule fire sweeps its ready tickets, in whole hours, one when unset
 * (dispatch/pickup.mjs). The turn that applies it is in
 * test/dispatch-turn.test.ts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_PATH, readConfig } from '../dispatch/repo-config.mjs';
import { SWEEP_HOURS, SWEEP_SLACK_MS, byOf, sweepDue, sweepHoursOf } from '../dispatch/pickup.mjs';
import { factoryFile } from './helpers/factory.ts';

const LABELS = { ready: ['mode: afk'], claim: 'claimed' };
const BASE = { environment: 'env_01ASK', pickup: LABELS };
/** A file whose pickup section holds the labels and `pickup`, and the rest of `over` at the top. */
const file = ({ pickup = {}, ...over }: Record<string, unknown>) => JSON.stringify({ ...BASE, pickup: { ...LABELS, ...(pickup as object) }, ...over });
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-27T12:17:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('the config file\'s pickup section', () => {
  test('a file may set pickup\'s sweep interval in whole hours, at least one', () => {
    const read = readConfig(file({ pickup: { sweepHours: 6 } }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(sweepHoursOf(read.config), 6);
    for (const pickup of [{ sweepHours: 0 }, { sweepHours: 1.5 }, { sweepHours: '6' }, { sweepHours: -2 }, { hours: 6 }]) {
      assert.ok(!readConfig(file({ pickup })).ok, JSON.stringify(pickup));
    }
  });

  test('unset is one hour, the schedule fire\'s own tick: a pickup section that sets no sweepHours', () => {
    assert.equal(SWEEP_HOURS, 1);
    const read = readConfig(file({}));
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(sweepHoursOf(read.config), 1);
  });

  test('pickup\'s labels are its section\'s: ready, claim, claimRemoves and exclude', () => {
    const read = readConfig(file({ pickup: { ready: ['mode: afk', 'ready'], claim: 'taken', claimRemoves: ['ready'], exclude: ['mode: human'] } }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.labels, { ready: ['mode: afk', 'ready'], claim: 'taken', claimRemoves: ['ready'], exclude: ['mode: human'] });
    const defaults = readConfig(file({}));
    assert.ok(defaults.ok);
    assert.deepEqual(defaults.config.labels, { ready: ['mode: afk'], claim: 'claimed', claimRemoves: [], exclude: ['type: prd'] });
  });

  test('pickup on needs ready and claim; pickup off needs neither', () => {
    for (const key of ['ready', 'claim']) {
      const { [key]: _drop, ...rest } = LABELS as Record<string, unknown>;
      const read = readConfig(JSON.stringify({ ...BASE, pickup: rest }));
      assert.ok(!read.ok);
      assert.match(read.ok ? '' : read.fault, new RegExp(`pickup\\.${key}: pickup is on`));
    }
    const off = readConfig(JSON.stringify({ environment: 'env_01ASK', pickup: { enabled: false } }));
    assert.ok(off.ok, JSON.stringify(off));
    assert.equal(off.config.features.pickup, false);
  });

  test('unset, a repo swept at the last hourly fire is swept again at this one', () => {
    assert.equal(sweepDue(ago(HOUR), SWEEP_HOURS, NOW), true);
    assert.equal(sweepDue(ago(HOUR - 20 * 60 * 1000), SWEEP_HOURS, NOW), true, 'the last sweep\'s turn ran late after its fire');
  });

  test('the factory sets it', () => {
    const read = readConfig(factoryFile(CONFIG_PATH));
    assert.ok(read.ok);
    assert.equal(typeof read.config.pickup?.sweepHours, 'number');
  });

  test('pickup.by is dropped and refused: whose tickets pickup starts is trust.task', () => {
    const read = readConfig(file({ pickup: { by: ['OWNER', 'NONE'] } }));
    assert.ok(!read.ok);
    assert.match(read.ok ? '' : read.fault, /pickup: Unrecognized key: "by"/);
    const task = readConfig(file({ trust: { task: ['OWNER', 'NONE'], relay: ['OWNER', 'NONE'], review: ['OWNER', 'NONE'] } }));
    assert.ok(task.ok, JSON.stringify(task));
    assert.deepEqual(byOf(task.config), ['OWNER', 'NONE']);
    for (const by of [['owner'], ['ANYONE'], 'OWNER', [1]]) {
      assert.ok(!readConfig(file({ trust: { task: by } })).ok, JSON.stringify(by));
    }
  });

  test('unset, whose tickets pickup starts is OWNER, MEMBER and COLLABORATOR', () => {
    for (const over of [{}, { pickup: { sweepHours: 3 } }]) {
      const read = readConfig(file(over));
      assert.ok(read.ok, JSON.stringify(read));
      assert.deepEqual(byOf(read.config), ['OWNER', 'MEMBER', 'COLLABORATOR']);
    }
  });
});

describe('when a repo\'s sweep is due', () => {
  test('a repo with no record of a sweep is swept now: a lost item means sweep now', () => {
    assert.equal(sweepDue(null, 6, NOW), true);
  });

  test('a repo is swept at the first fire at or after its interval', () => {
    assert.equal(sweepDue(ago(6 * HOUR), 6, NOW), true);
    assert.equal(sweepDue(ago(8 * HOUR), 6, NOW), true);
    assert.equal(sweepDue(ago(4 * HOUR), 6, NOW), false, 'the fire two hours short of the interval does not sweep');
  });

  test('a fire a little early on the clock still sweeps: the last sweep\'s time is when its turn ran, which can lag its fire', () => {
    assert.equal(SWEEP_SLACK_MS, 30 * 60 * 1000);
    assert.equal(sweepDue(ago(2 * HOUR - 20 * 60 * 1000), 2, NOW), true);
    assert.equal(sweepDue(ago(2 * HOUR - SWEEP_SLACK_MS - 1), 2, NOW), false);
  });

  // A fire waits on the lane behind the turns ahead of it, so the last
  // sweep's turn can have run most of an hour after its fire. One sweep per
  // tick is all the clock allows, so an interval of one tick needs no slack.
  test('an interval of the clock\'s own tick sweeps at every fire, however late the last sweep\'s turn ran', () => {
    assert.equal(sweepDue(ago(20 * 60 * 1000), 1, NOW), true, 'the last sweep ran 40 minutes after its fire');
    assert.equal(sweepDue(ago(HOUR), 2, NOW), false, 'a longer interval keeps its slack');
  });

  test('an interval shorter than the clock\'s tick sweeps at every fire', () => {
    assert.equal(sweepDue(ago(2 * HOUR), 1, NOW), true);
    assert.equal(sweepDue(ago(HOUR), 1, NOW), true);
  });
});
