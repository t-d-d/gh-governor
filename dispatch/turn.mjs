/**
 * The dispatcher's turn: starts Claude Code cloud sessions from a stored
 * claude.ai login, off any machine of ours.
 *
 * One task is one turn (dispatch/cli.mjs is the entrypoint): restore the
 * login from Secrets Manager into the CLI's credential file, read the fire
 * (dispatch/webhook/fire.mjs) and decide what to start
 * (scripts/lib/dispatch-router.mjs), run the launcher once per session
 * (dispatch/launch-session.py, the same pseudo-terminal launcher the
 * Mac runs), claiming each ticket before its launch, leave a marker
 * comment with the session URL on each ticket,
 * write each served repo's heartbeat, and put the login back in the secret if
 * the CLI refreshed it. A `message` turn restores the login the same way
 * and sends text into a cloud session that already exists (`claude -p
 * --cloud <session>`, the text on stdin), which needs no pseudo-terminal;
 * the owner's message of a merge into main first gains the tickets the PR's
 * closed issues blocked, and a fallback when one waits on it
 * (dispatch/handoff.mjs);
 * a session that refuses (the CLI answers it archived) gets
 * the message's fallback, if it carries one, started as a fresh session
 * through the launcher, which rewrites the PR body's session link to it and
 * leaves the dispatch marker on the PR. The body is the address: the
 * receiver messages the session it names. The marker is the forwarding
 * address when the rewrite failed or the launch printed no URL: the next
 * refusal on that PR inside the window messages the session the marker
 * names instead of starting a third. Whom a message reaches and what a
 * refusal does is dispatch/deliveries.mjs; each kind plans, then delivers
 * each note through it.
 * A `workflow` turn sends the same way: a red run on the default branch, told to the
 * session of each PR it is about, once for all its PRs (dispatch/workflow.mjs),
 * a red main with the fallback, a red deploy without; a red main with several
 * suspect PRs instead starts one fresh session that owns the fix. A `job`
 * turn, for a shipping job that succeeded on the default branch, first labels
 * the tickets it shipped with the label its name carries, then
 * tells their sessions. Both read one account of what the fire covers
 * (dispatch/coverage.mjs). A turn that planned its news moves its
 * label's cursor under its workflow in the state table after its sends;
 * a refused turn leaves it, so the next job covers the
 * refused one.
 * A `branch-run` turn sends a finished run dispatched on a branch to the
 * session that wrote the commit it ran on, or the local session holding the
 * branch, with no fallback (dispatch/branch-run.mjs).
 * A `conflicts` turn follows a merge into the default branch: it reads every open PR's
 * mergeable state and messages each conflicted one's owner session, with
 * the fallback, naming the merge and main's commit; a conditional record in
 * the state table tells each PR of a merge once (dispatch/conflicts.mjs).
 * A `review` turn runs the repo's checklist (its file's `review.checklist`)
 * over a PR into its default branch, or every open one, as the
 * system prompt of a `claude -p` run under the same login, and merges,
 * approves or comments on its answer as the repo's `review` settings say
 * (dispatch/review.mjs, the checklist in dispatch/checklist.mjs); the
 * comment is the record, and the receiver turns a fail an edit meets and a
 * conflict into a message fire for the session the PR names, with its
 * fallback. No run holds a merge. Each run's
 * transcript goes to the drop box the stack names, if any.
 * Every fire but the bare schedule fire names its repo: the turn
 * mints its GitHub token for that repo, reads its config file
 * (dispatch/repo-config.mjs) and refuses a kind the file does not turn on.
 * The bare schedule fire lists the App's installations on the stack's
 * owners and serves each repo whose file reads valid (dispatch/repos.mjs):
 * one queue over every served repo's ready tickets, each claimed with its
 * repo's labels and launched in its repo's cloud environment.
 * Every turn but a probe ends with the sign-off sweep: it archives each
 * idle session in a served repo (the fire's, or every one for the bare
 * schedule fire) whose last reply, read from its own events, ends
 * `Signing off.`; a turn that messaged sessions first waits, on a quiet fire
 * lane, for their replies (scripts/lib/session-signoff.mjs).
 * A PR whose body names no session was raised from a local session, which
 * cannot learn its own link: a message fire on it carries
 * `byBranch`, and a workflow turn reaches it the same way. The turn asks the
 * sessions API, under the stored login, for the live session holding the
 * PR's head branch (scripts/lib/session-branch.mjs); with none, nobody is
 * told.
 * A refresh rotates the refresh token, so two turns refreshing the same
 * login would leave one of them dead: the schedule's spacing keeps them
 * apart, and a by-hand run waits for a fire to finish (scripts/run-turn.mjs).
 *
 * `run` is the turn with every I/O injected; `realDeps` binds the real ones.
 * The image (dispatch/Dockerfile) carries the scripts/ modules this turn
 * imports, unbundled: the selection, the prompts and the heartbeat's format
 * are the repo's modules, not copies.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { ConditionalCheckFailedException, DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DEFAULT_MODEL, launchOutcome } from '../scripts/lib/dispatch-prompt.mjs';
import { parseLogin, describeLogin, refreshExpiring, readStoredLogin, storedLogin } from '../scripts/lib/claude-login.mjs';
import { ARCHIVE_TIMEOUT_MS, accessToken, awaitReplies, sweepSignoffs } from '../scripts/lib/session-signoff.mjs';
import { branchFinder, sessionRecord, sessionRow, sessionRows } from '../scripts/lib/session-branch.mjs';
import { planSchedule } from '../scripts/lib/dispatch-router.mjs';
import { appInstallations, githubReader, installationToken } from '../scripts/lib/github-app.mjs';
import { repoServed, servedRepos } from './repos.mjs';
import { CONFIG_PATH, switchOf, turnsOn } from './repo-config.mjs';
import { planWorkflow, redRunPrompt } from './workflow.mjs';
import { STALE_RUNS_PAUSES_MS, baselineIn, freshRuns } from './runs.mjs';
import { coverageOf } from './coverage.mjs';
import { planBranchRun } from './branch-run.mjs';
import { checkConflicts } from './conflicts.mjs';
import { blockedBy, handoffFallback, handoffText, unreadText } from './handoff.mjs';
import { cliJudge } from './checklist.mjs';
import { reviewPull } from './review.mjs';
import { sessionId } from './webhook/subscribe.mjs';
import { DEFAULT_SESSION_NAME, DELIVER_LAUNCHES, OUTPUT_TAIL, deliveries as turnDeliveries, fromDispatcher, refusedAsArchived } from './deliveries.mjs';
import { RED, dispatchMarker, ownersOf, parseFire } from './webhook/fire.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { stampLastRun } from './heartbeat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The event a claimed ticket with no session-naming marker logs, here and at
 * the deadline (dispatch/cli.mjs). Its own alarm pages on it
 * (infra/governor.cfn.yml).
 */
export const CLAIM_STRANDED = 'dispatch-claim-stranded';

/**
 * The event a repo whose launch started nothing logs: the fire skips the
 * rest of its tickets. Its own alarm pages on it (infra/governor.cfn.yml).
 */
export const REPO_SKIPPED = 'dispatch-repo-skipped';

/**
 * A heartbeat the repo's file names an issue for, refused because the
 * issue's body lacks the marker. Logged as an error and not
 * alarmed: the repo's own watchdog reports the lapse that follows.
 */
export const HEARTBEAT_REFUSED = 'dispatch-heartbeat-refused';

/**
 * A heartbeat whose issue could not be read or written. Logged as an error,
 * and the turn fails once every other repo's heartbeat has gone.
 */
export const HEARTBEAT_UNWRITTEN = 'dispatch-heartbeat-unwritten';

/**
 * A claim's key, `owner/name#number`, as the repo and issue it names.
 *
 * @param {string} key
 * @returns {{ repo: string, issue: number }}
 */
export const ticketOf = (key) => {
  const at = key.lastIndexOf('#');
  return { repo: key.slice(0, at), issue: Number(key.slice(at + 1)) };
};

