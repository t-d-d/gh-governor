/**
 * Unit tests for `errorText`, a thrown value as a log line carries it.
 *
 * The task's entrypoint, the receiver and the starter each wrote a thrown
 * value's stack into their log lines with a copy of the same one-liner. A
 * change to one, such as adding the cause, would have missed the others, so
 * they share this one. It lives beside the receiver because both Lambdas
 * ship dispatch/webhook/ and nothing else.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorText } from '../dispatch/webhook/error-text.mjs';
import { importClosure } from './helpers/imports.ts';

const ROOT = join(import.meta.dirname, '..');

describe('errorText', () => {
  test('an Error gives its stack, which starts with its message', () => {
    const error = new Error('boom');
    assert.equal(errorText(error), error.stack);
    assert.match(errorText(error), /^Error: boom\n/);
  });

  test('a value with no stack is stringified', () => {
    assert.equal(errorText('plain'), 'plain');
    assert.equal(errorText(42), '42');
    assert.equal(errorText(undefined), 'undefined');
    assert.equal(errorText(null), 'null');
  });

  test('a value String() cannot convert gives a line instead of throwing', () => {
    const bare = Object.create(null);
    assert.equal(errorText(bare), '[object Object]');

    const badToString = { toString() { throw new Error('no string'); } };
    assert.equal(errorText(badToString), '[object Object]');

    const badStack = {
      get stack() { throw new Error('no stack'); },
      toString() { return 'the value'; },
    };
    assert.equal(errorText(badStack), 'the value');

    const nothingWorks = new Proxy({}, { get() { throw new Error('no property'); } });
    assert.equal(typeof errorText(nothingWorks), 'string');
  });

  test('the three callers use it and keep no copy of their own', () => {
    for (const path of ['dispatch/cli.mjs', 'dispatch/webhook/starter.mjs', 'dispatch/webhook/route.mjs']) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      assert.match(source, /import \{[^}]*\berrorText\b[^}]*\} from '\.\/(webhook\/)?error-text\.mjs';/, `${path} imports errorText`);
      assert.doesNotMatch(source, /\.stack\s*(\?\?|\|\|)/, `${path} keeps its own copy`);
    }
  });

  test('the Lambdas that use it can load it: their imports stay inside dispatch/webhook/', () => {
    for (const entry of ['dispatch/webhook/handler.mjs', 'dispatch/webhook/starter-handler.mjs']) {
      const outside = [...importClosure(ROOT, entry)].filter((path) => !path.startsWith('dispatch/webhook/'));
      assert.deepEqual(outside, [], `${entry} reaches outside the directory its Lambda ships`);
    }
  });
});
