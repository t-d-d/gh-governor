/**
 * The selection and the claim's second read decide through `ticketStatus`
 * and `mayPickUp` (scripts/lib/ready-work.mjs), never by putting the
 * readiness checks together themselves. A path that combines them on its
 * own is how a rule added to one path came to be missed in another.
 *
 * Each function is read as source text, from its declaration to the close
 * of its body, and must call none of the checks directly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);

/**
 * The text of a declaration, from its first line to the first line after it
 * that closes a block at the declaration's own indent.
 */
const bodyOf = (path: string, start: string): string => {
  const text = readFileSync(new URL(path, root), 'utf8');
  const at = text.indexOf(start);
  assert.notEqual(at, -1, `${path} has no ${start}`);
  const indent = /^\s*/.exec(start)?.[0] ?? '';
  const end = text.indexOf(`\n${indent}};\n`, at);
  return end === -1 ? text.slice(at) : text.slice(at, end);
};

const CHECKS = /\b(labelRow|isBlocked|isWaiting|waitHolds)\s*\(/;

describe('the selection and the claim decide through ticketStatus', () => {
  const paths = [
    { name: 'isEligible', path: 'scripts/lib/ready-work.mjs', start: 'const isEligible =' },
    { name: 'planSchedule', path: 'scripts/lib/dispatch-router.mjs', start: 'export const planSchedule =' },
    { name: 'claim', path: 'dispatch/turn.mjs', start: '  const claim = async' },
  ];
  for (const { name, path, start } of paths) {
    test(`${name} calls no readiness check directly`, () => {
      const body = bodyOf(path, start);
      assert.match(body, /\bticketStatus\(/, `${name} asks ticketStatus`);
      assert.doesNotMatch(body, CHECKS);
    });
  }
});
