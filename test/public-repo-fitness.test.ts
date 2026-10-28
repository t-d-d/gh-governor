/**
 * Every tracked file, its path included, passes the public-repo scan. The
 * gate runs the same scan as `npm run scan`; this holds it in `npm test`
 * too, so a test run alone cannot pass a file the gate would refuse.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanRepo, trackedFiles } from '../scripts/public-repo-scan.mjs';

describe('fitness: no file names the old home, holds an id, or cites an issue of four or more digits (public-repo.md)', () => {
  test('the scan reads every tracked file, with none exempted', () => {
    const files = trackedFiles();
    assert.ok(files.includes('scripts/public-repo-scan.mjs'));
    assert.ok(files.includes('test/public-repo-scan.test.ts'));
    assert.ok(files.includes('LICENSE'));
  });

  test('no tracked file has a finding', () => {
    const findings = scanRepo();
    assert.deepEqual(findings.map((f) => `${f.path}:${f.line} ${f.kind} ${f.text}`), []);
  });
});
