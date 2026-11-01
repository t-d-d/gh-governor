/**
 * The dispatcher stack and the workflow that ships it, held to what their
 * headers promise (infra/governor.cfn.yml, .github/workflows/deploy.yml).
 *
 * The facts span three files: the template, the workflow and the
 * Dockerfile. The grants are what keep a stored full claude.ai login
 * readable by one task and writable by that task alone; the image tag is
 * honest only while the workflow hashes exactly what the Dockerfile copies.
 * None of that is visible to a green deploy, so it is a fitness sweep.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGIN_EXPIRY_WARNING_MS } from '../scripts/lib/claude-login.mjs';
import {
  ACCOUNT_ID_PLACEHOLDER,
  asList,
  inlinePolicyStatements,
  loadTemplate,
  resourcesOfType,
  type Statement,
} from './helpers/cfn.ts';
import { loadWorkflow, type WorkflowStep } from './helpers/workflow.ts';
import { appliesStack, runsCommand, runsScript, usesAction, withId } from './helpers/repo-model.ts';
import { importClosure, relativeImports } from './helpers/imports.ts';
import { OUTPUT_KEYS, START_BUDGET_MS } from '../scripts/run-turn.mjs';
import { DEADLINE_MS } from '../dispatch/cli.mjs';
import { SESSION_UNRECORDED, STATE_TTL_ATTRIBUTE } from '../dispatch/turn.mjs';
import { DEFER_SECONDS } from '../dispatch/webhook/starter.mjs';
import { MAX_START_ATTEMPTS } from '../dispatch/webhook/retry.mjs';
import { HOOK_EVENTS } from '../dispatch/webhook/route.mjs';
import { HOOK_KEY_STALE } from '../dispatch/webhook/hook-table.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const substitutions = { 'AWS::AccountId': ACCOUNT_ID_PLACEHOLDER, 'AWS::Region': 'us-east-1' };
const template = loadTemplate(resolve(ROOT, 'infra/governor.cfn.yml'), substitutions);
const { workflow, codeOnly } = loadWorkflow(resolve(ROOT, '.github/workflows/deploy.yml'));
const steps: WorkflowStep[] = workflow.jobs?.deploy?.steps ?? [];
/** The step that builds and pushes the task image, through the shared action. */
const buildsImage = usesAction('./.github/actions/image');
const dockerfile = readFileSync(resolve(ROOT, 'dispatch/Dockerfile'), 'utf8');

const taskDefinition = template.Resources.DispatchTaskDefinition;
const container = taskDefinition?.Properties?.ContainerDefinitions?.[0];
const actionsOf = (s: Statement) => asList(s.Action);
const sidOf = (s: Statement) => String((s as { Sid?: string }).Sid ?? '');
const resourcesOf = (s: Statement) => asList(s.Resource).map(String);
const ACCOUNT = ACCOUNT_ID_PLACEHOLDER;
// The secrets the operator writes live in the bootstrap stack
// (infra/bootstrap.cfn.yml), so this stack names them. Secrets Manager ends a
// secret's ARN with six random characters after its name.
const loginName = 'governor/claude-login';
const appName = 'governor/github-app';
const writerName = 'governor/session-log-writer';
const arnOfSecret = (name: string) => `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:${name}-??????`;
const loginArn = arnOfSecret(loginName);
const appArn = arnOfSecret(appName);
const writerArn = arnOfSecret(writerName);
const LOG_GROUP = '/governor';


describe('infra/governor.cfn.yml — the task', () => {
  test('is a Fargate task on arm64 running the image the workflow resolves; the only Lambda is the webhook receiver', () => {
    assert.equal(taskDefinition?.Type, 'AWS::ECS::TaskDefinition');
    assert.deepEqual(taskDefinition?.Properties?.RequiresCompatibilities, ['FARGATE']);
    assert.equal(taskDefinition?.Properties?.NetworkMode, 'awsvpc');
    assert.equal(taskDefinition?.Properties?.RuntimePlatform?.CpuArchitecture, 'ARM64');
    assert.equal(taskDefinition?.Properties?.Family, 'governor');
    assert.equal(container?.Image, '${ImageUri}');
    assert.equal(template.Resources.DispatchCluster?.Type, 'AWS::ECS::Cluster');
    // A Lambda has no pseudo-terminal devices (run 36132993403): the turn
    // runs as a task, and the Lambdas here are the webhook receiver, the
    // starter that drains its lane, and the retrier that puts back a fire
    // whose task failed to start.
    const lambdas = Object.entries(template.Resources).filter(([, r]) => r.Type === 'AWS::Lambda::Function').map(([id]) => id);
    assert.deepEqual(lambdas.sort(), ['RetrierFunction', 'StarterFunction', 'WebhookFunction']);
  });

  /**
   * node is the container's PID 1, and PID 1 gets no default signal
   * handling: a stop-task's SIGTERM is dropped and the task lives on until
   * the SIGKILL thirty seconds later; the launcher's orphaned grandchildren
   * are never reaped. Fargate's init process forwards the one and reaps the
   * other.
   */
  test('runs under an init process, so a stop reaches node and orphans are reaped', () => {
    assert.equal(container?.LinuxParameters?.InitProcessEnabled, true);
  });

  test('logs to its own group, whose lines the metric filter and the probe read', () => {
    const group = template.Resources.DispatchLogGroup;
    assert.equal(group?.Type, 'AWS::Logs::LogGroup');
    assert.equal(group?.Properties?.LogGroupName, LOG_GROUP);
    assert.equal(container?.LogConfiguration?.LogDriver, 'awslogs');
    assert.equal(container?.LogConfiguration?.Options?.['awslogs-group'], '${DispatchLogGroup}');
    assert.ok(container?.LogConfiguration?.Options?.['awslogs-stream-prefix'], 'no stream prefix: the probe cannot name the stream to tail');
  });

  test('carries every setting the turn reads, and no credential in its environment', () => {
    const env = new Map<string, unknown>((container?.Environment ?? []).map((e: { Name: string; Value: unknown }) => [e.Name, e.Value]));
    for (const name of ['CLAUDE_LOGIN_SECRET_ID', 'GITHUB_APP_SECRET_ID', 'DISPATCH_OWNERS', 'DISPATCH_CAP', 'SESSION_LOG_SECRET_ID', 'SESSION_LOG_URL']) {
      assert.ok(env.has(name), `${name} missing from the container environment`);
    }
    // Every fire names its repo, and the bare schedule fire sweeps the served ones.
    assert.ok(!env.has('GITHUB_REPOSITORY'), 'the task has no repo of its own to fall back to');
    assert.equal(template.Parameters?.GitHubRepository, undefined, 'nothing reads GitHubRepository');
    for (const name of env.keys()) {
      assert.doesNotMatch(name, /TOKEN|KEY$|PASSWORD|LOGIN_JSON/, `${name} puts a credential in the environment`);
    }
    assert.ok(!env.has('DISPATCH_EVENT'), 'the event is what each run overrides, never a fixed value');
  });

  // The PR review's transcripts go to the drop box under a writer of
  // governor's own, named so a reader tells them from a session's.
  test('writes review transcripts to the drop box under its own writer', () => {
    const env = new Map<string, unknown>((container?.Environment ?? []).map((e: { Name: string; Value: unknown }) => [e.Name, e.Value]));
    assert.equal(env.get('SESSION_LOG_SECRET_ID'), writerName);
    assert.equal(env.get('SESSION_LOG_URL'), '${DropBoxUrl}');
    assert.equal(template.Parameters?.DropBoxUrl?.Default, '', 'the drop box is optional');
  });

  test('runs under the task role for its secrets and the execution role for the pull and the logs', () => {
    assert.equal(taskDefinition?.Properties?.TaskRoleArn, '${DispatchRole.Arn}');
    assert.equal(taskDefinition?.Properties?.ExecutionRoleArn, '${DispatchExecutionRole.Arn}');
    for (const id of ['DispatchRole', 'DispatchExecutionRole']) {
      const trusted = template.Resources[id]?.Properties?.AssumeRolePolicyDocument?.Statement?.[0]?.Principal?.Service;
      assert.equal(trusted, 'ecs-tasks.amazonaws.com', `${id} is not assumable by ECS tasks`);
    }
  });

  test('outputs exactly what scripts/run-turn.mjs reads to start one by hand', () => {
    for (const key of Object.values(OUTPUT_KEYS)) {
      assert.ok(template.Outputs?.[key], `the script reads output ${key}, which the template does not declare`);
    }
    assert.equal(template.Outputs?.[OUTPUT_KEYS.container]?.Value, container?.Name);
    assert.equal(template.Outputs?.[OUTPUT_KEYS.logStreamPrefix]?.Value, container?.LogConfiguration?.Options?.['awslogs-stream-prefix']);
    assert.equal(template.Outputs?.[OUTPUT_KEYS.firesQueueUrl]?.Value, '${DispatchFiresQueue}', 'a by-hand fire queues on the lane the starter drains');
    assert.equal(template.Outputs?.[OUTPUT_KEYS.starterLogGroup]?.Value, '${StarterLogGroup}', 'a by-hand fire finds its task in the starter\'s log');
  });
});

/**
 * A record one dispatcher turn writes for a later one lives in
 * the stack's one table; logs are never read back as state.
 */
