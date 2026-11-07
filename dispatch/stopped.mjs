/**
 * A pickup session that ended without a pull request. Pickup claims a
 * ticket before its session starts, and never takes a claimed ticket, so a
 * session that stops (the ticket is already done, far larger than it reads,
 * needs the owner's decision, or a gate it cannot make green) and is then
 * archived leaves the ticket claimed with nobody working on it and nobody
 * told to decide.
 *
 * Under pickup's switch, governor ends that claim. The ticket is an open
 * issue carrying the claim label that no open PR closes, whose newest
 * dispatch comment governor's App posted names a session that is archived
 * or that the sessions API no longer has. Governor posts one comment under
 * `<!-- governor:stopped <session> -->`, then takes every ready label
 * and then the claim label off, as a not-planned blocker close does
 * (dispatch/unblocked-fire.mjs). Putting the ready labels back starts a
 * fresh session at once through the label's own fire, and that session's
 * pickup prompt tells it to read the earlier sessions' comments
 * (dispatch/prompts.mjs).
 *
 * Two sweeps look. The sign-off sweep, once it has archived sessions, looks
 * at the tickets those sessions were dispatched to (dispatch/turn.mjs). The
 * bare schedule fire's pickup sweep looks at every claimed ticket of a repo
 * it sweeps (dispatch/sweep.mjs), which finds a session archived by hand.
 *
 * The comment is the record: governor reads the thread for its marker
 * before it writes another, so it posts once per stopped session. It goes
 * before the labels, so a comment that fails takes nothing off and the next
 * sweep tries again; a label that stays is taken off again by the next
 * sweep, with no second comment. A read that fails releases nothing, and a
 * session read never reads as ended unless the record says so.
 */

import { messageOf } from '../scripts/lib/error-message.mjs';
import { archived, branchesOf } from '../scripts/lib/session-branch.mjs';
import { lastDispatch } from './webhook/fire.mjs';
import { sessionId } from './webhook/subscribe.mjs';
import { turnsOn } from './repo-config.mjs';

/** How governor's comment on a released ticket starts; the session id and ` -->` follow. */
export const STOPPED_MARKER = '<!-- governor:stopped ';

/** The log event for each ticket the release looks at. */
export const STOPPED_EVENT = 'dispatch-stopped';

/**
 * @typedef {{ archived: boolean, branches: string[] } | null} Stopped
 *   A session's state as its own record reads it: archived or not, and the
 *   branches of the ticket's repo it pushed. Null for a session the API no
 *   longer has.
 * @typedef {{
 *   openClaimed: (claim: string) => Promise<Array<{ number: number, title: string, labels: string[] }>>,
 *   allComments: (n: number) => Promise<Array<{ id: number, body: string, created_at: string, ours: boolean }>>,
 *   removeLabel: (n: number, label: string) => Promise<void>,
 *   comment: (n: number, body: string) => Promise<void>,
 * }} StoppedReader
 */

/**
 * A session's record as the release reads it: null where the API answered
 * none, else archived or not, with the branches of `repo` it holds. A
 * record that carries no status throws: it is never read as ended.
 *
 * @param {unknown} record
 * @param {string} repo
 * @returns {Stopped}
 */
export const stoppedOf = (record, repo) => {
  if (record === null || record === undefined) return null;
  const fields = /** @type {Record<string, unknown>} */ (typeof record === 'object' ? record : {});
  if (typeof (fields.session_status ?? fields.status) !== 'string') throw new Error(`the session's record carries no status: it ${typeof record === 'object' ? `has ${Object.keys(fields).join(', ')}` : `is ${typeof record}`}`);
  return { archived: archived(record), branches: [...new Set(branchesOf(record, repo.toLowerCase()).held)] };
};

/** `a`, `a` and `b`, `a`, `b` and `c`, each in backticks. @param {readonly string[]} names */
const listOf = (names) => {
  const quoted = names.map((n) => `\`${n}\``);
  return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
};

/**
 * Governor's comment on a ticket whose session stopped without a PR: which
 * session, its last comment here and the branches it pushed where there are
 * any, what came off, and the one step that starts the ticket again.
 *
 * @param {{ session: string, removed: readonly string[], ready: readonly string[], last: string | null, branches: readonly string[] }} args
 * @returns {string}
 */
