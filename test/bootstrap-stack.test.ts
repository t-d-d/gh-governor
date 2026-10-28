/**
 * The bootstrap stack and its place in the deploy (infra/bootstrap.cfn.yml).
 *
 * It holds what the main stack cannot create for itself: GitHub's OIDC
 * provider, the role the deploy assumes, and the secrets the operator writes
 * before the first deploy. The operator applies it once by hand, and every
 * deploy after that applies it before the main stack. The facts span the two
 * templates, the deploy and the operator's scripts, so they are held here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ACCOUNT_ID_PLACEHOLDER, loadTemplate } from './helpers/cfn.ts';
import { loadWorkflow, type WorkflowStep } from './helpers/workflow.ts';
import { appliesStack, REPO_ROOT, usesAction } from './helpers/repo-model.ts';
import { SECRETS } from '../scripts/save-secret.mjs';
import { parseArgs as mintArgs } from '../scripts/mint-claude-login.mjs';

const substitutions = { 'AWS::AccountId': ACCOUNT_ID_PLACEHOLDER, 'AWS::Region': 'us-east-1' };
const bootstrap = loadTemplate(resolve(REPO_ROOT, 'infra/bootstrap.cfn.yml'), substitutions);
const main = loadTemplate(resolve(REPO_ROOT, 'infra/governor.cfn.yml'), substitutions);
const { workflow } = loadWorkflow(resolve(REPO_ROOT, '.github/workflows/deploy.yml'));
const steps: WorkflowStep[] = workflow.jobs?.deploy?.steps ?? [];

/** The secrets the operator writes, by their logical ids in the bootstrap stack. */
const OPERATOR_SECRETS = {
  ClaudeLoginSecret: 'governor/claude-login',
  GitHubAppSecret: 'governor/github-app',
  SessionLogWriterSecret: 'governor/session-log-writer',
} as const;

const nameOf = (id: keyof typeof OPERATOR_SECRETS): unknown => bootstrap.Resources[id]?.Properties?.Name;

describe('infra/bootstrap.cfn.yml', () => {
  test('holds GitHub\'s OIDC provider, the deploy role and the secrets the operator writes, and nothing else', () => {
    const resources = Object.entries(bootstrap.Resources).map(([id, r]) => `${id} ${r.Type}`).sort();
    assert.deepEqual(resources, [
      'ClaudeLoginSecret AWS::SecretsManager::Secret',
      'DeployRole AWS::IAM::Role',
      'GitHubAppSecret AWS::SecretsManager::Secret',
      'GitHubOidcProvider AWS::IAM::OIDCProvider',
      'SessionLogWriterSecret AWS::SecretsManager::Secret',
    ]);
    const provider = bootstrap.Resources.GitHubOidcProvider?.Properties;
    assert.equal(provider?.Url, 'https://token.actions.githubusercontent.com');
    assert.deepEqual(provider?.ClientIdList, ['sts.amazonaws.com']);
  });

  // A role that creates the stack's roles and passes them to Lambda can make
  // itself an administrator, so a narrower policy would not hold.
  test('the deploy role is an administrator, under the fixed name the README gives', () => {
    const role = bootstrap.Resources.DeployRole?.Properties;
    assert.equal(role?.RoleName, 'governor-github-deploy');
    assert.deepEqual(role?.ManagedPolicyArns, ['arn:aws:iam::aws:policy/AdministratorAccess']);
    assert.equal(role?.Policies, undefined);
  });

  // GitHub gives a repo created after 15 July 2026 a token subject that
  // carries the owner and repo ids beside their names, so a trust by name
  // alone refuses every deploy. The ids also keep a later repo that takes
  // either name from assuming the role.
  test('the deploy role trusts a run on the repo\'s main alone, naming the repo by owner and repo id', () => {
    const trust = bootstrap.Resources.DeployRole?.Properties?.AssumeRolePolicyDocument?.Statement;
    assert.equal(trust?.length, 1);
    assert.equal(trust[0].Effect, 'Allow');
    assert.equal(trust[0].Action, 'sts:AssumeRoleWithWebIdentity');
    assert.deepEqual(trust[0].Principal, { Federated: '${GitHubOidcProvider.Arn}' });
    assert.deepEqual(trust[0].Condition, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': 'repo:${GitHubOwner}@${GitHubOwnerId}/${GitHubRepo}@${GitHubRepoId}:ref:refs/heads/main',
      },
    });
  });

  test('names no repo of its own: the owner, the repo and their ids are parameters with no default', () => {
    for (const name of ['GitHubOwner', 'GitHubOwnerId', 'GitHubRepo', 'GitHubRepoId']) {
      assert.ok(bootstrap.Parameters?.[name], `no ${name} parameter`);
      assert.equal(bootstrap.Parameters?.[name]?.Default, undefined, `${name} has a default a fork would deploy`);
    }
    for (const name of ['GitHubOwnerId', 'GitHubRepoId']) {
      assert.equal(bootstrap.Parameters?.[name]?.AllowedPattern, '^[1-9][0-9]*$', `${name} takes a number`);
    }
  });

  // The login is minted by hand and lasts about two weeks; a template change
  // that dropped or replaced its secret would take it with it. A failed first
  // create is the exception: under a plain Retain its rollback leaves the
  // three names taken, and the next create fails on them.
  test('each secret starts as a placeholder, is kept if its resource is removed or replaced, and goes with a failed first create', () => {
    for (const [id, name] of Object.entries(OPERATOR_SECRETS)) {
      const secret = bootstrap.Resources[id];
      assert.equal(secret?.Properties?.Name, name, id);
      assert.equal(secret?.Properties?.SecretString, undefined, `${id} carries a value in the template`);
      assert.ok(secret?.Properties?.GenerateSecretString, `${id} has no placeholder`);
      assert.equal(secret?.DeletionPolicy, 'RetainExceptOnCreate', `${id} is deleted with its resource, or outlives a failed first create`);
      assert.equal(secret?.UpdateReplacePolicy, 'Retain', `${id} is deleted when its resource is replaced`);
    }
  });

  test('outputs the role\'s ARN, the value of AWS_DEPLOY_ROLE_ARN', () => {
    assert.equal(bootstrap.Outputs?.DeployRoleArn?.Value, '${DeployRole.Arn}');
  });
});

