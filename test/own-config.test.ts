/**
 * This repo's own config file: governor picks up its `mode: afk` tickets,
 * acts on a ticket when its blocker closes, tells a PR's session when a
 * merge into main leaves the PR conflicted, and reviews its pull requests
 * with merge off. The owner merges every pull request, so a pass here only
 * posts a comment and an approving review, and governor cannot pass a change
 * to itself with nobody looking. A pull request cannot review itself either:
 * the review runs the image deployed from main and reads its checklist from
 * main (CLAUDE.md, Branches and pull requests).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONFIG_PATH, readConfig, resolveFiles } from '../dispatch/repo-config.mjs';

const own = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('this repo\'s config file is valid and turns pickup, unblocked, the conflicts check, sign-off and the PR review on', () => {
  const read = readConfig(own(CONFIG_PATH));
  assert.ok(read.ok, JSON.stringify(read));
  // A hold label keeps a ticket out of pickup and out of the spec session a
  // blocker's close would start for a ticket that is not ready (dispatch/unblocked.mjs).
  assert.deepEqual(read.config.labels, { ready: ['mode: afk'], claim: 'claimed', claimRemoves: [], exclude: ['type: prd', 'mode: human'] });
  assert.equal(read.config.features.pickup, true);
  assert.equal(read.config.features.unblocked, true);
  assert.equal(read.config.features.conflicts, true);
  assert.equal(read.config.features.signOff, true);
  assert.equal(read.config.features.prReview, true);
});

test('this repo\'s review never merges, forbids closing a PRD, and reads its checklist from a file here', async () => {
  const read = readConfig(own(CONFIG_PATH));
  assert.ok(read.ok, JSON.stringify(read));
  const review = read.config.review;
  assert.ok(review !== undefined);
  // `merge` is true unless set, so the file must say false: the owner merges.
  assert.equal(review.merge, false);
  assert.deepEqual(review.tickets.forbid, [{ labels: ['type: prd'], unless: [] }]);
  assert.deepEqual(review.checklist, { file: '.claude/skills/pr-review/SKILL.md' });
  const resolved = await resolveFiles(read.config, async (path) => own(path));
  assert.ok(resolved.ok, JSON.stringify(resolved));
  const checklist = resolved.config.review?.checklist ?? '';
  for (const n of [2, 3, 4, 5, 6]) assert.match(checklist, new RegExp(`^${n}\\. `, 'm'), `the checklist numbers test ${n}`);
});