/** What a turn's login warnings tell the operator to run. */
const REMINT = 're-mint: node scripts/mint-claude-login.mjs';

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
 * @typedef {import('./deliveries.mjs').OpenRow} OpenRow
 * @typedef {{ prompt: string, sessionName: string, model: string, repo: string, environment: string }} Launch
 *   `repo`, `environment`: the repo the session is for and its cloud
 *   environment, from the repo's config file.
 * @typedef {{ status: number | null, output: string }} LaunchResult
 * @typedef {import('../scripts/lib/dispatch-router.mjs').Reader & import('./workflow.mjs').WorkflowReader & {
 *   comment: (n: number, body: string) => Promise<void>,
 *   pull: (n: number) => Promise<{ number: number, body: string, head: string }>,
 *   updatePull: (n: number, change: { body: string }) => Promise<void>,
 *   issue: (n: number) => Promise<{ number: number, body: string, pull: boolean }>,
 *   updateIssue: (n: number, change: { body: string }) => Promise<void>,
 *   openPulls: () => Promise<import('../scripts/lib/github-app.mjs').OpenPullRow[]>,
 *   branchHead: (branch: string) => Promise<string>,
 *   openNaming: (term: string) => Promise<OpenRow[]>,
 *   commit: (sha: string) => Promise<{ sha: string, message: string, parents?: string[] }>,
 *   addLabels: (n: number, labels: string[]) => Promise<void>,
 *   removeLabel: (n: number, label: string) => Promise<void>,
 *   ensureLabel: (name: string) => Promise<void>,
 *   defaultBranch: () => Promise<string>,
 * } & import('./review.mjs').ReviewReader} Reader
 *
 * @typedef {{
 *   owners: readonly string[],
 *   installations: () => Promise<Array<{ account: string, repos: string[] }>>,
 *   configFile: (repo: string, token: string, path?: string) => Promise<string | null>,
 *   environments: (token: string, organization: string | null) => Promise<unknown>,
 *   refreshLogin: () => Promise<LaunchResult>,
 *   cap: number,
 *   now: () => number,
 *   log: (event: string, context?: Record<string, unknown>) => void,
 *   secret: { get: () => Promise<string>, put: (text: string) => Promise<void> },
 *   githubToken: (repo: string) => Promise<string>,
 *   appId: () => Promise<number>,
 *   reader: (token: string, appId: number, repo: string) => Reader,
 *   workspace: {
 *     prepare: (repo?: string) => void,
 *     writeLogin: (text: string) => void,
 *     readLogin: () => string | null,
 *     useAccount: (account: import('../scripts/lib/claude-login.mjs').LoginAccount | null) => void,
 *   },
 *   launch: (launch: Launch) => Promise<LaunchResult>,
 *   launchTimeoutMs?: number,
 *   probe: () => Promise<{ ok: boolean, detail: string }>,
 *   message: (message: { session: string, text: string }) => Promise<LaunchResult>,
 *   review: (run: { system: string, prompt: string, schema: object }) => Promise<LaunchResult>,
 *   transcript: (run: { sessionId: string, pr: number }) => Promise<{ key: string } | { skipped: string }>,
 *   sleep: (ms: number) => Promise<void>,
 *   archive: import('../scripts/lib/session-signoff.mjs').Archive,
 *   fires?: import('../scripts/lib/session-signoff.mjs').Fires | undefined,
 *   sessions: { list: (token: string, after?: string) => Promise<unknown>, get: (id: string, token: string) => Promise<unknown>, events: import('../scripts/lib/session-signoff.mjs').Events },
 *   state: DispatchState,
 *   claims?: Set<string> | undefined,
 * }} Deps
 *   `owners`: the stack's owner list. The stack names no repo: every fire
 *   but the bare schedule fire names its own, and the bare one
 *   sweeps the served repos.
 *   `workspace.prepare`: the turn's own working directory, a checkout-less
 *   copy of the fire's repo, or of none for the bare schedule fire.
 *   `installations`: the App's installations and their repos.
 *   `configFile`: a repo's config file text on its default branch, or a
 *   prompt file's at `path` beside it, null when it has none; any other
 *   failure throws.
 *   `environments`: the login's cloud environment list, parsed, under its
 *   access token and organization; any refusal throws.
 *   `refreshLogin`: one minimal CLI call under the restored login, which
 *   refreshes it when its access token has expired.
 *   `sessions`: the sessions API the CLI lists and teleports with, each
 *   answer parsed; a session it does not have is null, any other refusal throws.
 *   `events` is a page of one session's events; any refusal throws.
 *   `state`: the dispatcher's state table ({@link dynamoState}).
 *   `claims`: the tickets the turn claimed that no marker naming a session
 *   covers yet, each `owner/name#number`, shared with dispatch/cli.mjs, whose deadline unwinds
 *   nothing and logs what is left in it.
 *   `fires`: the fire lane ({@link sqsFires}); without it, a turn never
 *   waits for replies.
 *
 * @typedef {{
 *   cursor: (repo: string, workflow: string, label: string | null) => Promise<import('./runs.mjs').Cursor | null>,
 *   advance: (repo: string, workflow: string, label: string | null, cursor: import('./runs.mjs').Cursor) => Promise<boolean>,
 *   delivered: (repo: string, workflow: string, label: string | null, from: number | null) => Promise<Delivered>,
 *   record: (repo: string, workflow: string, label: string | null, from: number | null, delivered: Delivered) => Promise<void>,
 *   recordConflict: (repo: string, pr: number, merge: string) => Promise<boolean>,
 * }} DispatchState
 *   Each label's cursor, by its repo, its workflow's file name and the
 *   label (null for CI's, which earns none): read (null when it has none),
 *   and moved forward (false when a cursor at or past it already stood).
 *   What the turns that started from one cursor (`from`, its run id, null
 *   for none) delivered while it was held: read (empty when none), and
 *   merged into. That PR `pr` of `repo` was told of the conflict
 *   merge `merge` left it in: recorded, false where a record stood.
 *   A read or write that fails throws.
 *
 * @typedef {{ told: string[], failed: string[] }} Delivered
 *   `told`: each PR whose session heard it, as `<pr> <session>`. `failed`:
 *   a session per send to it that failed, so a session's count is its tries.
 *
 * @typedef {{ repo: string, issue: number | null, outcome: 'dispatched' | 'unconfirmed' | 'failed', sessionUrl: string | null }} Dispatched
 */

/**
 * How many issues one schedule fire may dispatch: the stack's DispatchCap,
 * two when unset. `0` is a count (a fire that reads the backlog, writes the
 * heartbeat and starts nothing), and anything that is not a count is a
 * misconfiguration, said so rather than read as the default. Above two,
 * SCHEDULE_LAUNCH_WINDOW_MS may stop a slow fire short of the cap.
 *
 * @param {string | undefined} raw
 * @returns {number}
 */
export const dispatchCap = (raw) => {
  if (raw === undefined || raw === '') return 2;
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 0) throw new Error(`DISPATCH_CAP needs a non-negative integer, got: ${raw}`);
  return cap;
};

/**
 * Put a refreshed login back, with the account it was stored beside, unless
 * the CLI marked it dead, in which case the secret keeps the login it had
 * and the log says so.
 *
 * @param {Deps} deps
 * @param {string} original
 * @param {import('../scripts/lib/claude-login.mjs').LoginAccount | null} account
 * @returns {Promise<boolean>}
 */
const storeIfRefreshed = async (deps, original, account) => {
  const after = deps.workspace.readLogin();
  if (after === null || after === original) return false;
  const parsed = parseLogin(after);
  if (!parsed.ok) {
    deps.log('dispatch-login-dead', { reason: parsed.reason });
    return false;
  }
  await deps.secret.put(storedLogin(after, account));
  deps.log('dispatch-login-stored', { login: describeLogin(parsed.login) });
  return true;
};

/**
 * The stored login's access token after one minimal CLI call, which
 * refreshes an expired login as any call does. The login is
 * restored first, and the refresh goes back to the secret at once, so the
 * turn that restores it next starts from it: the refresh token rotates, and
 * the one the secret held no longer works. A call that fails, or leaves the
 * token expired, is the reason.
 *
 * @param {Deps} deps
 * @param {string} credentials
 * @param {import('../scripts/lib/claude-login.mjs').LoginAccount | null} account
 * @returns {Promise<{ token: string } | { reason: string }>}
 */
const refreshedLogin = async (deps, credentials, account) => {
  deps.workspace.prepare();
  deps.workspace.writeLogin(credentials);
  deps.workspace.useAccount(account);
  try {
    const begun = deps.refreshLogin();
    const { status, output } = await (deps.launchTimeoutMs === undefined ? begun : withinBudget(begun, deps.launchTimeoutMs, 'the login refresh'));
    deps.log('dispatch-login-refresh', { status, tail: output.slice(-OUTPUT_TAIL) });
  } catch (error) {
    deps.log('dispatch-login-refresh', { level: 'error', error: messageOf(error) });
  }
  // Stored even when the call failed: the CLI may have refreshed before it did.
  await storeIfRefreshed(deps, credentials, account);
  const usable = accessToken(deps.workspace.readLogin(), deps.now());
  return 'reason' in usable ? { reason: 'the access token has expired, and the CLI call that refreshes it did not (dispatch-login-refresh says why)' } : usable;
};

/**
 * A launch that outlives its budget is a thrown turn. The task's deadline
 * (dispatch/cli.mjs) exits the process from a timer, which unwinds nothing:
 * a login the CLI refreshed before the launcher hung would never reach the
 * secret. A throw runs the `finally` below first.
 *
 * @template T
 * @param {Promise<T>} launched
 * @param {number} ms
 * @param {string} sessionName
 * @returns {Promise<T>}
 */
const withinBudget = (launched, ms, sessionName) =>
  new Promise((resolveLaunch, rejectLaunch) => {
    const timer = setTimeout(() => rejectLaunch(new Error(`the launcher for ${sessionName} ran past ${ms} ms`)), ms);
    launched.then(
      (value) => { clearTimeout(timer); resolveLaunch(value); },
      (error) => { clearTimeout(timer); rejectLaunch(error); },
    );
  });

/**
 * One turn, then the sign-off sweep (scripts/lib/session-signoff.mjs): every
 * turn but a probe archives the sessions whose last turn signed off, in the
 * repos it serves, with the login as the turn leaves it. A fire naming a
 * repo that is not served does nothing, archiving included; one whose kind
 * the repo's file does not turn on restores the login and only sweeps. A turn that messaged sessions first waits
 * for their replies while no fire is queued (`awaitReplies`), so a sign-off
 * in reply to it is archived by it.
 *
 * @param {unknown} event The raw event: EventBridge's, or the by-hand script's.
 * @param {Deps} deps
 */
