/**
 * The owner's key script (scripts/hook-key.mjs): one hook's key, derived from
 * the stack's hook secret read with the operator's AWS identity, printed as
 * the one value a caller stores.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_SECRET_ID, keyLine, parseArgs } from '../../scripts/hook-key.mjs';
import { hookKey } from '../../dispatch/webhook/hook.mjs';

describe('scripts/hook-key.mjs', () => {
  test('reads the repo, the hook and the version, and an optional profile', () => {
    assert.deepEqual(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--version', '2']), { repo: 'acme/factory', hook: 'operator-prod', version: 2 });
    assert.deepEqual(parseArgs(['--repo', 'acme/factory', '--hook', 'operator-prod', '--version', '1', '--profile', 'ops']), { repo: 'acme/factory', hook: 'operator-prod', version: 1, profile: 'ops' });
  });

  test('refuses a repo, hook or version the receiver would not take', () => {
    for (const argv of [
      ['--hook', 'operator-prod', '--version', '1'],
      ['--repo', 'factory', '--hook', 'operator-prod', '--version', '1'],
      ['--repo', 'acme/factory', '--version', '1'],
      ['--repo', 'acme/factory', '--hook', 'Operator', '--version', '1'],
      ['--repo', 'acme/factory', '--hook', 'operator-prod'],
      ['--repo', 'acme/factory', '--hook', 'operator-prod', '--version', '0'],
      ['--repo', 'acme/factory', '--hook', 'operator-prod', '--version', '1.5'],
    ]) assert.throws(() => parseArgs(argv), argv.join(' '));
  });

  test('prints v<version>.<hex key>, the key derived from the stack\'s hook secret, and nothing else', () => {
    const reads: Array<{ id: string, profile: string | undefined }> = [];
    const line = keyLine({ repo: 'acme/factory', hook: 'operator-prod', version: 3, profile: 'ops' }, (id, profile) => {
      reads.push({ id, profile });
      return 'hook-secret-test\n';
    });
    assert.equal(HOOK_SECRET_ID, 'governor/hook-secret');
    assert.deepEqual(reads, [{ id: 'governor/hook-secret', profile: 'ops' }]);
    assert.equal(line, `v3.${hookKey('hook-secret-test', 'acme/factory', 'operator-prod', 3)}`);
    assert.match(line, /^v3\.[0-9a-f]{64}$/);
  });

  test('an empty secret is refused, not a key', () => {
    assert.throws(() => keyLine({ repo: 'acme/factory', hook: 'operator-prod', version: 1 }, () => ''), /empty/);
  });
});
