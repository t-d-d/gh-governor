/**
 * This repo's own config file: governor picks up its `mode: afk` tickets
 * and never reviews its pull requests, since every file here is the
 * reviewer's own code (CLAUDE.md, Branches and pull requests).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONFIG_PATH, readConfig } from '../dispatch/repo-config.mjs';

test('this repo\'s config file is valid, turns pickup on and leaves the PR review off', () => {
  const read = readConfig(readFileSync(new URL(`../${CONFIG_PATH}`, import.meta.url), 'utf8'));
  assert.ok(read.ok, JSON.stringify(read));
  // A hold label keeps a ticket out of pickup and out of the spec session a
  // blocker's close would start for a ticket that is not ready (dispatch/unblocked.mjs).
  assert.deepEqual(read.config.labels, { ready: ['mode: afk'], claim: 'claimed', claimRemoves: [], exclude: ['type: prd', 'mode: human'] });
  assert.equal(read.config.features.pickup, true);
  assert.notEqual(read.config.features.prReview, true);
});