export const run = async (event, deps) => {
  const invocation = parseFire(event);
  if (invocation.kind === 'probe') return { kind: 'probe', ...(await deps.probe()) };
  const started = deps.now();
  /** One installation token a repo a turn. @type {Map<string, Promise<string>>} */
  const tokens = new Map();
  /** @param {string} repo */
  const tokenFor = (repo) => {
    let token = tokens.get(repo);
    if (token === undefined) tokens.set(repo, token = deps.githubToken(repo));
    return token;
  };
  /** The stored login's text, read once a turn and kept as the turn puts it back: a read straight after a write need not see it. @type {Promise<string> | null} */
  let secretText = null;
  /** @type {Deps['secret']} */
  const secret = {
    get: () => (secretText ??= deps.secret.get()),
    put: async (text) => {
      await deps.secret.put(text);
      secretText = Promise.resolve(text);
    },
  };
  /** The login's environment list, read at most once a turn, and only for a file naming its environment. @type {Promise<unknown> | null} */
  let listed = null;
  /**
   * The refresh's store-back or restore that failed. The refresh
   * rotated the login the secret holds out, so the turn ends here rather
   * than restore it over the one on disk: a repo's unread list would not.
   * @type {unknown}
   */
  let refreshFailed = null;
  // Under the stored login's token. One that has expired is refreshed first:
  // only a CLI run refreshes it, and a turn for such a repo alone
  // may run none before the list is needed.
  const environments = () => (listed ??= (async () => {
    const { credentials, account } = readStoredLogin(await secret.get());
    let usable = accessToken(credentials, deps.now());
    if ('reason' in usable) {
      usable = await refreshedLogin({ ...deps, secret }, credentials, account).catch((error) => {
        refreshFailed = error;
        throw error;
      });
    }
    if ('reason' in usable) throw new Error(`cannot list the login's cloud environments: ${usable.reason}`);
    return deps.environments(usable.token, account?.organizationUuid ?? null);
  })());
  const reads = { owners: deps.owners, token: tokenFor, config: deps.configFile, environments, log: deps.log };
  // The bare schedule fire names no repo: it serves every repo it finds.
  // Any other fire names its repo, or parseFire refused it.
  const bare = invocation.kind === 'schedule' && invocation.repo === undefined;
  const repo = invocation.repo;
  /** @type {import('./repos.mjs').Served[]} */
  let served;
  /** @type {Array<{ repo: string, error: string }>} */
  let unread = [];
  /** @type {string | null} */
  let refusal = null;
  if (bare) {
    ({ served, unread } = await servedRepos({ ...reads, installations: deps.installations }));
    if (refreshFailed !== null) throw refreshFailed;
  } else {
    if (repo === undefined) throw new Error(`a ${invocation.kind} fire names no repo`);
    const one = await repoServed({ ...reads, repo });
    if (refreshFailed !== null) throw refreshFailed;
    if (one === null) return { kind: invocation.kind, refusal: `${repo} is not served`, signoffs: null };
    // A label the receiver could not judge: not one of the repo's
    // ready labels, the fire ends here, before the login and the sweep.
    if (invocation.kind === 'schedule' && invocation.label !== undefined && !one.config.labels.ready.includes(invocation.label)) {
      const reason = `${invocation.label} is not one of ${repo}'s ready labels (${one.config.labels.ready.join(', ')})`;
      deps.log('dispatch-refused', { level: 'info', repo, kind: invocation.kind, issue: invocation.issue, reason });
      return { kind: invocation.kind, refusal: reason, signoffs: null };
    }
    served = [one];
    const name = switchOf(invocation, one.config.workflows);
    if (name !== null && !turnsOn(one.config, name)) {
      refusal = `${repo}'s ${CONFIG_PATH} does not turn ${name} on`;
      deps.log('dispatch-refused', { level: 'info', repo, kind: invocation.kind, reason: refusal });
    }
  }
  /** The sessions this turn messaged, and when: a result from before is not the reply. @type {Map<string, number>} */
  const woken = new Map();
  /** One read of the sessions list a turn, per token. @type {Map<string, import('../scripts/lib/session-branch.mjs').FindOnBranch>} */
  const finders = new Map();
  /** @type {(token: string) => import('../scripts/lib/session-branch.mjs').FindOnBranch} */
  const finder = (token) => {
    let find = finders.get(token);
    // Only a fire naming its repo looks a session up by its branch.
    if (repo === undefined) throw new Error('the bare schedule fire names no repo to find a session in');
    if (find === undefined) finders.set(token, find = branchFinder({ list: (after) => deps.sessions.list(token, after), get: async (id) => sessionRecord(await deps.sessions.get(id, token)) }, repo, { log: deps.log }));
    return find;
  };
  const result = await turnFor(invocation, {
    ...deps,
    secret,
    githubToken: tokenFor,
    message: async (message) => {
      const session = sessionId(message.session);
      if (!woken.has(session)) woken.set(session, deps.now());
      const sent = await deps.message(message);
      // An archived session cannot reply: neither wait for it nor defer it.
      // A resend counts too: the first send may have blipped.
      if (refusedAsArchived(sent)) woken.delete(session);
      return sent;
    },
  }, finder, { served, bare, refusal, repo });
  // Read when called: a turn whose sweep skips never touches `sessions`.
  /** @type {import('../scripts/lib/session-signoff.mjs').Events} */
  const events = (id, token, cursor) => deps.sessions.events(id, token, cursor);
  await awaitReplies({ fires: deps.fires, woken, login: deps.workspace.readLogin(), started, now: deps.now, sleep: deps.sleep, log: deps.log, events });
  const signoffs = await sweepSignoffs({
    archive: deps.archive,
    login: deps.workspace.readLogin(),
    started,
    now: deps.now,
    log: deps.log,
    woken,
    repos: served.map((s) => s.repo),
    list: (token) => sessionRows((after) => deps.sessions.list(token, after), { log: deps.log }),
    lookup: sweepLookup(deps),
    events,
  });
  const left = [...unread, ...('unread' in result && Array.isArray(result.unread) ? result.unread : [])];
  return { ...result, ...(left.length === 0 ? {} : { unread: left }), signoffs };
};

/**
 * The sweep's read of a session: its row in the sessions list, read afresh
 * for each session and paged only until a page names it, else its own
 * record, unwrapped from `response_shape` (`sessionRecord`), which
 * then carries the list row's idle state (`worker_status` in newer
 * records, `session_status` in older ones). Afresh, since a read taken for an earlier
 * record may predate a prompt that set this session to work. It says which
 * it read: a refusal names the source.
 *
 * @param {Deps} deps
 * @returns {import('../scripts/lib/session-signoff.mjs').Lookup}
 */
const sweepLookup = (deps) => async (id, token) => {
  const listed = await sessionRow((after) => deps.sessions.list(token, after), id);
  return listed === undefined ? { row: sessionRecord(await deps.sessions.get(id, token)), from: 'record' } : { row: listed, from: 'list' };
};

/**
 * The turn itself, for the fire's repo, or every served repo for the bare
 * schedule fire.
 *
 * @param {import('./webhook/fire.mjs').Fire} invocation
 * @param {Deps} deps
 * @param {(token: string) => import('../scripts/lib/session-branch.mjs').FindOnBranch} finder
 * @param {{ served: import('./repos.mjs').Served[], bare: boolean, refusal: string | null, repo: string | undefined }} scope
 *   `repo`: the fire's, none for the bare schedule fire.
 */
