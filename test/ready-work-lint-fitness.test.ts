/**
 * Only scripts/lib/ready-work.mjs combines the readiness checks, and
 * `ticketStatus` is what keeps a ticket out (docs/constraints/dispatcher-repos.md).
 * The repo's eslint config refuses a new caller of the checks in dispatch/
 * or scripts/, through one rule that reads a static import, an export-from
 * and an `import()` alike. Two callers stay: dispatch/checklist.mjs reads `labelRow`,
 * and dispatch/waits.mjs reads `isWaiting` for a moved date.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

const CHECKS = ['isBlocked', 'isWaiting', 'waitHolds', 'heldUnreadied', 'labelRow'];

const RULE = 'governor/no-readiness-checks';

/** The readiness-check messages eslint gives `code` linted as the file at `path`. */
const refusals = async (path: string, code: string) => {
  const results = await eslint.lintText(code, { filePath: `${root}${path}` });
  return results.flatMap((r) => r.messages).filter((m) => m.ruleId === RULE).map((m) => m.message);
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

  test('a check re-exported from ready-work.mjs is refused', async () => {
    assert.equal((await refusals('dispatch/new-path.mjs', `export { isBlocked } from '../scripts/lib/ready-work.mjs';\n`)).length, 1);
    assert.equal((await refusals('dispatch/new-path.mjs', `export { waitHolds as w } from '../scripts/lib/ready-work.mjs';\n`)).length, 1);
    assert.deepEqual(await refusals('dispatch/new-path.mjs', `export { ticketStatus } from '../scripts/lib/ready-work.mjs';\n`), []);
  });

  test('a namespace import or export of ready-work.mjs, which could reach any check, is refused', async () => {
    assert.equal((await refusals('dispatch/new-path.mjs', `import * as m from '../scripts/lib/ready-work.mjs';\nexport const x = m;\n`)).length, 1);
    assert.equal((await refusals('dispatch/new-path.mjs', `export * from '../scripts/lib/ready-work.mjs';\n`)).length, 1);
    assert.equal((await refusals('dispatch/new-path.mjs', `export * as m from '../scripts/lib/ready-work.mjs';\n`)).length, 1);
  });

  test('a static import kept only for its side effects takes no check', async () => {
    assert.deepEqual(await refusals('dispatch/new-path.mjs', `import '../scripts/lib/ready-work.mjs';\n`), []);
  });

  test('one rule holds the checks: no-restricted-imports no longer guards them', async () => {
    const results = await eslint.lintText(`import { isBlocked } from '../scripts/lib/ready-work.mjs';\nexport const x = isBlocked;\n`, { filePath: `${root}dispatch/new-path.mjs` });
    const ids = results.flatMap((r) => r.messages).map((m) => m.ruleId);
    assert.deepEqual(ids, [RULE]);
  });

  test('tests may import the checks, since they test them directly', async () => {
    assert.deepEqual(await refusals('test/new-path.test.ts', `import { isBlocked } from '../scripts/lib/ready-work.mjs';\nexport const x = isBlocked;\n`), []);
  });
});