describe('fitness: the dispatcher keeps its state in one table, and the receiver its own (dispatcher-state.md)', () => {
  const tables = Object.entries(template.Resources).filter(([, r]) => r?.Type === 'AWS::DynamoDB::Table');
  const taskStatements = inlinePolicyStatements(template, 'DispatchRole');
  const receiverStatements = inlinePolicyStatements(template, 'WebhookRole');
  const dynamoGrants = (statements: Statement[]) => statements.filter((s) => actionsOf(s).some((a) => a.startsWith('dynamodb:')));
  const env = new Map<string, unknown>((container?.Environment ?? []).map((e: { Name: string; Value: unknown }) => [e.Name, e.Value]));

  // The receiver is the internet-facing function: a different access
  // boundary, the one exception the file names to a table per use.
  test('two tables: the state table, and the hook table the receiver reads', () => {
    assert.deepEqual(tables.map(([id]) => id).sort(), ['DispatchHookTable', 'DispatchStateTable']);
  });

  test('each is on demand, keyed pk/sk, with a TTL, and named by CloudFormation', () => {
    for (const [id, table] of tables) {
      assert.equal(table.Properties?.BillingMode, 'PAY_PER_REQUEST', id);
      assert.equal(table.Properties?.TableName, undefined, `${id}: a named table cannot be re-created`);
      assert.equal(table.Properties?.TimeToLiveSpecification?.Enabled, true, id);
      assert.equal(
        table.Properties?.TimeToLiveSpecification?.AttributeName, STATE_TTL_ATTRIBUTE,
        `${id} expires the attribute the delivered records are stamped with`,
      );
      assert.deepEqual(table.Properties?.KeySchema, [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], id);
    }
  });

  test('the task is handed both, and the receiver the hook table alone', () => {
    assert.equal(env.get('DISPATCH_STATE_TABLE'), '${DispatchStateTable}');
    assert.equal(env.get('DISPATCH_HOOK_TABLE'), '${DispatchHookTable}');
    const receiver = template.Resources.WebhookFunction?.Properties?.Environment?.Variables ?? {};
    assert.equal(receiver.HOOK_TABLE, '${DispatchHookTable}');
    assert.ok(!JSON.stringify(receiver).includes('DispatchStateTable'), 'the receiver is not told of the state table');
  });

  test('the task reaches the state table\'s items, and only puts the hook table\'s', () => {
    const items = new Set(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query']);
    const grants = dynamoGrants(taskStatements);
    const onState = grants.filter((s) => resourcesOf(s).includes('${DispatchStateTable.Arn}'));
    const onHooks = grants.filter((s) => resourcesOf(s).includes('${DispatchHookTable.Arn}'));
    assert.ok(onState.length > 0);
    for (const s of grants) {
      for (const a of actionsOf(s)) assert.ok(items.has(a), `${a} is not an item action`);
      assert.equal(resourcesOf(s).length, 1, 'one table per statement');
    }
    assert.deepEqual(onHooks.flatMap(actionsOf), ['dynamodb:PutItem']);
    assert.equal(onState.length + onHooks.length, grants.length, 'the task reaches no other table');
  });

  test('the receiver holds GetItem and UpdateItem on the hook table, and nothing on the state table', () => {
    const grants = dynamoGrants(receiverStatements);
    assert.deepEqual(grants.flatMap(actionsOf).sort(), ['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    assert.deepEqual([...new Set(grants.flatMap(resourcesOf))], ['${DispatchHookTable.Arn}']);
    assert.ok(!JSON.stringify(receiverStatements).includes('DispatchStateTable'));
  });

  test('the task reads no log back', () => {
    const reads = taskStatements.flatMap(actionsOf).filter((a) => a.startsWith('logs:'));
    assert.deepEqual(reads, []);
    for (const file of readdirSync(resolve(ROOT, 'dispatch'), { recursive: true }).map(String).filter((f) => f.endsWith('.mjs') && !f.includes('node_modules'))) {
      assert.doesNotMatch(readFileSync(resolve(ROOT, 'dispatch', file), 'utf8'), /client-cloudwatch-logs/, `dispatch/${file} reads the logs`);
    }
  });
});

describe('infra/governor.cfn.yml — the grants', () => {
  const taskStatements = inlinePolicyStatements(template, 'DispatchRole');
  const executionStatements = inlinePolicyStatements(template, 'DispatchExecutionRole');
  const webhookStatements = inlinePolicyStatements(template, 'WebhookRole');

  test('every role holds its policy inline, where this test can read all of it', () => {
    for (const id of ['DispatchRole', 'DispatchExecutionRole', 'WebhookRole', 'StarterRole', 'RetrierRole']) {
      assert.equal(template.Resources[id]?.Properties?.ManagedPolicyArns, undefined, `${id} attaches a managed policy`);
      assert.ok(inlinePolicyStatements(template, id).length > 0, `no inline statements on ${id}`);
    }
  });

  // The sign-off sweep waits for replies only while no fire is queued
  // (scripts/lib/session-signoff.mjs): it counts the lane. A close queues
  // an `unblocked` fire per ticket it blocked (dispatch/unblocked.mjs). It
  // takes nothing off the lane.
  test('the task counts the fire lane and sends to it, and does nothing else to it', () => {
    const sqs = taskStatements.filter((s) => actionsOf(s).some((a) => a.startsWith('sqs:')));
    assert.deepEqual(sqs.flatMap(actionsOf).sort(), ['sqs:GetQueueAttributes', 'sqs:SendMessage']);
    for (const statement of sqs) assert.deepEqual(resourcesOf(statement), ['${DispatchFiresQueue.Arn}']);
    const container = template.Resources.DispatchTaskDefinition?.Properties?.ContainerDefinitions?.[0];
    const env = new Map<string, unknown>((container?.Environment ?? []).map((e: { Name: string; Value: unknown }) => [e.Name, e.Value]));
    assert.equal(env.get('DISPATCH_FIRES_QUEUE_URL'), '${DispatchFiresQueue}');
  });

  test('the task reads its three secrets, writes the login alone, and nothing else', () => {
    assert.deepEqual(
      [...new Set(taskStatements.flatMap(actionsOf))].sort(),
      ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'sqs:GetQueueAttributes', 'sqs:SendMessage'],
    );
    const puts = taskStatements.filter((s) => actionsOf(s).includes('secretsmanager:PutSecretValue'));
    assert.equal(puts.length, 1);
    assert.deepEqual(resourcesOf(puts[0]!), [loginArn], 'PutSecretValue reaches a secret that is not the login');
    const gets = taskStatements.filter((s) => actionsOf(s).includes('secretsmanager:GetSecretValue'));
    assert.deepEqual(new Set(gets.flatMap(resourcesOf)), new Set([loginArn, appArn, writerArn]));
  });

  // The sweep reads each session's sign-off from the session's own events
  // (scripts/lib/session-signoff.mjs); no session writes a record for it.
  describe('fitness: the task role holds no grant on sign-off keys (session-signoff.md)', () => {
    test('no statement reaches the drop box, and the task is not told where it is', () => {
      const s3 = taskStatements.filter((s) => actionsOf(s).some((a) => a.startsWith('s3:')) || resourcesOf(s).some((r) => /session-logs|signoff/.test(r)));
      assert.deepEqual(s3, [], JSON.stringify(s3));
      const container = template.Resources.DispatchTaskDefinition?.Properties?.ContainerDefinitions?.[0];
      const names = (container?.Environment ?? []).map((e: { Name: string }) => e.Name);
      assert.ok(!names.includes('SESSION_LOG_BUCKET'), names.join());
    });
  });

  test('the execution role pulls the one image and writes the one log group', () => {
    const pulls = executionStatements.filter((s) => actionsOf(s).includes('ecr:BatchGetImage'));
    assert.equal(pulls.length, 1);
    const repo = (steps.find(buildsImage)?.with?.repo_name ?? '') as string;
    assert.deepEqual(resourcesOf(pulls[0]!), [`arn:aws:ecr:us-east-1:${ACCOUNT}:repository/${repo}`], 'the pull grant names a repository the workflow does not push to');
    // `!GetAtt LogGroup.Arn` is `…:log-group:<name>:*`; appending another
    // `:*` demands two segments after the name and misses the group itself.
    const logs = executionStatements.filter((s) => actionsOf(s).includes('logs:PutLogEvents'));
    assert.equal(logs.length, 1);
    assert.deepEqual(resourcesOf(logs[0]!), ['${DispatchLogGroup.Arn}']);
  });

  test('no statement is a wildcard, except the two list-style calls that take no resource', () => {
    for (const s of [...taskStatements, ...executionStatements, ...webhookStatements]) {
      assert.ok(!actionsOf(s).some((a) => a === '*' || a.endsWith(':*')), `wildcard action in ${sidOf(s)}`);
      if (resourcesOf(s).includes('*')) {
        assert.ok(['ecr:GetAuthorizationToken', 'ecs:ListTasks'].includes(actionsOf(s).join()), `wildcard resource in ${sidOf(s)}`);
        if (actionsOf(s).join() === 'ecs:ListTasks') assert.ok(s.Condition?.ArnEquals?.['ecs:cluster'], 'ListTasks on every cluster');
      }
    }
  });

  // A failed first create is cleared by deleting this stack, which must not
  // take the login, the App key or the writer with it.
  test('creates no secret the operator writes: its only secrets are the webhook key and the hook secret, each generated', () => {
    assert.deepEqual(resourcesOfType(template, 'AWS::SecretsManager::Secret').map(([id]) => id).sort(), ['HookSecret', 'WebhookSecret']);
  });
});

describe('infra/governor.cfn.yml — the schedule', () => {
  const rule = template.Resources.ScheduleRule;
  const target = rule?.Properties?.Targets?.[0];

  /**
   * The rule invokes the receiver rather than RunTask directly, so the
   * schedule and a webhook delivery share one running-task guard: a task a
   * delivery started at :10 is still running at :17, and a rule that ran
   * the task itself would start a second turn refreshing the same login.
   */
  test('fires the receiver with the schedule event, and is allowed to', () => {
    assert.equal(rule?.Type, 'AWS::Events::Rule');
    assert.equal(rule?.Properties?.State, 'ENABLED');
    assert.equal(target?.Arn, '${WebhookFunction.Arn}');
    assert.equal(target?.EcsParameters, undefined, 'the rule must not start the task itself');
    assert.deepEqual(JSON.parse(target?.Input ?? 'null'), { kind: 'schedule' });
    // A receiver EventBridge could not invoke is retried, inside the lane's
    // five-minute deduplication window, so a retry of a fire it did queue is
    // not a second fire.
    assert.ok(Number(target?.RetryPolicy?.MaximumRetryAttempts) >= 1, 'a throttled invoke loses the schedule fire for two hours');
    assert.ok(Number(target?.RetryPolicy?.MaximumEventAgeInSeconds) <= 300, 'a retry past the deduplication window could queue a second fire');
    const permission = template.Resources.SchedulePermission?.Properties;
    assert.equal(permission?.Principal, 'events.amazonaws.com');
    assert.equal(permission?.FunctionName, '${WebhookFunction}');
    assert.equal(permission?.SourceArn, '${ScheduleRule.Arn}');
    assert.equal(template.Resources.DispatchEventsRole, undefined, 'no role starts the task but the receiver\'s');
    assert.equal(template.Parameters?.SubnetIds?.Type, 'List<AWS::EC2::Subnet::Id>');
  });

});

describe('infra/governor.cfn.yml — the alarms', () => {
  test('a turn that failed is a tripwire, read off the line the task logs, never off a level', () => {
    const filter = template.Resources.DispatchFailuresFilter;
    assert.equal(filter?.Type, 'AWS::Logs::MetricFilter');
    assert.equal(filter?.Properties?.LogGroupName, '${DispatchLogGroup}');
    assert.match(filter?.Properties?.FilterPattern ?? '', /\$\.event = "dispatch-failed"/);
    assert.doesNotMatch(filter?.Properties?.FilterPattern ?? '', /\$\.level/);
    const published = filter?.Properties?.MetricTransformations?.[0];
    const alarm = template.Resources.DispatchErrorsAlarm;
    assert.equal(alarm?.Type, 'AWS::CloudWatch::Alarm');
    assert.equal(alarm?.Properties?.Namespace, published?.MetricNamespace);
    assert.equal(alarm?.Properties?.MetricName, published?.MetricName);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\]/);
    assert.equal(alarm?.Properties?.TreatMissingData, 'notBreaching');
  });

  /**
   * A turn that refuses to plan from a stale runs list exits 0, so the
   * failures filter never hears it. A run of stale answers would
   * silence every deploy notice with only log lines to say so.
   */
  test('a turn that refused a stale runs list is a tripwire, read off its own event, never off a level', () => {
    const filter = template.Resources.DispatchStaleRunsFilter;
    assert.equal(filter?.Type, 'AWS::Logs::MetricFilter');
    assert.equal(filter?.Properties?.LogGroupName, '${DispatchLogGroup}');
    assert.match(filter?.Properties?.FilterPattern ?? '', /\$\.event = "dispatch-stale-runs"/);
    assert.doesNotMatch(filter?.Properties?.FilterPattern ?? '', /\$\.level/);
    const published = filter?.Properties?.MetricTransformations?.[0];
    assert.notEqual(published?.MetricName, template.Resources.DispatchFailuresFilter?.Properties?.MetricTransformations?.[0]?.MetricName);
    const alarm = template.Resources.DispatchStaleRunsAlarm;
    assert.equal(alarm?.Type, 'AWS::CloudWatch::Alarm');
    assert.equal(alarm?.Properties?.Namespace, published?.MetricNamespace);
    assert.equal(alarm?.Properties?.MetricName, published?.MetricName);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\]/);
    assert.equal(alarm?.Properties?.Threshold, 1, 'one refusal pages');
    assert.equal(alarm?.Properties?.EvaluationPeriods, 1);
    assert.equal(alarm?.Properties?.TreatMissingData, 'notBreaching');
    const description = alarm?.Properties?.AlarmDescription ?? '';
    assert.match(description, /\/governor\b/, 'the description names where the line is');
    assert.match(description, /dispatch-stale-runs/);
    // A red CI refused this way told no suspect either: the page says so.
    assert.match(description, /\bCI\b/, 'a refused CI run owes its suspects a telling too');
    // The next run of the workflow tells the refused run's merges.
    assert.match(description, /next run of the same workflow/i, 'the page says the next run catches up');
    assert.match(description, /by hand/i, 'and when hand work is still owed');
  });

  /**
   * The refresh token's expiry is fixed at mint: the login dies about
   * 14 days on however often it is used. Each turn within three days of it
   * logs `dispatch-login-expiring`; this pages while there is time to re-mint.
   */
  test('a login near its refresh expiry pages, read off its own event, never off a level', () => {
    const filter = template.Resources.DispatchLoginExpiringFilter;
    assert.equal(filter?.Type, 'AWS::Logs::MetricFilter');
    assert.equal(filter?.Properties?.LogGroupName, '${DispatchLogGroup}');
    assert.match(filter?.Properties?.FilterPattern ?? '', /\$\.event = "dispatch-login-expiring"/);
    assert.doesNotMatch(filter?.Properties?.FilterPattern ?? '', /\$\.level/);
    const published = filter?.Properties?.MetricTransformations?.[0];
    const others = [template.Resources.DispatchFailuresFilter, template.Resources.DispatchStaleRunsFilter]
      .map((f) => f?.Properties?.MetricTransformations?.[0]?.MetricName);
    assert.ok(!others.includes(published?.MetricName), 'its own metric');
    const alarm = template.Resources.DispatchLoginExpiringAlarm;
    assert.equal(alarm?.Type, 'AWS::CloudWatch::Alarm');
    assert.equal(alarm?.Properties?.Namespace, published?.MetricNamespace);
    assert.equal(alarm?.Properties?.MetricName, published?.MetricName);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\]/);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /mint-claude-login\.mjs/, 'the page names the re-mint');
    // The window the page names is the one the turn warns in.
    const days = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][LOGIN_EXPIRY_WARNING_MS / 86_400_000];
    assert.match(alarm?.Properties?.AlarmDescription ?? '', new RegExp(`within ${days} days`));
    assert.equal(alarm?.Properties?.Threshold, 1);
    assert.equal(alarm?.Properties?.Period, 86400, 'a day: one page across the window, not one per turn');
    assert.equal(alarm?.Properties?.TreatMissingData, 'notBreaching');
    assert.deepEqual(alarm?.Properties?.AlarmActions, template.Resources.DispatchErrorsAlarm?.Properties?.AlarmActions, 'the same action as the errors alarm');
  });

  /**
   * A ticket the dispatcher claimed with no marker naming a session
   * stays under development with nobody known to be on it, and no fire
   * selects it again: it pages, read off its own event.
   */
  test('a stranded claim pages, read off its own event, never off a level', () => {
    const filter = template.Resources.DispatchClaimStrandedFilter;
    assert.equal(filter?.Type, 'AWS::Logs::MetricFilter');
    assert.equal(filter?.Properties?.LogGroupName, '${DispatchLogGroup}');
    assert.match(filter?.Properties?.FilterPattern ?? '', /\$\.event = "dispatch-claim-stranded"/);
    assert.doesNotMatch(filter?.Properties?.FilterPattern ?? '', /\$\.level/);
    const published = filter?.Properties?.MetricTransformations?.[0];
    const others = [template.Resources.DispatchFailuresFilter, template.Resources.DispatchStaleRunsFilter, template.Resources.DispatchLoginExpiringFilter]
      .map((f) => f?.Properties?.MetricTransformations?.[0]?.MetricName);
    assert.ok(!others.includes(published?.MetricName), 'its own metric');
    const alarm = template.Resources.DispatchClaimStrandedAlarm;
    assert.equal(alarm?.Type, 'AWS::CloudWatch::Alarm');
    assert.equal(alarm?.Properties?.Namespace, published?.MetricNamespace);
    assert.equal(alarm?.Properties?.MetricName, published?.MetricName);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\]/);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /dispatch-claim-stranded/);
    assert.equal(alarm?.Properties?.Threshold, 1);
    assert.equal(alarm?.Properties?.TreatMissingData, 'notBreaching');
    assert.deepEqual(alarm?.Properties?.AlarmActions, template.Resources.DispatchErrorsAlarm?.Properties?.AlarmActions, 'the same action as the errors alarm');
  });

  /**
   * A session governor started whose record failed to write gets no
   * human-only check from the PR review, so its PRs can clear a ticket's
   * mode label: it pages, read off its own event.
   */
  test('an unrecorded session pages, read off its own event, never off a level', () => {
    const filter = template.Resources.DispatchSessionUnrecordedFilter;
    assert.equal(filter?.Type, 'AWS::Logs::MetricFilter');
    assert.equal(filter?.Properties?.LogGroupName, '${DispatchLogGroup}');
    assert.equal(filter?.Properties?.FilterPattern, `{ $.event = "${SESSION_UNRECORDED}" }`);
    const published = filter?.Properties?.MetricTransformations?.[0];
    const others = Object.entries(template.Resources)
      .filter(([name, r]) => name !== 'DispatchSessionUnrecordedFilter' && (r as { Type?: string }).Type === 'AWS::Logs::MetricFilter')
      .map(([, f]) => (f as { Properties?: { MetricTransformations?: Array<{ MetricName?: string }> } }).Properties?.MetricTransformations?.[0]?.MetricName);
    assert.ok(published?.MetricName, 'the filter publishes a metric');
    assert.ok(!others.includes(published?.MetricName), 'its own metric');
    const alarm = template.Resources.DispatchSessionUnrecordedAlarm;
    assert.equal(alarm?.Type, 'AWS::CloudWatch::Alarm');
    assert.equal(alarm?.Properties?.Namespace, published?.MetricNamespace);
    assert.equal(alarm?.Properties?.MetricName, published?.MetricName);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\]/);
    assert.ok((alarm?.Properties?.AlarmDescription ?? '').includes(SESSION_UNRECORDED), 'the page names the line to read');
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /names no session.*sessions list.*session name/, 'the page covers a launch that printed no session');
    assert.equal(alarm?.Properties?.Threshold, 1);
    assert.equal(alarm?.Properties?.TreatMissingData, 'notBreaching');
    assert.deepEqual(alarm?.Properties?.AlarmActions, template.Resources.DispatchErrorsAlarm?.Properties?.AlarmActions, 'the same action as the errors alarm');
  });

  /**
   * A served repo's config file that fails its schema, a repo whose
   * launch started nothing, a periodic naming a connector the account
   * has not connected, and a periodic whose routine the routines API
   * refused, each page off their own event; a repo with no file pages
   * nobody.
   */
  test('an invalid config file, a skipped repo, a missing connector and a refused routine each page, read off their own event', () => {
    for (const [name, event] of [['DispatchConfigInvalid', 'dispatch-config-invalid'], ['DispatchRepoSkipped', 'dispatch-repo-skipped'], ['DispatchConnectorMissing', 'dispatch-connector-missing'], ['DispatchRoutineRefused', 'dispatch-routine-refused']]) {
      const filter = template.Resources[`${name}Filter`];
      assert.equal(filter?.Properties?.LogGroupName, '${DispatchLogGroup}', name);
      assert.match(filter?.Properties?.FilterPattern ?? '', new RegExp(`\\$\\.event = "${event}"`), name);
      assert.doesNotMatch(filter?.Properties?.FilterPattern ?? '', /\$\.level/);
      const published = filter?.Properties?.MetricTransformations?.[0];
      const alarm = template.Resources[`${name}Alarm`];
      assert.equal(alarm?.Type, 'AWS::CloudWatch::Alarm', name);
      assert.ok(published?.MetricName, `${name}: the filter publishes a metric`);
      assert.equal(alarm?.Properties?.Namespace, published?.MetricNamespace, name);
      assert.equal(alarm?.Properties?.MetricName, published?.MetricName);
      assert.equal(alarm?.Properties?.Threshold, 1, name);
      assert.equal(alarm?.Properties?.TreatMissingData, 'notBreaching', name);
      assert.match(alarm?.Properties?.AlarmDescription ?? '', new RegExp(`^\\[tripwire\\].*${event}`));
      assert.deepEqual(alarm?.Properties?.AlarmActions, template.Resources.DispatchErrorsAlarm?.Properties?.AlarmActions);
    }
    assert.ok(!Object.values(template.Resources).some((r) => /dispatch-not-served/.test(JSON.stringify((r as { Properties?: unknown }).Properties ?? {}))), 'a repo with no file pages nobody');
  });

  test('the owner list is a parameter the task reads; the cloud environment is each repo\'s file\'s, not the stack\'s', () => {
    assert.equal(template.Parameters?.DispatchOwners?.Default, undefined, 'the owner list names nobody until the deploy sets it');
    assert.equal(template.Parameters?.ClaudeRemoteEnvId, undefined);
    const env = new Map<string, unknown>((container?.Environment ?? []).map((e: { Name: string; Value: unknown }) => [e.Name, e.Value]));
    assert.equal(env.get('DISPATCH_OWNERS'), '${DispatchOwners}');
    assert.ok(!env.has('CLAUDE_REMOTE_ENV_ID'));
  });

  test('a task EventBridge could not start is a tripwire on the rule', () => {
    const alarm = template.Resources.DispatchNotStartedAlarm;
    assert.equal(alarm?.Properties?.Namespace, 'AWS/Events');
    assert.equal(alarm?.Properties?.MetricName, 'FailedInvocations');
    assert.deepEqual(alarm?.Properties?.Dimensions, [{ Name: 'RuleName', Value: '${ScheduleRule}' }]);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\]/);
  });

  /**
   * A task whose container never ran (a pull refused, no placement, an ENI
   * that would not attach) logs nothing, and the RunTask that started it
   * succeeded, so neither alarm above hears it. ECS says so on the
   * task's STOPPED event; the rule writes that event into the task's own
   * log group for the operator to read, and the alarm counts the rule's own
   * matches, so a log write EventBridge could not make still alarms.
   */
  test('a task that never started its container is logged and retried, read off the ECS stop event', () => {
    const rule = template.Resources.DispatchNotRunRule;
    assert.equal(rule?.Type, 'AWS::Events::Rule');
    assert.equal(rule.Properties?.State, 'ENABLED');
    assert.deepEqual(rule.Properties?.EventPattern, {
      source: ['aws.ecs'],
      'detail-type': ['ECS Task State Change'],
      detail: {
        clusterArn: ['${DispatchCluster.Arn}'],
        lastStatus: ['STOPPED'],
        stopCode: ['TaskFailedToStart'],
      },
    });
    const targets: Array<{ Arn?: string }> = rule.Properties?.Targets ?? [];
    assert.deepEqual(
      targets.map((t) => t.Arn).sort(),
      [`arn:aws:logs:us-east-1:${ACCOUNT}:log-group:\${DispatchLogGroup}`, '${RetrierFunction.Arn}'].sort(),
      'the rule writes the event into the dispatch log group and hands it to the retrier',
    );
    assert.match(String(rule.Properties?.Name ?? ''), /^governor-/, 'every name the stack gives starts governor-');

    // EventBridge writes to a log group on the group's resource policy, not a role.
    const policies = resourcesOfType(template, 'AWS::Logs::ResourcePolicy');
    assert.equal(policies.length, 1);
    const document = JSON.parse(String(policies[0]![1].Properties?.PolicyDocument)) as { Statement: Statement[] };
    assert.equal(document.Statement.length, 1);
    const grant = document.Statement[0]!;
    assert.deepEqual(new Set(asList((grant as { Principal?: { Service?: string | string[] } }).Principal?.Service)), new Set(['events.amazonaws.com', 'delivery.logs.amazonaws.com']));
    assert.deepEqual(new Set(actionsOf(grant)), new Set(['logs:CreateLogStream', 'logs:PutLogEvents']));
    assert.deepEqual(resourcesOf(grant), ['${DispatchLogGroup.Arn}'], 'the policy reaches a group that is not the dispatch group');

    const alarm = template.Resources.DispatchNotRunAlarm;
    assert.equal(alarm?.Type, 'AWS::CloudWatch::Alarm');
    assert.match(String(alarm?.Properties?.AlarmName), /^governor-/);
    // Counted on the rule, not off the log it writes: a delivery the log
    // group's policy refused would otherwise leave the tripwire deaf.
    assert.equal(alarm?.Properties?.Namespace, 'AWS/Events');
    assert.equal(alarm?.Properties?.MetricName, 'TriggeredRules');
    assert.deepEqual(alarm?.Properties?.Dimensions, [{ Name: 'RuleName', Value: '${DispatchNotRunRule}' }]);
    assert.equal(alarm?.Properties?.Statistic, 'Sum');
    assert.ok(Number(alarm?.Properties?.Period) * Number(alarm?.Properties?.EvaluationPeriods) <= 900, 'heard within fifteen minutes');
    // The retrier absorbs a transient, so one stop no longer pages:
    // as many stops in the window as one fire's attempts is a fault the
    // retries are not beating. The dead-letter tripwire pages the fire
    // itself.
    assert.equal(alarm?.Properties?.Threshold, MAX_START_ATTEMPTS);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /MAX_START_ATTEMPTS/, 'a threshold sized off a code constant names it');
    assert.equal(alarm?.Properties?.TreatMissingData, 'notBreaching');
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\]/);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /\/governor\b/, 'the description names where the stop reason is');
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /stoppedReason/);
  });

  /**
   * A task that ran leaves only its container's output in /governor, so
   * nothing recorded how long it took to start, or how much of that was the
   * image pull. A second rule writes every other stop event there, with its
   * pull and start times, and no event is written twice.
   */
  describe('every dispatcher task\'s stop event is logged once', () => {
    const stopRules = resourcesOfType(template, 'AWS::Events::Rule')
      .filter(([, r]) => r.Properties?.EventPattern?.source?.includes('aws.ecs'));
    const rule = template.Resources.DispatchTaskStoppedRule;
    const logTarget = `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:\${DispatchLogGroup}`;

    test('a task that ran and stopped has its stop event written into /governor', () => {
      assert.equal(rule?.Type, 'AWS::Events::Rule');
      assert.equal(rule?.Properties?.State, 'ENABLED');
      assert.match(String(rule?.Properties?.Name ?? ''), /^governor-/);
      assert.deepEqual(rule?.Properties?.EventPattern, {
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: {
          clusterArn: ['${DispatchCluster.Arn}'],
          lastStatus: ['STOPPED'],
          stopCode: [{ 'anything-but': ['TaskFailedToStart'] }],
        },
      });
      const targets: Array<{ Arn?: string }> = rule?.Properties?.Targets ?? [];
      assert.deepEqual(targets.map((t) => t.Arn), [logTarget], 'it only logs: the retrier hears tasks that failed to start alone');
    });

    test('the two rules split the stop codes, so no stop is logged twice and the not-run rule is unchanged', () => {
      assert.deepEqual(stopRules.map(([id]) => id).sort(), ['DispatchNotRunRule', 'DispatchTaskStoppedRule']);
      assert.deepEqual(template.Resources.DispatchNotRunRule?.Properties?.EventPattern?.detail?.stopCode, ['TaskFailedToStart']);
      for (const [id, r] of resourcesOfType(template, 'AWS::CloudWatch::Alarm')) {
        const dims: Array<{ Value?: string }> = r.Properties?.Dimensions ?? [];
        assert.ok(!dims.some((d) => d.Value === '${DispatchTaskStoppedRule}'), `${id} counts the stop-event log rule`);
      }
      const invokers = Object.values(template.Resources).filter((r) => r.Type === 'AWS::Lambda::Permission' && String(r.Properties?.SourceArn).includes('DispatchTaskStoppedRule'));
      assert.equal(invokers.length, 0, 'nothing but a log group hears the stop-event log rule');
    });

    test('no metric filter on /governor counts a stop event', () => {
      // An ECS Task State Change as EventBridge writes it into the group.
      const stopEvent = {
        version: '0',
        id: 'e1',
        'detail-type': 'ECS Task State Change',
        source: 'aws.ecs',
        account: ACCOUNT,
        time: '2026-11-01T16:43:10Z',
        region: 'us-east-1',
        resources: [],
        detail: {
          lastStatus: 'STOPPED',
          stopCode: 'EssentialContainerExited',
          createdAt: '2026-11-01T16:42:16Z',
          pullStartedAt: '2026-11-01T16:42:20Z',
          pullStoppedAt: '2026-11-01T16:42:41Z',
          startedAt: '2026-11-01T16:42:44Z',
          stoppedAt: '2026-11-01T16:43:09Z',
        },
      };
      const filters = resourcesOfType(template, 'AWS::Logs::MetricFilter').filter(([, f]) => f.Properties?.LogGroupName === '${DispatchLogGroup}');
      assert.ok(filters.length > 0);
      for (const [id, f] of filters) {
        const match = /^\{ \$\.(\w+) = "[^"]+" \}$/.exec(String(f.Properties?.FilterPattern));
        assert.ok(match, `${id} matches more than one top-level key`);
        assert.ok(!(match[1]! in stopEvent), `${id} matches a key a stop event carries`);
      }
    });
  });

  test('every alarm publishes to the stack\'s own alerts topic, which emails the address in Parameter Store', () => {
    for (const [id, r] of resourcesOfType(template, 'AWS::CloudWatch::Alarm')) {
      assert.deepEqual(r.Properties?.AlarmActions, ['${AlertsTopic}'], `${id} does not publish to the alerts topic`);
    }
    assert.equal(template.Resources.AlertsTopic?.Type, 'AWS::SNS::Topic');
    assert.deepEqual(template.Resources.AlertsTopic?.Properties?.Subscription, [{ Protocol: 'email', Endpoint: '${AlertEmail}' }]);
    // CloudFormation reads the address inside AWS on every apply, so it never
    // passes through GitHub, and a stack whose parameter is missing fails.
    assert.equal(template.Parameters?.AlertEmail?.Type, 'AWS::SSM::Parameter::Value<String>');
    assert.equal(template.Parameters?.AlertEmail?.Default, '/governor/alert-email');
    const apply = steps.find(appliesStack('governor'));
    assert.doesNotMatch(apply?.run ?? '', /AlertEmail=/, 'the deploy passes the address, which it should never hold');
    assert.equal(apply?.env?.ALERT_EMAIL, undefined);
  });

  test('no alarm carries a Retain in its steady-state home', () => {
    for (const [id, r] of Object.entries(template.Resources)) {
      if (r.Type === 'AWS::CloudWatch::Alarm') assert.equal(r.DeletionPolicy, undefined, `${id} is retained`);
    }
  });
});

