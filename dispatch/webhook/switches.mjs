/**
 * Which of a served repo's switches a fire needs, shared by the task, which
 * refuses a fire its repo's file does not turn on (dispatch/turn.mjs), and
 * the receiver, which drops a GitHub delivery's fire before the lane where
 * the hook table's item says that switch is off (route.mjs).
 *
 * The receiver reads no config file. It knows a repo's switches only as the
 * task last wrote them to the hook table (hook-table.mjs), so it drops a fire
 * only where the item says plainly that its switch is off ({@link
 * droppedBy}), and queues anything the item cannot say, for the task to
 * decide.
 *
 * A pure leaf beside fire.mjs: the Lambda packages dispatch/webhook/ whole,
 * and the task image copies this file.
 */

/**
 * Whether `run` is of the repo's CI workflow, the file its config names:
 * a red run is its merges' to fix. Every other workflow a PR
 * hears of declares a deploy target. A workflow's name decides nothing.
 *
 * @param {{ path?: string }} run
 * @param {{ ci?: string | undefined }} workflows The repo's config file's.
 */
export const isCi = (run, workflows) => workflows.ci !== undefined && run.path === workflows.ci;

/**
 * The switch a fire kind needs, or null for one that needs none (a probe).
 * A message to a PR's owner needs PR messages, one heard by subscription
 * (a `governor:subscribe` line, an issue's filer) subscribe messages; a
 * dispatch is a summons unless it is the red scheduled run's. A red run of
 * the repo's CI needs CI messages; a red deploy, like a green shipping job,
 * deploy messages. The bare schedule fire's heartbeat is read on its own.
 * A close needs none: it starts nothing, and queues an `unblocked` fire per
 * ticket it blocked, whose switch the ticket's own state picks in its own
 * repo, `pickup` or `unblocked` (dispatch/unblocked.mjs).
 *
 * @param {import('./fire.mjs').Fire} fire
 * @param {{ ci?: string | undefined }} [workflows] The repo's config file's.
 * @returns {string | null}
 */
export const switchOf = (fire, workflows = {}) => {
  switch (fire.kind) {
    case 'schedule': return fire.freed === undefined ? 'pickup' : null;
    case 'dispatch': return fire.scheduled === undefined ? 'summons' : 'redScheduledRun';
    case 'message': return fire.subscribed === true ? 'subscribeMessages' : 'prMessages';
    case 'workflow': return isCi(fire, workflows) ? 'ciMessages' : 'deployMessages';
    case 'job': return 'deployMessages';
    case 'branch-run': return 'branchRunMessages';
    case 'conflicts': return 'conflicts';
    case 'review': return 'prReview';
    case 'periodics': return 'periodics';
    case 'hook': return 'hooks';
    default: return null;
  }
};

/**
 * The switches, off in `switches`, that drop `fire` in the receiver, or null
 * to queue it. `switches` is the repo's item in the hook table: each switch
 * as the task last read the repo's file, null where there is no item or it
 * holds none. Only a switch the item names as off drops a fire; one it does
 * not name is the task's to judge.
 *
 * - A `conflicts` fire is never dropped. The merge that changes the repo's
 *   file queues one, and its turn reads the new file and writes the item:
 *   dropped, a switch just turned on would keep losing its fires until the
 *   schedule fire's sweep read the file.
 * - A fire carrying `counted` is kept unless `periodics` is off: a turn
 *   checks the repo's periodics whatever its own kind's switch says.
 * - A `workflow` fire needs `ciMessages` or `deployMessages` by the file's
 *   `workflows.ci`, which the item does not hold, so it is dropped only
 *   where both are off.
 *
 * @param {import('./fire.mjs').Fire} fire
 * @param {ReadonlyMap<string, boolean> | null} switches
 * @returns {string[] | null}
 */
export const droppedBy = (fire, switches) => {
  if (switches === null || fire.kind === 'conflicts') return null;
  const off = (/** @type {string} */ name) => switches.get(name) === false;
  if (fire.counted !== undefined && !off('periodics')) return null;
  const needs = fire.kind === 'workflow' ? ['ciMessages', 'deployMessages'] : [switchOf(fire)];
  const names = needs.filter((name) => name !== null);
  return names.length > 0 && names.every(off) ? names : null;
};