describe('fitness: lint refuses a dynamic import of the readiness checks (dispatcher-repos.md)', () => {
  for (const name of CHECKS) {
    test(`a file in dispatch/ may not destructure ${name} from import()`, async () => {
      const found = await refusals('dispatch/new-path.mjs', `const { ${name} } = await import('../scripts/lib/ready-work.mjs');\nexport const x = ${name};\n`);
      assert.equal(found.length, 1, `${name} imported dynamically in dispatch/ passed lint`);
      assert.match(found[0] ?? '', /ticketStatus/);
    });
  }

  test('a file in scripts/ may not destructure a check from import() either', async () => {
    assert.equal((await refusals('scripts/lib/new-path.js', `const { isBlocked: b } = await import('./ready-work.mjs');\nexport const x = b;\n`)).length, 1);
  });

  test('a check read off the awaited module is refused', async () => {
    assert.equal((await refusals('dispatch/new-path.mjs', `export const x = (await import('../scripts/lib/ready-work.mjs')).waitHolds;\n`)).length, 1);
    assert.equal((await refusals('dispatch/new-path.mjs', `export const x = (await import('../scripts/lib/ready-work.mjs'))['labelRow'];\n`)).length, 1);
  });

  test('a check taken in a then() callback is refused', async () => {
    assert.equal((await refusals('dispatch/new-path.mjs', `export const x = import('../scripts/lib/ready-work.mjs').then(({ heldUnreadied }) => heldUnreadied);\n`)).length, 1);
  });

  test('a module kept whole, whose names lint cannot read, is refused', async () => {
    assert.equal((await refusals('dispatch/new-path.mjs', `const m = await import('../scripts/lib/ready-work.mjs');\nexport const x = m;\n`)).length, 1);
    assert.equal((await refusals('dispatch/new-path.mjs', `const { ticketStatus, ...rest } = await import('../scripts/lib/ready-work.mjs');\nexport const x = [ticketStatus, rest];\n`)).length, 1);
  });

  test('ticketStatus and the other exports stay importable with import()', async () => {
    assert.deepEqual(await refusals('dispatch/new-path.mjs', `const { ticketStatus, mayPickUp, mayStartSpec } = await import('../scripts/lib/ready-work.mjs');\nexport const x = [ticketStatus, mayPickUp, mayStartSpec];\n`), []);
    assert.deepEqual(await refusals('dispatch/new-path.mjs', `export const x = (await import('../scripts/lib/ready-work.mjs')).ticketStatus;\n`), []);
  });

  test('another module stays importable with import()', async () => {
    assert.deepEqual(await refusals('dispatch/new-path.mjs', `const m = await import('./other.mjs');\nexport const x = m.isBlocked;\n`), []);
  });

  test('checklist.mjs keeps labelRow, and waits.mjs keeps isWaiting, but no other check', async () => {
    assert.deepEqual(await refusals('dispatch/checklist.mjs', `const { labelRow } = await import('../scripts/lib/ready-work.mjs');\nexport const x = labelRow;\n`), []);
    assert.deepEqual(await refusals('dispatch/waits.mjs', `const { isWaiting } = await import('../scripts/lib/ready-work.mjs');\nexport const x = isWaiting;\n`), []);
    assert.equal((await refusals('dispatch/checklist.mjs', `const { isBlocked } = await import('../scripts/lib/ready-work.mjs');\nexport const x = isBlocked;\n`)).length, 1);
    assert.equal((await refusals('dispatch/waits.mjs', `const { labelRow } = await import('../scripts/lib/ready-work.mjs');\nexport const x = labelRow;\n`)).length, 1);
  });

  test('a query or fragment on the path does not hide the module', async () => {
    assert.equal((await refusals('dispatch/new-path.mjs', `const { isBlocked } = await import('../scripts/lib/ready-work.mjs?v=1');\nexport const x = isBlocked;\n`)).length, 1);
    assert.equal((await refusals('dispatch/new-path.mjs', `const { isBlocked } = await import('../scripts/lib/ready-work.mjs#x');\nexport const x = isBlocked;\n`)).length, 1);
  });

  test('an import() kept only for its side effects takes no check', async () => {
    assert.deepEqual(await refusals('dispatch/new-path.mjs', `await import('../scripts/lib/ready-work.mjs');\n`), []);
    assert.deepEqual(await refusals('dispatch/new-path.mjs', `import('../scripts/lib/ready-work.mjs');\n`), []);
  });

  test('ready-work.mjs itself and tests stay outside', async () => {
    assert.deepEqual(await refusals('scripts/lib/ready-work.mjs', `const { isBlocked } = await import('./ready-work.mjs');\nexport const x = isBlocked;\n`), []);
    assert.deepEqual(await refusals('test/new-path.test.ts', `const { isBlocked } = await import('../scripts/lib/ready-work.mjs');\nexport const x = isBlocked;\n`), []);
  });
});
