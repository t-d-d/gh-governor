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
 * A fire, a dispatch or a message starts no task itself. It queues on the
 * fire lane, like the schedule's and a delivery's, and the dispatcher task
 * takes it from there (dispatch/lane.mjs): a refresh rotates the login's
 * refresh token, so two turns at once would leave one holding a dead login,
 * and the task runs one turn at a time. It does not call the starter: the
 * running task takes the fire, or the starter's backstop starts a task for
 * it within a minute. It finds its turn by the task's `fire-taken` line for
 * the message, and the turn's result line that names the message, in the
 * task's log. A probe touches no login, so it starts its own task beside
 * anything.
 *
 * With `--no-wait` it prints the task ARN (a probe) or the queued message id
 * (a fire or a dispatch) and returns. Otherwise a probe waits for its task
 * to stop and exits with the container's exit code, or 1 when the task never
 * ran its container; a fire waits for its turn's result line and exits with
 * the turn's exit code, or 1 when no task took it or the turn never ended.
 * Either way it prints the turn's log lines. Needs the aws CLI under
 * credentials that may run the task, queue on the lane and read the log.
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
});

/**
 * How long a queued fire may wait for a task to take it: the fires ahead of
 * it run first, one turn at a time. test/dispatch-stack.test.ts holds this
 * past the lane's stall alarm (infra/governor.cfn.yml
 * DispatchLaneStalledAlarm), so the script never gives up on a fire the
 * stack does not yet call stalled.
 */
export const START_BUDGET_MS = 50 * 60 * 1000;

/**
 * How long a taken fire's turn may run: its deadline (dispatch/cli.mjs
 * DEADLINE_MS, which test/scripts/run-turn.test.ts holds this past), and the
 * log's delivery.
 */
export const TURN_BUDGET_MS = 20 * 60 * 1000;
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
 * The task's own line out of one filter-log-events event: one JSON object a
 * line, as the turn logs it (dispatch/cli.mjs, dispatch/lane.mjs).
 *
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
const taskLine = (raw) => {
  try {
    const line = JSON.parse(raw);
    return line && typeof line === 'object' ? line : null;
  } catch {
    return null;
  }
};

/** The lines that end a turn in the lane: the result, failed or not. */
const RESULT = new Set(['dispatch-result', 'dispatch-failed']);

/**
 * @typedef {{ stream: string, takenAt: number, endedAt?: number, exitCode?: number }} Turn
 */

/**
 * Poll the task's log for the lines that name `messageId`: the task's
 * `fire-taken` line, which says which task's stream holds the turn, and the
 * turn's result line, which carries its exit code. A fire is first waited on
 * for START_BUDGET_MS, while the fires ahead of it run; once taken, its turn
 * for TURN_BUDGET_MS.
 *
 * @param {{ aws: Aws, log: (line: string) => void, logGroup: string, messageId: string, since: number, sleep: (ms: number) => Promise<unknown>, now: () => number }} io
 * @returns {Promise<Turn | null>} The turn, ended or not, or null when no task took the fire.
 */
