/**
 * `outputTail` (dispatch/deliveries.mjs) turns what the CLI printed into
 * plain text and keeps its last `OUTPUT_TAIL` characters, for a log line or
 * a stored reason. Governor runs `claude` under a pseudo-terminal, so its
 * output carries the terminal UI's control codes: cursor moves where the
 * text has spaces, and mode resets that would crowd the error out of the
 * tail.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OUTPUT_TAIL, outputTail, readSend } from '../dispatch/deliveries.mjs';

const ESC = '\x1b';
const WARNING = '⚠️  No dispatch confirmation — nothing was started\n';

/** A failed launch's output as the launcher collected it: claude's terminal, then the launcher's own warning. */
const FAILED_LAUNCH = [
  `Error:${ESC}[8GCloud${ESC}[14Gsession${ESC}[22Gcreate${ESC}[29Gfailed:\r\r\n`,
  `${ESC}[?25h${ESC}(B\x0f${ESC}[?1016l${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[>4m`,
  `${ESC}[?1004l${ESC}[?2031l${ESC}[?2004l${ESC}[<u${ESC}[?25h${ESC}7${ESC}[r${ESC}8${ESC}]0;\x07${ESC}[?25h`,
  WARNING,
].join('');

describe('outputTail: the CLI output governor logs is plain text', () => {
  test('a failed launch logs its error and the launcher\'s warning, with no control codes', () => {
    assert.equal(outputTail(FAILED_LAUNCH), `Error: Cloud session create failed:\n${WARNING}`);
  });

  test('a cursor move to a column keeps the words apart, and other sequences go', () => {
    assert.equal(outputTail(`a${ESC}[12Gb${ESC}[1;31mc${ESC}[0m`), 'a bc');
  });

  test('an OSC ends at BEL or at ESC backslash', () => {
    assert.equal(outputTail(`x${ESC}]0;title\x07y${ESC}]8;;https://example.com${ESC}\\z`), 'xyz');
  });

  test('carriage returns become newlines, and a run of blank lines becomes one', () => {
    assert.equal(outputTail('one\r\ntwo\rthree\n\n\n\nfour\r\r\n'), 'one\ntwo\nthree\n\nfour\n');
  });

  test('other C0 controls go, but tabs and newlines stay', () => {
    assert.equal(outputTail('a\x00b\x07c\x08d\te\x7ff\n'), 'abcd\tef\n');
  });

  test('control codes do not count against OUTPUT_TAIL', () => {
    const error = `${'e'.repeat(OUTPUT_TAIL - 1)}!`;
    const tail = outputTail(`${error}${`${ESC}[?1000l`.repeat(OUTPUT_TAIL)}`);
    assert.equal(tail, error);
  });

  test('plain output longer than OUTPUT_TAIL keeps its last characters', () => {
    const tail = outputTail(`start${'x'.repeat(OUTPUT_TAIL)}`);
    assert.equal(tail.length, OUTPUT_TAIL);
    assert.ok(!tail.startsWith('s'));
  });

  test('a cursor move forward keeps the words apart, and a move to another line breaks the line', () => {
    assert.equal(outputTail(`a${ESC}[5Cb${ESC}[Cc${ESC}[3;1Hd${ESC}[2Be${ESC}[Ef`), 'a b c\nd\ne\nf');
  });

  test('a line of only spaces counts as blank', () => {
    assert.equal(outputTail(`a\n${ESC}[1G\n${ESC}[1G\n${ESC}[1G\nb`), 'a\n\nb');
  });

  test('a huge output is cleaned from its end, not whole', () => {
    const frame = `${ESC}[2K${ESC}[1A${ESC}[2K${ESC}[G${ESC}[38;5;174m*${ESC}[39m Working${ESC}[8Gon\r\n`;
    const huge = `${frame.repeat(Math.ceil(20_000_000 / frame.length))}done\n`;
    const started = performance.now();
    const tail = outputTail(huge);
    assert.ok(performance.now() - started < 200, 'cleaning should not scan the whole output');
    assert.ok(tail.endsWith('* Working on\ndone\n'));
  });

  test('trailing whitespace does not count against the error a send keeps', () => {
    const error = `${'e'.repeat(OUTPUT_TAIL - 1)}!`;
    const sent = readSend({ status: 1, output: `${error}${' '.repeat(100)}` });
    assert.equal(sent.error, error);
  });

  test('a send the CLI did not answer has the cleaned output as its error', () => {
    const sent = readSend({ status: 1, output: FAILED_LAUNCH });
    assert.equal(sent.error, `Error: Cloud session create failed:\n${WARNING.trim()}`);
  });

  test('no dispatch file slices CLI output by OUTPUT_TAIL itself', () => {
    const dir = join(import.meta.dirname, '..', 'dispatch');
    const raw = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.mjs'))
      .filter((file) => readFileSync(join(dir, file), 'utf8').includes('slice(-OUTPUT_TAIL)'));
    assert.deepEqual(raw, ['deliveries.mjs']);
  });
});
