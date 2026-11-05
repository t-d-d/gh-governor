/**
 * A dispatch fire: a session started by hand or by a summons, on the fire's
 * own prompt, or one for a scheduled run on the default branch gone red,
 * on the run's facts the fire carries and the repo's instruction
 * (`redRunPrompt`, dispatch/workflow.mjs). A summons is judged by the
 * repo's `trust.start` first: a writer or assigner it leaves out gets the
 * one refusal comment, and nothing is reached or started. A written summons
 * on a PR then looks for the PR's owner (`ownerOf`, dispatch/deliveries.mjs):
 * where a live session owns it, the remark goes there, judged by
 * `trust.relay`, the session's link goes into the PR body, and no fresh
 * session starts, whatever `trust.task` says of the PR's author. Only
 * where nobody owns the PR does `trust.task` judge the author, and a fresh
 * session start.
 * A red scheduled run whose run before went red too starts nothing: the
 * session the red before started is on the failure.
 */

import { DEFAULT_MODEL } from '../scripts/lib/dispatch-prompt.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { strangerReason } from '../scripts/lib/dispatch-router.mjs';
import { DEFAULT_SESSION_NAME, GITHUB_SOURCE } from './deliveries.mjs';
import { turnsOn } from './repo-config.mjs';
import { fireRepoOf } from './repos.mjs';
import { STALE_RUNS_PAUSES_MS, baselineIn, freshRuns } from './runs.mjs';
import { relayOf, startNarrowed, startOf, taskOf } from './trust.mjs';
import { startKinds } from './start.mjs';
import { reportUnlooked, reportUnstarted, reportUntasked } from './uncounted.mjs';
import { RED, UNATTENDED } from './webhook/fire.mjs';
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
 * Whether a summons was set going by someone the repo's `trust.start`
 * leaves out, and if so, say so: at info with the one refusal comment on
 * `on`, or at warn with none where an assigner could not be looked up.
 *
 * @param {{ repo: string, on: number, writer?: string | undefined, assigner?: string | undefined }} summons
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<boolean>} true where nothing may start.
 */
const unstartedSummons = async ({ repo, on, writer, assigner }, ctx) => {
  const config = ctx.configOf(repo);
  const start = startOf(config);
  if (writer !== undefined) {
    if (start.includes(writer)) return false;
    await reportUnstarted({ reader: await ctx.readerFor(repo), unstarted: { repo, issue: on, start, by: [{ actor: '', kind: writer }] }, what: 'summoned', event: 'dispatch-launch', log: ctx.log });
    return true;
  }
  if (assigner === undefined || !startNarrowed(config)) return false;
  const reader = await ctx.readerFor(repo);
  const { kinds, error } = await startKinds({ reader, repo, logins: [assigner] });
  const kind = kinds.get(assigner.toLowerCase());
  if (kind === undefined) {
    reportUnlooked({ unlooked: { repo, issue: on, logins: [assigner], error: error ?? 'no lookup placed them' }, event: 'dispatch-launch', log: ctx.log });
    return true;
  }
  if (start.includes(kind)) return false;
  await reportUnstarted({ reader, unstarted: { repo, issue: on, start, by: [{ actor: assigner, kind }] }, what: 'summoned', event: 'dispatch-launch', log: ctx.log });
  return true;
};

/**
 * What a summons says to the live session that owns the PR it is on: the
 * summons's own prompt, which quotes the remark and points at the PR,
 * without the line meant for an unattended fresh session.
 *
 * @param {string} prompt
 */
const ownerText = (prompt) => [
  'This remark summoned a fresh session on your pull request, but you are the live session that owns it, so no fresh session starts and the remark comes to you.',
  '',
  prompt.endsWith(`\n${UNATTENDED}`) ? prompt.slice(0, -UNATTENDED.length - 1) : prompt,
].join('\n');

/**
 * What became of looking for the owner of the PR a written summons is on:
 * `none` where nobody owns it, or the lookup was not run; `held` where a
 * live session owns it but `trust.relay` leaves the writer out, so the
 * remark reaches nobody; `told`, the delivery to the owner.
 *
 * @typedef {{ kind: 'none' } | { kind: 'held', session: string } | { kind: 'told', told: import('./deliveries.mjs').Delivery }} Owned
 */

