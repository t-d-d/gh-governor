/**
 * The operator's write of the App key and the drop-box writer into the
 * bootstrap stack's secrets (scripts/save-secret.mjs).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SECRETS, parseArgs, saveSecret } from '../../scripts/save-secret.mjs';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----\n';
/** A writer of the shape the turn ships under (dispatch/turn.mjs, `transcript`). */
const WRITER = '0123456789abcdef0123456789abcdef';

/** Records every call; `put` answers with `status`. */
const deps = (files: Record<string, string>, status = 0) => {
  const puts: Array<{ secretId: string; text: string; profile: string | undefined }> = [];
  const removed: string[] = [];
  let written = '';
  return {
    puts,
    removed,
    get written() { return written; },
    io: {
      readFile: (path: string) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
      writeTemp: (text: string) => { written = text; return '/tmp/secret-1.json'; },
      remove: (path: string) => { removed.push(path); },
      put: (secretId: string, file: string, profile: string | undefined) => {
        puts.push({ secretId, text: written, profile });
        assert.equal(file, '/tmp/secret-1.json');
        return { status, stderr: status === 0 ? '' : 'AccessDenied' };
      },
      log: () => {},
    },
  };
};

describe('save-secret', () => {
  test('names the two secrets the bootstrap stack creates', () => {
    assert.deepEqual(Object.keys(SECRETS).sort(), ['github-app', 'session-log-writer']);
    assert.equal(SECRETS['github-app'], 'governor/github-app');
    assert.equal(SECRETS['session-log-writer'], 'governor/session-log-writer');
  });

  test('the App key is stored as the JSON the task reads, its id beside it', () => {
    const d = deps({ 'app.pem': PEM });
    saveSecret(parseArgs(['github-app', '--app-id', '12345', '--file', 'app.pem']), d.io);
    assert.deepEqual(d.puts.map((p) => p.secretId), ['governor/github-app']);
    assert.deepEqual(JSON.parse(d.puts[0]!.text), { appId: '12345', privateKey: PEM });
  });

  test('the drop-box writer is stored as the bare credential, trimmed', () => {
    const d = deps({ 'writer.txt': `  ${WRITER}\n` });
    saveSecret(parseArgs(['session-log-writer', '--file', 'writer.txt', '--profile', 'admin']), d.io);
    assert.deepEqual(d.puts, [{ secretId: 'governor/session-log-writer', text: WRITER, profile: 'admin' }]);
  });

  test('the value goes through a file that is removed afterwards, whatever the put answered', () => {
    for (const status of [0, 1]) {
      const d = deps({ 'writer.txt': WRITER }, status);
      const run = () => saveSecret(parseArgs(['session-log-writer', '--file', 'writer.txt']), d.io);
      if (status === 0) run(); else assert.throws(run, /AccessDenied/);
      assert.deepEqual(d.removed, ['/tmp/secret-1.json']);
    }
  });

  test('refuses an unknown secret, a missing file, an App key with no id, and a key that is not a PEM', () => {
    assert.throws(() => parseArgs(['claude-login', '--file', 'x']), /github-app or session-log-writer/);
    assert.throws(() => parseArgs(['session-log-writer']), /--file/);
    assert.throws(() => parseArgs(['github-app', '--file', 'app.pem']), /--app-id/);
    assert.throws(() => parseArgs(['github-app', '--app-id', 'x1', '--file', 'app.pem']), /--app-id/);
    const d = deps({ 'app.pem': 'not a key', 'empty.txt': '\n' });
    assert.throws(() => saveSecret(parseArgs(['github-app', '--app-id', '1', '--file', 'app.pem']), d.io), /PEM/);
    assert.throws(() => saveSecret(parseArgs(['session-log-writer', '--file', 'empty.txt']), d.io), /empty/);
    assert.deepEqual(d.puts, [], 'nothing stored');
  });

  // The turn reads a writer that is not 32 or more lowercase hex digits as no
  // writer and ships nothing, so a save it would ignore is refused here.
  test('refuses a drop-box writer the turn would read as unset', () => {
    const d = deps({ 'short.txt': 'abc\n', 'upper.txt': WRITER.toUpperCase(), 'json.txt': '{"placeholder":"x"}' });
    for (const file of ['short.txt', 'upper.txt', 'json.txt']) {
      assert.throws(() => saveSecret(parseArgs(['session-log-writer', '--file', file]), d.io), /32 or more lowercase hex digits/, file);
    }
    assert.deepEqual(d.puts, [], 'nothing stored');
  });
});
