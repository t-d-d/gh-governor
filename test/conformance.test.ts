/**
 * scripts/conformance.mjs, the deploy's read-back runner: every check runs,
 * every finding prints, and the exit says whether any check found something.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, runAll, runCheck } from '../scripts/conformance.mjs';

const check = (id: string, findings: string[], env = ['X']) => ({ id, env, run: async () => ({ findings }) });

describe('the conformance runner', () => {
  test('runs the three read-backs the deploy names, each by its own variable', () => {
    assert.deepEqual(CHECKS.map((c) => [c.id, c.env]), [['app-events', ['GOVERNOR_APP_SLUG']], ['webhook-url', ['GOVERNOR_STACK']], ['hook-url', ['GOVERNOR_STACK']]]);
  });

  test('a check whose variable is unset is not applicable, out loud, and runs nothing', async () => {
    let ran = 0;
    const outcome = await runCheck({ id: 'a', env: ['X'], run: async () => { ran++; return { findings: [] }; } }, {});
    assert.deepEqual(outcome, { skipped: 'not applicable: X unset' });
    assert.equal(ran, 0);
  });

  test('runs every check after a finding, prints each finding, and exits 1', async () => {
    const lines: string[] = [];
    const code = await runAll({ X: '1' }, { checks: [check('a', ['one', 'two']), check('b', []), check('c', [], ['Y'])], log: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.deepEqual(lines, ['FAIL a', '    one', '    two', 'ok b', '- c: not applicable: Y unset']);
  });

  test('a check that throws is a finding on that check, and the checks after it still run', async () => {
    const lines: string[] = [];
    const throws = { id: 'a', env: ['X'], run: async () => { throw new Error('describe-stacks: Stack with id governor does not exist'); } };
    const code = await runAll({ X: '1' }, { checks: [throws, check('b', [])], log: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.deepEqual(lines, ['FAIL a', '    the check threw: describe-stacks: Stack with id governor does not exist', 'ok b']);
  });

  test('a check\'s own notes print under its own line, after the verdict', async () => {
    const lines: string[] = [];
    const noted = (id: string, findings: string[]) => ({ id, env: ['X'], run: async () => ({ findings, notes: [`${id} read this`] }) });
    await runAll({ X: '1' }, { checks: [noted('a', []), noted('b', ['drift'])], log: (l) => lines.push(l) });
    assert.deepEqual(lines, ['ok a', '    a read this', 'FAIL b', '    b read this', '    drift']);
  });

  test('no finding exits 0, a skipped check included', async () => {
    assert.equal(await runAll({ X: '1' }, { checks: [check('a', []), check('c', [], ['Y'])], log: () => {} }), 0);
  });
});
