/**
 * The kinds that start sessions plan in their own modules and hand `turnFor`
 * a plan for `launchPlan`. The repo's eslint config refuses the planners'
 * own helpers in dispatch/turn.mjs, so a new feature that starts sessions
 * goes in its planner, not in `turnFor`. `hookFor`, `duePeriodics` and
 * `periodicPrompt` stay allowed: an event fire and `run` use them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

const HELPERS: Array<[string, string]> = [
  ['planSchedule', '../scripts/lib/dispatch-router.mjs'],
  ['endedWaits', './waits.mjs'],
  ['waitSpecPrompt', './waits.mjs'],
  ['ticketRow', './unblocked.mjs'],
  ['rowOf', './unblocked.mjs'],
  ['readyPrompt', './unblocked.mjs'],
  ['specPrompt', './unblocked.mjs'],
  ['hookPrompt', './hooks.mjs'],
  ['ticketStatus', '../scripts/lib/ready-work.mjs'],
  ['mayPickUp', '../scripts/lib/ready-work.mjs'],
  ['mayStartSpec', '../scripts/lib/ready-work.mjs'],
  ['specHold', '../scripts/lib/ready-work.mjs'],
];

/** The rule ids eslint reports for `code` linted as the file at `path`. */
const reported = async (path: string, code: string) => {
  const results = await eslint.lintText(code, { filePath: `${root}${path}` });
  return results.flatMap((r) => r.messages).map((m) => m.ruleId);
};

const importOf = (name: string, from: string) => `import { ${name} } from '${from}';\nexport const x = ${name};\n`;

describe('lint keeps the planners\' helpers out of turn.mjs', () => {
  for (const [name, from] of HELPERS) {
    test(`turn.mjs may not import ${name}`, async () => {
      assert.ok((await reported('dispatch/turn.mjs', importOf(name, from))).includes('no-restricted-imports'), `${name} imported in turn.mjs passed lint`);
    });

    test(`another dispatch module may still import ${name}`, async () => {
      assert.ok(!(await reported('dispatch/new-planner.mjs', importOf(name, from))).includes('no-restricted-imports'));
    });
  }

  test('a re-export from turn.mjs is refused too', async () => {
    assert.ok((await reported('dispatch/turn.mjs', `export { planSchedule } from '../scripts/lib/dispatch-router.mjs';\n`)).includes('no-restricted-imports'));
  });

  test('turn.mjs keeps hookFor, duePeriodics and periodicPrompt', async () => {
    const code = `import { hookFor } from './hooks.mjs';\nimport { duePeriodics, periodicPrompt } from './periodics.mjs';\nexport const x = [hookFor, duePeriodics, periodicPrompt];\n`;
    assert.deepEqual(await reported('dispatch/turn.mjs', code), []);
  });

  test('the readiness checks stay refused in turn.mjs', async () => {
    assert.ok((await reported('dispatch/turn.mjs', importOf('isBlocked', '../scripts/lib/ready-work.mjs'))).includes('governor/no-readiness-checks'));
  });
});