describe('infra/governor.cfn.yml — the webhook receiver', () => {
  const fn = template.Resources.WebhookFunction;
  const statements = inlinePolicyStatements(template, 'WebhookRole');

  test('is the receiver in dispatch/webhook/, packaged from the directory the template names', () => {
    assert.equal(fn?.Properties?.Handler, 'handler.handler');
    assert.equal(fn?.Properties?.Code, '../dispatch/webhook/');
    assert.ok(existsSync(resolve(ROOT, 'infra', fn.Properties.Code, 'handler.mjs')), 'the handler the template names does not exist');
    assert.equal(fn?.Properties?.LoggingConfig?.LogFormat, 'JSON');
    assert.equal(fn?.Properties?.Role, '${WebhookRole.Arn}');
  });

  test('is reachable unsigned, since GitHub cannot sign SigV4, and verifies the HMAC instead', () => {
    assert.equal(template.Resources.WebhookUrl?.Properties?.AuthType, 'NONE');
    // A Function URL made after October 2025 answers 403 before the function
    // runs unless the policy grants the public both actions (AWS's urls-auth
    // page). The first registered hook's ping found the second one missing.
    // Either spelling of the function names the receiver: `!Ref` and
    // `!GetAtt ...Arn` both address it, and a stray public grant in the second
    // form is still a grant.
    const receiver = new Set(['${WebhookFunction}', '${WebhookFunction.Arn}']);
    const publicGrants = resourcesOfType(template, 'AWS::Lambda::Permission')
      .map(([, r]) => r.Properties ?? {})
      .filter((p) => receiver.has(String(p.FunctionName)) && p.Principal === '*');
    const url = publicGrants.find((p) => p.Action === 'lambda:InvokeFunctionUrl');
    assert.equal(url?.FunctionUrlAuthType, 'NONE');
    const invoke = publicGrants.find((p) => p.Action === 'lambda:InvokeFunction');
    assert.equal(invoke?.InvokedViaFunctionUrl, true, 'the public may invoke the receiver, through its URL alone');
    assert.equal(publicGrants.length, 2, 'the public holds the two grants the URL needs and nothing more');
    const secret = template.Resources.WebhookSecret;
    assert.equal(secret?.Type, 'AWS::SecretsManager::Secret');
    assert.equal(secret?.Properties?.GenerateSecretString?.GenerateStringKey, undefined, 'the generated string is the key itself, not a placeholder');
    assert.ok(Number(secret?.Properties?.GenerateSecretString?.PasswordLength) >= 32);
    assert.equal(fn?.Properties?.Environment?.Variables?.WEBHOOK_SECRET_ID, '${WebhookSecret}');
  });

  // The App's one webhook delivers every installation's events:
  // the receiver gates them on the owner list, and names no repo of its own.
  test('knows the owner list it routes deliveries for, and the lane it queues fires on', () => {
    const env = fn?.Properties?.Environment?.Variables ?? {};
    assert.equal(env.DISPATCH_OWNERS, '${DispatchOwners}');
    assert.equal(env.GITHUB_REPOSITORY, undefined, 'the receiver serves every listed owner\'s repos, not one');
    assert.equal(env.FIRES_QUEUE_URL, '${DispatchFiresQueue}');
  });

  // The receiver reads no repo's ready labels, so the stack names the
  // labels whose addition is worth a selection fire, and the deploy sets the factory's.
  test('knows the labels whose addition queues a selection fire, which the deploy sets', () => {
    assert.equal(fn?.Properties?.Environment?.Variables?.SELECT_LABELS, '${SelectLabels}');
    assert.equal(template.Parameters?.SelectLabels?.Type, 'String');
    const apply = steps.find(appliesStack('governor'));
    assert.match(apply?.run ?? '', /"SelectLabels=\$\{SELECT_LABELS\}"/);
    assert.equal(apply?.env?.SELECT_LABELS, '${{ vars.SELECT_LABELS }}', 'the operator\'s labels are a repository variable, not a value here');
  });

  test('knows the dispatcher\'s App, whose comment alone is the PR review\'s', () => {
    assert.equal(fn?.Properties?.Environment?.Variables?.APP_ID, '${GitHubAppId}');
    assert.equal(template.Parameters?.GitHubAppId?.Default, undefined, 'a deploy that names no App fails, not a receiver that trusts no review');
  });

  test('takes every delivery as it comes: the lane serialises the fires, so nothing throttles GitHub', () => {
    assert.equal(fn?.Properties?.ReservedConcurrentExecutions, undefined);
  });

  test('may read its two keys and queue a fire, and starts nothing itself', () => {
    const allowed = new Set(statements.flatMap(actionsOf));
    assert.deepEqual([...allowed].sort(), ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'logs:CreateLogStream', 'logs:PutLogEvents', 'secretsmanager:GetSecretValue', 'sqs:SendMessage']);
    const key = statements.find((s) => actionsOf(s).includes('secretsmanager:GetSecretValue'))!;
    assert.deepEqual(resourcesOf(key).sort(), ['${HookSecret}', '${WebhookSecret}'], 'the receiver can read a secret that is not one of its keys');
    const send = statements.find((s) => actionsOf(s).includes('sqs:SendMessage'))!;
    assert.deepEqual(resourcesOf(send), ['${DispatchFiresQueue.Arn}']);
  });

  test('a receiver that throws is a tripwire; a refused signature is not a throw', () => {
    const alarm = template.Resources.WebhookErrorsAlarm;
    assert.equal(alarm?.Properties?.Namespace, 'AWS/Lambda');
    assert.equal(alarm?.Properties?.MetricName, 'Errors');
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\]/);
  });

  // A hook's key is derived from this one secret (dispatch/webhook/hook.mjs),
  // generated as the webhook key is, and read by the operator's key script
  // (scripts/hook-key.mjs) by its name.
  test('generates the hook secret under governor/, which the receiver is told of', () => {
    const secret = template.Resources.HookSecret;
    assert.equal(secret?.Type, 'AWS::SecretsManager::Secret');
    assert.equal(secret?.Properties?.Name, 'governor/hook-secret');
    assert.equal(secret?.Properties?.GenerateSecretString?.GenerateStringKey, undefined);
    assert.ok(Number(secret?.Properties?.GenerateSecretString?.PasswordLength) >= 32);
    assert.equal(fn?.Properties?.Environment?.Variables?.HOOK_SECRET_ID, '${HookSecret}');
  });

  test('a fire signed with a stale hook key pages, read off its own event', () => {
    const filter = template.Resources.HookKeyStaleFilter;
    assert.equal(filter?.Properties?.LogGroupName, '${DispatchLogGroup}');
    assert.match(filter?.Properties?.FilterPattern ?? '', /\$\.event = "hook-key-stale"/);
    const published = filter?.Properties?.MetricTransformations?.[0];
    const alarm = template.Resources.HookKeyStaleAlarm;
    assert.equal(alarm?.Properties?.AlarmName, 'governor-hook-key-stale');
    assert.equal(alarm?.Properties?.Namespace, published?.MetricNamespace);
    assert.equal(alarm?.Properties?.MetricName, published?.MetricName);
    assert.equal(alarm?.Properties?.Threshold, 1);
    assert.equal(alarm?.Properties?.TreatMissingData, 'notBreaching');
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\].*hook-key-stale/);
    assert.deepEqual(alarm?.Properties?.AlarmActions, template.Resources.DispatchErrorsAlarm?.Properties?.AlarmActions);
  });

  // The receiver refuses a key older than the hook table's (route.mjs), so
  // the same alarm hears its line too. Lambda's JSON log format nests a line
  // logged as one object under `message`, so the filter matches that field.
  // A bare term would not do: an unsigned request's path and headers are
  // logged too, and a stranger could write the event's name into them.
  test('a stale key the receiver refused pages through the same alarm, read off the event field of the receiver\'s line', () => {
    const task = template.Resources.HookKeyStaleFilter?.Properties?.MetricTransformations?.[0];
    const filter = template.Resources.WebhookHookKeyStaleFilter;
    assert.equal(filter?.Type, 'AWS::Logs::MetricFilter');
    assert.equal(filter?.Properties?.LogGroupName, '${WebhookLogGroup}');
    assert.equal(filter?.Properties?.FilterPattern, `{ $.message.event = "${HOOK_KEY_STALE}" }`);
    const handler = readFileSync(resolve(ROOT, 'dispatch/webhook/handler.mjs'), 'utf8');
    assert.match(handler, /log: \(event, context = \{\}\) => console\.log\(\{ event, \.\.\.context \}\)/, 'the receiver logs each line as one object, which Lambda nests under message');
    const published = filter?.Properties?.MetricTransformations?.[0];
    assert.equal(published?.MetricNamespace, task?.MetricNamespace);
    assert.equal(published?.MetricName, task?.MetricName);
    assert.equal(published?.MetricValue, '1');
  });

  test('outputs the URL and the secret the workflow points the App\'s webhook at', () => {
    assert.equal(template.Outputs?.WebhookUrl?.Value, '${WebhookUrl.FunctionUrl}');
    assert.equal(template.Outputs?.WebhookSecretArn?.Value, '${WebhookSecret}');
  });

  test('the workflow points the App\'s webhook after the apply, the keys read from the stack\'s secrets into the environment', () => {
    const apply = steps.findIndex(appliesStack('governor'));
    const point = steps.findIndex(runsScript('scripts/point-app-webhook.mjs'));
    assert.ok(apply >= 0 && point > apply, 'the App\'s webhook is pointed after the apply');
    const lines = (steps[point]!.run ?? '').split('\n');
    assert.ok(lines.some((l) => /get-secret-value --secret-id governor\/webhook-secret/.test(l)));
    assert.ok(lines.some((l) => /get-secret-value --secret-id governor\/github-app/.test(l)));
    const mask = lines.findIndex((l) => /^\s*echo "::add-mask::\$\{WEBHOOK_SECRET\}"$/.test(l));
    assert.ok(mask >= 0, 'the webhook key is masked');
    assert.ok(mask < lines.findIndex((l) => /point-app-webhook\.mjs/.test(l)), 'the mask must precede the script');
    for (const line of lines) {
      assert.doesNotMatch(line, /echo "(?!::add-mask::).*(WEBHOOK_SECRET|APP_PRIVATE_KEY)|point-app-webhook\.mjs\s+\S/, 'the keys must reach the script through the environment');
    }
    // GitHub holds only the deploy role's ARN and the drop box
    // (public-repo.md); the App key lives in Secrets Manager, and the alert
    // email in Parameter Store.
    const githubSecrets = [...new Set([...codeOnly.matchAll(/\bsecrets\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(githubSecrets, ['AWS_DEPLOY_ROLE_ARN', 'DROP_BOX_URL'], 'a GitHub secret beyond the deploy role and the drop box');
  });

  test('the workflow packages the receiver before the apply, and applies the packaged template', () => {
    const pkg = steps.findIndex(runsCommand('cloudformation package'));
    const apply = steps.findIndex(appliesStack('governor'));
    assert.ok(pkg >= 0 && apply > pkg, 'the package step must precede the apply');
    assert.match(steps[pkg]!.run ?? '', /--template-file infra\/governor\.cfn\.yml/);
    assert.match(steps[apply]!.run ?? '', /--template-file "\$RUNNER_TEMP\/governor\.packaged\.yml"/);
  });

  // The rule's RetryPolicy covers EventBridge's delivery alone; a function
  // error on an async invoke is retried by Lambda itself, a minute then two
  // minutes later. Both retries land inside the lane's five-minute
  // deduplication window, so a schedule fire the receiver could not queue
  // (a throttled SendMessage) is queued by the retry, and one it did queue
  // is not queued twice.
  test('a schedule fire the receiver could not queue is retried by Lambda, inside the deduplication window', () => {
    const config = Object.values(template.Resources).find((r) => r.Type === 'AWS::Lambda::EventInvokeConfig' && r.Properties?.FunctionName === '${WebhookFunction}');
    assert.equal(config?.Properties?.FunctionName, '${WebhookFunction}');
    assert.equal(config?.Properties?.Qualifier, '$LATEST');
    assert.ok(Number(config?.Properties?.MaximumRetryAttempts) >= 1);
    assert.ok(Number(config?.Properties?.MaximumEventAgeInSeconds) <= 300);
  });

});

/**
 * One lane between the receiver and the cluster: every fire, the schedule's
 * and a delivery's, waits its turn in a FIFO queue, and the starter drains
 * it one task at a time. A dispatcher turn refreshes the stored login, and
 * two turns refreshing one login leave one of them dead; a fire that found a
 * task running used to be dropped until the next schedule, which is fine for
 * a label change and wrong for a mention.
 */
describe('infra/governor.cfn.yml — the fire lane', () => {
  const queue = template.Resources.DispatchFiresQueue;
  const dead = template.Resources.DispatchFiresDeadQueue;
  const starter = template.Resources.StarterFunction;
  const statements = inlinePolicyStatements(template, 'StarterRole');
  const mapping = Object.values(template.Resources).find((r) => r.Type === 'AWS::Lambda::EventSourceMapping');

  test('is one FIFO queue, deduplicating on content, with a dead-letter queue after a few attempts', () => {
    assert.equal(queue?.Type, 'AWS::SQS::Queue');
    assert.equal(queue?.Properties?.FifoQueue, true);
    assert.equal(queue?.Properties?.ContentBasedDeduplication, true);
    assert.equal(queue?.Properties?.RedrivePolicy?.deadLetterTargetArn, '${DispatchFiresDeadQueue.Arn}');
    assert.equal(dead?.Properties?.FifoQueue, true, 'a FIFO queue dead-letters to a FIFO queue');
  });

  test('the starter drains the lane one fire at a time, from the same directory as the receiver', () => {
    assert.equal(starter?.Properties?.Handler, 'starter-handler.handler');
    assert.equal(starter?.Properties?.Code, '../dispatch/webhook/');
    assert.ok(existsSync(resolve(ROOT, 'infra', starter.Properties.Code, 'starter-handler.mjs')), 'the handler the template names does not exist');
    assert.equal(starter?.Properties?.LoggingConfig?.LogFormat, 'JSON');
    assert.equal(mapping?.Properties?.EventSourceArn, '${DispatchFiresQueue.Arn}');
    assert.equal(mapping?.Properties?.FunctionName, '${StarterFunction}');
    assert.equal(mapping?.Properties?.BatchSize, 1);
    // The smallest value the event source takes; the single message group
    // is what serialises the fires.
    assert.equal(mapping?.Properties?.ScalingConfig?.MaximumConcurrency, 2);
    // A deferral or a failure leaves as a batch item failure, not a throw, so
    // it never counts toward the account-wide Errors safety net; without this
    // the event source ignores the response and deletes the fire.
    assert.deepEqual(mapping?.Properties?.FunctionResponseTypes, ['ReportBatchItemFailures']);
  });

  test('starts the same task the schedule always did, from the same settings', () => {
    const env = starter?.Properties?.Environment?.Variables ?? {};
    assert.equal(env.CLUSTER, '${DispatchCluster}');
    assert.equal(env.TASK_FAMILY, taskDefinition?.Properties?.Family);
    assert.equal(env.CONTAINER_NAME, container?.Name);
    // The same joined list the by-hand script reads off the outputs.
    assert.equal(env.SUBNET_IDS, template.Outputs?.[OUTPUT_KEYS.subnets]?.Value);
  });

  test('may see running tasks and start one on this cluster passing the task roles, and consume the lane, nothing else', () => {
    const allowed = new Set(statements.flatMap(actionsOf));
    assert.deepEqual([...allowed].sort(), ['ecs:ListTasks', 'ecs:RunTask', 'iam:PassRole', 'logs:CreateLogStream', 'logs:PutLogEvents', 'sqs:ChangeMessageVisibility', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ReceiveMessage']);
    for (const action of ['ecs:ListTasks', 'ecs:RunTask']) {
      const s = statements.find((st) => actionsOf(st).includes(action))!;
      assert.equal(s.Condition?.ArnEquals?.['ecs:cluster'], '${DispatchCluster.Arn}', `${action} is not pinned to the cluster`);
    }
    const pass = statements.find((s) => actionsOf(s).includes('iam:PassRole'))!;
    assert.deepEqual(new Set(resourcesOf(pass)), new Set(['${DispatchRole.Arn}', '${DispatchExecutionRole.Arn}']));
    assert.equal(pass.Condition?.StringEquals?.['iam:PassedToService'], 'ecs-tasks.amazonaws.com');
    const consume = statements.find((s) => actionsOf(s).includes('sqs:ReceiveMessage'))!;
    assert.deepEqual(resourcesOf(consume), ['${DispatchFiresQueue.Arn}']);
    const reoffer = statements.find((s) => actionsOf(s).includes('sqs:ChangeMessageVisibility'))!;
    assert.deepEqual(resourcesOf(reoffer), ['${DispatchFiresQueue.Arn}'], 'the re-offer is on the lane alone');
    assert.equal(starter?.Properties?.Environment?.Variables?.FIRES_QUEUE_URL, '${DispatchFiresQueue}', 'the re-offer needs the queue URL the receipt handle belongs to');
  });

  // The starter hands a busy fire straight back rather than waiting, asked
  // back in DEFER_SECONDS (dispatch/webhook/starter.mjs), and the attempts
  // have to outlast a whole task and its provisioning before the fire is
  // given up. The queue's own visibility timeout is the hold: a message
  // must stay invisible for as long as the starter may hold it, with a
  // margin for the poller, or the lane hands the same fire to a second
  // invocation. The two are separate knobs: a minute of hold as the pace
  // was one fire a minute however short the task (2026-09-26: thirteen
  // fires ahead, fourteen minutes to the session). A fire that fails is
  // handed back at the same pace, so the attempts are also how long a
  // persistent failure holds the lane before the tripwire: half an hour of
  // re-offers, plus each attempt's own run.
  test('the lane re-offers a busy fire within seconds, for longer than a task may run, then gives it up', () => {
    const timeout = Number(starter?.Properties?.Timeout);
    const visibility = Number(queue?.Properties?.VisibilityTimeout);
    const attempts = Number(queue?.Properties?.RedrivePolicy?.maxReceiveCount);
    assert.ok(visibility >= 2 * timeout, 'a fire could be handed out twice: the poller holds a fire past the invocation it started');
    assert.ok(timeout <= 60, `the starter does not wait, so ${timeout}s of timeout is an idle Lambda`);
    assert.ok(DEFER_SECONDS <= 10, `a busy fire idles ${DEFER_SECONDS}s past the end of the task before it`);
    assert.ok(DEFER_SECONDS < visibility, 'the re-offer is sooner than the hold, or it is no pace');
    assert.ok(attempts * DEFER_SECONDS * 1000 >= DEADLINE_MS + 5 * 60 * 1000, 'the attempts give up before a task and its provisioning could end');
    assert.ok(attempts * DEFER_SECONDS <= 30 * 60, 'a fire that fails every attempt holds the lane for over half an hour before the tripwire');
    assert.ok(START_BUDGET_MS >= attempts * DEFER_SECONDS * 1000, 'a by-hand fire gives up on the starter while the lane is still re-offering it');
  });

  test('a fire that failed every attempt is a tripwire on the dead-letter queue\'s depth', () => {
    const alarm = template.Resources.DispatchFiresDeadAlarm;
    assert.equal(alarm?.Properties?.Namespace, 'AWS/SQS');
    assert.equal(alarm?.Properties?.MetricName, 'ApproximateNumberOfMessagesVisible');
    assert.deepEqual(alarm?.Properties?.Dimensions, [{ Name: 'QueueName', Value: '${DispatchFiresDeadQueue.QueueName}' }]);
    assert.equal(Number(alarm?.Properties?.Threshold), 1);
    assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\]/);
    assert.deepEqual(alarm?.Properties?.AlarmActions, template.Resources.DispatchErrorsAlarm?.Properties?.AlarmActions, 'the lane\'s alarm goes where the other tripwires go');
  });

  /**
   * A task that fails to start drops its fire: the starter was done with the
   * message once RunTask succeeded (a pull that came back "not found"
   * three times in two days, the digest in ECR throughout). The not-run
   * rule hands the stop event to the retrier, which puts the fire back on
   * the lane, and once the attempts run out, onto the dead-letter queue.
   */
  describe('a fire whose task failed to start', () => {
    const retrier = template.Resources.RetrierFunction;
    const retrierStatements = inlinePolicyStatements(template, 'RetrierRole');
    const rule = template.Resources.DispatchNotRunRule;

    test('is handed to the retrier in dispatch/webhook/, which the rule may invoke', () => {
      assert.equal(retrier?.Properties?.Code, '../dispatch/webhook/');
      assert.equal(retrier?.Properties?.Handler, 'retry-handler.handler');
      assert.ok(existsSync(resolve(ROOT, 'infra', retrier.Properties.Code, 'retry-handler.mjs')), 'the handler the template names does not exist');
      assert.equal(retrier?.Properties?.LoggingConfig?.LogFormat, 'JSON');
      assert.equal(retrier?.Properties?.LoggingConfig?.LogGroup, '${RetrierLogGroup}');
      assert.match(String(retrier?.Properties?.FunctionName), /^governor-/);
      const target = (rule?.Properties?.Targets ?? []).find((t: { Arn?: string }) => t.Arn === '${RetrierFunction.Arn}');
      assert.ok(target, 'the not-run rule does not target the retrier');
      assert.ok(Number(target.RetryPolicy?.MaximumRetryAttempts) >= 1, 'a retrier EventBridge could not invoke is a fire lost');
      const permission = Object.values(template.Resources).find((r) => r.Type === 'AWS::Lambda::Permission' && r.Properties?.FunctionName === '${RetrierFunction}');
      assert.equal(permission?.Properties?.Principal, 'events.amazonaws.com');
      assert.equal(permission?.Properties?.SourceArn, '${DispatchNotRunRule.Arn}');
      assert.equal(permission?.Properties?.Action, 'lambda:InvokeFunction');
    });

    test('may queue a fire on the lane and on its dead-letter queue, and nothing else', () => {
      assert.deepEqual([...new Set(retrierStatements.flatMap(actionsOf))].sort(), ['logs:CreateLogStream', 'logs:PutLogEvents', 'sqs:SendMessage']);
      const send = retrierStatements.filter((s) => actionsOf(s).includes('sqs:SendMessage'));
      assert.deepEqual(new Set(send.flatMap(resourcesOf)), new Set(['${DispatchFiresQueue.Arn}', '${DispatchFiresDeadQueue.Arn}']));
      const logs = retrierStatements.filter((s) => actionsOf(s).includes('logs:PutLogEvents'));
      assert.deepEqual(logs.flatMap(resourcesOf), ['${RetrierLogGroup.Arn}']);
      const env = retrier?.Properties?.Environment?.Variables ?? {};
      assert.equal(env.FIRES_QUEUE_URL, '${DispatchFiresQueue}');
      assert.equal(env.DEAD_QUEUE_URL, '${DispatchFiresDeadQueue}');
    });

    // The dead-letter tripwire reads the queue's depth every five minutes;
    // each attempt fails within a couple of minutes of its start.
    test('a fault that outlasts the attempts reaches the dead-letter tripwire within the half hour', () => {
      const dead = template.Resources.DispatchFiresDeadAlarm;
      const perAttemptMinutes = 5;
      const minutes = MAX_START_ATTEMPTS * perAttemptMinutes + Number(dead?.Properties?.Period) * Number(dead?.Properties?.EvaluationPeriods) / 60;
      assert.ok(minutes <= 30, `${minutes} minutes`);
    });

    // The rule's RetryPolicy covers EventBridge's delivery alone; a retrier
    // that throws is retried by Lambda itself. Both retries land inside the
    // lane's five-minute deduplication window, so a retry of a send the lane
    // did take is not a second fire.
    test('a retrier that threw is retried by Lambda, inside the deduplication window', () => {
      const config = Object.values(template.Resources).find((r) => r.Type === 'AWS::Lambda::EventInvokeConfig' && r.Properties?.FunctionName === '${RetrierFunction}');
      assert.ok(config, 'the retrier has no EventInvokeConfig, so its async retries run to the six-hour default');
      assert.equal(config?.Properties?.Qualifier, '$LATEST');
      assert.ok(Number(config?.Properties?.MaximumRetryAttempts) >= 1);
      assert.ok(Number(config?.Properties?.MaximumEventAgeInSeconds) <= 300);
    });

    // The dead-letter queue now holds two kinds of fire: the starter's, and
    // the retrier's, whose why is in the retrier's log, not the starter's.
    test('the dead-letter tripwire names both logs a dead fire\'s why is in', () => {
      const description = String(template.Resources.DispatchFiresDeadAlarm?.Properties?.AlarmDescription);
      assert.match(description, /\/aws\/lambda\/governor-starter/);
      assert.match(description, /\/aws\/lambda\/governor-retrier/);
    });

    // A retrier that throws has lost the fire the stop carried; Lambda
    // retries the invoke, and this is where that ends.
    test('a retrier that throws is a tripwire', () => {
      const alarm = template.Resources.RetrierErrorsAlarm;
      assert.equal(alarm?.Properties?.Namespace, 'AWS/Lambda');
      assert.equal(alarm?.Properties?.MetricName, 'Errors');
      assert.deepEqual(alarm?.Properties?.Dimensions, [{ Name: 'FunctionName', Value: '${RetrierFunction}' }]);
      assert.equal(Number(alarm?.Properties?.Threshold), 1);
      assert.ok(Number(alarm?.Properties?.Period) <= 900);
      assert.match(alarm?.Properties?.AlarmDescription ?? '', /^\[tripwire\]/);
      assert.match(String(alarm?.Properties?.AlarmName), /^governor-/);
    });
  });

  // A shipping job's own completion is the fire, so the hook hears jobs.
  test('the receiver routes the three events a mention arrives in, beside issues, pull requests, workflow jobs and workflow runs', () => {
    assert.deepEqual([...HOOK_EVENTS].sort(), ['issue_comment', 'issues', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'workflow_job', 'workflow_run']);
  });

  test('the Mac runner\'s workflow is gone: a mention comes through the receiver', () => {
    assert.ok(!existsSync(resolve(ROOT, '.github/workflows/claude.yml')), 'claude.yml still runs mentions on the self-hosted Mac');
  });
});

describe('dispatch/Dockerfile', () => {
  test('runs the task entrypoint as a user that is not root, with the launcher\'s two runtimes and the pinned CLI', () => {
    assert.match(dockerfile, /^CMD \["node", "dispatch\/cli\.mjs"\]$/m);
    assert.match(dockerfile, /^USER \S+$/m);
    assert.match(dockerfile, /install -y[^\n]* python3\b/);
    assert.match(dockerfile, /install -y[^\n]* git\b/);
    assert.match(dockerfile, /@anthropic-ai\/claude-code@\d+\.\d+\.\d+/);
  });
});

/** The source paths the Dockerfile's COPY lines carry. */
const copiedPaths = (): string[] => [...dockerfile.matchAll(/^COPY\s+(.+?)\s+\S+\s*$/gm)].flatMap((m) => m[1]!.split(/\s+/));

describe('the task\'s modules in the image', () => {
  test('relativeImports reads every form a module loads another by', () => {
    const source = [
      "import { a } from './a.mjs';",
      'import b from "./b.mjs";',
      "import './c.mjs';",
      "export * from '../d.mjs';",
      "const e = await import('./e.mjs');",
      "import fs from 'node:fs';",
      "/** @typedef {import('./typedef.mjs').T} T */",
    ].join('\n');
    assert.deepEqual(relativeImports(source).sort(), ['../d.mjs', './a.mjs', './b.mjs', './c.mjs', './e.mjs']);
  });

  // The Dockerfile copies dispatch/ file by file: a module the entrypoint
  // imports and the image lacks fails every turn at import.
  // The image carries the entrypoint's import closure and no other module:
  // one it lacks fails every turn at import, one it carries beyond the
  // closure rebuilds the image for a change the task never runs.
  test('copies exactly the modules the entrypoint imports, transitively', () => {
    const closure = importClosure(ROOT, 'dispatch/cli.mjs');
    assert.ok(closure.has('dispatch/turn.mjs') && closure.has('scripts/lib/github-app.mjs'), [...closure].join(', '));
    const copied = copiedPaths();
    assert.deepEqual(copied.filter((c) => c.endsWith('/')), [], 'a directory COPY carries modules beyond the closure');
    assert.deepEqual(copied.filter((c) => c.endsWith('.mjs')).sort(), [...closure].sort());
  });

  // The fire module is the one the task shares with the receiver;
  // the receiver's routing stays in the Lambda.
  test('copies the fire module and not the receiver\'s routing', () => {
    const copied = copiedPaths();
    assert.ok(copied.includes('dispatch/webhook/fire.mjs'), copied.join(', '));
    assert.equal(copied.includes('dispatch/webhook/route.mjs'), false, 'route.mjs is the receiver\'s');
  });
});

describe('.github/workflows/deploy.yml', () => {
  test('runs on every push to main, and by hand, and deploys only after the gate', () => {
    assert.deepEqual(Object.keys(workflow.on ?? {}).sort(), ['push', 'workflow_dispatch']);
    assert.deepEqual(workflow.on.push, { branches: ['main'] });
    assert.equal(workflow.jobs?.gate?.uses, './.github/workflows/gate.yml');
    assert.deepEqual(workflow.jobs?.deploy?.needs, ['gate', 'role']);
  });

  test('does nothing until the deploy role is set, and names no value of the operator\'s', () => {
    assert.equal(workflow.jobs?.deploy?.if, "${{ needs.role.outputs.set == 'true' }}");
    const apply = steps.find(appliesStack('governor'));
    for (const [parameter, variable, store] of [
      ['DispatchOwners', 'GOVERNOR_OWNERS', 'vars'],
      ['GitHubAppId', 'APP_ID', 'vars'],
      ['DropBoxUrl', 'DROP_BOX_URL', 'secrets'],
    ] as const) {
      assert.match(apply?.run ?? '', new RegExp(`"${parameter}=\\$\\{${variable}\\}"`), parameter);
      assert.equal(apply?.env?.[variable], `\${{ ${store}.${variable} }}`, variable);
    }
  });

  /** The paths the plan step hashes into the image tag. */
  const hashedPaths = (): Set<string> => {
    const plan = steps.find(withId('plan'));
    assert.ok(plan?.run, 'no plan step');
    const hashed = new Set(
      (plan.run.match(/git ls-tree -r HEAD -- \\\n([\s\S]*?)\|/)?.[1] ?? '')
        .replace(/\\\n/g, ' ')
        .split(/\s+/)
        .filter(Boolean),
    );
    assert.ok(hashed.size > 0, 'the plan step hashes nothing this test can read');
    return hashed;
  };

  test('hashes for the image tag exactly what the Dockerfile copies', () => {
    const hashed = hashedPaths();
    const copied = copiedPaths();
    for (const path of copied) {
      assert.ok(hashed.has(path), `${path} is copied into the image but not hashed into its tag`);
    }
    // The Dockerfile itself is hashed too: a changed instruction is a changed image.
    assert.ok(hashed.has('dispatch/Dockerfile'), 'the Dockerfile is not hashed into its own tag');
    for (const path of hashed) {
      if (path === 'dispatch/Dockerfile') continue;
      assert.ok(copied.includes(path), `${path} is hashed into the tag but not copied into the image`);
    }
  });

  test('discovers the default VPC\'s subnets and hands them to the apply', () => {
    const discover = steps.find(runsCommand('ec2 describe-subnets'));
    assert.ok(discover?.run, 'no step reads the subnets');
    assert.match(discover.run, /default-for-az/);
    const apply = steps.find(appliesStack('governor'));
    assert.match(apply?.run ?? '', /"SubnetIds=\$/);
    assert.doesNotMatch(apply?.run ?? '', /ReservedConcurrency/, 'a task has no reserved concurrency to set');
  });

  test('ends on the probe, run through the by-hand script so the two cannot drift, on every invocation of the workflow', () => {
    const probe = steps[steps.length - 1];
    assert.match(probe?.run ?? '', /node scripts\/run-turn\.mjs --kind probe/);
    assert.equal(probe?.if, undefined, 'the probe must run on every invocation of the workflow');
  });

  test('secrets reach the scripts through env, never inline', () => {
    for (const step of steps) {
      if (typeof step.run !== 'string') continue;
      assert.doesNotMatch(step.run, /\$\{\{\s*secrets\./, `step '${step.name}' expands a secret into its script`);
    }
  });

  // The plan step hashes scripts/lib/claude-login.mjs, the module the task
  // reads the login with, and the trigger watches it; neither names the
  // login's secret or the operator's mint, wherever in the file (env, with,
  // uses or run).
  test('never writes the login: that is the operator\'s mint, not a deploy', () => {
    assert.doesNotMatch(codeOnly, /governor\/claude-login|mint-claude-login/);
  });
});
