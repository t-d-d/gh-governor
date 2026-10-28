/**
 * Every tracked file, its path included, passes the public-repo scan. The
 * gate runs the same scan as `npm run scan`; this holds it in `npm test`
 * too, so a test run alone cannot pass a file the gate would refuse.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { scanRepo, trackedFiles } from '../scripts/public-repo-scan.mjs';
import { loadTemplate } from './helpers/cfn.ts';
import { appliesStack, REPO_ROOT } from './helpers/repo-model.ts';
import { loadWorkflow } from './helpers/workflow.ts';

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

// Anyone can read a public repo's Actions logs, and a step's env block prints
// each value it is given. Actions masks only a secret's exact string.
describe('fitness: the alert email never passes through GitHub, and the drop box is a repository secret (public-repo.md)', () => {
  const { workflow, codeOnly } = loadWorkflow(resolve(REPO_ROOT, '.github/workflows/deploy.yml'));
  const apply = (workflow.jobs?.deploy?.steps ?? []).find(appliesStack('governor'));
  const stack = loadTemplate(resolve(REPO_ROOT, 'infra/governor.cfn.yml'));

  test('the stack reads the alert email from Parameter Store, and the deploy names it nowhere', () => {
    assert.equal(stack.Parameters?.AlertEmail?.Type, 'AWS::SSM::Parameter::Value<String>');
    assert.equal(stack.Parameters?.AlertEmail?.Default, '/governor/alert-email');
    assert.doesNotMatch(codeOnly, /ALERT_EMAIL|AlertEmail/);
  });

  test('the apply takes the drop box from a secret', () => {
    assert.equal(apply?.env?.DROP_BOX_URL, '${{ secrets.DROP_BOX_URL }}');
  });

  test('reads its other values from the six repository variables the README lists', () => {
    const variables = [...new Set([...codeOnly.matchAll(/\bvars\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(variables, ['APP_ID', 'APP_SLUG', 'AWS_DEPLOY_ROLE_ARN', 'AWS_REGION', 'GOVERNOR_OWNERS', 'SELECT_LABELS']);
  });
});
