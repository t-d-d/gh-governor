/**
 * The launcher: one launch, CLI or routine, its session record, and the
 * pages a launch sends where it may have started a session nobody can name.
 *
 * dispatch/turn.mjs builds one launcher a turn ({@link launcher}) and hands
 * its `start` to every caller that starts a session. This module imports
 * nothing from turn.mjs; turn.mjs imports it. A test of any outcome needs
 * one fake launch and one fake record write (test/dispatch-launcher.test.ts),
 * and the outcomes a whole turn sees stay pinned by the table in
 * test/dispatch-turn.test.ts.
 */

import { launchOutcome } from '../scripts/lib/dispatch-prompt.mjs';
import { readStoredLogin } from '../scripts/lib/claude-login.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { launchRoutine, observed, routineName } from './routines.mjs';
import { OUTPUT_TAIL } from './deliveries.mjs';

/**
 * A session governor started that its state table does not record: the
 * PR review would let a ticket's mode label waive a human-only path for it.
 * Its own alarm pages on it (infra/governor.cfn.yml).
 */
export const SESSION_UNRECORDED = 'dispatch-session-unrecorded';

/** A session a launch its budget refused printed after all, which ties it to that refusal's page. */
export const SESSION_LATE = 'dispatch-session-late';

/**
 * A session record still being written: dispatch/cli.mjs logs each one
 * left as {@link SESSION_UNRECORDED} when the deadline ends the turn or the
 * turn throws.
 *
 * @typedef {{ repo: string, sessionName: string, sessionUrl: string }} PendingRecord
 */

/**
 * @typedef {{ prompt: string, sessionName: string, model: string, repo: string, environment: string, connectors?: string[], branch?: string }} Launch
 *   `repo`, `environment`: the repo the session is for and its cloud
 *   environment, from the repo's config file. `branch`: the branch the
 *   session starts on and pushes to, a PR's head for a takeover, in place
 *   of the default branch (dispatch/launch-session.py). `connectors`: a periodic's
 *   claude.ai connectors, which start it as a run of its routine
 *   (dispatch/routines.mjs), the periodic named by `sessionName`.
 * @typedef {{ status: number | null, output: string, missing?: string[], refused?: true, routine?: string }} LaunchResult
 *   `missing`: the connectors a routine launch named that the account has
 *   not connected. It started nothing. `refused`: the routines API refused
 *   a routine launch before the fire. It started nothing. `routine`: the id
 *   of the routine a routine launch fired, through which its run session is
 *   found.
 * @typedef {(event: string, context?: Record<string, unknown>) => void} Log
 */

/**
 * @typedef {{ writes: Promise<void>[], ended: boolean }} Records
 *   `writes`: each launch's record. `ended`: whether the turn has
 *   stopped waiting for them, after which nothing waits for a new one.
 */

/**
 * The {@link SESSION_UNRECORDED} line for a record that did not land, from
 * the turn's own catch or from dispatch/cli.mjs when the turn is cut off.
 * The reason matters to whoever reads the line.
 *
 * @param {PendingRecord} pending
 * @param {string} error
 */
export const unrecordedLine = (pending, error) => ({ level: 'error', ...pending, error, reason: 'its PRs may clear a human-only path on a ticket\'s mode label' });

/**
 * The session URL the launcher's output names, or null. The CLI prints the
 * URL on creation and the id on the "Resume with:" line; either will do.
 *
 * @param {string} output
 * @returns {string | null}
 */
export const sessionUrlFrom = (output) => {
  const url = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/.exec(output)?.[0];
  if (url) return url;
  const id = /\bsession_[A-Za-z0-9]{4,}\b/.exec(output)?.[0];
  return id ? `https://claude.ai/code/${id}` : null;
};

/**
 * A periodic that names connectors, as a run of its routine
 * (dispatch/routines.mjs), under the login's token and organization. A
 * token the turn cannot use started nothing.
 *
 * @param {{
 *   secret: { get: () => Promise<string> },
 *   token: () => Promise<string>,
 *   routines: (token: string, organization: string | null) => import('./routines.mjs').RoutinesApi,
 *   log: Log,
 *   sleep: (ms: number) => Promise<void>,
 *   uuid: () => string,
 * }} deps `token`: the login's access token for the routines API, read once a turn.
 * @returns {(begin: Launch, connectors: string[]) => Promise<LaunchResult>}
 */
