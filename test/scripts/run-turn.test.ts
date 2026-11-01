/**
 * scripts/run-turn.mjs: one dispatcher task started by hand or by the
 * deploy workflow's probe, through the aws CLI, and waited on. Every aws
 * call is injected and recorded; what is pinned is the RunTask the script
 * builds, what it reads back, and the exit code it turns that into.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OUTPUT_KEYS, START_BUDGET_MS, TURN_BUDGET_MS, WAIT_ROUNDS, WAITER_BUDGET_MS, eventFor, overridesFor, parseArgs, runTask } from '../../scripts/run-turn.mjs';
import { DEADLINE_MS } from '../../dispatch/cli.mjs';
import { LANE } from '../../dispatch/webhook/fire.mjs';

const OUTPUTS = [
  { OutputKey: OUTPUT_KEYS.cluster, OutputValue: 'governor' },
  { OutputKey: OUTPUT_KEYS.family, OutputValue: 'governor' },
  { OutputKey: OUTPUT_KEYS.container, OutputValue: 'dispatch' },
  { OutputKey: OUTPUT_KEYS.subnets, OutputValue: 'subnet-a,subnet-b' },
  { OutputKey: OUTPUT_KEYS.logGroup, OutputValue: '/governor' },
  { OutputKey: OUTPUT_KEYS.logStreamPrefix, OutputValue: 'task' },
  { OutputKey: OUTPUT_KEYS.firesQueueUrl, OutputValue: 'https://sqs.us-east-1.amazonaws.com/123456789012/governor-fires.fifo' },
];
const NONCE = 'by-hand-0f1e2d';
const MESSAGE_ID = 'a1b2c3d4-message';
const TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/governor/0123456789abcdef';
const STREAM = 'task/dispatch/0123456789abcdef';

type Answer = string | ((argv: string[]) => string);

/** An aws CLI answering by its first two words, recording every call. */
const fakeAws = (answers: Record<string, Answer>) => {
  const calls: string[][] = [];
  const aws = async (argv: string[]) => {
    calls.push(argv);
    const answer = answers[`${argv[0]} ${argv[1]}`];
    if (answer === undefined) throw new Error(`unexpected aws call: ${argv.join(' ')}`);
    return typeof answer === 'function' ? answer(argv) : answer;
  };
  return { aws, calls };
};

const stopped = (exitCode: number | null, reason = 'Essential container in task exited') =>
  JSON.stringify({
    tasks: [{ taskArn: TASK_ARN, stoppedReason: reason, containers: [{ name: 'dispatch', ...(exitCode === null ? {} : { exitCode }) }] }],
  });

const happy = (exitCode = 0) => ({
  'cloudformation describe-stacks': JSON.stringify(OUTPUTS),
  'ecs run-task': JSON.stringify({ tasks: [{ taskArn: TASK_ARN }], failures: [] }),
  'ecs wait': '',
  'ecs describe-tasks': stopped(exitCode),
  'logs get-log-events': JSON.stringify({ events: [{ message: '{"event":"dispatch-result","kind":"probe","ok":true}' }] }),
  'sqs send-message': JSON.stringify({ MessageId: MESSAGE_ID }),
  'logs filter-log-events': (argv: string[]) => taskSaw(argv, [taken(1000), ended(9000, 0)]),
});

/** The task's line for the fire it took, and its turn's result (dispatch/lane.mjs, dispatch/cli.mjs). */
const taken = (at: number, messageId = MESSAGE_ID) => ({ at, line: { event: 'fire-taken', messageId, kind: 'schedule', reason: `by hand ${NONCE}` } });
const ended = (at: number, exitCode: number, messageId = MESSAGE_ID) => ({ at, line: { event: exitCode === 0 ? 'dispatch-result' : 'dispatch-failed', kind: 'schedule', messageId, exitCode } });

/**
 * The task's log as filter-log-events returns it: each line the task's own
 * JSON, in the task's own stream.
 */
const taskSaw = (argv: string[], lines: Array<{ at: number; line: Record<string, unknown> }>, stream = STREAM) => {
  assert.equal(argv[argv.indexOf('--log-group-name') + 1], '/governor');
  assert.ok(argv[argv.indexOf('--filter-pattern') + 1]?.includes(MESSAGE_ID), 'the search is not narrowed to this fire');
  return JSON.stringify({ events: lines.map(({ at, line }) => ({ timestamp: at, logStreamName: stream, message: JSON.stringify(line) })) });
};

