/**
 * The PRs a merge to the default branch left conflicted, each owner session
 * told directly.
 *
 * GitHub sends no event for a PR that a merge leaves conflicted:
 * mergeability is computed lazily on read, and a PR's `synchronize` fires
 * only when it is pushed to. So a PR merged into the repo's default branch
 * queues a `conflicts` fire naming that branch (dispatch/webhook/route.mjs),
 * in any served repo, and the turn reads every open, non-draft PR into it here. A first read of `mergeable` is often null
 * (the read starts GitHub's computation), so the nulls are read again after
 * a wait; a PR still null is never taken for a conflict.
 *
 * A conflicted PR's owner session (the one its body names, else the live
 * local session on its head branch) gets a message naming the PR,
 * the commit the branch is at and the merge that moved it, with the fallback a
 * remark gets: an archived owner's PR is taken over by one fresh session
 * that resolves the conflict (dispatch/deliveries.mjs). Nothing is posted on
 * the PR. Before the send, the PR and the merge are recorded in the state
 * table by a conditional write: a PR that stays conflicted across three
 * merges hears of each once, and of a re-read never. A PR with no owner
 * session gets nothing. A mergeable PR is not touched; its next push is the
 * review's.
 *
 * `checkConflicts` reads through the injected reader and sends through the
 * injected delivery.
 */

import { SUMMONERS, UNATTENDED } from './webhook/fire.mjs';
import { HANDOFF, oneLine } from './webhook/mention.mjs';
import { instruction } from './prompts.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { GITHUB_SOURCE } from './deliveries.mjs';

/**
 * @typedef {import('./webhook/fire.mjs').ConflictsFire} ConflictsFire
 * @typedef {import('../scripts/lib/github-app.mjs').PullRequestRow} PullRequestRow
 * @typedef {import('../scripts/lib/github-app.mjs').OpenPullRow} OpenPullRow
 * @typedef {{
 *   branchHead: (branch: string) => Promise<string>,
 *   openPulls: () => Promise<OpenPullRow[]>,
 *   pullRequest: (n: number) => Promise<PullRequestRow>,
 * }} ConflictsReader
 * @typedef {{ pr: number, outcome: 'told' | 'fallback' | 'already-told' | 'no-owner' | 'skipped' | 'failed', reason: string | null, error: string | null }} Checked
 *   `told`: the owner took the message. `fallback`: it was archived, and a
 *   fresh session started or the message was forwarded. `already-told`: a
 *   turn recorded this PR and merge before. `no-owner`: no session to tell.
 */

/** How often, and how far apart, the PRs whose mergeable state is null are read. */
const CONFLICT_READS = 5;
const CONFLICT_WAIT_MS = 3000;

/**
 * The message a conflicted PR's session gets, and the fallback's prompt:
 * the facts (the PR, the commit the base is at, the merge that moved it),
 * then the `conflicts` instruction, the repo's prompt or the default
 * (dispatch/prompts.mjs).
 *
 * @param {{ pr: Pick<PullRequestRow, 'number' | 'title' | 'html_url'>, base: string, head: string, merged: Pick<ConflictsFire, 'pr' | 'sha'> }} about
 * @param {Readonly<Record<string, string | undefined>>} [prompts] The config file's.
 * @returns {{ text: string, fallback: import('./webhook/fire.mjs').Fallback }}
 */
export const conflictMessage = ({ pr, base, head, merged }, prompts = {}) => {
  const facts = `PR #${pr.number} (${oneLine(pr.title)}, ${pr.html_url}) conflicts with ${base} since ${base} moved to ${head}, after #${merged.pr} merged (merge commit ${merged.sha}).`;
  const ask = instruction(prompts, 'conflicts', { base });
  return {
    text: `${facts}\n\n${ask}`,
    fallback: {
      prompt: [facts, '', HANDOFF, ask, UNATTENDED].join('\n'),
      sessionName: oneLine(`Conflicts #${pr.number} ${pr.title}`).slice(0, 100),
      issue: pr.number,
    },
  };
};

/**
 * The open PRs into the default branch, each read until GitHub has computed its mergeable
 * state or the reads run out; each round's reads run together. A PR that
 * closed or turned draft meanwhile is dropped; one whose read fails is a
 * failed check, and the rest are still read.
 *
 * @param {ConflictsReader} reader
 * @param {OpenPullRow[]} candidates
 * @param {(ms: number) => Promise<void>} sleep
 */
