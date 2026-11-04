/**
 * A dispatch fire: a session started by hand or by a summons, on the fire's
 * own prompt, a summons only where the repo's `trust.task` lets in the
 * author of the issue or PR it is on, or one for a scheduled run on the default branch gone red,
 * on the run's facts the fire carries and the repo's instruction
 * (`redRunPrompt`, dispatch/workflow.mjs). A red scheduled run whose run
 * before went red too starts nothing: the session the red before started is
 * on the failure.
 */

import { DEFAULT_MODEL } from '../scripts/lib/dispatch-prompt.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { strangerReason } from '../scripts/lib/dispatch-router.mjs';
import { DEFAULT_SESSION_NAME } from './deliveries.mjs';
import { fireRepoOf } from './repos.mjs';
import { STALE_RUNS_PAUSES_MS, baselineIn, freshRuns } from './runs.mjs';
import { taskOf } from './trust.mjs';
import { reportUntasked } from './uncounted.mjs';
import { RED } from './webhook/fire.mjs';
import { redRunPrompt } from './workflow.mjs';

/**
 * Whether the scheduled run before `scheduled`, of the same workflow on
 * the default branch it ran on, went red too: its fire started a session that is on the failure,
 * and this red would start another to comment "this run too". The
 * run before is the completed scheduled one on that branch with the highest id
 * below this one's, read on past the first page while that holds none
 * ({@link baselineIn}): the list holds every event and branch. The list can
 * lag the run, so one lacking this run is read again
 * ({@link freshRuns}). A list it could not read, or that still lacks this
 * run, says no: a second session costs less than none on a red.
 *
 * @param {import('./webhook/fire.mjs').ScheduledRun} scheduled
 * @param {() => Promise<Pick<import('./workflow.mjs').WorkflowReader, 'workflowRuns'>>} getReader
 * @param {Pick<import('./turn.mjs').Deps, 'log' | 'sleep'>} deps
 * @returns {Promise<boolean>}
 */
const redBefore = async ({ workflowId, runId, branch }, getReader, { log, sleep }) => {
  const file = String(workflowId);
  /** @type {import('../scripts/lib/github-app.mjs').RunRow | null} */
  let before;
  try {
    const reader = await getReader();
    const got = await freshRuns(reader, file, runId, sleep, branch, { event: 'schedule', status: 'completed' });
    if (!got.fresh) {
      log('dispatch-scheduled-unread', { workflowId, runId, error: `the runs list still lacked run ${runId} after ${STALE_RUNS_PAUSES_MS.length} re-reads`, outcome: 'launching: the run before is unknown' });
      return false;
    }
    before = (await baselineIn(reader, file, branch, got.page, (rows) =>
      rows.filter((r) => r.id < runId && r.event === 'schedule' && r.status === 'completed').sort((a, b) => b.id - a.id)[0] ?? null)).baseline;
  } catch (error) {
    log('dispatch-scheduled-unread', { workflowId, runId, error: messageOf(error), outcome: 'launching: the run before is unknown' });
    return false;
  }
  if (before === null || !RED.has(String(before.conclusion))) return false;
  log('dispatch-launch', { workflowId, runId, outcome: 'skipped', reason: `scheduled run ${before.id} before it ended ${before.conclusion} too: its session is on the failure` });
  return true;
};

/**
 * A dispatch fire's plan: one session in the fire's repo, unclaimed and
 * holding nothing, unless the fire is a red scheduled run after a red
 * ({@link redBefore}), which plans none. The fire carries its name and
 * model, or the defaults.
 *
 * @param {import('./webhook/fire.mjs').DispatchFire & { repo?: string }} invocation
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<import('./turn.mjs').Plan>}
 */
export const planDispatch = async (invocation, ctx) => {
  const repo = fireRepoOf(invocation);
  const { scheduled, on, author } = invocation;
  // A summons names the issue or PR it is on and who opened it: work is
  // about it only where the repo's trust.task lets that author in. A
  // refusal starts nothing and is said once on it, at info.
  if (on !== undefined && author !== undefined && !taskOf(ctx.configOf(repo)).includes(author)) {
    const stranger = { repo, issue: on, association: author };
    ctx.log('dispatch-launch', { level: 'info', repo, issue: on, outcome: 'refused', reason: `a summons: ${strangerReason(stranger)}` });
    await reportUntasked({ reader: await ctx.readerFor(repo), stranger, what: 'summoned', event: 'dispatch-launch', log: ctx.log });
    return { launches: [], unread: [] };
  }
  if (scheduled !== undefined && await redBefore(scheduled, () => ctx.readerFor(repo), ctx)) return { launches: [], unread: [] };
  return {
    launches: [{
      repo,
      issue: null,
      claim: false,
      holdsRepo: false,
      asked: {
        // A red scheduled run's fire carries its facts; the instruction is the repo's.
        prompt: scheduled === undefined ? invocation.prompt : redRunPrompt(invocation.prompt, ctx.prompts),
        sessionName: invocation.sessionName ?? DEFAULT_SESSION_NAME,
        model: invocation.model ?? DEFAULT_MODEL,
      },
    }],
    unread: [],
  };
};