const followFire = async ({ aws, log, logGroup, messageId, since, sleep, now }) => {
  /** @type {Turn | null} */
  let turn = null;
  let takenSeen = 0;
  for (;;) {
    const found = JSON.parse(await aws([
      'logs', 'filter-log-events',
      '--log-group-name', logGroup,
      '--start-time', String(turn === null ? since - 60 * 1000 : turn.takenAt),
      '--filter-pattern', `"${messageId}"`,
      '--output', 'json',
    ]));
    for (const e of found.events ?? []) {
      const line = taskLine(String(e.message));
      if (line?.messageId !== messageId) continue;
      // Refused, the fire is already on the dead-letter queue: no task will take it.
      if (line.event === 'fire-refused' && turn === null) {
        log(`The task refused this fire and moved it to governor-fires-dead.fifo: ${String(line.error)}`);
        return null;
      }
      if (line.event === 'fire-taken' && turn === null) {
        turn = { stream: String(e.logStreamName), takenAt: Number(e.timestamp) };
        takenSeen = now();
        log(`A task took it: ${turn.stream}`);
      }
      if (RESULT.has(String(line.event)) && turn !== null && typeof line.exitCode === 'number') {
        return { ...turn, endedAt: Number(e.timestamp), exitCode: line.exitCode };
      }
    }
    if (turn === null && now() - since >= START_BUDGET_MS) {
      log(`No task took this fire in ${START_BUDGET_MS / 60000} minutes. Read /aws/lambda/governor-starter for start-failed lines, and ${logGroup} for the running task; the fire is in governor-fires-dead.fifo if the task refused it.`);
      return null;
    }
    if (turn !== null && now() - takenSeen >= TURN_BUDGET_MS) {
      log(`The turn logged no result in ${TURN_BUDGET_MS / 60000} minutes. Read ${turn.stream} in ${logGroup}: the task may have stopped mid-turn.`);
      return turn;
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

  if (event.kind !== 'probe') return queueFire({ aws, log, event, output, args, nonce, sleep, now });

  const taskArn = await startProbe({ aws, log, cluster, container, event, output });
  if (!taskArn) return 1;
  log(`Started ${taskArn}`);
  if (!args.wait) return 0;

  if (!(await waitForStop({ aws, log, cluster, taskArns: [taskArn] }))) return 1;
  const described = JSON.parse(await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn, '--output', 'json']));
  const task = described.tasks?.[0] ?? {};
  const exitCode = task.containers?.find((/** @type {{ name: string }} */ c) => c.name === container)?.exitCode;

  const taskId = taskArn.split('/').pop();
  await tail({ aws, log, logGroup: output(OUTPUT_KEYS.logGroup), stream: `${output(OUTPUT_KEYS.logStreamPrefix)}/${container}/${taskId}` });

  if (typeof exitCode !== 'number') {
    log(`The container never reported an exit code: ${task.stoppedReason ?? 'no reason given'}`);
    return 1;
  }
  log(`Exit ${exitCode}`);
  return exitCode;
};

/**
 * Print a task's log stream, or the part of it between two times.
 *
 * @param {{ aws: Aws, log: (line: string) => void, logGroup: string, stream: string, from?: number | undefined, to?: number | undefined }} io
 */
const tail = async ({ aws, log, logGroup, stream, from, to }) => {
  try {
    const events = JSON.parse(await aws([
      'logs', 'get-log-events',
      '--log-group-name', logGroup,
      '--log-stream-name', stream,
      ...(from === undefined ? [] : ['--start-time', String(from)]),
      ...(to === undefined ? [] : ['--end-time', String(to + 1)]),
      '--start-from-head',
      '--output', 'json',
    ]));
    for (const e of events.events ?? []) log(String(e.message));
  } catch (error) {
    log(`No log to tail: ${/** @type {Error} */ (error).message}`);
  }
};

/**
 * Queue a fire on the lane, then follow its turn in the task's log.
 *
 * @param {{ aws: Aws, log: (line: string) => void, event: unknown, output: (key: string) => string, args: Args } & Required<LaneIo>} io
 * @returns {Promise<number>}
 */
const queueFire = async ({ aws, log, event, output, args, nonce, sleep, now }) => {
  const reason = `by hand ${nonce()}`;
  const since = now();
  const sent = JSON.parse(await aws([
    'sqs', 'send-message',
    '--queue-url', output(OUTPUT_KEYS.firesQueueUrl),
    '--message-group-id', LANE,
    '--message-body', JSON.stringify({ fire: event, reason }),
    '--output', 'json',
  ]));
  const messageId = String(sent.MessageId);
  log(`Queued ${messageId} on the fire lane (${reason})`);
  if (!args.wait) return 0;
  const logGroup = output(OUTPUT_KEYS.logGroup);
  const turn = await followFire({ aws, log, logGroup, messageId, since, sleep, now });
  if (turn === null) return 1;
  // The task runs other fires after this one, so a turn with no result is
  // tailed only as far as its deadline could have run.
  await tail({ aws, log, logGroup, stream: turn.stream, from: turn.takenAt, to: turn.endedAt ?? turn.takenAt + TURN_BUDGET_MS });
  if (turn.exitCode === undefined) return 1;
  log(`Exit ${turn.exitCode}`);
  return turn.exitCode;
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
