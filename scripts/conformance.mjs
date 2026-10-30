#!/usr/bin/env node
/**
 * The deploy's read-back: each check compares what the repo declares with
 * what a system outside it holds, once the deploy has written. One side can
 * change with no code change, so these cannot run in the gate.
 *
 * Every check runs and every finding prints before the exit, so one run names
 * every drift. A check whose variable is unset reports not-applicable out
 * loud and fails nothing: a hand run against one side only is still useful.
 *
 * Run by .github/workflows/deploy.yml after the App's webhook is pointed:
 *
 *   GOVERNOR_STACK=governor GOVERNOR_APP_SLUG=governor-app node scripts/conformance.mjs
 */

import { isCliEntry } from './lib/cli-entry.mjs';
import { APP_SLUG_VAR, checkDispatchAppEvents } from './lib/conformance-app-events.mjs';
import { STACK_VAR, checkDispatchWebhookUrl, checkHookUrl } from './lib/conformance-webhook-url.mjs';

/**
 * A check's findings, and what it read, said out loud under its own line
 * whether or not it found anything.
 *
 * @typedef {{ findings: string[], notes?: string[] }} CheckOutcome
 */
/** @typedef {{ skipped: string }} Skipped */

/**
 * @typedef {object} Check
 * @property {string} id
 * @property {string[]} env - The variables the check reads; unset means not applicable.
 * @property {(options: { env: Readonly<Record<string, string | undefined>> }) => Promise<CheckOutcome>} run
 */

/** @type {readonly Check[]} */
export const CHECKS = Object.freeze([
  { id: 'app-events', env: [APP_SLUG_VAR], run: checkDispatchAppEvents },
  { id: 'webhook-url', env: [STACK_VAR], run: checkDispatchWebhookUrl },
  { id: 'hook-url', env: [STACK_VAR], run: checkHookUrl },
]);

/**
 * One check's outcome, or why it did not run.
 *
 * @param {Check} check
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {Promise<CheckOutcome | Skipped>}
 */
export async function runCheck(check, env) {
  const unset = check.env.filter((name) => !env[name]);
  if (unset.length > 0) return { skipped: `not applicable: ${unset.join(', ')} unset` };
  return check.run({ env });
}

/**
 * Runs every check, prints each outcome, and returns the exit code: 1 when
 * any check found something, else 0. A check that throws (a stack that does
 * not exist, a read that timed out) is a finding on that check, and the
 * checks after it still run.
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {{ checks?: readonly Check[], log?: (line: string) => void }} [io]
 */
export async function runAll(env, { checks = CHECKS, log = console.log } = {}) {
  let failed = false;
  for (const check of checks) {
    /** @type {CheckOutcome | Skipped} */
    let outcome;
    try {
      outcome = await runCheck(check, env);
    } catch (error) {
      outcome = { findings: [`the check threw: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if ('skipped' in outcome) {
      log(`- ${check.id}: ${outcome.skipped}`);
      continue;
    }
    if (outcome.findings.length > 0) failed = true;
    log(`${outcome.findings.length === 0 ? 'ok' : 'FAIL'} ${check.id}`);
    for (const line of [...(outcome.notes ?? []), ...outcome.findings]) log(`    ${line}`);
  }
  return failed ? 1 : 0;
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  process.exitCode = await runAll(process.env);
}
