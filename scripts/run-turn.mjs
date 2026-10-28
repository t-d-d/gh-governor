#!/usr/bin/env node
/**
 * Start one dispatcher task by hand, and wait for what it did.
 *
 * The dispatcher is a Fargate task (infra/governor.cfn.yml) that EventBridge
 * starts on the schedule; this is the other way to start it. The deploy
 * workflow's probe runs it too, so the command an operator types and the one
 * the deploy checks cannot drift. Everything it needs to place the task is
 * read off the stack's outputs, so nothing here names a subnet or a family.
 *
 *   node scripts/run-turn.mjs --kind probe                 # prove the runtime; exits with what it proved
 *   node scripts/run-turn.mjs --kind schedule [--repo owner/name]  # a schedule fire, now: every served repo, or the one named
 *   node scripts/run-turn.mjs --kind dispatch --repo owner/name --prompt '…' [--session-name '…'] [--model '…']
 *   node scripts/run-turn.mjs --kind message --repo owner/name --session <session_… | claude.ai/code URL> --text '…'
 *   [--no-wait] [--stack governor]
 *
 * Every fire names its repo but the bare schedule fire and a
 * probe, so every other kind refuses to queue without `--repo`.
 *
 * A fire, a dispatch or a message starts no task itself. It queues on the fire lane the
 * starter drains (dispatch/webhook/starter.mjs), like the schedule's and a
 * delivery's, then finds the task the starter started for it by the
 * `fire-started` line in the starter's log: a refresh rotates the login's
 * refresh token, so two turns at once would leave one holding a dead login,
 * and the starter is the one thing that starts a turn. A probe touches no
 * login, so it starts its own task beside anything.
 *
 * With `--no-wait` it prints the task ARN (a probe) or the queued message id
 * (a fire or a dispatch) and returns. Otherwise it waits for the task to
 * stop, prints the task's log lines, and exits with the container's exit
 * code, or 1 when the task never ran its container or the starter never
 * started one. Needs the aws CLI under credentials that may run the task
 * and queue on the lane.
 * Node built-ins only.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isCliEntry } from './lib/cli-entry.mjs';
import { LANE, containerOverride, parseFire } from '../dispatch/webhook/fire.mjs';

/** The stack outputs this script reads; test/dispatch-stack.test.ts holds the template to them. */
export const OUTPUT_KEYS = Object.freeze({
  cluster: 'ClusterName',
  family: 'TaskDefinitionFamily',
  container: 'ContainerName',
  subnets: 'SubnetIds',
  logGroup: 'LogGroupName',
  logStreamPrefix: 'LogStreamPrefix',
  firesQueueUrl: 'FiresQueueUrl',
  starterLogGroup: 'StarterLogGroupName',
});

/**
 * How long a queued fire may go, from its first offer, without the starter
 * starting its task: the lane re-offers a deferred fire for half an hour
 * from its first receipt before dead-lettering it
 * (infra/governor.cfn.yml DispatchFiresQueue), which
 * test/dispatch-stack.test.ts holds this past, plus the starter's log
 * delivery.
 */
export const START_BUDGET_MS = 35 * 60 * 1000;
export const START_POLL_MS = 10 * 1000;

/**
 * What one `aws ecs wait tasks-stopped` covers before it gives up: the CLI's
 * TasksStopped waiter polls every 6 s for 100 attempts. The task's own
 * deadline is eighteen minutes (dispatch/cli.mjs DEADLINE_MS), so one round
 * is not enough for a schedule fire of two launches; the wait runs this
 * many rounds, which test/scripts/run-turn.test.ts holds past the
 * deadline.
 */
export const WAITER_BUDGET_MS = 6 * 100 * 1000;
export const WAIT_ROUNDS = 2;

/**
 * Wait for tasks to stop, up to WAIT_ROUNDS of the CLI's waiter.
 *
 * @param {{ aws: Aws, log: (line: string) => void, cluster: string, taskArns: string[] }} io
 * @returns {Promise<boolean>} Whether they stopped.
 */
const waitForStop = async ({ aws, log, cluster, taskArns }) => {
  for (let round = 1; round <= WAIT_ROUNDS; round += 1) {
    try {
      await aws(['ecs', 'wait', 'tasks-stopped', '--cluster', cluster, '--tasks', ...taskArns]);
      return true;
    } catch (error) {
      const message = /** @type {Error} */ (error).message;
      const gaveUp = /Max attempts exceeded/.test(message);
      if (!gaveUp || round === WAIT_ROUNDS) {
        log(`The task did not stop in time: ${message}`);
        return false;
      }
    }
  }
  return false;
};

/**
 * @typedef {{ kind: string, repo?: string, prompt?: string, sessionName?: string, model?: string, session?: string, text?: string, wait: boolean, stack: string }} Args
 * @typedef {(argv: string[]) => Promise<string>} Aws The aws CLI: its stdout, or a throw with its stderr.
 * @typedef {{ nonce?: () => string, sleep?: (ms: number) => Promise<unknown>, now?: () => number }} LaneIo
 */