/**
 * Look for the owner of the PR a written summons is on, and hand it the
 * remark: the session the PR body links, else the newest live session on
 * its head branch (`ownerOf`, dispatch/deliveries.mjs). Run only where the
 * repo's `prMessages` switch is on and `on` is a PR; otherwise, or where
 * nobody owns it, `none`. A linked session that answers archived, with no
 * live session on the branch, owns nothing either. A read whether `on` is a
 * PR that fails is `none`, logged at warn: a summons on an issue owes the
 * lookup nothing. A lookup that fails is a `told` with its error, and
 * nothing starts beside a session that may be live. A send that throws
 * stores a login the CLI refreshed before the turn fails, as a hook's or an
 * unblocked fire's send does: the turn's own store-back runs only after the
 * plan.
 *
 * @param {{ repo: string, on: number, writer: string, prompt: string }} summons
 * @param {import('./turn.mjs').TurnContext} ctx
 * @returns {Promise<Owned>}
 */
const toOwner = async ({ repo, on, writer, prompt }, ctx) => {
  const config = ctx.configOf(repo);
  if (!turnsOn(config, 'prMessages')) return { kind: 'none' };
  try {
    if (!(await (await ctx.readerFor(repo)).issue(on)).pull) return { kind: 'none' };
  } catch (error) {
    ctx.log('dispatch-launch', { level: 'warn', repo, issue: on, error: `could not read whether #${on} is a PR, so its owner is not looked for: ${messageOf(error)}` });
    return { kind: 'none' };
  }
  /** @type {import('./deliveries.mjs').Delivery} */
  const failed = { ok: false, answered: null, refused: false, sessionUrl: null, error: null, fallback: null, dropped: null, skipped: null, relinked: null };
  /** @type {string | null} */
  let session;
  try {
    ({ session } = await ctx.delivery().ownerOf(on));
  } catch (error) {
    const why = `could not look for the owner of PR #${on}, so nothing starts beside a session that may be live: ${messageOf(error)}`;
    ctx.log('dispatch-launch', { level: 'error', repo, issue: on, error: why });
    return { kind: 'told', told: { ...failed, error: why } };
  }
  if (session === null) return { kind: 'none' };
  if (!relayOf(config).includes(writer)) return { kind: 'held', session };
  /** @type {import('./deliveries.mjs').Delivery} */
  let told;
  try {
    told = await ctx.delivery().deliver({ pr: on }, ownerText(prompt), { source: GITHUB_SOURCE, on: [on] });
  } catch (error) {
    await ctx.storeLogin();
    throw error;
  }
  // Nobody took it and nobody else was found: the PR has no live owner.
  if (told.skipped !== null || (told.refused && told.fallback === null)) return { kind: 'none' };
  return { kind: 'told', told };
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
  const { scheduled, on, author, writer, assigner } = invocation;
  // A summons starts a session only where the repo's trust.start lets in
  // who set it going: its writer, or the assigner of an issue assigned to
  // the summons account, looked up only where start is narrowed.
  if (on !== undefined && (writer !== undefined || assigner !== undefined)) {
    const refused = await unstartedSummons({ repo, on, writer, assigner }, ctx);
    if (refused) return { launches: [], unread: [] };
  }
  // A written summons on a PR goes to the PR's live owner, where it has
  // one: the summons sets work going, and the owner is already on it. No
  // fresh session starts beside it, and trust.task is not read: the PR's
  // author is not who the remark sets work going for.
  if (on !== undefined && writer !== undefined) {
    const owned = await toOwner({ repo, on, writer, prompt: invocation.prompt }, ctx);
    if (owned.kind === 'held') {
      ctx.log('dispatch-launch', { level: 'info', repo, issue: on, outcome: 'refused', session: owned.session, reason: `a summons by ${writer}, whom the repo's trust.relay leaves out, on a PR a live session owns: it reaches nobody, and no fresh session starts beside the owner` });
      return { launches: [], unread: [] };
    }
    if (owned.kind === 'told') {
      const { told } = owned;
      ctx.log('dispatch-launch', { ...(told.error === null ? { level: 'info' } : {}), repo, issue: on, outcome: told.ok || told.fallback?.outcome === 'forwarded' ? 'forwarded' : 'not forwarded', sessionUrl: told.sessionUrl, ...(told.error === null ? {} : { error: told.error }), reason: 'a summons on a PR a live session owns: it went to that session, and no fresh session starts' });
      return { launches: [], unread: [], result: { messaged: told } };
    }
  }
  // A summons names the issue or PR it is on and who opened it: a fresh
  // session's work is about it only where the repo's trust.task lets that
  // author in. A refusal starts nothing, and is said once on it, at info.
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
