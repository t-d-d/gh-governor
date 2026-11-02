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
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);

/**
 * The text of a declaration, from its first line to the next line that
 * starts at the declaration's own indent: the close of its block, or, for
 * one whose body is an expression, whatever follows it.
 */
const bodyOf = (path: string, start: string): string => {
  const text = readFileSync(new URL(path, root), 'utf8');
  const at = text.indexOf(start);
  assert.notEqual(at, -1, `${path} has no ${start}`);
  const indent = /^\s*/.exec(start)?.[0] ?? '';
  const next = new RegExp(`\\n${indent}\\S`).exec(text.slice(at));
  const body = next === null ? text.slice(at) : text.slice(at, at + next.index);
  // The body is one declaration's: it reaches no other at the same indent.
  assert.doesNotMatch(body.slice(start.length), new RegExp(`\\n${indent}(export )?const `), `${path}: ${start} read past its own end`);
  return body;
};

const CHECKS = /\b(labelRow|isBlocked|isWaiting|waitHolds)\s*\(/;

/** The checks, and `heldUnreadied`, which the unblocked row and wait end read through `mayStartSpec`. */
const ALL_CHECKS = /\b(labelRow|isBlocked|isWaiting|waitHolds|heldUnreadied)\s*\(/;

describe('the selection and the claim decide through ticketStatus', () => {
  const paths = [
    { name: 'isEligible', path: 'scripts/lib/ready-work.mjs', start: 'const isEligible =' },
    { name: 'planSchedule', path: 'scripts/lib/dispatch-router.mjs', start: 'export const planSchedule =' },
    { name: 'claim', path: 'dispatch/launch-plan.mjs', start: '  const claim = async' },
  ];
  for (const { name, path, start } of paths) {
    test(`${name} calls no readiness check directly`, () => {
      const body = bodyOf(path, start);
      assert.match(body, /\bticketStatus\(/, `${name} asks ticketStatus`);
      assert.doesNotMatch(body, CHECKS);
    });
  }
});

describe('the unblocked row and wait end decide through ticketStatus and mayStartSpec', () => {
  const paths = [
    { name: 'ticketRow', path: 'dispatch/unblocked.mjs', start: 'export const ticketRow =', asks: /\bticketStatus\(/ },
    { name: 'planUnblocked', path: 'dispatch/unblocked-fire.mjs', start: 'export const planUnblocked = async', asks: /\bmayStartSpec\(/ },
    { name: 'readUnblocked', path: 'dispatch/unblocked-fire.mjs', start: 'const readUnblocked = async', asks: /\bstatusOf\(/ },
    { name: 'endedWaits', path: 'dispatch/waits.mjs', start: 'export const endedWaits = async', asks: /\bmayStartSpec\(/ },
  ];
  for (const { name, path, start, asks } of paths) {
    test(`${name} calls no readiness check directly, but wait end's date reads`, () => {
      const body = bodyOf(path, start);
      assert.match(body, asks);
      // Wait end asks whether a person moved the line's date later, whatever
      // the labels say: a read of the line alone, `isWaiting({ wait }, now)`.
      const left = body.replace(/\bisWaiting\(\{ wait(: [\w.]+)? \}, now\)/g, '');
      assert.doesNotMatch(left, ALL_CHECKS);
    });
  }
});

describe('outside ready-work.mjs, the readiness checks are called only where #291 leaves them', () => {
  const files = (dir: string): string[] =>
    readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) => {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) return files(path);
      return e.name.endsWith('.mjs') ? [path] : [];
    });
  const all = [...files('dispatch'), ...files('scripts')].filter((p) => p !== 'scripts/lib/ready-work.mjs');
  // checklist.mjs asks only whether a ticket is claimed or excluded, which
  // its labels answer. waits.mjs reads a line's date alone, whatever the
  // labels say.
  const allowed: Record<string, RegExp> = {
    'dispatch/checklist.mjs': /\blabelRow\(/g,
    'dispatch/waits.mjs': /\bisWaiting\(\{ wait(: [\w.]+)? \}, now\)/g,
  };
  for (const path of all) {
    test(`${path} calls none of the checks`, () => {
      const code = readFileSync(new URL(path, root), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const left = code.replace(allowed[path] ?? /$^/g, '');
      assert.doesNotMatch(left, ALL_CHECKS);
    });
  }
});