/**
 * The starter's own line out of one filter-log-events event: under the
 * Lambda's JSON log format the line is the `message` of the record, as a
 * string or already parsed.
 *
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
const starterLine = (raw) => {
  try {
    /** @type {any} */
    let line = JSON.parse(raw);
    if (line && typeof line.event !== 'string' && line.message !== undefined) {
      line = typeof line.message === 'string' ? JSON.parse(line.message) : line.message;
    }
    return line && typeof line === 'object' ? line : null;
  } catch {
    return null;
  }
};

/**
 * Poll the starter's log for the `fire-started` line carrying `reason`,
 * until START_BUDGET_MS has passed since the lane first offered the fire:
 * the lane is FIFO in one group, so a fire queued behind another is first
 * offered only once that one leaves. Before any line of its own, the budget
 * runs from the send.
 *
 * @param {{ aws: Aws, log: (line: string) => void, logGroup: string, reason: string, nonce: string, since: number, sleep: (ms: number) => Promise<unknown>, now: () => number }} io
 * @returns {Promise<string | null>} The task ARN, or null when none started.
 */
const findStartedTask = async ({ aws, log, logGroup, reason, nonce, since, sleep, now }) => {
  let windowStart = since;
  let told = false;
  for (;;) {
    const found = JSON.parse(await aws([
      'logs', 'filter-log-events',
      '--log-group-name', logGroup,
      '--start-time', String(since - 60 * 1000),
      '--filter-pattern', `"${nonce}"`,
      '--output', 'json',
    ]));
    for (const e of found.events ?? []) {
      const line = starterLine(String(e.message));
      if (line?.reason !== reason) continue;
      if (line.event === 'fire-started' && typeof line.taskArn === 'string') return line.taskArn;
      if (windowStart === since && typeof e.timestamp === 'number') windowStart = Math.max(since, e.timestamp);
      if (!told) {
        told = true;
        log(line.event === 'fire-deferred' && Array.isArray(line.running)
          ? `The starter deferred it behind ${line.running.length} running task(s): ${line.running.join(', ')}`
          : `The starter logged ${String(line.event)} for it: ${JSON.stringify(line)}`);
      }
    }
    if (now() - windowStart >= START_BUDGET_MS) {
      log(`The starter started no task for this fire in ${START_BUDGET_MS / 60000} minutes. Read ${logGroup} for why; the fire is in governor-fires-dead.fifo once the lane gives up on it.`);
      return null;
    }
    await sleep(START_POLL_MS);
  }
};

/**
 * @param {string[]} argv
 * @returns {Args}
 */
