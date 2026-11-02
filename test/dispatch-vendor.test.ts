/**
 * The parser copied into the receiver (dispatch/webhook/vendor/): one file
 * from a published package, kept byte for byte, with the licence notices of
 * every package whose code it carries.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import commonmark from '../dispatch/webhook/vendor/commonmark.cjs';

const VENDOR = fileURLToPath(new URL('../dispatch/webhook/vendor/', import.meta.url));
const read = (name: string) => readFileSync(`${VENDOR}${name}`, 'utf8');

describe('dispatch/webhook/vendor/', () => {
  test('holds commonmark.js unchanged: its hash is the one the README records', () => {
    const recorded = /sha256 `([0-9a-f]{64})`/.exec(read('README.md'))?.[1];
    assert.ok(recorded, 'the README records no sha256');
    assert.equal(createHash('sha256').update(readFileSync(`${VENDOR}commonmark.cjs`)).digest('hex'), recorded);
    assert.match(read('commonmark.cjs'), /^\/\* commonmark 0\.31\.2 /);
  });

  test('carries the notice of each package in the bundle', () => {
    assert.deepEqual(
      readdirSync(VENDOR).filter((name) => name.startsWith('LICENSE')).sort(),
      ['LICENSE.commonmark', 'LICENSE.entities', 'LICENSE.mdurl'],
    );
    assert.match(read('LICENSE.commonmark'), /Copyright \(c\) 2014, John MacFarlane/);
    assert.match(read('LICENSE.entities'), /Copyright \(c\) Felix Böhm/);
    assert.match(read('LICENSE.mdurl'), /Copyright \(c\) 2015 Vitaly Puzrin, Alex Kocharin/);
  });

  test('loads from ESM and gives each block its source lines', () => {
    const walker = new commonmark.Parser().parse('a\n\n> b\n> c').walker();
    const quotes = [];
    for (let step = walker.next(); step; step = walker.next()) {
      if (step.entering && step.node.type === 'block_quote') quotes.push(step.node.sourcepos);
    }
    assert.deepEqual(quotes, [[[3, 1], [4, 3]]]);
  });
});
