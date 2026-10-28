/**
 * Unit tests for the entry-point guard every `scripts/` CLI puts between its
 * exports and its `main()`.
 *
 * There is one thing to hold here, and it is the asymmetry: a wrong "not the
 * entry point" prints nothing, runs nothing, and leaves with exit 0 — which
 * every caller reads as the good answer ("drained", "nothing leaked", "the
 * committed file is current"). A wrong "yes" is loud: the module runs when it
 * was imported. So the cases below are mostly spellings of the same file that
 * a naive compare misses, because those are the ones that fail silently.
 *
 * Two of them are the reason this function is shared rather than copied:
 * a verbatim copy once was fixed for symlinks and the original was not.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCliEntry } from '../../scripts/lib/cli-entry.mjs';

const SELF = '/home/u/acme/scripts/operator-drain-check.mjs';

/** A real checkout plus a symlink to it, torn down whatever the test does. */
function withLinkedCheckout(body: (paths: { real: string; linked: string }) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cli-entry-')));
  try {
    mkdirSync(join(dir, 'checkout'));
    const real = join(dir, 'checkout', 'script.mjs');
    writeFileSync(real, '');
    symlinkSync(join(dir, 'checkout'), join(dir, 'link'), 'dir');
    body({ real, linked: join(dir, 'link', 'script.mjs') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('isCliEntry', () => {
  test('the ordinary invocation is recognised', () => {
    assert.equal(isCliEntry(`file://${SELF}`, SELF), true);
  });

  test('a path that needs URL-encoding is still the entry point', () => {
    // `import.meta.url` percent-encodes; the argv path does not. Comparing the
    // two as raw strings silently skips `main()`.
    assert.equal(
      isCliEntry(
        'file:///home/u/my%20repo/scripts/operator-drain-check.mjs',
        '/home/u/my repo/scripts/operator-drain-check.mjs',
      ),
      true,
    );
  });

  test('a checkout reached through a symlinked directory is still the entry point', () => {
    // Node resolves the MAIN module's symlinks before it builds
    // `import.meta.url`, and leaves `process.argv[1]` the spelling it was
    // handed — so a runner whose workspace is linked elsewhere, or a macOS
    // `/tmp`, makes the file disagree with itself.
    withLinkedCheckout(({ real, linked }) => {
      assert.equal(isCliEntry(pathToFileURL(real).href, linked), true);
    });
  });

  test('a symlink to the file itself is still the entry point', () => {
    // The same disagreement one level down: the link is on the file, not on a
    // directory above it. `realpathSync` resolves either.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cli-entry-')));
    try {
      const real = join(dir, 'script.mjs');
      writeFileSync(real, '');
      symlinkSync(real, join(dir, 'alias.mjs'));
      assert.equal(isCliEntry(pathToFileURL(real).href, join(dir, 'alias.mjs')), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('being imported by something else is not the entry point', () => {
    assert.equal(isCliEntry(`file://${SELF}`, '/usr/lib/node_modules/test-runner.js'), false);
  });

  test('a different file with the same basename is not the entry point', () => {
    // What a `argv1.endsWith('/script.mjs')` fallback would wave through. The
    // question is "is this file the entry point", not "is some file by that
    // name", and this guard's wrong answers are invisible either way.
    assert.equal(isCliEntry(`file://${SELF}`, '/somewhere/else/operator-drain-check.mjs'), false);
  });

  test('an argv path that does not exist is refused rather than thrown', () => {
    // `realpathSync` throws on a missing path. A guard that threw here would
    // take down every import of the module it guards.
    assert.equal(isCliEntry(`file://${SELF}`, '/no/such/file.mjs'), false);
  });

  test('no argv path at all is not the entry point', () => {
    // `node -e`, a REPL: there is no script, so no module is its entry point.
    assert.equal(isCliEntry(`file://${SELF}`, undefined), false);
  });
});