const turnFor = async (invocation, deps, finder, { served, bare, refusal, repo }) => {
  if (invocation.kind === 'probe') throw new Error('a probe is not a turn: run answers it');
  /**
   * The fire's repo. The bare schedule fire names none, and reads
   * only the served repos it found; nothing falls back to a default repo.
   */
  const fireRepo = () => {
    if (repo === undefined) throw new Error(`the bare ${invocation.kind} fire names no repo`);
    return repo;
  };
  deps.workspace.prepare(repo);
  const { credentials: original, account } = readStoredLogin(await deps.secret.get());
  const parsed = parseLogin(original);
  if (!parsed.ok) throw new Error(`the stored login is not a login: ${parsed.reason}`);
  deps.workspace.writeLogin(original);
  // Without the ids each CLI call looks the org up with a profile fetch,
  // whose failure the CLI reports without its cause. Re-minting
  // stores them.
  if (account === null) deps.log('dispatch-login-lacks-ids', { remedy: REMINT });
  // The refresh expiry is fixed at mint: say so while there is time
  // to re-mint, before the CLI's refresh fails and the dispatcher stops.
  const expiring = refreshExpiring(parsed.login, deps.now());
  if (expiring !== null) deps.log('dispatch-login-expiring', { refreshExpiresAt: expiring.toISOString(), remedy: REMINT });
  deps.workspace.useAccount(account);
  if (refusal !== null) return { kind: invocation.kind, refusal };

  /**
   * A served repo's config: the fire's repo's, or, in the bare schedule
   * fire, each launch's.
   *
   * @param {string} repo
   */
  const configOf = (repo) => {
    const found = served.find((s) => s.repo.toLowerCase() === repo.toLowerCase());
    if (found === undefined) throw new Error(`${repo} is not a repo this turn serves`);
    return found.config;
  };

  /**
   * A call under the launch budget, cut to what is left before `until`
   * where the call is one of several sharing a budget. With nothing left
   * it is not started: a child left running past the store-back could
   * refresh the login after it was read.
   *
   * @template T
   * @param {() => Promise<T>} begin
   * @param {string} name
   * @param {number} [until]
   * @returns {Promise<T>}
   */
  const budgeted = async (begin, name, until) => {
    if (deps.launchTimeoutMs === undefined) return begin();
    const ms = Math.min(deps.launchTimeoutMs, (until ?? Infinity) - deps.now());
    if (ms <= 0) throw new Error(`no budget left to start ${name}: the calls sharing it used it up`);
    return withinBudget(begin(), ms, name);
  };

  /**
   * One session through the launcher: what came of it, and the URL where
   * the launcher printed one.
   *
   * In the fire's repo and its cloud environment unless the launch names
   * its own.
   *
   * @param {Omit<Launch, 'repo' | 'environment'> & Partial<Pick<Launch, 'repo' | 'environment'>>} launch
   * @param {number} [until] When the budget it shares runs out.
   * @returns {Promise<{ outcome: Dispatched['outcome'], sessionUrl: string | null, status: number | null }>}
   */
  const start = async (launch, until) => {
    const repo = launch.repo ?? fireRepo();
    const full = { ...launch, repo, environment: launch.environment ?? configOf(repo).environment };
    const { status, output } = await budgeted(() => deps.launch(full), launch.sessionName, until);
    const outcome = launchOutcome(status) ?? 'failed';
    return { outcome, sessionUrl: outcome === 'failed' ? null : sessionUrlFrom(output), status };
  };

  /** One reader a repo a turn. @type {Map<string, Reader>} */
  const readers = new Map();
  /**
   * The reader for `repo`, under its own installation token. The App the
   * token belongs to: the reader trusts a review marker only on its
   * comments.
   *
   * @param {string} repo
   */
  const readerFor = async (repo) => {
    let reader = readers.get(repo);
    if (reader === undefined) readers.set(repo, reader = deps.reader(await deps.githubToken(repo), await deps.appId(), repo));
    return reader;
  };
  const getReader = () => readerFor(fireRepo());

  /**
   * The sessions API under the login the turn restored. A token the turn
   * cannot use throws: no CLI has run yet to refresh it.
   *
   * @param {string} asking What the lookup is for, for the error.
   */
  const sessionsFinder = (asking) => {
    const usable = accessToken(deps.workspace.readLogin(), deps.now());
    if ('reason' in usable) throw new Error(`cannot ask ${asking}: ${usable.reason}`);
    return finder(usable.token);
  };

  // Whom a message reaches, and the send (dispatch/deliveries.mjs): each
  // send and launch under what is left of its delivery's budget.
  // The fire's repo's prompts (dispatch/prompts.mjs). The bare schedule fire
  // names no repo and sends no message.
  const prompts = repo === undefined ? {} : configOf(repo).prompts;
  /** @type {ReturnType<typeof turnDeliveries> | null} */
  let made = null;
  const delivery = () => (made ??= turnDeliveries({
    prompts,
    reader: getReader,
    repo: fireRepo(),
    send: (message, until) => budgeted(() => deps.message(message), message.session, until),
    launch: start,
    sessions: sessionsFinder,
    now: deps.now,
    log: deps.log,
    sleep: deps.sleep,
    launchTimeoutMs: deps.launchTimeoutMs,
  }));

  if (invocation.kind === 'message') {
    const { on, event, commit, closing } = invocation;
    let { text, fallback } = invocation;
    // The owner's message of a merge into main lists what the PR's closed
    // issues blocked, and a waiting hand-off falls back to a fresh session.
    // A read that fails still sends the message, saying so.
    if (invocation.merged === true && on !== undefined && turnsOn(configOf(fireRepo()), 'mergeHandoff')) {
      try {
        const { title, blocked } = await blockedBy({ pr: on, reader: await getReader(), repo: fireRepo() });
        const listed = handoffText(blocked, fireRepo(), prompts, configOf(fireRepo()).labels);
        const waiting = blocked.flatMap((b) => b.waiting.map((t) => t.number));
        deps.log('dispatch-handoff', { pr: on, closes: blocked.map((b) => b.closed), waiting, freed: blocked.flatMap((b) => b.freed.map((t) => t.number)) });
        if (listed !== null) text = `${text}\n\n${listed}`;
        if (waiting.length > 0 && fallback === undefined) fallback = handoffFallback({ pr: on, title, text, deploys: turnsOn(configOf(fireRepo()), 'deployMessages') });
      } catch (error) {
        deps.log('dispatch-handoff', { pr: on, error: messageOf(error) });
        text = `${text}\n\n${unreadText(messageOf(error), prompts)}`;
      }
    }
    /** @type {import('./deliveries.mjs').Delivery} */
    let told = { ok: false, answered: null, refused: false, sessionUrl: null, error: null, fallback: null, dropped: null, skipped: null };
    let loginStored = false;
    try {
      told = await delivery().deliver(
        'byBranch' in invocation ? { pr: invocation.on, ...(invocation.poster === undefined ? {} : { poster: invocation.poster }) } : { session: invocation.session },
        text,
        {
          fallback,
          takeover: true,
          on: on === undefined ? [] : [on],
          closing: closing === true,
          dropFrom: event === undefined || on === undefined ? [] : [on],
          commit,
        },
      );
    } finally {
      loginStored = await storeIfRefreshed(deps, original, account);
    }
    // The session is gone and nothing else was tried: the dispatcher reached
    // it with a live login, so the refusal is the caller's to read, not a
    // dispatcher failure (dispatch/cli.mjs). Any other answer with ok:false
    // (a revoked login, a 5xx), or a fallback that was tried, stays one.
    const archived = told.refused && told.fallback === null;
    return { kind: 'message', ...told, archived, loginStored };
  }

  // A red run on the default branch, or a shipping job that succeeded there: the PR(s)
  // it is about hear it in the session that wrote them and each subscribed
  // to it (dispatch/workflow.mjs), and a job's tickets get its label. Whom
  // nobody hears of, and why, is a `dispatch-workflow` line, or
  // `dispatch-stale-runs` when the runs list was stale.
  if (invocation.kind === 'workflow' || invocation.kind === 'job') {
    /** @type {Array<{ prs: number[], session: string } & Omit<import('./deliveries.mjs').Delivery, 'sessionUrl' | 'dropped' | 'skipped'>>} */
    const deliveries = [];
    /** @type {string | null} */
    let reason = null;
    /** @type {{ outcome: Dispatched['outcome'], sessionUrl: string | null } | null} */
    let triage = null;
    let loginStored = false;
    /** @type {Awaited<ReturnType<typeof labelTickets>>} */
    let labels = null;
    /** What became of the label's cursor, when the plan moved it. @type {{ moved: boolean } | { held: number } | { error: string } | null} */
    let cursor = null;
    const about = invocation.kind === 'job'
      ? { name: invocation.workflow, job: invocation.name, runId: invocation.runId, jobId: invocation.jobId, url: invocation.url, label: invocation.label, conclusion: 'success' }
      : { name: invocation.name, runId: invocation.runId, url: invocation.url, conclusion: invocation.conclusion };
    const started = deps.now();
    try {
      // One reading of what the fire covers feeds both the labels and the
      // messages: each read, and each wait on a stale runs list,
      // happens once per turn. Labels first: a send may run to the
      // task's deadline, and a label left behind it is never added, since
      // nothing backfills.
      const reader = await getReader();
      // Which run is CI, which targets triage, and each target's tag: the
      // repo's own (dispatch/repo-config.mjs).
      const config = configOf(fireRepo());
      const { workflows } = config;
      /** @type {import('./coverage.mjs').Coverage} */
      let coverage;
      try {
        coverage = await coverageOf({ invocation, reader, repo: fireRepo(), workflows, sleep: deps.sleep, cursor: (file, label) => deps.state.cursor(fireRepo(), file, label), onBranch: delivery().onBranch });
      } catch (error) {
        if (invocation.kind === 'job') deps.log('dispatch-labels', { ...about, error: messageOf(error) });
        throw error;
      }
      if (turnsOn(config, 'deployedLabels')) labels = await labelTickets(invocation, reader, coverage, deps, about);
      const plan = await planWorkflow({ invocation, coverage, prompts, workflows });
      reason = plan.reason;
      // What the range covers, before anything is sent: a wrong baseline is
      // read off this line. A refusal to plan from a stale runs list
      // is its own event, which governor-stale-runs pages on.
      if (plan.stale !== null) deps.log('dispatch-stale-runs', { ...about, newest: plan.stale.newest, reason });
      else if (plan.range !== null || reason !== null) deps.log('dispatch-workflow', { ...about, ...plan.range, ...(reason === null ? {} : { reason }) });
      for (const { pr, reason: why } of plan.unnamed) deps.log('dispatch-workflow', { ...about, pr, reason: why });
      // The cursor the plan moves is the label's under its workflow file,
      // both known once coverage read the run.
      const workflow = coverage.workflow ?? '';
      const label = coverage.label;
      // A turn that moves the cursor skips what earlier turns from the same
      // held cursor told, and a session that failed every try. The
      // range's own cursor: one at or past this run is not this range's, and
      // with none the range starts at its baseline, where a hold pins it.
      /** @type {import('./runs.mjs').Cursor | null} */
      let from = null;
      /** The cursor a hold writes: with none, this range's baseline, or the next run's fallback baseline would start past it. @type {import('./runs.mjs').Cursor | null} */
      let pin = null;
      /** @type {Delivered | null} A record that cannot be read refuses the sends, as a cursor that cannot does. */
      let before = { told: [], failed: [] };
      if (plan.advance !== null && plan.notes.length > 0) {
        try {
          const baseline = plan.range?.baseline ?? null;
          from = coverage.from;
          if (from === null && baseline !== null) from = pin = { runId: baseline.id, commit: baseline.commit, created: baseline.created };
          before = await deps.state.delivered(fireRepo(), workflow, label, from?.runId ?? null);
        } catch (error) {
          reason = `could not read what the range from run ${from?.runId ?? 'none'} has delivered: ${messageOf(error)}`;
          deps.log('dispatch-stale-runs', { ...about, reason });
          before = null;
        }
      }
      if (before !== null) {
        if (plan.triage !== null) {
          const launched = await start({ prompt: fromDispatcher(plan.triage.prompt), sessionName: plan.triage.sessionName, model: DEFAULT_MODEL });
          triage = { outcome: launched.outcome, sessionUrl: launched.sessionUrl };
          deps.log('dispatch-workflow', { ...about, triage, reason: 'no one session to tell: one fresh session owns the fix' });
        }
        // Keyed by session id: a session named by URL in one turn and by id in another is one session.
        const told = new Set(before.told.map((t) => t.replace(/ (.*)$/, (_, s) => ` ${sessionId(s)}`)));
        const failedIds = before.failed.map(sessionId);
        const tries = (/** @type {string} */ session) => failedIds.filter((s) => s === sessionId(session)).length;
        const toldOf = (/** @type {{ prs: number[], session: string }} */ n) => n.prs.map((pr) => `${pr} ${sessionId(n.session)}`);
        const owed = plan.notes.filter((n) => !toldOf(n).every((t) => told.has(t)) && tries(n.session) < WORKFLOW_SEND_TRIES);
        if (owed.length < plan.notes.length) deps.log('dispatch-workflow', { ...about, settled: plan.notes.filter((n) => !owed.includes(n)).map((n) => ({ session: n.session, prs: n.prs })), reason: 'told, or given up on, by an earlier turn' });
        /** @type {Delivered} */
        const now = { told: [], failed: [] };
        let untold = 0;
        for (const [i, note] of owed.entries()) {
          if (deps.now() - started > WORKFLOW_SEND_WINDOW_MS) {
            untold += owed.length - i;
            deps.log('dispatch-workflow', { ...about, untold: owed.slice(i).map((n) => ({ session: n.session, prs: n.prs })), reason: `out of time: past ${WORKFLOW_SEND_WINDOW_MS} ms, another delivery might outrun the deadline` });
            break;
          }
          const { ok, answered, refused, error, fallback } = await delivery().deliver({ session: note.session }, note.text, { fallback: note.fallback, on: note.prs, closing: note.closing, dropFrom: note.subscribed });
          deliveries.push({ prs: note.prs, session: note.session, ok, answered, refused, error, fallback });
          // As dispatch/cli.mjs counts a fault: a refusal with no fallback is a gone session, told enough.
          if (ok || (refused && fallback?.outcome !== 'failed')) {
            now.told.push(...toldOf(note));
          } else if (tries(note.session) + 1 < WORKFLOW_SEND_TRIES) {
            now.failed.push(sessionId(note.session));
            untold += 1;
          } else {
            // Recorded too: a cursor another note holds must not try it again.
            now.failed.push(sessionId(note.session));
            deps.log('dispatch-workflow', { ...about, session: note.session, prs: note.prs, reason: `gave up after ${WORKFLOW_SEND_TRIES} turns' sends failed` });
          }
        }
        // After the sends: a turn that dies sending leaves the cursor, and
        // the next run tells its range again rather than not at all. So does
        // a triage session that started nothing: its suspects were never told.
        // A note left untold holds it, and the record says what the range has
        // had, so the next run sends only the rest.
        if (plan.advance !== null && triage?.outcome !== 'failed' && untold > 0) {
          try {
            if (pin !== null) await deps.state.advance(fireRepo(), workflow, label, pin);
            await deps.state.record(fireRepo(), workflow, label, from?.runId ?? null, now);
            cursor = { held: untold };
          } catch (error) {
            cursor = { error: messageOf(error) };
          }
          deps.log('dispatch-workflow', { ...about, cursor: 'error' in cursor ? `held, but what was delivered is unrecorded: ${cursor.error}` : `held: ${untold} note(s) untold` });
        } else if (plan.advance !== null && triage?.outcome !== 'failed') {
          try {
            cursor = { moved: await deps.state.advance(fireRepo(), workflow, label, plan.advance) };
          } catch (error) {
            cursor = { error: messageOf(error) };
          }
          deps.log('dispatch-workflow', { ...about, cursor: 'error' in cursor ? `not moved: ${cursor.error}` : cursor.moved ? `moved to run ${plan.advance.runId}` : `a cursor at or past run ${plan.advance.runId} stood` });
        }
      }
    } finally {
      loginStored = await storeIfRefreshed(deps, original, account);
    }
    return { kind: invocation.kind, reason, deliveries, triage, labels, cursor, loginStored };
  }

  // A run dispatched on a branch, finished: the session that wrote the commit
  // it tested, or the local session holding the branch, hears it, with no
  // fallback (dispatch/branch-run.mjs). A `dispatch-branch-run` line says
  // whom, or why nobody.
  if (invocation.kind === 'branch-run') {
    /** @type {Array<{ prs: number[], session: string } & Omit<import('./deliveries.mjs').Delivery, 'sessionUrl' | 'dropped' | 'skipped'>>} */
    const deliveries = [];
    /** @type {string | null} */
    let reason = null;
    let loginStored = false;
    const about = { name: invocation.name, runId: invocation.runId, branch: invocation.branch, conclusion: invocation.conclusion };
    try {
      const plan = await planBranchRun({ invocation, reader: await getReader(), onBranch: delivery().onBranch });
      reason = plan.reason;
      deps.log('dispatch-branch-run', { ...about, session: plan.session, reason });
      if (plan.session !== null && plan.text !== null) {
        const { ok, answered, refused, error, fallback } = await delivery().deliver({ session: plan.session }, plan.text);
        deliveries.push({ prs: [], session: plan.session, ok, answered, refused, error, fallback });
      }
    } finally {
      loginStored = await storeIfRefreshed(deps, original, account);
    }
    return { kind: 'branch-run', reason, deliveries, loginStored };
  }

  // A merge into the default branch: each open PR it left conflicted has its owner
  // session told, once per merge (dispatch/conflicts.mjs). Past the
  // send window, a PR is left unrecorded and the turn fails, as a workflow
  // turn's untold notes do.
  if (invocation.kind === 'conflicts') {
    /** @type {string | null} */
    let head = null;
    /** @type {import('./conflicts.mjs').Checked[]} */
    let checks = [];
    let loginStored = false;
    const started = deps.now();
    try {
      ({ head, checks } = await checkConflicts({
        invocation,
        reader: await getReader(),
        sleep: deps.sleep,
        record: (pr) => deps.state.recordConflict(fireRepo(), pr, invocation.sha),
        deliver: delivery().deliver,
        inTime: () => deps.now() - started <= WORKFLOW_SEND_WINDOW_MS,
        prompts,
      }));
      for (const check of checks) deps.log('dispatch-conflicts', { merged: invocation.pr, sha: invocation.sha, head, ...check });
    } finally {
      loginStored = await storeIfRefreshed(deps, original, account);
    }
    return { kind: 'conflicts', head, checks, loginStored };
  }

  // The PR review: one PR, or every open one, through the checklist. No
  // run holds a merge. Each run's transcript goes to the drop
  // box whatever it answered.
  if (invocation.kind === 'review') {
    /** @type {import('./review.mjs').Reviewed[]} */
    const reviews = [];
    let loginStored = false;
    const started = deps.now();
    try {
      const reader = await getReader();
      // Every PR reviewed is into the default branch, so a sweep reads its required checks once.
      /** @type {Map<string, Promise<string[]>>} */
      const required = new Map();
      /** @param {string} branch */
      const requiredChecks = (branch) => {
        let checks = required.get(branch);
        if (checks === undefined) required.set(branch, checks = reader.requiredChecks(branch));
        return checks;
      };
      const github = { ...reader, requiredChecks };
      const { review, labels } = configOf(fireRepo());
      // The schema holds a section wherever prReview is on, and the switch was checked.
      if (review === undefined) throw new Error(`${fireRepo()}'s ${CONFIG_PATH} has no review section`);
      const base = await github.defaultBranch();
      const targets = invocation.pr === undefined
        ? (await github.openPulls()).filter((p) => !p.draft).map((p) => ({ number: p.number }))
        : [{ number: invocation.pr, ...(invocation.headSha === undefined ? {} : { headSha: invocation.headSha }) }];
      const judge = cliJudge({
        skill: review.checklist,
        run: (request, pr) => budgeted(() => deps.review(request), `review #${pr}`),
        transcript: deps.transcript,
        log: deps.log,
      });
      for (const [i, target] of targets.entries()) {
        if (deps.now() - started > REVIEW_WINDOW_MS) {
          deps.log('dispatch-review', { unreviewed: targets.slice(i).map((t) => t.number), reason: `out of time: past ${REVIEW_WINDOW_MS} ms, another review might outrun the deadline; each is reviewed on its next push or edit` });
          break;
        }
        const reviewed = await reviewPull({ ...target, reader: github, judge, sleep: deps.sleep, review, labels, base });
        deps.log('dispatch-review', { ...reviewed });
        reviews.push(reviewed);
      }
    } finally {
      loginStored = await storeIfRefreshed(deps, original, account);
    }
    return { kind: 'review', reviews, loginStored };
  }

  const started = deps.now();
  /** @type {Array<{ issue: number | null, repo: string, prompt: string, sessionName: string, model: string }>} */
  const plan = [];
  /** The issues a targeted schedule fire limits the plan to; undefined for the sweep. @type {number[] | undefined} */
  let only;
  /** The served repos whose backlog the bare fire could not read. @type {Array<{ repo: string, error: string }>} */
  const unread = [];
  if (invocation.kind === 'schedule') {
    // Every served repo's ready tickets in one queue; a repo
    // whose file turns pickup off is still swept, and its backlog unread.
    /** @type {import('../scripts/lib/dispatch-router.mjs').Source[]} */
    const sources = [];
    for (const { repo, config } of served) {
      if (!turnsOn(config, 'pickup')) {
        deps.log('dispatch-refused', { level: 'info', repo, kind: 'schedule', reason: `${repo}'s ${CONFIG_PATH} does not turn pickup on` });
        continue;
      }
      sources.push({ repo, reader: await readerFor(repo), labels: config.labels, prompts: config.prompts });
    }
    // A close frees what it blocked and nothing else: the plan is those
    // issues, each through the selection's own checks, so one another open
    // issue still blocks stays put. A fire naming issues names one repo.
    const blocking = invocation.freed === undefined ? undefined : (await (await getReader()).blocking(invocation.freed)).map((row) => row.number);
    only = invocation.issue === undefined ? blocking : [invocation.issue];
    // In the bare fire one repo's refusal leaves the others to go; a fire
    // naming its repo throws on its own.
    const planned = blocking?.length === 0 ? [] : await planSchedule({
      sources,
      cap: deps.cap,
      now: deps.now(),
      ...(only === undefined ? {} : { only }),
      ...(bare ? { unread } : {}),
    });
    for (const { repo, error } of unread) deps.log('dispatch-backlog-unread', { level: 'error', repo, error });
    if (sources.length > 0 && new Set(unread.map((u) => u.repo)).size === sources.length) {
      throw new Error(`no served repo's backlog could be read: ${unread.map((u) => `${u.repo}: ${u.error}`).join('; ')}`);
    }
    if (blocking !== undefined) {
      deps.log('dispatch-plan', {
        freed: invocation.freed,
        blocking,
        planned: planned.map((d) => d.issue),
        ...(blocking.length === 0 ? { reason: `#${invocation.freed} blocked nothing` }
          : planned.length === 0 ? { reason: 'none of what it blocked is selectable: still blocked, not ready, parent parked, or dispatched inside the window' }
            : {}),
      });
    }
    for (const d of planned) {
      plan.push({ issue: d.issue ?? null, repo: d.repo, prompt: d.prompt, sessionName: d.sessionName, model: DEFAULT_MODEL });
    }
    // A scheduled red after a red plans nothing: the red before started the session that is on it.
  } else if (!(invocation.kind === 'dispatch' && invocation.scheduled !== undefined && await redBefore(invocation.scheduled, getReader, deps))) {
    plan.push({
      issue: null,
      repo: fireRepo(),
      // A red scheduled run's fire carries its facts; the instruction is the repo's.
      prompt: invocation.kind === 'dispatch' && invocation.scheduled !== undefined ? redRunPrompt(invocation.prompt, prompts) : invocation.prompt,
      sessionName: invocation.sessionName ?? DEFAULT_SESSION_NAME,
      model: invocation.model ?? DEFAULT_MODEL,
    });
  }

  // The dispatcher claims a ticket before its launch: a session that
  // never claims, or dies first, would leave it ready for the next fire. A
  // ticket stays in `claims` until a marker naming its session covers it, or
  // its labels are back as they were. Each repo claims with its own labels
  // (dispatch/repo-config.mjs), the claim label made where the repo lacks it.
  const claims = deps.claims ?? new Set();
  /** @param {{ repo: string, issue: number }} ticket */
  const keyOf = ({ repo, issue }) => `${repo}#${issue}`;
  /** The repos whose claim label is known to exist this turn. @type {Set<string>} */
  const labelled = new Set();

  /**
   * Put the ready labels the claim took off back, and take the claim off. A
   * release that fails leaves the ticket in `claims`, so the turn's end logs
   * it stranded.
   *
   * @param {{ repo: string, issue: number }} ticket
   */
  const release = async (ticket) => {
    const { repo, issue } = ticket;
    const { labels } = configOf(repo);
    try {
      const github = await readerFor(repo);
      if (labels.claimRemoves.length > 0) await github.addLabels(issue, labels.claimRemoves);
      await github.removeLabel(issue, labels.claim);
      claims.delete(keyOf(ticket));
      deps.log('dispatch-claim', { repo, issue, outcome: 'released' });
    } catch (error) {
      deps.log('dispatch-claim', { repo, issue, outcome: 'not released', error: messageOf(error) });
    }
  };

  /**
   * Claim one ticket: the claim label on, then the ready labels it takes
   * off. The plan was read before earlier launches that take minutes, so
   * the ticket is read again first: one closed, unreadied or claimed since
   * is skipped, untouched, since its session would proceed on the prompt's
   * claim line over someone else's work. A claim that fails is released,
   * and starts nothing.
   *
   * @param {{ repo: string, issue: number }} ticket
   * @returns {Promise<'claimed' | 'taken' | 'failed'>}
   */
  const claim = async (ticket) => {
    const { repo, issue } = ticket;
    const { labels } = configOf(repo);
    try {
      const { state, labels: on } = await (await readerFor(repo)).ticket(issue);
      if (state !== 'open' || !labels.ready.every((l) => on.includes(l)) || on.includes(labels.claim)) {
        deps.log('dispatch-claim', { repo, issue, outcome: 'skipped', reason: `no longer ready to claim: ${state}, labelled ${JSON.stringify(on)}` });
        return 'taken';
      }
    } catch (error) {
      deps.log('dispatch-claim', { repo, issue, outcome: 'not claimed', error: `the ticket could not be read: ${messageOf(error)}` });
      return 'failed';
    }
    claims.add(keyOf(ticket));
    try {
      const github = await readerFor(repo);
      if (!labelled.has(repo)) {
        await github.ensureLabel(labels.claim);
        labelled.add(repo);
      }
      await github.addLabels(issue, [labels.claim]);
      for (const label of labels.claimRemoves) await github.removeLabel(issue, label);
      return 'claimed';
    } catch (error) {
      deps.log('dispatch-claim', { repo, issue, outcome: 'not claimed', error: messageOf(error) });
      await release(ticket);
      return 'failed';
    }
  };

  /** @type {Dispatched[]} */
  const dispatched = [];
  /** The repos whose launch started nothing: the rest of their tickets wait for the next fire. @type {Set<string>} */
  const skipped = new Set();
  let heartbeat = false;
  let loginStored = false;
  try {
    for (const [i, entry] of plan.entries()) {
      if (deps.now() - started > SCHEDULE_LAUNCH_WINDOW_MS) {
        deps.log('dispatch-launch', { undispatched: plan.slice(i).map((e) => ({ repo: e.repo, issue: e.issue })), reason: `out of time: past ${SCHEDULE_LAUNCH_WINDOW_MS} ms, another launch might outrun the deadline; each is left unmarked for the next fire` });
        break;
      }
      const ticket = entry.issue === null ? null : { repo: entry.repo, issue: entry.issue };
      if (ticket !== null && skipped.has(ticket.repo)) continue;
      const claimed = ticket === null ? 'claimed' : await claim(ticket);
      if (claimed === 'taken') continue;
      if (claimed === 'failed') {
        dispatched.push({ repo: entry.repo, issue: entry.issue, outcome: 'failed', sessionUrl: null });
        continue;
      }
      const { outcome, sessionUrl, status } = await start({ prompt: entry.prompt, sessionName: entry.sessionName, model: entry.model, repo: entry.repo });
      deps.log('dispatch-launch', { repo: entry.repo, issue: entry.issue, sessionName: entry.sessionName, outcome, status, sessionUrl });
      if (ticket !== null && outcome === 'failed') {
        await release(ticket);
        // A launch that started nothing is the repo's environment or the
        // login: the repo's next ticket would fail the same way.
        skipped.add(ticket.repo);
        deps.log(REPO_SKIPPED, { level: 'error', repo: ticket.repo, issue: ticket.issue, status, reason: 'its launch started nothing: the rest of its tickets wait for the next fire' });
      } else if (ticket !== null) {
        const at = new Date(deps.now()).toISOString();
        await (await readerFor(ticket.repo)).comment(ticket.issue, dispatchMarker({ at, sessionUrl }));
        if (sessionUrl !== null) claims.delete(keyOf(ticket));
      }
      dispatched.push({ repo: entry.repo, issue: entry.issue, outcome, sessionUrl });
    }

    // The heartbeat says the sweep ran, runs with nothing to dispatch or
    // nothing left to claim included, unless every claim or launch failed. A
    // fire naming its repo or its issues (one labelled, or what a close
    // freed) is not the sweep: one per label or per merge would keep the
    // heartbeat fresh while the schedule was dead, and the watchdog reads
    // the heartbeat as the schedule's. It is written in each repo whose file
    // turns it on, into the issue the file names, judged on that
    // repo's own claims and launches (another repo's launch going through
    // says nothing of this one's), and only where that issue's body already
    // carries the marker: a wrong number refuses
    // the write rather than overwrite someone's ticket, and the repo's
    // watchdog then reports the lapse.
    // One repo's read or write that fails leaves the rest to go, then fails
    // the turn.
    if (bare) {
      /** @type {string[]} */
      const unwritten = [];
      for (const { repo, config } of served) {
        if (!turnsOn(config, 'heartbeat') || config.heartbeat === undefined || unread.some((u) => u.repo === repo)) continue;
        const own = dispatched.filter((d) => d.repo === repo);
        if (own.length > 0 && own.every((d) => d.outcome === 'failed')) continue;
        const { issue, marker } = config.heartbeat;
        try {
          const github = await readerFor(repo);
          const { body } = await github.issue(issue);
          if (!body.includes(marker)) {
            deps.log(HEARTBEAT_REFUSED, { level: 'error', repo, issue, marker, reason: 'the issue\'s body has no marker, so the heartbeat is not written: fix the issue number or marker in the repo\'s .github/dispatch.json, or add the marker to the issue' });
            continue;
          }
          await github.updateIssue(issue, { body: stampLastRun(body, marker, deps.now()) });
        } catch (error) {
          deps.log(HEARTBEAT_UNWRITTEN, { level: 'error', repo, issue, error: messageOf(error) });
          unwritten.push(`${repo}#${issue}: ${messageOf(error)}`);
          continue;
        }
        deps.log('dispatch-heartbeat', { repo, issue });
        heartbeat = true;
      }
      if (unwritten.length !== 0) throw new Error(`heartbeat not written: ${unwritten.join('; ')}`);
    }
  } finally {
    // A claim no marker names a session for: an unconfirmed launch, one past
    // its budget, a marker refused, a release refused. Nothing puts the
    // labels back, because the session may be running.
    for (const key of claims) deps.log(CLAIM_STRANDED, { ...ticketOf(key), reason: 'claimed, and no dispatch marker names its session: the launch was unconfirmed, ran past its budget, or the turn threw' });
    claims.clear();
    // Whatever the turn threw, a login the CLI refreshed goes back: the
    // rotation has already happened server-side, and a turn that restored
    // the copy from before it would hold a dead refresh token.
    loginStored = await storeIfRefreshed(deps, original, account);
  }
  return { kind: invocation.kind, dispatched, heartbeat, loginStored, ...(unread.length === 0 ? {} : { unread }) };
};

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
 * @param {Pick<Deps, 'log' | 'sleep'>} deps
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