export const stoppedComment = ({ session, removed, ready, last, branches }) => [
  `${STOPPED_MARKER}${session} -->`,
  `The session governor started for this ticket, https://claude.ai/code/${session}, has ended without a pull request that closes it, so nobody is working on it now.`,
  '',
  ...(last === null ? ['It left no comment here.'] : [`Its last comment here: ${last}`]),
  ...(branches.length === 0 ? [] : [`It pushed ${branches.length === 1 ? 'the branch' : 'the branches'} ${listOf(branches)}.`]),
  '',
  `Governor took ${listOf(removed)} off, so pickup sees the ticket as not ready. Decide what it needs. To start it again, put ${listOf(ready)} back: that starts a fresh session, which reads this thread and carries on from any branch the earlier session pushed.`,
].join('\n');

/** The session link a post signs with, not followed by more of an id. @param {string} session */
const signedBy = (session) => new RegExp(`https://claude\\.ai/code/${session}(?![A-Za-z0-9_-])`);

/**
 * End the claim of each of a repo's claimed tickets whose pickup session
 * has ended without a PR, under pickup's switch. `only`, the sessions the
 * sign-off sweep archived, narrows it to their tickets. Each ticket logs
 * {@link STOPPED_EVENT}; nothing here throws for one ticket, and a read of
 * the open list that fails throws.
 *
 * @param {{
 *   repo: string,
 *   config: import('./repo-config.mjs').RepoConfig,
 *   reader: StoppedReader,
 *   stopped: (session: string) => Promise<Stopped>,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 *   only?: ReadonlySet<string>,
 * }} args
 * @returns {Promise<{ released: Array<{ issue: number, session: string }>, unread: Array<{ repo: string, issue: number, error: string }> }>}
 */
export const releaseStopped = async ({ repo, config, reader, stopped, log, only }) => {
  /** @type {Array<{ issue: number, session: string }>} */
  const released = [];
  /** @type {Array<{ repo: string, issue: number, error: string }>} */
  const unread = [];
  if (!turnsOn(config, 'pickup')) return { released, unread };
  const { claim, ready } = config.labels;
  for (const ticket of await reader.openClaimed(claim)) {
    const issue = ticket.number;
    try {
      const comments = await reader.allComments(issue);
      const dispatched = lastDispatch(comments)?.sessionUrl ?? null;
      if (dispatched === null) {
        if (only === undefined) log(STOPPED_EVENT, { level: 'info', repo, issue, outcome: 'left', reason: 'no dispatch comment of governor\'s names its session' });
        continue;
      }
      const session = sessionId(dispatched);
      if (only !== undefined && !only.has(session)) continue;
      const marker = `${STOPPED_MARKER}${session} -->`;
      const told = comments.some((c) => c.ours && c.body.includes(marker));
      const state = told ? { archived: true, branches: [] } : await stopped(session);
      if (state !== null && !state.archived) {
        log(STOPPED_EVENT, { level: 'info', repo, issue, session, outcome: 'left', reason: 'its session is not archived' });
        continue;
      }
      // The ready labels first and the claim last: a ready label that
      // stays then keeps the claim on, so pickup cannot start the ticket
      // before the next sweep finishes the release.
      const takeOff = [...ready.filter((l) => l !== claim && ticket.labels.includes(l)), claim];
      if (!told) {
        const last = comments.filter((c) => !c.ours && signedBy(session).test(c.body)).at(-1);
        await reader.comment(issue, stoppedComment({
          session,
          removed: [claim, ...takeOff.slice(0, -1)],
          ready,
          last: last === undefined ? null : `https://github.com/${repo}/issues/${issue}#issuecomment-${last.id}`,
          branches: state?.branches ?? [],
        }));
      }
      /** @type {Array<{ label: string, error: string }>} */
      const stayed = [];
      for (const label of takeOff) {
        if (label === claim && stayed.length > 0) {
          stayed.push({ label, error: 'kept on while a ready label stays' });
          continue;
        }
        try {
          await reader.removeLabel(issue, label);
        } catch (error) {
          stayed.push({ label, error: messageOf(error) });
        }
      }
      if (stayed.length > 0) {
        log(STOPPED_EVENT, { level: 'error', repo, issue, session, outcome: 'labels stayed', stayed, reason: 'a label would not come off a ticket whose session ended; the next sweep tries again' });
        unread.push({ repo, issue, error: `labels stayed on a ticket whose session ended: ${stayed.map((s) => `${s.label}: ${s.error}`).join('; ')}` });
        continue;
      }
      log(STOPPED_EVENT, { repo, issue, session, outcome: told ? 'labels taken off again' : 'released', removed: takeOff });
      if (!told) released.push({ issue, session });
    } catch (error) {
      log(STOPPED_EVENT, { level: 'error', repo, issue, outcome: 'unread', error: messageOf(error), reason: 'the ticket keeps its claim until a later sweep' });
      unread.push({ repo, issue, error: messageOf(error) });
    }
  }
  return { released, unread };
};
