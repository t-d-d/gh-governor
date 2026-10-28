/**
 * Unit tests for `messageOf`, the text of whatever a `catch` bound.
 *
 * A catch binding is `unknown`, so the ticket scripts each narrowed it with a
 * copy of the same one-liner; they share this one instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageOf } from '../../scripts/lib/error-message.mjs';

test('an Error gives its message; anything else is stringified', () => {
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf('plain'), 'plain');
  assert.equal(messageOf(42), '42');
});