// ── The real I/O ────────────────────────────────────────────────────────────

/**
 * The launcher's own budget: its four-minute confirmation window, the
 * preflight before it, and margin. Two of these, with the reads around
 * them, fit inside the task's deadline (dispatch/cli.mjs); a schedule turn
 * starts no launch past SCHEDULE_LAUNCH_WINDOW_MS, whatever its cap.
 */
export const LAUNCH_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * How long into a schedule turn a launch may still start: one more launch at
 * the budget above, its marker and the heartbeat still end inside the task's
 * deadline (dispatch/cli.mjs), so the refreshed login is stored. Two launches
 * at the full budget both start; a DispatchCap above two runs out of window.
 */
export const SCHEDULE_LAUNCH_WINDOW_MS = 7 * 60 * 1000;

/**
 * One delivery's budget: its send, a forward and a fallback launch
 * together. A quick send leaves the launch its full budget; slow ones cut
 * it short, and a launch cut short is a thrown turn with the login stored.
 */
export const DELIVER_BUDGET_MS = DELIVER_LAUNCHES * LAUNCH_TIMEOUT_MS;

/**
 * @typedef {{ label: string | null, tickets: Array<{ ticket: number, prs: number[] }>, reason: string | null, range: import('./coverage.mjs').Range | null }} LabelPlan
 */

