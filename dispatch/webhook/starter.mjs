/**
 * The starter's decisions: start a dispatcher task when a fire waits on the
 * lane and none runs, and do nothing otherwise.
 *
 * The starter holds no fire. The task is the lane's only reader: it takes
 * each fire and runs it as its own turn, until the lane stays empty
 * (dispatch/lane.mjs). A dispatcher turn refreshes the stored login, and two
 * turns refreshing one login leave one of them dead, so there is never more
 * than one task. The function's reserved concurrency of one keeps two calls
 * from both seeing no task and both starting one (infra/governor.cfn.yml,
 * StarterFunction).
 *
 * Three things call it:
 * - the receiver, after it queues a fire (dispatch/webhook/poke.mjs). The
 *   lane took that fire, so the call counts as a fire waiting without
 *   asking the lane, whose counts are approximate and may lag the send;
 * - every task's stop event, so a fire that lands while a task is exiting
 *   finds the next task started;
 * - a schedule every minute, the backstop for a call that never came.
 *
 * A task that fails to start never took a fire, so the fire is still on the
 * lane. Its stop starts the next attempt, which rides on the task's
 * startedBy, up to MAX_START_ATTEMPTS in a row. Past that the starter starts
 * nothing for the chain and logs `start-gave-up` at error, which pages; the
 * next poke or the backstop begins a new chain.
 *
 * ECS's API is eventually consistent: ListTasks may miss a task for a few
 * seconds after RunTask started it. So the starter also counts the task it
 * last started as running, until that task's stop event arrives or
 * START_GRACE_MS passes. The reserved concurrency of one keeps that memory
 * in one execution environment.
 *
 * Nothing is thrown. A failed call to ECS or the lane is logged at error and
 * the backstop calls again within a minute: the fire never left the lane.
 *
 * Pure: `startNext` takes its I/O as `deps`. starter-handler.mjs binds the
 * real ones.
 */

/**
 * @typedef {'receiver' | 'stop' | 'backstop'} Caller
 * @typedef {{
 *   running: () => Promise<string[]>,
 *   waiting: () => Promise<number>,
 *   runTask: (startedBy: string) => Promise<string>,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 *   now: () => number,
 *   memory: { started?: { taskArn: string, at: number } | undefined },
 * }} Deps
 */

/**
 * How long the task the starter last started counts as running though
 * ListTasks does not show it. ListTasks catches up in seconds; past this, a
 * lost stop event holds nothing back.
 */
export const START_GRACE_MS = 2 * 60 * 1000;

/**
 * How many tasks in a row may fail to start before the starter gives up on
 * the chain. The pull fault cleared within seconds each time it was seen, so
 * a second attempt carries a transient; a third is the margin.
 * infra/governor.cfn.yml's DispatchNotRunAlarm threshold is sized off this.
 */
export const MAX_START_ATTEMPTS = 3;

/**
 * The task's startedBy, which carries its attempt: the one field RunTask
 * sets that the task's stop event hands back. ECS takes letters, digits,
 * hyphens, underscores and slashes there.
 */
const STARTED_BY = /^governor-starter\/attempt-(\d+)$/;

/** @param {number} attempt @returns {string} */
export const startedByFor = (attempt) => `governor-starter/attempt-${attempt}`;

/**
 * @param {string | undefined} startedBy
 * @returns {number | undefined} The attempt, or undefined for a task the starter did not start.
 */
export const attemptFrom = (startedBy) => {
  const match = STARTED_BY.exec(String(startedBy ?? ''));
  return match ? Number(match[1]) : undefined;
};

/**
 * @param {unknown} event
 * @returns {Caller | undefined}
 */
export const callerOf = (event) => {
  const e = /** @type {Record<string, unknown> | null} */ (event);
  if (e?.source === 'aws.ecs' && e?.['detail-type'] === 'ECS Task State Change') return 'stop';
  if (e?.caller === 'receiver' || e?.caller === 'backstop') return e.caller;
  return undefined;
};

/** @param {unknown} error */
const errorText = (error) => String(/** @type {any} */ (error)?.stack ?? error);

/**
 * Start the next dispatcher task, if a fire waits and none runs.
 *
 * @param {unknown} event The receiver's call, a stop event or the backstop's.
 * @param {Deps} deps
 * @returns {Promise<string | undefined>} The task ARN, or undefined when it started none.
 */
export const startNext = async (event, deps) => {
  const caller = callerOf(event);
  if (caller === undefined) {
    deps.log('start-ignored', { reason: 'not a call the starter knows', called: JSON.stringify(event)?.slice(0, 300) });
    return undefined;
  }
  /** @type {Record<string, unknown>} */
  const context = { caller };
  let attempt = 1;
  if (caller === 'stop') {
    const detail = /** @type {{ taskArn?: string, stopCode?: string, startedBy?: string, stoppedReason?: string } | undefined} */ (/** @type {any} */ (event).detail);
    Object.assign(context, { stopped: detail?.taskArn, stopCode: detail?.stopCode, stoppedReason: detail?.stoppedReason });
    if (deps.memory.started?.taskArn === detail?.taskArn) deps.memory.started = undefined;
    const prior = detail?.stopCode === 'TaskFailedToStart' ? attemptFrom(detail?.startedBy) : undefined;
    if (prior !== undefined) {
      if (prior >= MAX_START_ATTEMPTS) {
        deps.log('start-gave-up', { level: 'error', ...context, attempts: prior, reason: `${prior} tasks in a row failed to start; the next poke or the backstop tries again` });
        return undefined;
      }
      attempt = prior + 1;
    }
  }
  try {
    const started = deps.memory.started;
    if (started !== undefined && deps.now() - started.at < START_GRACE_MS) return undefined;
    if ((await deps.running()).length > 0) return undefined;
    if (caller !== 'receiver' && (await deps.waiting()) === 0) return undefined;
    const taskArn = await deps.runTask(startedByFor(attempt));
    deps.memory.started = { taskArn, at: deps.now() };
    deps.log('task-started', { ...context, attempt, taskArn });
    return taskArn;
  } catch (error) {
    deps.log('start-failed', { level: 'error', ...context, attempt, error: errorText(error) });
    return undefined;
  }
};