const readMergeable = async (reader, candidates, sleep) => {
  /** @type {PullRequestRow[]} */
  const settled = [];
  /** @type {Checked[]} */
  const failed = [];
  let pending = candidates.map((p) => p.number);
  for (let read = 0; read < CONFLICT_READS && pending.length > 0; read += 1) {
    if (read > 0) await sleep(CONFLICT_WAIT_MS);
    const rows = await Promise.all(pending.map(async (number) => {
      try {
        return { number, pr: await reader.pullRequest(number) };
      } catch (error) {
        return { number, error: messageOf(error) };
      }
    }));
    /** @type {number[]} */
    const again = [];
    for (const row of rows) {
      if (row.pr === undefined) {
        failed.push({ pr: row.number, outcome: 'failed', reason: null, error: row.error ?? null });
      } else if (row.pr.state === 'open' && !row.pr.draft) {
        if (row.pr.mergeable === null) again.push(row.number);
        else settled.push(row.pr);
      }
    }
    pending = again;
  }
  return { settled, unsettled: pending, failed };
};

/**
 * One conflicted PR: recorded, then its owner told, with the fallback. The
 * record comes first, so a turn that dies sending leaves no second message
 * for the next read of the same merge.
 *
 * @param {{ pr: PullRequestRow, text: string, fallback: import('./webhook/fire.mjs').Fallback, record: (pr: number) => Promise<boolean>, deliver: import('./deliveries.mjs').Deliveries['deliver'] }} args
 * @returns {Promise<Checked>}
 */
const tell = async ({ pr, text, fallback, record, deliver }) => {
  const checked = { pr: pr.number, reason: null, error: null };
  try {
    if (!await record(pr.number)) return { ...checked, outcome: 'already-told', reason: `#${pr.number} was told of this merge already` };
  } catch (error) {
    return { ...checked, outcome: 'failed', error: `could not record #${pr.number} told, so told nobody: ${messageOf(error)}` };
  }
  /** @type {import('./deliveries.mjs').Delivery} */
  let sent;
  try {
    sent = await deliver({ pr: pr.number }, text, { source: GITHUB_SOURCE, fallback, takeover: true, on: [pr.number] });
  } catch (error) {
    // A send past its budget, or a GitHub read in the fallback, throws: this
    // PR's check fails, and the PRs after it are still told.
    return { ...checked, outcome: 'failed', error: `recorded #${pr.number} told, but the send threw: ${messageOf(error)}` };
  }
  if (sent.skipped !== null) return { ...checked, outcome: 'no-owner', reason: sent.skipped };
  if (sent.ok) return { ...checked, outcome: 'told' };
  if (sent.refused && sent.fallback !== null && sent.fallback.outcome !== 'failed') return { ...checked, outcome: 'fallback', reason: `the owner was archived: ${sent.fallback.outcome}` };
  return { ...checked, outcome: 'failed', error: sent.error ?? `the owner was archived, and its fallback ${sent.fallback?.outcome ?? 'never ran'}` };
};

/**
 * Check every open PR into the default branch after `merged` moved it,
 * the branch the fire names, and tell the conflicted ones' sessions.
 *
 * @param {{
 *   invocation: ConflictsFire,
 *   reader: ConflictsReader,
 *   sleep: (ms: number) => Promise<void>,
 *   record: (pr: number) => Promise<boolean>,
 *   deliver: import('./deliveries.mjs').Deliveries['deliver'],
 *   inTime: () => boolean,
 *   prompts?: Readonly<Record<string, string | undefined>>,
 * }} args
 *   `record`: the PR told of this merge, false where a record stood.
 *   `prompts`: the repo's config file's.
 *   `inTime`: whether another send fits before the deadline.
 * @returns {Promise<{ head: string, checks: Checked[] }>}
 */
export const checkConflicts = async ({ invocation: merged, reader, sleep, record, deliver, inTime, prompts = {} }) => {
  const { base } = merged;
  const head = await reader.branchHead(base);
  const candidates = (await reader.openPulls()).filter((p) => !p.draft && p.base === base);
  const { settled, unsettled, failed } = await readMergeable(reader, candidates, sleep);
  /** @type {Checked[]} */
  const checks = [
    ...failed,
    ...unsettled.map((pr) => ({ pr, outcome: /** @type {const} */ ('skipped'), reason: `GitHub had not computed #${pr}'s mergeable state after ${CONFLICT_READS} reads: not taken for a conflict`, error: null })),
  ];
  for (const pr of settled) {
    if (pr.mergeable) continue;
    if (!SUMMONERS.has(pr.association)) {
      checks.push({ pr: pr.number, outcome: 'skipped', reason: `#${pr.number} conflicts, but is by a ${pr.association} author, for whom the dispatcher does not act: a person tells it`, error: null });
      continue;
    }
    // Unrecorded, so the PR is owed: the exit code says so.
    if (!inTime()) {
      checks.push({ pr: pr.number, outcome: 'failed', reason: null, error: `#${pr.number} conflicts, and was not told: out of time, another delivery might outrun the deadline` });
      continue;
    }
    const { text, fallback } = conflictMessage({ pr, base, head, merged }, prompts);
    checks.push(await tell({ pr, text, fallback, record, deliver }));
  }
  return { head, checks };
};
