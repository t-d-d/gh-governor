/**
 * The public-repo scan (scripts/public-repo-scan.mjs): what it refuses in a
 * file's text and in its path. The fitness test that runs it over every
 * tracked file is test/public-repo-fitness.test.ts.
 *
 * A word or an id this file must spell to test the scan is built from parts,
 * so the scan of this file passes with no exemption.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepo, scanText, trackedFiles } from '../scripts/public-repo-scan.mjs';

const OLD_HOME = ['pod', 'stow'].join('');
const kinds = (text: string, path = 'a.txt') => scanText(path, text).map((f) => f.kind);

describe('scanText', () => {
  test('refuses the old home\'s name, in any case, in the text or the path', () => {
    assert.deepEqual(kinds(`the ${OLD_HOME} dispatcher`), ['name']);
    assert.deepEqual(kinds(`${OLD_HOME.toUpperCase()}_LABELS`), ['name']);
    assert.deepEqual(kinds(`<!-- ${OLD_HOME[0]!.toUpperCase()}${OLD_HOME.slice(1)}:subscribe -->`), ['name']);
    assert.deepEqual(kinds('nothing here', `docs/${OLD_HOME}.md`), ['name']);
  });

  test('refuses a twelve-digit AWS account id, but not AWS\'s documented example or a longer number', () => {
    assert.deepEqual(kinds(`arn:aws:iam::${'3422'}${'06308824'}:user/x`), ['account']);
    assert.deepEqual(kinds('arn:aws:iam::123456789012:role/x'), []);
    assert.deepEqual(kinds('expiresAt: 1790400000000'), [], 'a thirteen-digit epoch is no account');
  });

  test('refuses a claude.ai environment or session id, and passes a short fake', () => {
    assert.deepEqual(kinds(`env_${'01G8qtjDbkXH'}${'ByysyphAikoG'}`), ['claude-id']);
    assert.deepEqual(kinds(`https://claude.ai/code/session_${'0123Nq9iniLQ'}${'CthXv43hDTRp'}`), ['claude-id']);
    assert.deepEqual(kinds(`cse_${'01ABCDEFGHIJ'}${'KLMNOPQRSTUV'}`), ['claude-id']);
    assert.deepEqual(kinds('session_01OWNER env_fakefactory cse_01ELSE'), []);
  });

  test('refuses a GitHub installation id, and passes a small fake one', () => {
    assert.deepEqual(kinds(`"installation": { "id": ${'9123'}${'4567'} }`), ['installation']);
    assert.deepEqual(kinds(`/app/installations/${'9123'}${'4567'}/access_tokens`), ['installation']);
    assert.deepEqual(kinds('installation: { id: 42 }'), []);
  });

  test('refuses an issue or pull request reference of four or more digits', () => {
    assert.deepEqual(kinds(`Closes #${'53'}${'82'}`), ['issue-number']);
    assert.deepEqual(kinds(`https://github.com/acme/factory/pull/${'42'}${'71'}`), ['issue-number']);
    assert.deepEqual(kinds(`https://api.github.com/repos/acme/factory/issues/${'10'}${'00'}/comments`), ['issue-number']);
    assert.deepEqual(kinds('Closes #412, see #7 and https://github.com/acme/factory/pull/123'), []);
  });

  test('passes a hex colour with a letter after four or more digits, and still refuses a bare four-digit reference', () => {
    assert.deepEqual(kinds('color: #59' + '636e;'), []);
    assert.deepEqual(kinds('background: #12' + '34ab'), []);
    assert.deepEqual(kinds(`see #${'12'}${'34'}.`), ['issue-number']);
    assert.deepEqual(kinds(`_see #${'12'}${'34'}_`), ['issue-number']);
    assert.deepEqual(kinds(`/issues/${'12'}${'34'}`), ['issue-number']);
  });

  test('reports each finding with its line', () => {
    assert.deepEqual(scanText('a.md', `one\ntwo #${'12'}${'34'}\n`), [{ path: 'a.md', line: 2, kind: 'issue-number', text: `#${'12'}${'34'}` }]);
  });
});

describe('trackedFiles', () => {
  test('lists committed and new files, and skips a tracked file deleted but not yet staged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir });
      git('init', '-q');
      writeFileSync(join(dir, 'kept.txt'), 'kept');
      writeFileSync(join(dir, 'gone.txt'), 'gone');
      git('add', '.');
      git('commit', '-qm', 'one');
      rmSync(join(dir, 'gone.txt'));
      writeFileSync(join(dir, 'new.txt'), 'new');
      assert.deepEqual(trackedFiles(dir).sort(), ['kept.txt', 'new.txt']);
      assert.deepEqual(scanRepo({ files: trackedFiles(dir), read: () => '' }), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