/**
 * The label a shipping job that succeeded on main adds, and the tickets it
 * adds it to, or why none, read off what the job covers
 * (dispatch/coverage.mjs): each ticket a merged PR its paths pick closes,
 * as GitHub reads the PR body (a `Closes #N` at the top or in prose). A run
 * fire names no label: a run earns none, its shipping jobs do. Labels are
 * only added; nothing is backfilled.
 *
 * @param {import('./webhook/fire.mjs').WorkflowFire | import('./webhook/fire.mjs').JobFire} invocation
 * @param {import('./coverage.mjs').Coverage} coverage
 * @returns {LabelPlan}
 */
export const ticketsOf = (invocation, coverage) => {
  if (invocation.kind !== 'job') return { label: null, tickets: [], reason: `${invocation.name} run ${invocation.runId} ended ${invocation.conclusion}: a run earns no label, its shipping jobs do`, range: null };
  const { workflow: name, runId, label } = invocation;
  const { range } = coverage;
  if (coverage.reason !== null || range === null) return { label, tickets: [], reason: coverage.reason, range };
  // A label needs a merge to close a ticket.
  if (coverage.merges.length === 0) return { label, tickets: [], reason: `${name} run ${runId} shipped no merge since run ${range.baseline.id}`, range };
  /** @type {Map<number, number[]>} */
  const tickets = new Map();
  for (const pr of coverage.picked) {
    for (const ticket of coverage.closes.get(pr.number) ?? []) tickets.set(ticket, [...(tickets.get(ticket) ?? []), pr.number]);
  }
  return {
    label,
    tickets: [...tickets].map(([ticket, prs]) => ({ ticket, prs })),
    reason: tickets.size === 0 ? `${name} run ${runId}: no merge it shipped closes a ticket its paths pick` : null,
    range,
  };
};

/**
 * The tickets a shipping job on main shipped get the label its name carries
 * ({@link ticketsOf}). A `dispatch-labels` line says what was added, or why
 * nothing was. A write that failed is kept, not thrown: the job's messages
 * are still to send, and the turn's exit code reports it
 * (dispatch/cli.mjs).
 *
 * @param {import('./webhook/fire.mjs').WorkflowFire | import('./webhook/fire.mjs').JobFire} invocation
 * @param {Reader} reader
 * @param {import('./coverage.mjs').Coverage} coverage
 * @param {{ log: (event: string, context?: Record<string, unknown>) => void }} deps
 * @param {Record<string, unknown>} about
 * @returns {Promise<{ label: string, added: number[], failed: Array<{ ticket: number, error: string }> } | null>}
 */
const labelTickets = async (invocation, reader, coverage, deps, about) => {
  const plan = ticketsOf(invocation, coverage);
  if (plan.label === null || plan.tickets.length === 0) {
    if (invocation.kind === 'job') deps.log('dispatch-labels', { ...about, label: plan.label, ...(plan.range ?? {}), reason: plan.reason });
    return null;
  }
  const added = [];
  const failed = [];
  for (const { ticket, prs } of plan.tickets) {
    try {
      await reader.addLabels(ticket, [plan.label]);
      added.push(ticket);
    } catch (error) {
      failed.push({ ticket, error: messageOf(error) });
      deps.log('dispatch-labels', { ...about, label: plan.label, ticket, prs, error: messageOf(error) });
    }
  }
  deps.log('dispatch-labels', { ...about, label: plan.label, ...plan.range, added });
  return { label: plan.label, added, failed };
};

/**
 * How long into a workflow or conflicts turn a send may still start: one more delivery
 * at the budget above still ends inside the task's deadline
 * (dispatch/cli.mjs), so the refreshed login is stored.
 */
export const WORKFLOW_SEND_WINDOW_MS = 5 * 60 * 1000;

/**
 * How many turns may fail to send one session a range's news before the
 * range gives up on it and the cursor moves past: a session that
 * answers 5xx every time otherwise holds the cursor for good.
 */
export const WORKFLOW_SEND_TRIES = 3;

/** How long a delivered record outlives its last write: past any cursor held that long, it is never read again. */
const DELIVERED_TTL_S = 30 * 24 * 60 * 60;

/** How long a PR's record of a merge's conflict is kept: a merge's fire is redelivered within hours, and never a month on. */
const CONFLICT_TTL_S = 30 * 24 * 60 * 60;

/** The attribute the state table's TTL expires on (infra/governor.cfn.yml). */
export const STATE_TTL_ATTRIBUTE = 'ttl';

