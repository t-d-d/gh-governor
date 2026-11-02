/**
 * Only scripts/lib/ready-work.mjs combines the readiness checks, and
 * `ticketStatus` is what keeps a ticket out (docs/constraints/dispatcher-repos.md).
 * The repo's eslint config refuses a new caller of the checks in dispatch/
 * or scripts/. Two callers stay: dispatch/checklist.mjs reads `labelRow`,
 * and dispatch/waits.mjs reads `isWaiting` for a moved date.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

const CHECKS = ['isBlocked', 'isWaiting', 'waitHolds', 'heldUnreadied', 'labelRow'];

/** The restricted-import messages eslint gives `code` linted as the file at `path`. */
const refusals = async (path: string, code: string) => {
  const results = await eslint.lintText(code, { filePath: `${root}${path}` });
  return results.flatMap((r) => r.messages).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
};

describe('fitness: lint refuses a new caller of the readiness checks (dispatcher-repos.md)', () => {
  for (const name of CHECKS) {
    test(`a file in dispatch/ may not import ${name}`, async () => {
      const found = await refusals('dispatch/new-path.mjs', `import { ${name} } from '../scripts/lib/ready-work.mjs';\nexport const x = ${name};\n`);
      assert.equal(found.length, 1, `${name} imported in dispatch/ passed lint`);
      assert.match(found[0] ?? '', /ticketStatus/);
    });

    test(`a file in scripts/ may not import ${name}`, async () => {
      const found = await refusals('scripts/lib/new-path.mjs', `import { ${name} } from './ready-work.mjs';\nexport const x = ${name};\n`);
      assert.equal(found.length, 1, `${name} imported in scripts/ passed lint`);
    });
  }

  test('a .js file in dispatch/ may not import a check either', async () => {
    assert.equal((await refusals('dispatch/new-path.js', `import { isBlocked } from '../scripts/lib/ready-work.mjs';\nexport const x = isBlocked;\n`)).length, 1);
  });

  test('ready-work.mjs, ticketStatus and the other exports stay importable', async () => {
    assert.deepEqual(await refusals('dispatch/new-path.mjs', `import { ticketStatus, mayPickUp, mayStartSpec } from '../scripts/lib/ready-work.mjs';\nexport const x = [ticketStatus, mayPickUp, mayStartSpec];\n`), []);
  });

  test('checklist.mjs keeps labelRow, and waits.mjs keeps isWaiting', async () => {
    assert.deepEqual(await refusals('dispatch/checklist.mjs', `import { labelRow } from '../scripts/lib/ready-work.mjs';\nexport const x = labelRow;\n`), []);
    assert.deepEqual(await refusals('dispatch/waits.mjs', `import { isWaiting } from '../scripts/lib/ready-work.mjs';\nexport const x = isWaiting;\n`), []);
  });

  test('checklist.mjs and waits.mjs may import no other check', async () => {
    assert.equal((await refusals('dispatch/checklist.mjs', `import { isBlocked } from '../scripts/lib/ready-work.mjs';\nexport const x = isBlocked;\n`)).length, 1);
    assert.equal((await refusals('dispatch/waits.mjs', `import { labelRow } from '../scripts/lib/ready-work.mjs';\nexport const x = labelRow;\n`)).length, 1);
  });

  test('tests may import the checks, since they test them directly', async () => {
    assert.deepEqual(await refusals('test/new-path.test.ts', `import { isBlocked } from '../scripts/lib/ready-work.mjs';\nexport const x = isBlocked;\n`), []);
  });
});