/** The io a lane fire needs beyond the aws CLI: a fixed nonce and a sleep that costs nothing. */
const laneIo = () => {
  const slept: number[] = [];
  let clock = 0;
  return {
    slept,
    nonce: () => NONCE,
    sleep: async (ms: number) => { slept.push(ms); clock += ms; },
    now: () => clock,
  };
};

const collect = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => { lines.push(line); } };
};

describe('parseArgs', () => {
  test('a kind, waited on, against the stack by name', () => {
    assert.deepEqual(parseArgs(['--kind', 'probe']), { kind: 'probe', wait: true, stack: 'governor' });
    assert.deepEqual(parseArgs(['--kind', 'schedule', '--no-wait', '--stack', 'other']), { kind: 'schedule', wait: false, stack: 'other' });
  });

  test('a dispatch carries its prompt, and optionally a session name and a model', () => {
    assert.deepEqual(
      parseArgs(['--kind', 'dispatch', '--prompt', 'hello', '--session-name', 'TEST', '--model', 'claude-sonnet-5']),
      { kind: 'dispatch', prompt: 'hello', sessionName: 'TEST', model: 'claude-sonnet-5', wait: true, stack: 'governor' },
    );
  });

  test('refuses what it does not know', () => {
    assert.throws(() => parseArgs([]), /--kind/);
    assert.throws(() => parseArgs(['--kind']), /--kind/);
    assert.throws(() => parseArgs(['--kind', 'probe', '--bogus']), /--bogus/);
    assert.throws(() => parseArgs(['--kind', 'dispatch', '--prompt', '--no-wait']), /--prompt needs a value/);
  });

  test('takes a value that merely starts with two dashes, as a markdown rule does', () => {
    assert.deepEqual(
      parseArgs(['--kind', 'message', '--session', 'session_01ABC', '--text', '--- see the review above']),
      { kind: 'message', session: 'session_01ABC', text: '--- see the review above', wait: true, stack: 'governor' },
    );
  });
});

describe('eventFor', () => {
  test('is the invocation the turn parses, so a refusal happens here and not in the task', () => {
    assert.deepEqual(eventFor(parseArgs(['--kind', 'probe'])), { kind: 'probe' });
    assert.deepEqual(eventFor(parseArgs(['--kind', 'dispatch', '--prompt', 'x', '--repo', 'acme/factory'])), { kind: 'dispatch', prompt: 'x', repo: 'acme/factory' });
    assert.throws(() => eventFor(parseArgs(['--kind', 'dispatch', '--repo', 'acme/factory'])), /prompt/);
    assert.deepEqual(
      eventFor(parseArgs(['--kind', 'message', '--session', 'https://claude.ai/code/session_01ABC', '--text', 'the reviewer asked for a test', '--repo', 't-d-d/askme-mcp'])),
      { kind: 'message', session: 'https://claude.ai/code/session_01ABC', text: 'the reviewer asked for a test', repo: 't-d-d/askme-mcp' },
    );
    assert.throws(() => eventFor(parseArgs(['--kind', 'message', '--session', 'session_01ABC', '--repo', 'acme/factory'])), /text/);
    assert.throws(() => eventFor(parseArgs(['--kind', 'nope'])), /kind/);
  });
});

describe('eventFor — the repo', () => {
  test('every kind but schedule and probe needs --repo; a schedule without one is the bare fire, every served repo', () => {
    assert.throws(() => eventFor(parseArgs(['--kind', 'dispatch', '--prompt', 'x'])), /--repo/);
    assert.throws(() => eventFor(parseArgs(['--kind', 'message', '--session', 'session_01ABC', '--text', 't'])), /--repo/);
    assert.deepEqual(eventFor(parseArgs(['--kind', 'schedule'])), { kind: 'schedule' });
    assert.deepEqual(eventFor(parseArgs(['--kind', 'schedule', '--repo', 't-d-d/askme-mcp'])), { kind: 'schedule', repo: 't-d-d/askme-mcp' });
    assert.throws(() => eventFor(parseArgs(['--kind', 'schedule', '--repo', 'nonsense'])), /owner\/name/);
  });
});

describe('overridesFor', () => {
  test('sets DISPATCH_EVENT on the one container, the shape the schedule rule sends', () => {
    assert.deepEqual(JSON.parse(overridesFor('dispatch', { kind: 'schedule' })), {
      containerOverrides: [{ name: 'dispatch', environment: [{ name: 'DISPATCH_EVENT', value: '{"kind":"schedule"}' }] }],
    });
  });
});