/**
 * How long into a review turn a review may still start: one more `claude
 * -p` run at the launch budget above, the mergeable reads and the upload
 * still end inside the task's deadline (dispatch/cli.mjs).
 */
const REVIEW_WINDOW_MS = 5 * 60 * 1000;

/**
 * What a transcript carries that the drop box must not: tokens and keys of
 * every shape a session's own export redacts, and the writer's own secret.
 *
 * @param {string} text
 * @param {string} secret
 */
export const redactTranscript = (text, secret) => {
  let out = text
    .replace(/gh-token:[^\s\\"]+/g, 'gh-token:<redacted>')
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, '<redacted-github-token>')
    .replace(/\b(?:AKIA|ASIA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g, '<redacted-aws-key-id>')
    .replace(/(aws_secret_access_key(?:\\?")?\s*[=:]\s*(?:\\?")?)[^\s\\"]+/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]{20,}=*/g, '$1<redacted>')
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '<redacted-claude-token>');
  if (secret.length >= 8) out = out.split(secret).join('<redacted>');
  return out;
};

/**
 * A child run to its end: stdout and stderr as they arrived, and the exit
 * status. A spawn that never started rejects.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<LaunchResult>}
 */
const collect = (child) =>
  new Promise((resolveRun, rejectRun) => {
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.on('error', rejectRun);
    child.on('close', (status) => resolveRun({ status, output }));
  });

/** The launcher: beside this file in the image, in .github/scripts in a checkout. */
const launcherPath = () => {
  const inImage = join(HERE, 'launch-session.py');
  return existsSync(inImage) ? inImage : join(HERE, '..', '.github', 'scripts', 'launch-session.py');
};

const PROBE = [
  'import os, pty',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  "    os.execvp('sh', ['sh', '-c', 'echo pty-ok'])",
  "out = b''",
  'while True:',
  '    try:',
  '        chunk = os.read(fd, 1024)',
  '    except OSError:',
  '        break',
  '    if not chunk:',
  '        break',
  '    out += chunk',
  'os.waitpid(pid, 0)',
  "print(out.decode(errors='replace'))",
].join('\n');

/**
 * The dispatcher's fire lane (infra/governor.cfn.yml DispatchFiresQueue):
 * the fires on it, visible or in flight, which is all the task role may ask
 * of it.
 *
 * @param {Pick<SQSClient, 'send'>} client
 * @param {string} url
 * @returns {import('../scripts/lib/session-signoff.mjs').Fires}
 */
export const sqsFires = (client, url) => ({
  waiting: async () => {
    const names = /** @type {const} */ (['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']);
    const { Attributes } = await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: [...names] }));
    return names.reduce((sum, name) => {
      const count = Number(Attributes?.[name]);
      if (Attributes?.[name] === undefined || !Number.isInteger(count)) throw new Error(`the fire lane did not say ${name}`);
      return sum + count;
    }, 0);
  },
});

/**
 * The sessions API the CLI archives a cloud session through (its
 * `archiveRemoteSession`): the session's `cse_` id, the login's bearer
 * token. Not a documented API; a refusal leaves the session for the next
 * sweep, and its sign-off line is still there for the operator.
 */
const ARCHIVE_API = 'https://api.anthropic.com/v1/code/sessions';

/**
 * The login's cloud environments, the list `/remote-env` shows: the CLI
 * reads it with `GET /v1/environment_providers` under the login's token and
 * its organization, and a session-create falls back to the first entry when
 * its default environment ID is not in it. So the dispatcher turns a name
 * into its ID itself, and never hands the CLI a name.
 */
const ENVIRONMENTS_API = 'https://api.anthropic.com/v1/environment_providers';

/**
 * One read of the sessions API, parsed; a 404 is null, and any other answer
 * but a 2xx throws. The
 * same API's list and one session's record, which the CLI reads with
 * `GET /v1/code/sessions?limit=100` and `GET /v1/code/sessions/<id>`: the
 * branch a session holds (scripts/lib/session-branch.mjs). A hundred a page,
 * newest first; the next page is the one `after_id` the last row, as the
 * CLI pages it.
 *
 * @param {string} url
 * @param {string} token
 * @returns {Promise<unknown>}
 */
const sessionsCall = async (url, token) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
  });
  const text = await response.text();
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${url.replace(ARCHIVE_API, '/v1/code/sessions')}: ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

/**
 * The environment every CLI call the task spawns runs under: the task's,
 * with its home, and the stored login's org named, so the CLI skips the
 * profile fetch it otherwise makes to find it. A login stored
 * without the ids leaves the CLI to look the org up.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 * @param {import('../scripts/lib/claude-login.mjs').LoginAccount | null} account
 * @returns {Record<string, string | undefined>}
 */
export const cliEnv = (env, home, account) => ({
  ...env,
  HOME: home,
  ...(account === null ? {} : { CLAUDE_CODE_ORGANIZATION_UUID: account.organizationUuid }),
});

/**
 * The dispatcher's state in its DynamoDB table (infra/governor.cfn.yml,
 * docs/constraints/dispatcher-state.md): a label's cursor is the item `workflow#<repo>#<file>` /
 * `cursor#<label>` (one workflow earns dev, then prod, and a
 * run that stopped after dev moves dev's alone; two repos' runs
 * of one file keep apart), read consistently, and
 * written only over an older run's, so two turns racing cannot move it
 * back. CI's, which earns no label, is `cursor`. What a held cursor's range delivered is the item
 * `workflow#<repo>#<file>` / `delivered#<label>#<cursor's run id>` (CI's
 * `delivered#<run id>`), merged into by one update and expired by `ttl`
 * once the cursor moves on. A PR told of a merge's conflict is the
 * item `conflicts#<repo>` / `<pr>#<merge sha>`, put only where none stands
 * and expired by `ttl`.
 *
 * @param {Pick<DynamoDBClient, 'send'>} client
 * @param {string} table
 * @returns {DispatchState}
 */
export const dynamoState = (client, table) => {
  const pk = (/** @type {string} */ repo, /** @type {string} */ workflow) => ({ S: `workflow#${repo}#${workflow}` });
  const key = (/** @type {string} */ repo, /** @type {string} */ workflow, /** @type {string | null} */ label) => ({ pk: pk(repo, workflow), sk: { S: label === null ? 'cursor' : `cursor#${label}` } });
  const sent = (/** @type {string} */ repo, /** @type {string} */ workflow, /** @type {string | null} */ label, /** @type {number | null} */ from) => ({ pk: pk(repo, workflow), sk: { S: `delivered#${label === null ? '' : `${label}#`}${from ?? 'none'}` } });
  return {
    cursor: async (repo, workflow, label) => {
      const { Item: item } = await client.send(new GetItemCommand({ TableName: table, Key: key(repo, workflow, label), ConsistentRead: true }));
      if (item === undefined) return null;
      const runId = Number(item.runId?.N);
      const commit = item.commit?.S;
      // A malformed item is a failed read, never a missing one.
      if (!Number.isSafeInteger(runId) || commit === undefined) throw new Error(`the cursor item for ${repo} ${workflow} ${label ?? ''} is malformed: ${JSON.stringify(item)}`);
      return { runId, commit, created: item.created?.S ?? '' };
    },
    delivered: async (repo, workflow, label, from) => {
      const { Item: item } = await client.send(new GetItemCommand({ TableName: table, Key: sent(repo, workflow, label, from), ConsistentRead: true }));
      if (item === undefined) return { told: [], failed: [] };
      const failed = (item.failed?.L ?? []).map((v) => v.S);
      if ((item.told !== undefined && item.told.SS === undefined) || (item.failed !== undefined && item.failed.L === undefined) || failed.some((s) => s === undefined)) {
        throw new Error(`the delivered item for ${workflow} ${label ?? ''} from ${from ?? 'none'} is malformed: ${JSON.stringify(item)}`);
      }
      return { told: item.told?.SS ?? [], failed: /** @type {string[]} */ (failed) };
    },
    // One update merges into what a racing turn wrote: never a read, then a write.
    record: async (repo, workflow, label, from, { told, failed }) => {
      if (told.length === 0 && failed.length === 0) return;
      await client.send(new UpdateItemCommand({
        TableName: table,
        Key: sent(repo, workflow, label, from),
        UpdateExpression: [
          `SET #ttl = :ttl${failed.length === 0 ? '' : ', failed = list_append(if_not_exists(failed, :none), :failed)'}`,
          ...(told.length === 0 ? [] : ['ADD told :told']),
        ].join(' '),
        ExpressionAttributeNames: { '#ttl': STATE_TTL_ATTRIBUTE },
        ExpressionAttributeValues: {
          ':ttl': { N: String(Math.floor(Date.now() / 1000) + DELIVERED_TTL_S) },
          ...(failed.length === 0 ? {} : { ':none': { L: [] }, ':failed': { L: failed.map((s) => ({ S: s })) } }),
          ...(told.length === 0 ? {} : { ':told': { SS: [...new Set(told)] } }),
        },
      }));
    },
    recordConflict: async (repo, pr, merge) => {
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: { pk: { S: `conflicts#${repo}` }, sk: { S: `${pr}#${merge}` }, [STATE_TTL_ATTRIBUTE]: { N: String(Math.floor(Date.now() / 1000) + CONFLICT_TTL_S) } },
          ConditionExpression: 'attribute_not_exists(pk)',
        }));
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException || /** @type {any} */ (error)?.name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
    advance: async (repo, workflow, label, { runId, commit, created }) => {
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: { ...key(repo, workflow, label), runId: { N: String(runId) }, commit: { S: commit }, created: { S: created } },
          ConditionExpression: 'attribute_not_exists(pk) OR runId < :runId',
          ExpressionAttributeValues: { ':runId': { N: String(runId) } },
        }));
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException || /** @type {any} */ (error)?.name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
  };
};

/**
 * The stack's owner list (DispatchOwners): the accounts whose installations
 * the dispatcher serves. Unset is no owner, so nothing is served: never a
 * default account. The receiver reads it the same way (webhook/fire.mjs).
 */
export const dispatchOwners = ownersOf;

