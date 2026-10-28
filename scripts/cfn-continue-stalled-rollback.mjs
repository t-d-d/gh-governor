#!/usr/bin/env node
//
// Unstick the stack before applying it.
//
// The deploy applies the stack from CI so it never needs admin credentials
// on somebody's machine. A stack in UPDATE_ROLLBACK_FAILED breaks that: it
// cannot be updated, so every later deploy fails, and clearing it is a
// `continue-update-rollback`. The deploy role holds
// `cloudformation:ContinueUpdateRollback` on the stack, and this is what
// calls it.
//
// Run before the deploy step:
//
//   node scripts/cfn-continue-stalled-rollback.mjs <stack-name>
//
// It is a no-op on a healthy stack and on an absent one, so it sits in front
// of every apply rather than being something an operator has to remember.
//
// What it will NOT do is clear a ROLLBACK_COMPLETE or a ROLLBACK_FAILED — a
// failed FIRST create, in the two spellings it leaves behind. Only a delete
// clears either (ContinueUpdateRollback takes UPDATE_ROLLBACK_FAILED and no
// other state), and a deploy role should hold no DeleteStack: a deploy that
// may delete the stack may delete its secrets with it. Both are reachable
// only on a fresh account, where admin credentials are already present. So it refuses and says which
// credentials the operator needs, rather than letting the deploy fail later
// with an error about change sets.

import { spawnSync } from 'node:child_process';
import { isCliEntry } from './lib/cli-entry.mjs';

/**
 * What an apply should do about a stack in `stackStatus`, where `undefined`
 * means the stack does not exist yet.
 *
 * Three states stop an apply, in two ways: one this script can clear itself,
 * and two only a delete clears. Everything else — UPDATE_ROLLBACK_COMPLETE
 * included, which reads like a failure and is a working state — proceeds and
 * lets `aws cloudformation deploy` be the judge; it reports the rest better
 * than a second copy of CloudFormation's state machine would.
 *
 * @param {string | undefined} stackStatus
 * @returns {'continue' | 'refuse' | 'proceed'}
 */
export function recoveryAction(stackStatus) {
  if (stackStatus === 'UPDATE_ROLLBACK_FAILED') return 'continue';
  // Both spellings of a failed FIRST create: the rollback finished, or it
  // failed too. `ContinueUpdateRollback` answers for neither — the API takes
  // UPDATE_ROLLBACK_FAILED and nothing else — so both are the delete-only case.
  if (stackStatus === 'ROLLBACK_COMPLETE' || stackStatus === 'ROLLBACK_FAILED') return 'refuse';
  return 'proceed';
}

/**
 * What an `aws cloudformation describe-stacks` run learned about a stack:
 * `status` with the state it read, `absent` for a stack that is not there
 * yet, or `unreadable` when the call failed for some other reason.
 *
 * Absent and unreadable are not the same answer and must not be read as one.
 * The exit code says only that the call failed, so an AccessDenied, a throttle
 * or an unreachable endpoint looks exactly like a first apply. Taken for
 * absence, a stack genuinely stuck in UPDATE_ROLLBACK_FAILED is never
 * continued — the one job this script has — and the operator is told it does
 * not exist, which sends them to delete it with admin credentials: the
 * wrong path entirely. CloudFormation spells the real absence `... does not exist`, so
 * that, rather than the exit status, is what tells the two apart.
 *
 * @param {{ status: number, stdout: string, stderr: string }} described
 * @returns {{ kind: 'status', status: string } | { kind: 'absent' } | { kind: 'unreadable' }}
 */
export function describedStatus(described) {
  if (described.status === 0) return { kind: 'status', status: described.stdout };
  if (/does not exist/i.test(described.stderr)) return { kind: 'absent' };
  return { kind: 'unreadable' };
}

/**
 * The two `aws` invocations that clear a stalled rollback, in order.
 *
 * Exported so the waiter's NAME is pinned by a test. It is a subcommand, not
 * an argument: `aws` rejects a name it does not know before it contacts AWS at
 * all, so a wrong one fails every recovery — and only ever on the day one was
 * needed, which is the day nobody is reading this file. The list the CLI
 * accepts is `aws cloudformation wait help`.
 *
 * @param {string} stackName
 * @returns {[string[], string[]]}
 */
export function rollbackCommands(stackName) {
  return /** @type {[string[], string[]]} */ ([
    ['cloudformation', 'continue-update-rollback', '--stack-name', stackName],
    ['cloudformation', 'wait', 'stack-rollback-complete', '--stack-name', stackName],
  ]);
}

/**
 * `aws` with the given arguments.
 *
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function aws(args) {
  const result = spawnSync('aws', args, { encoding: 'utf-8' });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: result.stderr ?? '' };
}

/** @param {string | undefined} stackName */
function main(stackName) {
  if (!stackName) {
    console.error('usage: cfn-continue-stalled-rollback.mjs <stack-name>');
    process.exit(2);
  }

  const described = aws([
    'cloudformation', 'describe-stacks',
    '--stack-name', stackName,
    '--query', 'Stacks[0].StackStatus',
    '--output', 'text',
  ]);
  // A stack that does not exist is not an error here — it is a first apply.
  // A read that failed for any OTHER reason is: see `describedStatus`.
  const read = describedStatus(described);
  if (read.kind === 'unreadable') {
    console.error(
      `::error::could not read ${stackName}'s state: `
        + `${described.stderr.trim() || `aws exited ${described.status}`}. A stalled rollback cannot be `
        + 'told from a stack that does not exist yet without it, so this refuses rather than letting '
        + 'the apply run against a stack it knows nothing about.',
    );
    process.exit(1);
  }
  const status = read.kind === 'status' ? read.status : undefined;

  const action = recoveryAction(status);

  if (action === 'proceed') {
    console.log(`${stackName}: ${status ?? 'does not exist yet'} — nothing to recover.`);
    return;
  }

  if (action === 'refuse') {
    console.error(
      `::error::${stackName} is in ${status}: a create that failed, which only a delete clears. ` +
        'This role holds no cloudformation:DeleteStack. Delete the stack with admin ' +
        'credentials, then dispatch this workflow again.',
    );
    process.exit(1);
  }

  console.log(`${stackName}: ${status} — continuing the rollback so the apply can proceed.`);
  const [continueCommand, waitCommand] = rollbackCommands(stackName);
  const continued = aws(continueCommand);
  if (continued.status !== 0) {
    console.error(`::error::continue-update-rollback failed for ${stackName}: ${continued.stderr.trim()}`);
    process.exit(1);
  }

  // Without the wait the deploy below would race the rollback and fail with an
  // error about the stack being busy — which reads like a different fault.
  const waited = aws(waitCommand);
  if (waited.status !== 0) {
    console.error(
      `::error::${stackName} did not reach UPDATE_ROLLBACK_COMPLETE. Some resource is blocking ` +
        'the rollback; read the stack events, fix it, and dispatch again.',
    );
    process.exit(1);
  }
  console.log(`${stackName}: rollback complete — the stack can be updated again.`);
}

// Importable for the unit test; only the direct invocation touches AWS.
if (isCliEntry(import.meta.url, process.argv[1])) {
  main(process.argv[2]);
}
