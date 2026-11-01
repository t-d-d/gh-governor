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

  test('reads its other values from the five repository variables the README lists', () => {
    const variables = [...new Set([...codeOnly.matchAll(/\bvars\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(variables, ['APP_ID', 'APP_SLUG', 'AWS_REGION', 'GOVERNOR_OWNERS', 'SELECT_LABELS']);
  });
});

// The deploy role's ARN carries the account id, and so do the registry and
// the image URI. Actions masks a secret's exact string, and the credentials
// action masks the account id in every later line when it is asked to.
describe('fitness: the deploy\'s log never shows the AWS account id (public-repo.md)', () => {
  const { workflow, codeOnly } = loadWorkflow(resolve(REPO_ROOT, '.github/workflows/deploy.yml'));
  const credentials = (workflow.jobs?.deploy?.steps ?? []).filter(
    (step: { uses?: string }) => step.uses?.startsWith('aws-actions/configure-aws-credentials@'),
  );

  test('the deploy assumes the role named by a secret, and masks the account id', () => {
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].with?.['role-to-assume'], '${{ secrets.AWS_DEPLOY_ROLE_ARN }}');
    assert.equal(credentials[0].with?.['mask-aws-account-id'], true);
  });

  test('the deploy\'s switch reads the secret, never a variable of the same name', () => {
    assert.doesNotMatch(codeOnly, /vars\.AWS_DEPLOY_ROLE_ARN/);
    assert.equal(workflow.jobs?.deploy?.if, "${{ needs.role.outputs.set == 'true' }}");
    const role = workflow.jobs?.role;
    assert.equal(role?.outputs?.set, '${{ steps.read.outputs.set }}');
    const read = (role?.steps ?? []).find((step: { id?: string }) => step.id === 'read');
    assert.equal(read?.env?.ROLE_ARN, '${{ secrets.AWS_DEPLOY_ROLE_ARN }}');
  });
});