describe('the secrets the operator writes', () => {
  test('the task reads each by the name the bootstrap stack gives it', () => {
    const container = main.Resources.DispatchTaskDefinition?.Properties?.ContainerDefinitions?.[0];
    const env = new Map<string, unknown>((container?.Environment ?? []).map((e: { Name: string; Value: unknown }) => [e.Name, e.Value]));
    assert.equal(env.get('CLAUDE_LOGIN_SECRET_ID'), nameOf('ClaudeLoginSecret'));
    assert.equal(env.get('GITHUB_APP_SECRET_ID'), nameOf('GitHubAppSecret'));
    assert.equal(env.get('SESSION_LOG_SECRET_ID'), nameOf('SessionLogWriterSecret'));
  });

  test('the operator\'s scripts write to those names', () => {
    assert.equal(mintArgs([]).secret, nameOf('ClaudeLoginSecret'));
    assert.equal(SECRETS['github-app'], nameOf('GitHubAppSecret'));
    assert.equal(SECRETS['session-log-writer'], nameOf('SessionLogWriterSecret'));
  });
});

describe('.github/workflows/deploy.yml: the bootstrap stack', () => {
  const credentials = steps.findIndex(usesAction('aws-actions/configure-aws-credentials'));
  const applyBootstrap = steps.findIndex(appliesStack('governor-bootstrap'));
  const applyMain = steps.findIndex(appliesStack('governor'));

  test('applies the bootstrap stack once it holds the role, and before the main stack', () => {
    assert.ok(credentials >= 0, 'no step takes the deploy role');
    assert.ok(applyBootstrap > credentials, 'the bootstrap stack is applied before the job holds the role');
    assert.ok(applyMain > applyBootstrap, 'the main stack is applied before the bootstrap stack');
  });

  // A bootstrap stack stuck in UPDATE_ROLLBACK_FAILED refuses every update,
  // and the main stack's guard runs only after this apply.
  test('continues a stalled rollback of the bootstrap stack before applying it', () => {
    const guard = steps.findIndex((s) => /cfn-continue-stalled-rollback\.mjs governor-bootstrap(?![\w-])/.test(s.run ?? ''));
    assert.ok(guard > credentials, 'no guard for the bootstrap stack once the job holds the role');
    assert.ok(guard < applyBootstrap, 'the guard runs after the bootstrap apply');
    assert.equal(steps[guard]?.if, '${{ !inputs.probe_only }}');
  });

  test('applies the bootstrap template with the capability its named role needs, and no change is no failure', () => {
    const run = steps[applyBootstrap]?.run ?? '';
    assert.match(run, /--template-file infra\/bootstrap\.cfn\.yml(?=\s)/);
    assert.match(run, /--capabilities CAPABILITY_NAMED_IAM(?=\s)/);
    assert.match(run, /--no-fail-on-empty-changeset/);
  });

  // `aws cloudformation deploy` keeps a parameter it is not given, so a
  // dropped override would deploy the hand-applied values forever, unseen.
  test('names the repo and its ids from the run, so no file holds them', () => {
    const step = steps[applyBootstrap];
    for (const [parameter, variable, context] of [
      ['GitHubOwner', 'OWNER', 'github.repository_owner'],
      ['GitHubOwnerId', 'OWNER_ID', 'github.repository_owner_id'],
      ['GitHubRepo', 'REPO', 'github.event.repository.name'],
      ['GitHubRepoId', 'REPO_ID', 'github.repository_id'],
    ] as const) {
      assert.match(step?.run ?? '', new RegExp(`"${parameter}=\\$\\{${variable}\\}"`), parameter);
      assert.equal(step?.env?.[variable], `\${{ ${context} }}`, variable);
    }
  });

  test('a probe-only run applies neither stack', () => {
    assert.equal(steps[applyBootstrap]?.if, '${{ !inputs.probe_only }}');
    assert.equal(steps[applyMain]?.if, '${{ !inputs.probe_only }}');
  });
});