describe('runTask', () => {
  test('starts the task from the stack\'s outputs, waits, tails its log and exits with the container\'s code', async () => {
    const { aws, calls } = fakeAws(happy());
    const { lines, log } = collect();
    const code = await runTask({ args: parseArgs(['--kind', 'probe']), aws, log });
    assert.equal(code, 0);
    const run = calls.find((c) => c[1] === 'run-task')!;
    assert.ok(run.includes('--cluster') && run[run.indexOf('--cluster') + 1] === 'governor');
    assert.equal(run[run.indexOf('--task-definition') + 1], 'governor');
    assert.equal(run[run.indexOf('--launch-type') + 1], 'FARGATE');
    assert.equal(run[run.indexOf('--network-configuration') + 1], 'awsvpcConfiguration={subnets=[subnet-a,subnet-b],assignPublicIp=ENABLED}');
    assert.equal(run[run.indexOf('--overrides') + 1], overridesFor('dispatch', { kind: 'probe' }));
    const wait = calls.find((c) => c[1] === 'wait')!;
    assert.deepEqual(wait.slice(2, 7), ['tasks-stopped', '--cluster', 'governor', '--tasks', TASK_ARN]);
    const tail = calls.find((c) => c[1] === 'get-log-events')!;
    assert.equal(tail[tail.indexOf('--log-stream-name') + 1], 'task/dispatch/0123456789abcdef');
    assert.ok(lines.some((l) => /"event":"dispatch-result"/.test(l)), lines.join('\n'));
  });

  test('a task that exited non-zero is that code, with its log still shown', async () => {
    const { aws } = fakeAws(happy(1));
    const { lines, log } = collect();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'probe']), aws, log }), 1);
    assert.ok(lines.some((l) => /dispatch-result/.test(l)));
  });

  test('a task that stopped without running its container is a failure that names the reason', async () => {
    const { aws } = fakeAws({
      ...happy(),
      'ecs describe-tasks': stopped(null, 'CannotPullContainerError: image not found'),
      'logs get-log-events': () => { throw new Error('ResourceNotFoundException: the stream does not exist'); },
    });
    const { lines, log } = collect();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'probe']), aws, log }), 1);
    assert.ok(lines.some((l) => /CannotPullContainerError/.test(l)), lines.join('\n'));
  });

  test('a RunTask that placed nothing is a failure that names why, and nothing is waited on', async () => {
    const { aws, calls } = fakeAws({
      ...happy(),
      'ecs run-task': JSON.stringify({ tasks: [], failures: [{ arn: 'arn:cluster', reason: 'RESOURCE:VCPU' }] }),
    });
    const { lines, log } = collect();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'probe']), aws, log }), 1);
    assert.ok(lines.some((l) => /RESOURCE:VCPU/.test(l)), lines.join('\n'));
    assert.ok(!calls.some((c) => c[1] === 'wait'));
  });

  test('--no-wait on a probe starts the task, names it, and returns', async () => {
    const { aws, calls } = fakeAws(happy());
    const { lines, log } = collect();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'probe', '--no-wait']), aws, log }), 0);
    assert.ok(!calls.some((c) => c[1] === 'wait' || c[1] === 'describe-tasks'));
    assert.ok(lines.some((l) => l.includes(TASK_ARN)));
  });

  /**
   * The aws CLI's tasks-stopped waiter gives up after ten minutes (6 s × 100
   * attempts), and a task may run to its eighteen-minute deadline: the wait
   * has to outlast the task, or a by-hand schedule fire of two launches is
   * reported as "did not stop" while it goes on to succeed.
   */
  test('the wait outlasts the task\'s own deadline, one waiter round at a time', async () => {
    assert.ok(WAIT_ROUNDS * WAITER_BUDGET_MS > DEADLINE_MS, 'the waiter gives up before the task does');
    let rounds = 0;
    const { aws } = fakeAws({
      ...happy(),
      'ecs wait': () => {
        rounds += 1;
        if (rounds === 1) throw new Error('Waiter TasksStopped failed: Max attempts exceeded');
        return '';
      },
    });
    const { log } = collect();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'probe']), aws, log }), 0);
    assert.equal(rounds, 2);
  });

  test('a wait that gave up every round is a failure, not a hang', async () => {
    let rounds = 0;
    const { aws } = fakeAws({
      ...happy(),
      'ecs wait': () => {
        rounds += 1;
        throw new Error('Waiter TasksStopped failed: Max attempts exceeded');
      },
    });
    const { lines, log } = collect();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'probe']), aws, log }), 1);
    assert.equal(rounds, WAIT_ROUNDS);
    assert.ok(lines.some((l) => /Max attempts/.test(l)));
  });

  test('a wait that failed for any other reason is that failure, at once', async () => {
    let rounds = 0;
    const { aws } = fakeAws({
      ...happy(),
      'ecs wait': () => {
        rounds += 1;
        throw new Error('aws ecs wait exited 255: An error occurred (AccessDeniedException)');
      },
    });
    const { lines, log } = collect();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'probe']), aws, log }), 1);
    assert.equal(rounds, 1);
    assert.ok(lines.some((l) => /AccessDeniedException/.test(l)));
  });

  test('a probe touches no login, so it starts its own task beside anything and never queues', async () => {
    const { aws, calls } = fakeAws(happy());
    const { log } = collect();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'probe']), aws, log }), 0);
    assert.ok(calls.some((c) => c[1] === 'run-task'));
    assert.ok(!calls.some((c) => c[0] === 'sqs'));
  });
});