export const routineLaunch = (deps) => async (begin, connectors) => {
  /** @type {import('./routines.mjs').RoutinesApi} */
  let api;
  try {
    const { account } = readStoredLogin(await deps.secret.get());
    api = observed(deps.routines(await deps.token(), account?.organizationUuid ?? null), deps.log, { repo: begin.repo, periodic: begin.sessionName });
  } catch (error) {
    return { status: 1, output: messageOf(error) };
  }
  const result = await launchRoutine({ api, repo: begin.repo, periodic: begin.sessionName, prompt: begin.prompt, environment: begin.environment, model: begin.model, connectors, sleep: deps.sleep, uuid: deps.uuid });
  deps.log('dispatch-routine-output', { repo: begin.repo, periodic: begin.sessionName, status: result.status, tail: result.output.slice(-OUTPUT_TAIL) });
  // Nothing started for any other reason than a missing connector is the
  // routines API refusing the routine or its fire: the CLI is not at fault.
  return result.status === 1 && result.missing === undefined ? { ...result, refused: true } : result;
};

/**
 * A call under the launch budget, cut to what is left before `until`, as
 * dispatch/turn.mjs's `budgetedBy` builds it. `onOver` runs when the
 * budget refuses a call it started.
 *
 * @typedef {<T>(begin: () => Promise<T>, name: string, until?: number, onOver?: () => void) => Promise<T>} Budgeted
 */

/**
 * @typedef {{
 *   cli: (launch: Launch) => Promise<LaunchResult>,
 *   routine: (launch: Launch, connectors: string[]) => Promise<LaunchResult>,
 *   recordSession: (sessionUrl: string) => Promise<void>,
 *   suffix: (repo: string) => string,
 *   budgeted: Budgeted,
 *   fireRepo?: string | undefined,
 *   environment: (repo: string) => string,
 *   records: Records,
 *   pending?: Set<PendingRecord> | undefined,
 *   log: Log,
 * }} LauncherDeps
 *   `cli`: a launch through `claude --cloud`. `routine`: one through the
 *   periodic's routine ({@link routineLaunch}). `recordSession`: the state
 *   table's session record. `suffix`: what follows every prompt,
 *   `SIGN_POSTS` and then, in a repo whose file turns `waits` on,
 *   `WAIT_PROMPT`. `budgeted`: the turn's launch budget, which its message
 *   sends and the PR review's model run spend too. `fireRepo`: the fire's
 *   repo, where a launch naming none starts; the bare schedule fire names
 *   none. `environment`: a served repo's cloud environment, from its config
 *   file. `records`: the turn's record writes, which it waits for
 *   before it ends. `pending`: the records still being written, shared with
 *   dispatch/cli.mjs, which logs each one left at the deadline or a throw.
 *
 * @typedef {Omit<Launch, 'repo' | 'environment'> & Partial<Pick<Launch, 'repo' | 'environment'>>} Asked
 *   A launch as its caller asks for it: in the fire's repo and that repo's
 *   environment unless it names its own.
 * @typedef {{ outcome: import('./deliveries.mjs').LaunchOutcome, sessionUrl: string | null, status: number | null, output: string, missing?: string[], refused?: true }} Started
 *   What came of a launch, and the URL where the launcher printed one and
 *   did not fail.
 * @typedef {{ start: (launch: Asked, until?: number) => Promise<Started> }} Launcher
 *   `until`: when the budget the launch shares with other calls runs out.
 */

/**
 * Every launch, recorded as governor's own session wherever the launcher
 * printed one, whatever outcome it reported, and paged where it may have
 * started one it did not print: the PR review reads the
 * record back, and a ticket's mode label waives no human-only path for a
 * session nobody watched. A record that fails is an error, not a turn
 * that fails: the session is running either way. The record spends none
 * of the launch's budget, so a slow one never turns a launch that started
 * into one tried again; the turn waits for every record before it ends.
 * Every prompt ends in `SIGN_POSTS`, which no repo's prompts replace: the
 * receiver skips a session's own posts only where the session signed them.
 * In a repo whose file turns `waits` on, the line on making a ticket wait
 * follows it (`WAIT_PROMPT`, dispatch/waits.mjs).
 * A launch runs under the turn's budget (`budgeted`), cut to `until`.
 * One its budget refuses pages once, at the refusal, since the launcher
 * runs on: the budget calls the page back. A session it prints later is
 * logged at info with its name and URL, so the operator can tie it to that
 * page, and recorded.
 * The turn waits for that record while it is still waiting for others.
 * Once it has ended, nothing waits for it, so it pages again, naming the
 * session, before the write is tried.
 *
 * @param {LauncherDeps} deps
 * @returns {Launcher}
 */