/** @returns {Deps} */
export const realDeps = () => {
  const env = process.env;
  const home = env.HOME || '/home/dispatch';
  const cwd = env.DISPATCH_WORKDIR || '/tmp/repo';
  const configPath = join(home, '.claude.json');
  const credentials = join(home, '.claude', '.credentials.json');
  /** The restored login's account, which every CLI call is handed. @type {import('../scripts/lib/claude-login.mjs').LoginAccount | null} */
  let account = null;
  const secrets = new SecretsManagerClient({});
  const secretText = async (/** @type {string} */ id) =>
    (await secrets.send(new GetSecretValueCommand({ SecretId: id }))).SecretString ?? '';
  const log = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ context = {}) =>
    console.log(JSON.stringify({ event, ...context }));

  /** The App's secret, read once a turn. @type {Promise<{ appId?: unknown, privateKey?: unknown }> | null} */
  let appSecret = null;
  const app = () => (appSecret ??= secretText(String(env.GITHUB_APP_SECRET_ID)).then((text) => JSON.parse(text)));

  /**
   * The CLI trusts a working directory once told so, in the home's config.
   *
   * @param {string} dir
   */
  const trust = (dir) => {
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    config.hasCompletedOnboarding = true;
    config.projects ??= {};
    config.projects[dir] = { hasTrustDialogAccepted: true };
    writeFileSync(configPath, JSON.stringify(config));
  };

  /**
   * A launch's working directory for `launched`, beside the turn's own: a
   * git checkout-less repo whose origin is the repo, so the CLI starts the
   * session there, and the repo's cloud environment as its default.
   *
   * @param {string} launched
   * @param {string} environment
   */
  const workspaceFor = (launched, environment) => {
    const dir = join(dirname(cwd), 'repos', ...launched.split('/'));
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dir, { recursive: true });
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
      spawnSync('git', ['remote', 'add', 'origin', `https://github.com/${launched}.git`], { cwd: dir, stdio: 'ignore' });
    }
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ remote: { defaultEnvironmentId: environment } }));
    trust(dir);
    return dir;
  };

  /** The App's id and key, as the token mints take them. */
  const appKey = async () => {
    const { appId, privateKey } = await app();
    return { appId: String(appId), privateKeyPem: String(privateKey) };
  };

  const owners = dispatchOwners(env.DISPATCH_OWNERS);

  return {
    owners,
    installations: async () => appInstallations({ ...(await appKey()), owners }),
    configFile: (served, token, path) => githubReader({ token, repo: served }).configFile(path),
    environments: async (token, organization) => {
      const response = await fetch(ENVIRONMENTS_API, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', ...(organization === null ? {} : { 'x-organization-uuid': organization }) },
        signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GET /v1/environment_providers: ${response.status}`);
      return response.json();
    },
    cap: dispatchCap(env.DISPATCH_CAP),
    now: () => Date.now(),
    log,
    secret: {
      get: () => secretText(String(env.CLAUDE_LOGIN_SECRET_ID)),
      put: async (text) => {
        await secrets.send(new PutSecretValueCommand({ SecretId: String(env.CLAUDE_LOGIN_SECRET_ID), SecretString: text }));
      },
    },
    githubToken: async (served) => installationToken({ ...(await appKey()), repo: served }),
    appId: async () => {
      const id = Number((await app()).appId);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`the GitHub App secret's appId is not an App ID: ${String((await app()).appId)}`);
      return id;
    },
    reader: (token, appId, served) => githubReader({ token, repo: served, appId }),
    workspace: {
      // The turn's own directory, where a message and a review run, a
      // checkout-less repo of the fire's; the bare schedule
      // fire's has no origin, and each launch runs in its own repo's
      // (`workspaceFor`). A login refresh prepares it first, naming no
      // repo, so the origin is added whenever one is named and none is set.
      prepare: (served) => {
        mkdirSync(join(home, '.claude'), { recursive: true });
        if (!existsSync(join(cwd, '.git'))) {
          mkdirSync(cwd, { recursive: true });
          spawnSync('git', ['init', '-q', '-b', 'main'], { cwd, stdio: 'ignore' });
        }
        if (served !== undefined) spawnSync('git', ['remote', 'add', 'origin', `https://github.com/${served}.git`], { cwd, stdio: 'ignore' });
        trust(cwd);
      },
      writeLogin: (text) => {
        writeFileSync(credentials, text, { mode: 0o600 });
        chmodSync(credentials, 0o600);
      },
      readLogin: () => (existsSync(credentials) ? readFileSync(credentials, 'utf8') : null),
      useAccount: (stored) => {
        account = stored;
      },
    },
    launch: async ({ prompt, sessionName, model, repo: launched, environment }) => {
      const dir = mkdtempSync(join(tmpdir(), 'governor-'));
      try {
        const promptFile = join(dir, 'prompt.txt');
        writeFileSync(promptFile, `${prompt}\n`);
        const result = await collect(spawn('python3', [launcherPath(), promptFile], {
          cwd: workspaceFor(launched, environment),
          env: cliEnv({ ...env, CLAUDE_MODEL: model, CLAUDE_SESSION_NAME: sessionName }, home, account),
          stdio: ['ignore', 'pipe', 'pipe'],
        }));
        log('dispatch-launcher-output', { sessionName, status: result.status, tail: result.output.slice(-OUTPUT_TAIL) });
        return result;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    launchTimeoutMs: LAUNCH_TIMEOUT_MS,
    // No pseudo-terminal: with --print the CLI sends the text to the session
    // and prints one JSON line, {ok, session_id, url} or {ok: false, error}.
    // The text goes on stdin, which the CLI reads as the prompt: as an
    // argument, one beginning with `-` (a markdown list) is an unknown option.
    message: async ({ session, text }) => {
      const child = spawn('claude', ['-p', '--cloud', session, '--output-format', 'json'], {
        cwd,
        env: cliEnv(env, home, account),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // A CLI that refuses before reading stdin closes the pipe on us; the
      // answer is what it printed and its status, not the write that failed.
      child.stdin.on('error', () => {});
      child.stdin.end(text);
      const result = await collect(child);
      log('dispatch-message-output', { session, status: result.status, tail: result.output.slice(-OUTPUT_TAIL) });
      return result;
    },
    // The smallest call that reaches the API, so the CLI refreshes an
    // expired login first: no tools, the smallest model, one word.
    refreshLogin: async () => {
      const child = spawn('claude', ['-p', '--output-format', 'json', '--model', 'haiku', '--tools', ''], {
        cwd,
        env: cliEnv(env, home, account),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', () => {});
      child.stdin.end('Reply with OK.');
      return collect(child);
    },
    // The checklist's run: the repo's checklist as the system prompt, the PR
    // on stdin, no tools (the PR's text is someone else's, and the answer is
    // a judgement over it), the answer held to the schema. The only process
    // a review starts: it runs none of the served repo's code.
    review: async ({ system, prompt, schema }) => {
      const dir = mkdtempSync(join(tmpdir(), 'governor-review-'));
      try {
        const systemFile = join(dir, 'system.md');
        writeFileSync(systemFile, system);
        const child = spawn('claude', [
          '-p', '--output-format', 'json', '--model', DEFAULT_MODEL,
          '--append-system-prompt-file', systemFile, '--json-schema', JSON.stringify(schema), '--tools', '',
        ], { cwd, env: cliEnv(env, home, account), stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
        const result = await collect(child);
        log('dispatch-review-output', { status: result.status, tail: result.output.slice(-OUTPUT_TAIL) });
        return result;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // The run's transcript, to the drop box the stack names, under governor's
    // own writer, named for the review so a reader tells it from a session's.
    transcript: async ({ sessionId, pr }) => {
      const url = env.SESSION_LOG_URL;
      if (!url || !env.SESSION_LOG_SECRET_ID) return { skipped: 'no drop box configured' };
      const secret = (await secretText(env.SESSION_LOG_SECRET_ID)).trim();
      if (!/^[0-9a-f]{32,}$/.test(secret)) return { skipped: 'the writer secret is not set' };
      const projects = join(home, '.claude', 'projects');
      const file = existsSync(projects)
        ? readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find((f) => existsSync(f))
        : undefined;
      if (file === undefined) return { skipped: `no transcript for ${sessionId}` };
      const key = `${new Date().toISOString().slice(0, 10)}/pr-review-${pr}-${sessionId}.jsonl.gz`;
      const response = await fetch(`${url.replace(/\/+$/, '')}/${key}`, {
        method: 'PUT',
        headers: { referer: secret, 'content-type': 'application/gzip', 'x-amz-meta-pr': String(pr) },
        body: gzipSync(redactTranscript(readFileSync(file, 'utf8'), secret)),
      });
      if (!response.ok) throw new Error(`PUT ${key} failed: ${response.status} ${response.statusText}`);
      return { key };
    },
    sleep: (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); }),
    fires: env.DISPATCH_FIRES_QUEUE_URL ? sqsFires(new SQSClient({}), env.DISPATCH_FIRES_QUEUE_URL) : undefined,
    // No table named: every read and write fails, so a workflow turn refuses, and a conflicts turn tells nobody, rather than guess.
    state: env.DISPATCH_STATE_TABLE
      ? dynamoState(new DynamoDBClient({}), env.DISPATCH_STATE_TABLE)
      : {
        cursor: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        advance: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        delivered: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        record: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordConflict: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
      },
    sessions: {
      list: (token, after) => sessionsCall(`${ARCHIVE_API}?limit=100${after === undefined ? '' : `&after_id=${encodeURIComponent(after)}`}`, token),
      get: (id, token) => {
        if (!/^(?:cse|session)_[A-Za-z0-9]+$/.test(id)) throw new Error(`not a session id: ${id}`);
        return sessionsCall(`${ARCHIVE_API}/${id}`, token);
      },
      // The newest hundred events, or the hundred older than the page whose
      // `next_cursor` is `cursor`, as the CLI pages them: the endpoint
      // ignores `before_id`. A refusal names its status alone: the
      // body may quote the session, and the sweep logs what this throws.
      events: async (id, token, cursor) => {
        if (!/^cse_[A-Za-z0-9]+$/.test(id)) throw new Error(`not a session id: ${id}`);
        const page = cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const response = await fetch(`${ARCHIVE_API}/${id}/events?limit=100&sort_order=desc${page}`, {
          headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`GET /v1/code/sessions/${id}/events: ${response.status}`);
        try {
          return JSON.parse(text);
        } catch {
          // JSON.parse's own message quotes the body.
          throw new Error(`GET /v1/code/sessions/${id}/events: ${response.status}, not JSON`);
        }
      },
    },
    archive: async ({ session, token }) => {
      const id = /^session_([A-Za-z0-9]+)$/.exec(session)?.[1];
      if (id === undefined) throw new Error(`not a session id: ${session}`);
      const response = await fetch(`${ARCHIVE_API}/cse_${id}/archive`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: '{}',
        signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
      });
      return { status: response.status, body: await response.text() };
    },
    probe: async () => {
      const pty = spawnSync('python3', ['-c', PROBE], { encoding: 'utf8' });
      const cli = spawnSync('claude', ['--version'], { encoding: 'utf8', env: cliEnv(env, home, account) });
      const ok = pty.status === 0 && /pty-ok/.test(pty.stdout) && cli.status === 0;
      return {
        ok,
        detail: `pty: ${pty.status === 0 ? pty.stdout.trim() : (pty.stderr || `exit ${pty.status}`).trim()}; claude: ${(cli.stdout || cli.stderr || `exit ${cli.status}`).trim()}`,
      };
    },
  };
};