/**
 * A refresh rotates the login's refresh token, so two turns at once leave
 * one holding a dead login. The starter is the one thing that starts a turn
 * (dispatch/webhook/starter.mjs): a fire or a dispatch by hand queues on its
 * lane like any other, and tails the task the starter started for it.
 */
describe('runTask — a fire or a dispatch goes through the lane', () => {
  test('queues the fire on the lane, starts nothing itself, and tails the turn the task ran it in', async () => {
    const { aws, calls } = fakeAws(happy());
    const { lines, log } = collect();
    const io = laneIo();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'dispatch', '--repo', 'acme/factory', '--prompt', 'hi', '--session-name', 'S']), aws, log, ...io }), 0);
    assert.ok(!calls.some((c) => c[1] === 'run-task'), 'a by-hand fire started a task outside the lane');
    assert.ok(!calls.some((c) => c[0] === 'lambda'), 'a by-hand fire calls no starter: the backstop starts its task');

    const send = calls.find((c) => c[0] === 'sqs' && c[1] === 'send-message')!;
    assert.equal(send[send.indexOf('--queue-url') + 1], 'https://sqs.us-east-1.amazonaws.com/123456789012/governor-fires.fifo');
    assert.equal(send[send.indexOf('--message-group-id') + 1], LANE, 'a by-hand fire queues in the receiver\'s group, behind a delivery\'s');
    assert.deepEqual(JSON.parse(send[send.indexOf('--message-body') + 1]!), {
      fire: { kind: 'dispatch', prompt: 'hi', sessionName: 'S', repo: 'acme/factory' },
      reason: `by hand ${NONCE}`,
    });

    const order = calls.map((c) => c[1]);
    assert.ok(order.indexOf('send-message') < order.indexOf('filter-log-events'), order.join(' > '));
    assert.ok(!calls.some((c) => c[1] === 'wait'), 'a task runs many turns: the turn ends at its result line, not the task\'s stop');
    // The task's stream, from the fire it took to its turn's result: the
    // turns before and after it are other fires'.
    const tail = calls.find((c) => c[1] === 'get-log-events')!;
    assert.equal(tail[tail.indexOf('--log-stream-name') + 1], STREAM);
    assert.equal(tail[tail.indexOf('--start-time') + 1], '1000');
    assert.equal(tail[tail.indexOf('--end-time') + 1], '9001');
    assert.ok(lines.some((l) => l.includes(MESSAGE_ID)), lines.join('\n'));
    assert.ok(lines.some((l) => /"event":"dispatch-result"/.test(l)), lines.join('\n'));
  });

  test('exits with the turn\'s own exit code', async () => {
    const { aws } = fakeAws({ ...happy(), 'logs filter-log-events': (argv: string[]) => taskSaw(argv, [taken(1000), ended(9000, 1)]) });
    const { lines, log } = collect();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'schedule']), aws, log, ...laneIo() }), 1);
    assert.ok(lines.includes('Exit 1'), lines.join('\n'));
  });

  test('waits while fires ahead of it run, and reads only its own message\'s lines', async () => {
    let polls = 0;
    const { aws } = fakeAws({
      ...happy(),
      'logs filter-log-events': (argv: string[]) => {
        polls += 1;
        if (polls === 1) return taskSaw(argv, []);
        if (polls === 2) return taskSaw(argv, [taken(500, 'another-message'), ended(800, 1, 'another-message')]);
        if (polls === 3) return taskSaw(argv, [taken(1000)]);
        return taskSaw(argv, [taken(1000), ended(9000, 0)]);
      },
    });
    const { lines, log } = collect();
    const io = laneIo();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'schedule']), aws, log, ...io }), 0, lines.join('\n'));
    assert.equal(polls, 4);
    assert.equal(io.slept.length, 3);
    assert.equal(lines.filter((l) => l.startsWith('A task took it')).length, 1, lines.join('\n'));
  });

  test('a fire no task took in the whole budget is a failure that names where to look', async () => {
    const { aws, calls } = fakeAws({ ...happy(), 'logs filter-log-events': (argv: string[]) => taskSaw(argv, []) });
    const { lines, log } = collect();
    const io = laneIo();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'schedule']), aws, log, ...io }), 1);
    assert.ok(io.now() >= START_BUDGET_MS);
    assert.ok(!calls.some((c) => c[1] === 'get-log-events'));
    assert.ok(lines.some((l) => /governor-starter/.test(l) && /governor-fires-dead\.fifo/.test(l)), lines.join('\n'));
  });

  test('a fire the task refused is a failure at once, naming the dead-letter queue, not a wait for the whole budget', async () => {
    const refused = { at: 1000, line: { event: 'fire-refused', level: 'error', messageId: MESSAGE_ID, error: 'a dispatch fire needs a prompt' } };
    const { aws, calls } = fakeAws({ ...happy(), 'logs filter-log-events': (argv: string[]) => taskSaw(argv, [refused]) });
    const { lines, log } = collect();
    const io = laneIo();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'schedule']), aws, log, ...io }), 1);
    assert.equal(io.slept.length, 0, 'it waited on a fire that is already dead-lettered');
    assert.ok(!calls.some((c) => c[1] === 'get-log-events'));
    assert.ok(lines.some((l) => /governor-fires-dead\.fifo/.test(l) && l.includes('a dispatch fire needs a prompt')), lines.join('\n'));
  });

  test('a turn that logged no result past its deadline is a failure that names its stream', async () => {
    const { aws, calls } = fakeAws({ ...happy(), 'logs filter-log-events': (argv: string[]) => taskSaw(argv, [taken(1000)]) });
    const { lines, log } = collect();
    const io = laneIo();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'schedule']), aws, log, ...io }), 1);
    // Once taken, each search starts at the fire's own line.
    const searches = calls.filter((c) => c[1] === 'filter-log-events');
    assert.equal(searches.at(-1)![searches.at(-1)!.indexOf('--start-time') + 1], '1000');
    // The task runs other fires after it: the tail stops where this turn's deadline would.
    const tail = calls.find((c) => c[1] === 'get-log-events')!;
    assert.equal(tail[tail.indexOf('--end-time') + 1], String(1000 + TURN_BUDGET_MS + 1));
    assert.ok(io.now() >= TURN_BUDGET_MS);
    assert.ok(io.now() < START_BUDGET_MS, 'once taken, the turn has its own budget');
    assert.ok(lines.some((l) => l.includes(STREAM) && /no result/.test(l)), lines.join('\n'));
  });

  test('the turn\'s budget outlasts its deadline', () => {
    assert.ok(TURN_BUDGET_MS > DEADLINE_MS);
  });

  test('--no-wait queues the fire, names the message, and returns', async () => {
    const { aws, calls } = fakeAws(happy());
    const { lines, log } = collect();
    assert.equal(await runTask({ args: parseArgs(['--kind', 'schedule', '--no-wait']), aws, log, ...laneIo() }), 0);
    assert.ok(calls.some((c) => c[1] === 'send-message'));
    assert.ok(!calls.some((c) => c[1] === 'filter-log-events' || c[1] === 'run-task' || c[1] === 'wait'));
    assert.ok(lines.some((l) => l.includes(MESSAGE_ID)), lines.join('\n'));
  });

  test('a lane that refused the fire is that failure, and nothing is waited on', async () => {
    const { aws, calls } = fakeAws({
      ...happy(),
      'sqs send-message': () => { throw new Error('aws sqs send-message exited 254: AccessDenied'); },
    });
    const { log } = collect();
    await assert.rejects(runTask({ args: parseArgs(['--kind', 'schedule']), aws, log, ...laneIo() }), /AccessDenied/);
    assert.ok(!calls.some((c) => c[1] === 'filter-log-events'));
  });
});