export const launcher = (deps) => {
  const { records } = deps;
  const unrecorded = deps.pending ?? new Set();
  /**
   * The launch itself, and its record or page once it ends.
   *
   * @param {Launch} begin
   * @param {() => boolean} paged Whether its budget already paged on it.
   * @returns {Promise<LaunchResult & { sessionUrl: string | null }>} `sessionUrl`:
   *   the one its output names, whatever its outcome.
   */
  const launchAndRecord = async (begin, paged) => {
    const launched = begin.connectors !== undefined && begin.connectors.length > 0 ? await deps.routine(begin, begin.connectors) : await deps.cli(begin);
    const sessionUrl = sessionUrlFrom(launched.output);
    if (sessionUrl !== null) {
      /** @type {PendingRecord} */
      const pending = { repo: begin.repo, sessionName: begin.sessionName, sessionUrl };
      if (paged()) {
        const record = records.ended ? 'its turn has ended, so nothing waits for its record' : 'the turn waits for its record';
        deps.log(SESSION_LATE, { level: 'info', ...pending, reason: `the launch ran past its budget and paged with no session URL; this is the session it started: ${record}` });
      }
      if (records.ended) {
        // Nothing waits for the write, and the task may exit before it
        // lands, so it pages now, naming the session. It is still tried.
        deps.log(SESSION_UNRECORDED, unrecordedLine(pending, 'the launcher printed it after its turn had ended, so nothing waits for its record and it may not land'));
        void deps.recordSession(sessionUrl).catch(() => {});
      } else {
        unrecorded.add(pending);
        records.writes.push((async () => deps.recordSession(sessionUrl))().catch((error) => {
          deps.log(SESSION_UNRECORDED, unrecordedLine(pending, messageOf(error)));
        }).finally(() => { unrecorded.delete(pending); }));
      }
    } else if (!paged() && launchOutcome(launched.status) !== null) {
      // The launch may have started a session but named none, so nothing
      // can record it: the operator finds it by its name and the line's time.
      // A routine's run session is found through its routine, not by the
      // periodic's name, so a routine launch's line names the routine.
      const routine = launched.routine === undefined ? {} : {
        routine: launched.routine,
        routineName: routineName(begin.repo, begin.sessionName),
        tail: launched.output.slice(-OUTPUT_TAIL),
      };
      const reason = launched.routine === undefined
        ? 'the launch may have started a session, but it printed no session URL, so the session could not be named or recorded: its PRs may clear a human-only path on a ticket\'s mode label'
        : 'the routine was fired, but none of its run sessions could be named as this fire\'s, so the session could not be named or recorded: look in the routine\'s run sessions for one started shortly before this line\'s time. Its PRs may clear a human-only path on a ticket\'s mode label';
      deps.log(SESSION_UNRECORDED, { level: 'error', repo: begin.repo, sessionName: begin.sessionName, sessionUrl: null, status: launched.status, ...routine, reason });
    }
    return { ...launched, sessionUrl };
  };
  /** @type {Launcher['start']} */
  const start = async (asked, until) => {
    const repo = asked.repo ?? deps.fireRepo;
    if (repo === undefined) throw new Error(`the bare fire names no repo to start ${asked.sessionName} in`);
    const environment = asked.environment ?? deps.environment(repo);
    const begin = { ...asked, repo, environment, prompt: `${asked.prompt}\n\n${deps.suffix(repo)}` };
    let paged = false;
    const onOver = () => {
      paged = true;
      deps.log(SESSION_UNRECORDED, { level: 'error', repo: begin.repo, sessionName: begin.sessionName, sessionUrl: null, reason: 'the launch ran past its budget and may have started a session, so the session could not be named or recorded: its PRs may clear a human-only path on a ticket\'s mode label' });
    };
    const { status, output, missing, refused, sessionUrl } = await deps.budgeted(() => launchAndRecord(begin, () => paged), begin.sessionName, until, onOver);
    const outcome = launchOutcome(status) ?? 'failed';
    return { outcome, sessionUrl: outcome === 'failed' ? null : sessionUrl, status, output, ...(missing === undefined ? {} : { missing }), ...(refused === undefined ? {} : { refused }) };
  };
  return { start };
};