export const parseArgs = (argv) => {
  /** @type {Args} */
  const args = { kind: '', wait: true, stack: 'governor' };
  /** @type {Record<string, 'kind' | 'repo' | 'prompt' | 'sessionName' | 'model' | 'session' | 'text' | 'stack'>} */
  const valued = { '--kind': 'kind', '--repo': 'repo', '--prompt': 'prompt', '--session-name': 'sessionName', '--model': 'model', '--session': 'session', '--text': 'text', '--stack': 'stack' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = /** @type {string} */ (argv[i]);
    const field = valued[flag];
    if (flag === '--no-wait') {
      args.wait = false;
    } else if (field !== undefined) {
      const value = argv[i + 1];
      // Refuse a flag in the value's place, not every value with two
      // leading dashes: a message's text may open with a markdown rule.
      if (value === undefined || value === '--no-wait' || Object.hasOwn(valued, value)) throw new Error(`${flag} needs a value`);
      args[field] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.kind) throw new Error('--kind is required: probe, schedule, dispatch or message');
  return args;
};

/** The kinds that name no repo: a probe touches none, and a schedule without one serves every repo. */
const UNNAMED = new Set(['probe', 'schedule']);

/**
 * The invocation the task will parse, parsed here first so a refusal costs
 * no task.
 *
 * @param {Args} args
 */
export const eventFor = ({ kind, repo, prompt, sessionName, model, session, text }) => {
  if (repo === undefined && !UNNAMED.has(kind)) throw new Error(`--repo is required for --kind ${kind}: every fire but a schedule's or a probe's names its repo`);
  return parseFire({ kind, repo, prompt, sessionName, model, session, text });
};

/**
 * The RunTask override that carries the event: DISPATCH_EVENT on the one
 * container, the same shape the schedule rule's target input sends.
 *
 * @param {string} containerName
 * @param {unknown} event
 * @returns {string}
 */
export const overridesFor = (containerName, event) => JSON.stringify(containerOverride(containerName, event));

/**
 * RunTask for a probe, the one kind started outside the lane.
 *
 * @param {{ aws: Aws, log: (line: string) => void, cluster: string, container: string, event: unknown, output: (key: string) => string }} io
 * @returns {Promise<string | null>} The task ARN, or null when nothing was placed.
 */
const startProbe = async ({ aws, log, cluster, container, event, output }) => {
  const started = JSON.parse(await aws([
    'ecs', 'run-task',
    '--cluster', cluster,
    '--task-definition', output(OUTPUT_KEYS.family),
    '--launch-type', 'FARGATE',
    '--network-configuration', `awsvpcConfiguration={subnets=[${output(OUTPUT_KEYS.subnets)}],assignPublicIp=ENABLED}`,
    '--overrides', overridesFor(container, event),
    '--output', 'json',
  ]));
  /** @type {string | undefined} */
  const taskArn = started.tasks?.[0]?.taskArn;
  if (taskArn) return taskArn;
  for (const failure of started.failures ?? []) log(`RunTask placed nothing: ${failure.reason} (${failure.arn})`);
  if (!(started.failures?.length)) log('RunTask placed nothing and gave no reason');
  return null;
};

/**
 * @param {{ args: Args, aws: Aws, log: (line: string) => void } & LaneIo} io
 * @returns {Promise<number>} The exit code.
 */
export const runTask = async ({ args, aws, log, nonce = randomUUID, sleep = delay, now = Date.now }) => {
  const event = eventFor(args);
  const outputs = new Map(
    /** @type {Array<{ OutputKey: string, OutputValue: string }>} */
    (JSON.parse(await aws(['cloudformation', 'describe-stacks', '--stack-name', args.stack, '--query', 'Stacks[0].Outputs', '--output', 'json'])))
      .map((o) => [o.OutputKey, o.OutputValue]),
  );
  const output = (/** @type {string} */ key) => {
    const value = outputs.get(key);
    if (value === undefined) throw new Error(`stack ${args.stack} has no output ${key}`);
    return value;
  };
  const cluster = output(OUTPUT_KEYS.cluster);
  const container = output(OUTPUT_KEYS.container);

  /** @type {string | null} */
  let taskArn;
  if (event.kind === 'probe') {
    taskArn = await startProbe({ aws, log, cluster, container, event, output });
    if (!taskArn) return 1;
    log(`Started ${taskArn}`);
    if (!args.wait) return 0;
  } else {
    const id = nonce();
    const reason = `by hand ${id}`;
    const since = now();
    const sent = JSON.parse(await aws([
      'sqs', 'send-message',
      '--queue-url', output(OUTPUT_KEYS.firesQueueUrl),
      '--message-group-id', LANE,
      '--message-body', JSON.stringify({ fire: event, reason }),
      '--output', 'json',
    ]));
    log(`Queued ${sent.MessageId} on the fire lane (${reason})`);
    if (!args.wait) return 0;
    taskArn = await findStartedTask({ aws, log, logGroup: output(OUTPUT_KEYS.starterLogGroup), reason, nonce: id, since, sleep, now });
    if (!taskArn) return 1;
    log(`The starter started ${taskArn}`);
  }

  if (!(await waitForStop({ aws, log, cluster, taskArns: [taskArn] }))) return 1;
  const described = JSON.parse(await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn, '--output', 'json']));
  const task = described.tasks?.[0] ?? {};
  const exitCode = task.containers?.find((/** @type {{ name: string }} */ c) => c.name === container)?.exitCode;

  const taskId = taskArn.split('/').pop();
  try {
    const tail = JSON.parse(await aws([
      'logs', 'get-log-events',
      '--log-group-name', output(OUTPUT_KEYS.logGroup),
      '--log-stream-name', `${output(OUTPUT_KEYS.logStreamPrefix)}/${container}/${taskId}`,
      '--start-from-head',
      '--output', 'json',
    ]));
    for (const e of tail.events ?? []) log(String(e.message));
  } catch (error) {
    log(`No log to tail: ${/** @type {Error} */ (error).message}`);
  }

  if (typeof exitCode !== 'number') {
    log(`The container never reported an exit code: ${task.stoppedReason ?? 'no reason given'}`);
    return 1;
  }
  log(`Exit ${exitCode}`);
  return exitCode;
};

/** @type {Aws} */
const realAws = (argv) =>
  new Promise((resolveCall, rejectCall) => {
    const child = spawn('aws', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectCall);
    child.on('close', (status) => {
      if (status === 0) resolveCall(stdout);
      else rejectCall(new Error(`aws ${argv.slice(0, 2).join(' ')} exited ${status}: ${stderr.trim()}`));
    });
  });

if (isCliEntry(import.meta.url, process.argv[1])) {
  try {
    const code = await runTask({ args: parseArgs(process.argv.slice(2)), aws: realAws, log: console.log });
    process.exit(code);
  } catch (error) {
    // A refused argument or an aws call that failed: the message, not a stack.
    console.error(/** @type {Error} */ (error).message);
    process.exit(2);
  }
}
