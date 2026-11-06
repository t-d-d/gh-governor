/**
 * The dispatcher's turn: starts Claude Code cloud sessions from a stored
 * claude.ai login, off any machine of ours.
 *
 * One fire is one turn (dispatch/cli.mjs is the entrypoint, and a task runs
 * one turn after another off the lane, dispatch/lane.mjs): restore the
 * login from Secrets Manager into the CLI's credential file, read the fire
 * (dispatch/webhook/fire.mjs) and decide what to start
 * (scripts/lib/dispatch-router.mjs), run the launcher once per session
 * (dispatch/launch-session.py, the same pseudo-terminal launcher the
 * Mac runs), claiming each ticket before its launch, leave a marker
 * comment with the session URL on each ticket,
 * record each fire on the served repo's heartbeat issue (dispatch/heartbeat.mjs:
 * the bare fire's sweep and every periodic fire, held or nothing to do
 * included, and the sign-off sweep's marks), and put the login back in the secret if
 * the CLI refreshed it. A `message` turn restores the login the same way
 * and sends text into a cloud session that already exists (`claude -p
 * --cloud <session>`, the text on stdin), which needs no pseudo-terminal;
 * a session that refuses (the CLI answers it archived) gets
 * the message's fallback, if it carries one, started as a fresh session
 * through the launcher, and the PR body's session link is rewritten to it,
 * with no comment posted. The body is the address, and the one record of
 * the PR's session: the receiver messages the session it names. A rewrite
 * that fails fails the turn, and the next refusal on that PR takes it over
 * again. Whom a message reaches and what a
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
 * session that wrote the commit it ran on, or the newest live session holding
 * the branch, with no fallback (dispatch/branch-run.mjs).
 * A `conflicts` turn follows a merge into the default branch: it reads every open PR's
 * mergeable state and messages each conflicted one's owner session, with
 * the fallback, naming the merge and main's commit; a conditional record in
 * the state table tells each PR of a merge once (dispatch/conflicts.mjs).
 * A `schedule` turn naming a `freed` issue, one just closed, starts
 * nothing: it queues an `unblocked` fire for each open ticket the issue
 * blocked, in whichever served repo it is, and an `unblocked` turn acts on
 * that ticket under its own repo's config: a message, a comment, a pickup,
 * or a session to rewrite its spec (dispatch/unblocked.mjs).
 * A `review` turn runs the repo's checklist (its file's `review.checklist`)
 * over a PR into its default branch, or every open one, as the
 * system prompt of a `claude -p` run under the same login, posts its answer
 * as the `governor` check, and merges or comments as the repo's `review`
 * settings say (dispatch/review.mjs, the checklist in
 * dispatch/checklist.mjs); the comment is the record, and the receiver
 * turns each new one into a message fire for the session the PR names,
 * with the fallback only where the session can act on it. No run but the
 * CI workflow's at the PR's head holds a merge. Each run's
 * transcript goes to the drop box the stack names, if any.
 * Every fire but the bare schedule fire names its repo: the turn
 * mints its GitHub token for that repo, reads its config file
 * (dispatch/repo-config.mjs) and refuses a kind the file does not turn on.
 * The bare schedule fire lists the App's installations on the stack's
 * owners and serves each repo whose file reads valid (dispatch/repos.mjs):
 * one queue over every served repo's ready tickets, each claimed with its
 * repo's labels and launched in its repo's cloud environment.
 * Every turn but a probe ends with the sign-off sweep: it archives each
 * idle session in a served repo whose file turns `signOff` on (the fire's,
 * or every one for the bare schedule fire) whose last reply, read from its
 * own events, ends
 * `Signing off.`; a turn that messaged sessions first waits, on a quiet fire
 * lane, for their replies (scripts/lib/session-signoff.mjs).
 * A PR's owner is the live session its body links, else the most recently
 * updated live session, local or cloud, holding the PR's head branch
 * (dispatch/deliveries.mjs). A message fire on a PR whose body names no
 * session carries `byBranch`, and a workflow turn reaches it the same way;
 * a linked owner that answers archived hands the message to the branch's
 * session. The turn asks the sessions API, under the stored login, which
 * session holds the branch (scripts/lib/session-branch.mjs), and writes
 * the one it finds into the PR body; with none, nobody is told, or the
 * message's fallback starts.
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
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetQueueAttributesCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DEFAULT_MODEL } from '../scripts/lib/dispatch-prompt.mjs';
import { parseLogin, describeLogin, refreshExpiring, readStoredLogin, storedLogin } from '../scripts/lib/claude-login.mjs';
import { ARCHIVE_TIMEOUT_MS, SIGNOFF_LATEST_START_MS, SIGNOFF_WINDOW_MS, accessToken, awaitReplies, heldMessage, sweepSignoffs } from '../scripts/lib/session-signoff.mjs';
import { archived, branchFinder, sessionRecord, sessionRow, sessionRows } from '../scripts/lib/session-branch.mjs';
import { WAIT_PROMPT, holdWait, waitLinks } from './waits.mjs';
import { tellerFor } from './told.mjs';
import { connectorsOf, duePeriodics, logNotStarted, periodicPrompt, recordFire, windowOf } from './periodics.mjs';
import { RoutinesApiError } from './routines.mjs';
import { hookFor, planHook } from './hooks.mjs';
import { planDispatch } from './dispatch-fire.mjs';
import { planUnblocked } from './unblocked-fire.mjs';
import { planClosingPr, planTicket } from './ticket-fire.mjs';
import { offerAfterRefusal, planOffer } from './offer.mjs';
import { planPrEdit, takeAfterNotice } from './take.mjs';
import { planAuthor, relayedText, searchAuthor, tellAuthor, wroteIt } from './author.mjs';
import { editedText, searchEditor, tellEditor } from './editor.mjs';
import { planSweep } from './sweep.mjs';
import { hookTable } from './webhook/hook-table.mjs';
import { appInstallations, githubReader, installationToken, turnResends } from '../scripts/lib/github-app.mjs';
import { fireRepoOf, repoServed, servedRepos } from './repos.mjs';
import { CONFIG_PATH, SWITCHES, switchesOf, turnsOn } from './repo-config.mjs';
import { planWorkflow, withTickets } from './workflow.mjs';
import { coverageOf } from './coverage.mjs';
import { planBranchRun } from './branch-run.mjs';
import { checkConflicts } from './conflicts.mjs';
import { closingFires } from './unblocked.mjs';
import { cliJudge } from './checklist.mjs';
import { ownerMessageId, reviewPull } from './review.mjs';
import { reviewIssue, reviewLabelsOf } from './issue-review.mjs';
import { sessionId } from './webhook/subscribe.mjs';
import { rolesOf } from './roles.mjs';
import { DELIVER_LAUNCHES, OUTPUT_TAIL, GITHUB_SOURCE, countAgainst, deliveries as turnDeliveries, fromDispatcher, readSend, refusedAsArchived } from './deliveries.mjs';
import { HOOK_PER_HOUR, LANE, deployedTarget, LANE_COUNTS, laneCount, ownerListed, ownersOf, parseFire, SIGN_POSTS } from './webhook/fire.mjs';
import { SESSION_RULES, blockIn, rulesFile } from './session-rules.mjs';
import { deployedComment } from './webhook/deployed-comment.mjs';
import { messageOf } from '../scripts/lib/error-message.mjs';
import { HEARTBEAT_MARKER, readHeartbeat, stampHeartbeat, writeHeartbeatIssue } from './heartbeat.mjs';
import { launcher, routineLaunch } from './launcher.mjs';
import { RELAY, autoOf, relayOf, reviewOf } from './trust.mjs';
import { CAP_ZERO_REASON, REPO_SKIPPED, SCHEDULE_LAUNCH_WINDOW_MS, launchPlan, routineFault } from './launch-plan.mjs';

export { CLAIM_STRANDED, CONNECTOR_MISSING, REPO_SKIPPED, ROUTINE_REFUSED, SCHEDULE_LAUNCH_WINDOW_MS, ticketOf } from './launch-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** What a turn's login warnings tell the operator to run. */
const REMINT = 're-mint: node scripts/mint-claude-login.mjs';

/**
 * @typedef {import('./deliveries.mjs').OpenRow} OpenRow
 * @typedef {import('./launcher.mjs').Launch} Launch
 * @typedef {import('./launcher.mjs').LaunchResult} LaunchResult
 * @typedef {import('./launcher.mjs').PendingRecord} PendingRecord
 * @typedef {import('../scripts/lib/dispatch-router.mjs').Reader & import('./workflow.mjs').WorkflowReader & {
 *   comment: (n: number, body: string) => Promise<void>,
 *   blocking: (n: number) => Promise<Array<import('../scripts/lib/github-app.mjs').BlockerRow & { repo: string, wait?: import('../scripts/lib/ready-work.mjs').Wait }>>,
 *   closure: (n: number) => Promise<{ title: string, reason: string | null, pr: import('./webhook/fire.mjs').ClosingPull | null, closedAt?: string }>,
 *   ticket: (n: number) => Promise<import('../scripts/lib/github-app.mjs').TicketRow>,
 *   pull: (n: number) => Promise<{ number: number, body: string, head: string, defaultBranch: string, open: boolean } & import('./webhook/fire.mjs').Author>,
 *   updatePull: (n: number, change: { body: string }) => Promise<void>,
 *   issue: (n: number) => Promise<{ number: number, body: string, pull: boolean }>,
 *   updateIssue: (n: number, change: { body: string }) => Promise<void>,
 *   openPulls: () => Promise<import('../scripts/lib/github-app.mjs').OpenPullRow[]>,
 *   branchHead: (branch: string) => Promise<string>,
 *   openNaming: (session: string, relay: readonly string[], options?: { claim?: string, holding?: readonly string[] }) => Promise<OpenRow[]>,
 *   openClosing: (n: number) => Promise<Array<{ number: number, title: string, html_url: string }>>,
 *   commit: (sha: string) => Promise<{ sha: string, message: string, parents?: string[] }>,
 *   addLabels: (n: number, labels: string[]) => Promise<void>,
 *   removeLabel: (n: number, label: string) => Promise<void>,
 *   labelRemovals: (n: number) => Promise<Array<{ label: string, at: string, ours: boolean }>>,
 *   labelAdds: (n: number) => Promise<Array<{ label: string, actor: string }>>,
 *   repoOwnerType: () => Promise<string>,
 *   outsideCollaborators: () => Promise<string[]>,
 *   addBlocker: (n: number, blockerId: number) => Promise<void>,
 *   removeBlocker: (n: number, blockerId: number) => Promise<void>,
 *   ensureLabel: (name: string, description?: string) => Promise<void>,
 *   defaultBranch: () => Promise<string>,
 *   mergedSince: (base: string, since: string) => Promise<import('./periodics.mjs').Counted[]>,
 *   issuesOpenedSince: (since: string, by?: readonly string[]) => Promise<import('./periodics.mjs').Counted[]>,
 *   issuesClosedSince: (since: string, by?: readonly string[]) => Promise<import('./periodics.mjs').Counted[]>,
 * } & import('./review.mjs').ReviewReader & import('./waits.mjs').RelativeReader & Pick<import('./issue-review.mjs').IssueReader, 'parentIssue' | 'openIssues'>} Reader
 *
 * @typedef {{
 *   owners: readonly string[],
 *   installations: () => Promise<Array<{ account: string, repos: string[] }>>,
 *   configFile: (repo: string, token: string, path?: string) => Promise<string | null>,
 *   environments: (token: string, organization: string | null) => Promise<unknown>,
 *   refreshLogin: () => Promise<LaunchResult>,
 *   cap: number,
 *   messageCeiling?: number,
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
 *   routines: (token: string, organization: string | null) => import('./routines.mjs').RoutinesApi,
 *   uuid: () => string,
 *   launchTimeoutMs?: number,
 *   probe: () => Promise<{ ok: boolean, detail: string }>,
 *   message: (message: { session: string, text: string }) => Promise<LaunchResult>,
 *   review: (run: { system: string, prompt: string, schema: object }) => Promise<LaunchResult>,
 *   transcript: (run: { sessionId: string } & ({ pr: number } | { key: string })) => Promise<{ key: string } | { skipped: string }>,
 *   sleep: (ms: number) => Promise<void>,
 *   archive: import('../scripts/lib/session-signoff.mjs').Archive,
 *   fires?: import('../scripts/lib/session-signoff.mjs').Fires | undefined,
 *   enqueue?: ((message: import('./webhook/fire.mjs').FireMessage, dedupId: string) => Promise<string>) | undefined,
 *   sessions: { list: (token: string, after?: string) => Promise<unknown>, get: (id: string, token: string) => Promise<unknown>, events: import('../scripts/lib/session-signoff.mjs').Events },
 *   state: DispatchState,
 *   hookTable: Pick<import('./webhook/hook-table.mjs').HookTable, 'publish'>,
 *   claims?: Set<string> | undefined,
 *   unrecorded?: Set<PendingRecord> | undefined,
 *   threw?: ((error: unknown) => void) | undefined,
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
 *   `routines`: the routines API and the account's connector list under the
 *   login's access token and organization (dispatch/routines.mjs). `uuid`:
 *   a fresh v4 UUID, for a routine's prompt event.
 *   `sessions`: the sessions API the CLI lists and teleports with, each
 *   answer parsed; a session it does not have is null, any other refusal throws.
 *   `events` is a page of one session's events; any refusal throws.
 *   `state`: the dispatcher's state table ({@link dynamoState}).
 *   `hookTable`: the receiver's hook table (webhook/hook-table.mjs), where
 *   each served repo's hooks and switches are written as its file was read.
 *   `claims`: the tickets the turn claimed that no marker naming a session
 *   covers yet, each `owner/name#number`, shared with dispatch/cli.mjs, whose deadline unwinds
 *   nothing and logs what is left in it.
 *   `unrecorded`: the session records the turn is still writing, shared
 *   with dispatch/cli.mjs, which logs each one left as unrecorded when the
 *   deadline ends the turn or the turn throws, since a write cut off never lands.
 *   `threw`: told the error a turn threw before the turn waits for its
 *   records, shared with dispatch/cli.mjs, whose deadline logs it when a
 *   record write that hangs holds the rejection past it.
 *   `fires`: the fire lane ({@link sqsFires}); without it, a turn never
 *   waits for replies.
 *   `enqueue`: a fire onto that lane, deduplicated by the id given
 *   ({@link sqsEnqueue}): a close's `unblocked` fires. Without it, a close
 *   that blocked an open ticket fails.
 *
 * @typedef {{
 *   cursor: (repo: string, workflow: string, label: string | null) => Promise<import('./runs.mjs').Cursor | null>,
 *   advance: (repo: string, workflow: string, label: string | null, cursor: import('./runs.mjs').Cursor) => Promise<boolean>,
 *   delivered: (repo: string, workflow: string, label: string | null, from: number | null) => Promise<Delivered>,
 *   record: (repo: string, workflow: string, label: string | null, from: number | null, delivered: Delivered) => Promise<void>,
 *   recordConflict: (repo: string, pr: number, merge: string) => Promise<boolean>,
 *   recordSession: (session: string) => Promise<void>,
 *   recordHeld: (session: string) => Promise<boolean>,
 *   recordTold: (session: string, kind: string) => Promise<boolean>,
 *   startedSession: (session: string) => Promise<boolean>,
 *   verdict: (repo: string, pr: number) => Promise<(import('./review.mjs').Verdict & { at: string }) | null>,
 *   recordVerdict: (repo: string, pr: number, read: (import('./review.mjs').Verdict & { at: string }) | null, verdict: import('./review.mjs').Verdict) => Promise<boolean>,
 *   countMessage: (session: string, subject: string | null, kind: string, at: number, ceiling: number) => Promise<import('./deliveries.mjs').Count>,
 * } & import('./periodics.mjs').PeriodicState & import('./pickup.mjs').PickupState & import('./hooks.mjs').HookState & import('./waits.mjs').WaitState} DispatchState
 *   Each label's cursor, by its repo, its workflow's file name and the
 *   label (null for CI's, which earns none): read (null when it has none),
 *   and moved forward (false when a cursor at or past it already stood).
 *   What the turns that started from one cursor (`from`, its run id, null
 *   for none) delivered while it was held: read (empty when none), and
 *   merged into. That PR `pr` of `repo` was told of the conflict
 *   merge `merge` left it in: recorded, false where a record stood.
 *   A periodic's record (dispatch/periodics.mjs): read, and written over
 *   the record the turn read, false where another stood.
 *   A repo's last pickup sweep (dispatch/pickup.mjs): read, and written
 *   unless a later one stood, false then.
 *   A hook's last session (dispatch/hooks.mjs): read, and written over the
 *   record the turn read, false where another stood.
 *   A session governor started, by URL or id: recorded, and read back by
 *   the PR review (dispatch/review.mjs), whichever repo its PR is in.
 *   That the sign-off sweep told a session it held it: recorded, false
 *   where a record stood (scripts/lib/session-signoff.mjs).
 *   That governor told a session of a correction of one kind: recorded,
 *   false where a record stood (dispatch/take.mjs).
 *   A PR review's verdict (dispatch/review.mjs): read, and written over
 *   the item the review read, false where another stood.
 *   One session's count of messages about one subject (`<repo>#<number>`,
 *   or null for none) in the clock hour holding `at`: raised by `kind`
 *   while under `ceiling`, or refused at it with the counts by kind and
 *   whether this is the hour's first refusal (dispatch/deliveries.mjs).
 *   A read or write that fails throws.
 *
 * @typedef {{ told: string[], failed: string[], tickets?: number[] }} Delivered
 *   `told`: each PR whose session heard it, as `<pr> <session>`. `failed`:
 *   a session per send to it that failed, so a session's count is its tries,
 *   and `#<ticket>` per lookup of a ticket's roles that failed. `tickets`:
 *   each ticket a green deploy commented on, whose roles the range owes the
 *   deploy, left out where there are none.
 *
 * @typedef {{ repo: string, issue: number | null, outcome: 'dispatched' | 'unconfirmed' | 'failed', sessionUrl: string | null }} Dispatched
 *   `issue`: null for a launch with no ticket, a periodic's among them.
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

/** The stack's MessageCeiling when unset: messages one session hears about one subject in a clock hour. */
export const MESSAGE_CEILING = 20;

/**
 * How many messages governor sends one session about one issue or PR in a
 * clock hour: the stack's MessageCeiling, {@link MESSAGE_CEILING} when
 * unset. It is a safety limit against a loop, so it is at least one, and
 * anything else is a misconfiguration, said so rather than read as the
 * default.
 *
 * @param {string | undefined} raw
 * @returns {number}
 */
export const messageCeiling = (raw) => {
  if (raw === undefined || raw === '') return MESSAGE_CEILING;
  const ceiling = Number(raw);
  if (!Number.isInteger(ceiling) || ceiling < 1) throw new Error(`MESSAGE_CEILING needs a positive integer, got: ${raw}`);
  return ceiling;
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
 * secret. A throw runs the `finally` below first. `onOver`, a launch's
 * page where it may have started a session nobody can name
 * (dispatch/launcher.mjs), runs before the throw.
 *
 * @template T
 * @param {Promise<T>} launched
 * @param {number} ms
 * @param {string} sessionName
 * @param {() => void} [onOver]
 * @returns {Promise<T>}
 */
const withinBudget = (launched, ms, sessionName, onOver) =>
  new Promise((resolveLaunch, rejectLaunch) => {
    const timer = setTimeout(() => {
      onOver?.();
      rejectLaunch(new Error(`the launcher for ${sessionName} ran past ${ms} ms`));
    }, ms);
    launched.then(
      (value) => { clearTimeout(timer); resolveLaunch(value); },
      (error) => { clearTimeout(timer); rejectLaunch(error); },
    );
  });

/**
 * The turn's launch budget: a call under it, cut to what is left before
 * `until` where the call is one of several sharing a budget. With nothing
 * left it is not started: a child left running past the store-back could
 * refresh the login after it was read. The launcher, message sends and the
 * PR review's model run all spend it, so one is built a turn and handed to
 * each.
 *
 * @param {Pick<Deps, 'launchTimeoutMs' | 'now'>} deps
 * @returns {import('./launcher.mjs').Budgeted}
 */
const budgetedBy = (deps) => async (begin, name, until, onOver) => {
  if (deps.launchTimeoutMs === undefined) return begin();
  const ms = Math.min(deps.launchTimeoutMs, (until ?? Infinity) - deps.now());
  if (ms <= 0) throw new Error(`no budget left to start ${name}: the calls sharing it used it up`);
  return withinBudget(begin(), ms, name, onOver);
};

/**
 * The labels by which an issue a session owns holds its sign-off ask, for a
 * repo's deliveries: its ready labels and its claim label, where its file
 * turns `sessionRules` on. Ownership of an issue lapses at sign-off, so an
 * issue filed in passing, with none of them, does not hold it
 * (docs/constraints/session-signoff.md). With the switch off, nothing: every
 * open row holds the ask, as before.
 *
 * @param {import('./repo-config.mjs').RepoConfig} config
 * @returns {{ holding?: string[] }}
 */
const holdingOf = (config) => (turnsOn(config, 'sessionRules')
  ? { holding: [...config.labels.ready, config.labels.claim].filter((label) => label !== '') }
  : {});

/**
 * One turn, then the sign-off sweep (scripts/lib/session-signoff.mjs): every
 * turn but a probe archives the sessions whose last turn signed off, in the
 * repos it serves whose file turns `signOff` on, with the login as the turn
 * leaves it. A fire naming a
 * repo that is not served does nothing, archiving included; one whose kind
 * the repo's file does not turn on restores the login and only sweeps. A turn that messaged sessions, in a repo
 * that turns `signOff` on, first waits
 * for their replies while no fire is queued (`awaitReplies`), so a sign-off
 * in reply to it is archived by it.
 *
 * Each launch's session record is written in the background, and the turn
 * waits for every one through its launcher's `settle` before it ends,
 * whether it returns or throws:
 * dispatch/cli.mjs takes a throw as the turn's end, and the task may exit
 * straight after (a by-hand turn's at once, the lane's once the lane stays
 * empty), which would cut off a record still being written, and one cut off
 * never lands. A launcher its budget refused may print its session while the
 * turn waits, so the turn waits for that record too, and is marked ended
 * only once no record is left.
 *
 * @param {unknown} event The raw event: EventBridge's, or the by-hand script's.
 * @param {Deps} deps
 */
export const run = async (event, deps) => {
  /** The turn's launcher, once {@link turnOf} builds it: a probe builds none. @type {{ launcher: import('./launcher.mjs').Launcher | null }} */
  const built = { launcher: null };
  try {
    return await turnOf(event, deps, built);
  } catch (error) {
    // Handed over before the wait below: a record write that hangs holds
    // the rejection until the deadline, which then names the error.
    deps.threw?.(error);
    throw error;
  } finally {
    await built.launcher?.settle();
  }
};

/**
 * A served repo's config, its name matched in any case, or undefined for a
 * repo the turn does not serve.
 *
 * @param {import('./repos.mjs').Served[]} served
 * @param {string} repo
 */
const configIn = (served, repo) => served.find((s) => s.repo.toLowerCase() === repo.toLowerCase())?.config;

/**
 * A served repo's config, as {@link configIn} finds it, for a repo the turn
 * must serve: one it does not is a throw.
 *
 * @param {import('./repos.mjs').Served[]} served
 * @param {string} repo
 */
const servedConfig = (served, repo) => {
  const found = configIn(served, repo);
  if (found === undefined) throw new Error(`${repo} is not a repo this turn serves`);
  return found;
};

/**
 * {@link run}'s turn, which hands {@link run} the launcher it builds, so
 * the turn's end waits for its records.
 *
 * @param {unknown} event
 * @param {Deps} deps
 * @param {{ launcher: import('./launcher.mjs').Launcher | null }} built
 */
const turnOf = async (event, deps, built) => {
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
  const readAt = new Date(deps.now()).toISOString();
  /**
   * Each served repo's hooks, key versions and hourly caps, each of its
   * switches as {@link turnsOn} reads it, its ready labels, and the labels
   * whose change can start an issue review ({@link reviewLabelsOf}), as its
   * file reads now, to the receiver's hook table, in one write, so the
   * receiver refuses a revoked key, a removed hook or a fire past the cap
   * before the queue, drops a delivery's fire whose switch is off
   * (dispatch/webhook/switches.mjs), and queues a selection fire only for a
   * ready label and an issue review fire only for a label a review names
   * (dispatch/webhook/route.mjs). It
   * is written before the turn refuses its fire, so a turn whose own switch
   * is off still brings the item up to the file. A write that
   * fails is logged at error and counts the repo unread, and the turn goes
   * on: the receiver queues on the last list meanwhile, and this turn's own
   * checks still refuse a stale key (dispatch/hooks.mjs).
   *
   * @param {import('./repos.mjs').Served[]} list
   * @returns {Promise<Array<{ repo: string, error: string }>>} The repos whose list was not written.
   */
  const publishHooks = async (list) => {
    // One item per repo, so the writes are independent: each goes at once.
    const written = await Promise.all(list.map(async ({ repo: served, config }) => {
      const hooks = turnsOn(config, 'hooks') ? config.hooks.map(({ name, keyVersion, perHour }) => ({ name, keyVersion, perHour: perHour ?? HOOK_PER_HOUR })) : [];
      const switches = Object.fromEntries(SWITCHES.map((name) => [name, turnsOn(config, name)]));
      try {
        await deps.hookTable.publish(served, { hooks, switches, ready: config.labels.ready, reviewLabels: reviewLabelsOf(config), trust: { relay: relayOf(config) }, claim: config.labels.claim }, readAt);
        return null;
      } catch (error) {
        deps.log('hook-table-unwritten', { level: 'error', repo: served, error: messageOf(error) });
        return { repo: served, error: `hook table: ${messageOf(error)}` };
      }
    }));
    return written.filter((w) => w !== null);
  };
  // The bare schedule fire names no repo: it serves every repo it finds.
  // Any other fire names its repo, or parseFire refused it.
  const bare = invocation.kind === 'schedule' && invocation.repo === undefined;
  /** The closing check a `prEdit` fire runs as its `closingPr` fire, where its own switches are off. @type {import('./webhook/fire.mjs').ClosingPrFire & { repo: string } | null} */
  let closingInstead = null;
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
    unread.push(...await publishHooks(served));
  } else {
    if (repo === undefined) throw new Error(`a ${invocation.kind} fire names no repo`);
    const one = await repoServed({ ...reads, repo });
    if (refreshFailed !== null) throw refreshFailed;
    if (one === null) return { kind: invocation.kind, refusal: `${repo} is not served`, signoffs: null };
    unread.push(...await publishHooks([one]));
    // A label the receiver could not judge: not one of the repo's
    // ready labels, the fire ends here, before the login and the sweep.
    if (invocation.kind === 'schedule' && invocation.label !== undefined && !one.config.labels.ready.includes(invocation.label)) {
      const reason = `${invocation.label} is not one of ${repo}'s ready labels (${one.config.labels.ready.join(', ')})`;
      deps.log('dispatch-refused', { level: 'info', repo, kind: invocation.kind, issue: invocation.issue, reason });
      return { kind: invocation.kind, refusal: reason, signoffs: null, ...(unread.length === 0 ? {} : { unread }) };
    }
    served = [one];
    // A `prEdit` fire marked `closing` carries the edit's closing check in
    // place of its own `closingPr` fire: where the file turns a switch the
    // `prEdit` fire needs off, that check runs as the `closingPr` fire would
    // have, under its own switch.
    if (invocation.kind === 'prEdit' && invocation.closing === true && switchesOf(invocation).some((needed) => !turnsOn(one.config, needed))) {
      closingInstead = { kind: 'closingPr', pr: invocation.pr, repo };
    }
    // The first switch the fire needs that the file does not turn on: a
    // `prEdit` fire needs two (switchesOf).
    const name = switchesOf(closingInstead ?? invocation, one.config.workflows).find((needed) => !turnsOn(one.config, needed)) ?? null;
    const relayed = closingInstead === null && (invocation.kind === 'message' || invocation.kind === 'ticket' || invocation.kind === 'offer' || invocation.kind === 'prEdit' || invocation.kind === 'author');
    const unheard = relayed ? unrelayed(invocation, relayOf(one.config)) : null;
    // An unblocked fire's switch is its ticket's state's (dispatch/unblocked.mjs):
    // with both off, no row acts. Its turn still reads the ticket once, for a
    // relative `Blocked until:` line on the close, and refuses after
    // (dispatch/waits.mjs).
    if (name !== null) {
      refusal = `${repo}'s ${CONFIG_PATH} does not turn ${name} on`;
      // A hook fired into a repo that turned hooks off is a caller someone
      // forgot: worth a look, not a page.
      deps.log('dispatch-refused', { level: invocation.kind === 'hook' ? 'warn' : 'info', repo, kind: invocation.kind, reason: refusal });
    } else if (relayed && unheard !== null) {
      // The receiver judged the fire by the repo's hook-table item, which
      // may lag the file, and dropped only an author outside the three. A
      // refusal here is as silent: no comment, no page.
      refusal = unheard;
      deps.log('dispatch-refused', { level: 'info', repo, kind: invocation.kind, session: 'session' in invocation ? invocation.session : null, on: invocation.kind === 'message' ? invocation.on ?? null : invocation.kind === 'prEdit' ? invocation.pr : invocation.kind === 'author' ? invocation.on : invocation.issue, reason: refusal });
    } else if (invocation.kind === 'hook') {
      // The receiver read no file: a hook it lists no more, or a key version
      // it has moved past, is refused here (dispatch/hooks.mjs).
      const found = hookFor(one.config, invocation);
      if ('refusal' in found) {
        refusal = found.refusal;
        deps.log(found.event, { level: found.level, repo, kind: invocation.kind, hook: invocation.hook, keyVersion: invocation.keyVersion, reason: refusal });
      }
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
  /** The turn's one launch budget. */
  const budgeted = budgetedBy(deps);
  /** The turn's one launcher (dispatch/launcher.mjs). */
  const launches = launcher({
    cli: deps.launch,
    routine: routineLaunch({ secret, token: loginToken({ ...deps, secret }, 'start a periodic as a routine run'), routines: deps.routines, log: deps.log, sleep: deps.sleep, uuid: deps.uuid }),
    recordSession: (sessionUrl) => deps.state.recordSession(sessionUrl),
    suffix: (launchRepo) => {
      const own = configIn(served, launchRepo);
      if (own === undefined) return SIGN_POSTS;
      // Rule 1 is the signing rule, so the rules take SIGN_POSTS's place.
      const signing = turnsOn(own, 'sessionRules') ? SESSION_RULES : SIGN_POSTS;
      return turnsOn(own, 'waits') ? `${signing}\n\n${WAIT_PROMPT}` : signing;
    },
    budgeted,
    fireRepo: repo,
    environment: (launchRepo) => servedConfig(served, launchRepo).environment,
    pending: deps.unrecorded,
    log: deps.log,
  });
  built.launcher = launches;
  /** What the turn changes in each repo's governor heartbeat block, written below. @type {RepoBeat[]} */
  const turnBeats = [];
  // The bare fire checks each served repo's session rules block beside the
  // turn's own work, so a slow read holds neither a launch nor the sweep.
  // It catches its own failures, so it never rejects.
  const rulesChecked = bare ? checkRules(deps, tokenFor, served) : Promise.resolve([]);
  /** @type {Awaited<ReturnType<typeof turnFor>>} */
  let turned;
  try {
    turned = await turnFor(closingInstead ?? invocation, {
      ...deps,
      secret,
      githubToken: tokenFor,
      // The launcher in place of the CLI, so nothing below starts a session past it.
      launch: launches.start,
      message: async (message) => {
        const session = sessionId(message.session);
        if (!woken.has(session)) woken.set(session, deps.now());
        const sent = await deps.message(message);
        // An archived session cannot reply: neither wait for it nor defer it.
        // A resend counts too: the first send may have blipped.
        if (refusedAsArchived(sent)) woken.delete(session);
        return sent;
      },
    }, finder, { served, bare, refusal, repo, beats: turnBeats, start: launches.start, budgeted });
  } catch (error) {
    // A periodic that launched has moved its record, so no later fire
    // writes its line: it goes before the turn fails.
    await writeBeats(deps, tokenFor, served, turnBeats);
    throw error;
  }
  // An event a periodic counts: the repo's periodics are checked after the
  // turn's own work, under their own switch, whatever switch that work
  // needed (dispatch/periodics.mjs), as the sweep below runs on every turn.
  const config = served[0]?.config;
  const checked = invocation.counted === undefined || repo === undefined || config === undefined || !turnsOn(config, 'periodics') ? null : await eventPeriodics({
    repo,
    config,
    counted: invocation.counted,
    base: invocation.kind === 'conflicts' ? invocation.base : undefined,
    started,
    carried: 'dispatched' in turned && Array.isArray(turned.dispatched) ? turned.dispatched.filter((d) => d.repo.toLowerCase() === repo.toLowerCase()) : [],
    start: launches.start,
    deps: { ...deps, secret, githubToken: tokenFor, launch: launches.start },
  });
  const eventBeats = checked?.beats ?? [];
  const rulesBeats = await rulesChecked;
  const periodics = checked === null ? null : { dispatched: checked.dispatched, unread: checked.unread };
  // The fires' lines go before the replies and the sweep, which may run
  // into the deadline; the sign-offs' marks after the sweep.
  const beaten = await writeBeats(deps, tokenFor, served, [...turnBeats, ...eventBeats, ...rulesBeats]);
  // Read when called: a turn whose sweep skips never touches `sessions`.
  /** @type {import('../scripts/lib/session-signoff.mjs').Events} */
  const events = (id, token, cursor) => deps.sessions.events(id, token, cursor);
  // Only a repo whose file turns sign-off on has its sessions archived, so
  // only there is a reply worth waiting for.
  const signing = served.filter((s) => turnsOn(s.config, 'signOff')).map((s) => s.repo);
  if (signing.length > 0) await awaitReplies({ fires: deps.fires, woken, login: deps.workspace.readLogin(), started, now: deps.now, sleep: deps.sleep, log: deps.log, events });
  const signoffs = await sweepSignoffs({
    archive: deps.archive,
    login: deps.workspace.readLogin(),
    started,
    now: deps.now,
    log: deps.log,
    woken,
    repos: signing,
    ...heldBy({ ...deps, secret }, served, tokenFor, budgeted, started + SIGNOFF_LATEST_START_MS + SIGNOFF_WINDOW_MS),
    list: (token) => sessionRows((after) => deps.sessions.list(token, after), { log: deps.log }),
    lookup: sweepLookup(deps),
    events,
  });
  // Only a periodic's line names a session, so only those repos are read.
  const marked = signoffs.archived.length === 0 ? { written: [], unwritten: [] } : await writeBeats(deps, tokenFor, served, served.filter((s) => turnsOn(s.config, 'periodics')).map((s) => ({ repo: s.repo, beat: { signedOff: signoffs.archived } })));
  const heartbeatUnwritten = [...beaten.unwritten, ...marked.unwritten];
  const left = [...unread, ...('unread' in turned && Array.isArray(turned.unread) ? turned.unread : [])];
  return {
    ...turned,
    ...('heartbeat' in turned && beaten.written.some((r) => turnBeats.some((b) => b.repo === r && b.beat.pickup !== undefined)) ? { heartbeat: true } : {}),
    ...(left.length === 0 ? {} : { unread: left }),
    ...(periodics === null ? {} : { periodics }),
    ...(heartbeatUnwritten.length === 0 ? {} : { heartbeatUnwritten }),
    signoffs,
  };
};

/**
 * The sweep's view of the PRs a session still owns
 * (scripts/lib/session-signoff.mjs): `holds` reads each repo's open list
 * once, through the reader's `openNaming` under the repo's `trust.relay`,
 * and counts only PRs. `onHeld` tells a held session why, where a repo it
 * names sets `signOff.heldMessage`: it puts the session's held record
 * first, only where none stands, and sends nothing where one did or the
 * put failed, so a session hears it once whatever it does next. The send
 * runs the CLI after the turn stored its login, so a refresh it makes goes
 * back to the secret here, and it ends by `until`, the sweep's own end,
 * which keeps the sweep inside the task's deadline. With no time left
 * before `until`, it writes no record, and a later sweep tells the session.
 *
 * @param {Deps} deps The turn's deps, with the turn's `secret`.
 * @param {import('./repos.mjs').Served[]} served
 * @param {(repo: string) => Promise<string>} tokenFor
 * @param {import('./launcher.mjs').Budgeted} budgeted
 * @param {number} until
 * @returns {{ holds: import('../scripts/lib/session-signoff.mjs').Holds, onHeld: import('../scripts/lib/session-signoff.mjs').OnHeld }}
 */
const heldBy = (deps, served, tokenFor, budgeted, until) => {
  /** @type {Map<string, Promise<Reader>>} */
  const readers = new Map();
  /** @param {string} repo The served repo's own spelling, so the turn's token for it is reused. */
  const readerOf = (repo) => {
    let reader = readers.get(repo);
    if (reader === undefined) readers.set(repo, reader = (async () => deps.reader(await tokenFor(repo), await deps.appId(), repo))());
    return reader;
  };
  return {
    holds: async (session, repos) => {
      /** @type {number[]} */
      const prs = [];
      for (const named of repos) {
        const own = served.find((s) => s.repo.toLowerCase() === named.toLowerCase());
        if (own === undefined) throw new Error(`${named} is not a repo this turn serves`);
        for (const row of await (await readerOf(own.repo)).openNaming(session, relayOf(own.config))) if (row.pull) prs.push(row.number);
      }
      return prs;
    },
    onHeld: async (session, prs, repos) => {
      if (!repos.some((repo) => configIn(served, repo)?.signOff?.heldMessage === true)) return {};
      if (deps.now() >= until) return { told: false, reason: 'no time left in the sweep' };
      // Read before the record, so a failed read leaves the session to be told later.
      const { credentials, account } = readStoredLogin(await deps.secret.get());
      if (!(await deps.state.recordHeld(session))) return { told: false, reason: 'told before' };
      // Counted after the record, which a sweep that holds the session
      // again would otherwise count each time. One the ceiling holds is not
      // told later: the session already hears plenty about its PR, and the
      // ceiling's page has gone. PRs read from more than one repo carry no
      // repo, so they count against the session's pair with no subject.
      const subjects = repos.length === 1 ? prs.map((n) => `${repos[0]?.toLowerCase()}#${n}`) : [];
      const capped = await countAgainst({ count: ({ subject, kind }) => deps.state.countMessage(session, subject, kind, deps.now(), deps.messageCeiling ?? MESSAGE_CEILING), log: deps.log }, session, subjects, 'signoff-held');
      if (capped !== null) return { told: false, reason: `held: ${capped}` };
      try {
        const sent = readSend(await budgeted(() => deps.message({ session, text: heldMessage(prs) }), session, until));
        return sent.ok ? { told: true } : { told: false, error: sent.error };
      } finally {
        await storeIfRefreshed(deps, credentials, account);
      }
    },
  };
};

/**
 * Why the file's `trust.relay` refuses a message fire, or null: the kinds
 * the receiver judged it by (`authors`) that `relay` does not list. A fire
 * queued before the receiver judged by them names none, and was judged by
 * the defaults (dispatch/webhook/fire.mjs).
 *
 * @param {import('./webhook/fire.mjs').MessageFire | import('./webhook/fire.mjs').TicketFire | import('./webhook/fire.mjs').OfferFire | import('./webhook/fire.mjs').PrEditFire | import('./webhook/fire.mjs').AuthorFire} fire
 * @param {readonly string[]} relay
 * @returns {string | null}
 */
const unrelayed = (fire, relay) => {
  const outside = (fire.authors ?? []).filter((kind) => !relay.includes(kind));
  return outside.length === 0 ? null : `the message was judged by ${outside.join(' and ')}, whom the repo's trust.relay (${relay.join(', ') || 'nobody'}) does not let in`;
};

/**
 * @typedef {{ repo: string, beat: import('./heartbeat.mjs').Beat }} RepoBeat
 *   What a turn changes in one repo's governor heartbeat block.
 */

/** A served repo whose file lacks the current session rules block. Logged at warn. */
export const SESSION_RULES_STALE = 'dispatch-session-rules';

/** A served repo whose session rules file could not be read. Logged at warn. */
export const SESSION_RULES_UNREAD = 'dispatch-session-rules-unread';

/**
 * The bare schedule fire's check of each served repo's session rules block
 * (dispatch/session-rules.mjs): where the repo's file turns `sessionRules`
 * on, the file `rulesFile` names, read from the default branch, side by
 * side. A missing or old block logs {@link SESSION_RULES_STALE} at warn and
 * sets the heartbeat's line; a current block clears it, and so does the
 * switch turned off, with no read. A read that fails logs
 * {@link SESSION_RULES_UNREAD} at warn and changes nothing. None of it
 * stops the repo being served or fails the turn, and it pages nobody.
 *
 * @param {Deps} deps
 * @param {(repo: string) => Promise<string>} tokenFor
 * @param {import('./repos.mjs').Served[]} served
 * @returns {Promise<RepoBeat[]>} A line or a clear for each repo whose
 *   heartbeat is on; `writeBeats` writes only where the line changes.
 */
const checkRules = async (deps, tokenFor, served) => {
  const checked = await Promise.all(served.map(async ({ repo, config }) => {
    /** @type {import('./heartbeat.mjs').RulesLine | null} */
    let rules = null;
    if (turnsOn(config, 'sessionRules')) {
      const file = rulesFile(config);
      try {
        const block = blockIn(await deps.configFile(repo, await tokenFor(repo), file) ?? '');
        if (block !== 'current') {
          deps.log(SESSION_RULES_STALE, { level: 'warn', repo, file, block, reason: 'sessions a person starts in this repo are not given the session rules: copy the current block into the file (docs/serving-a-repo.md, The session rules)' });
          rules = { file, block };
        }
      } catch (error) {
        deps.log(SESSION_RULES_UNREAD, { level: 'warn', repo, file, error: messageOf(error), reason: 'the session rules block was not checked, and the heartbeat\'s line stays as it was' });
        return [];
      }
    }
    return turnsOn(config, 'heartbeat') ? [{ repo, beat: { rules } }] : [];
  }));
  return checked.flat();
};

/**
 * Write each repo's changes into its governor heartbeat block
 * (dispatch/heartbeat.mjs), one read and at most one write a repo: only in a
 * repo whose file turns the heartbeat on in the `{ issue }` shape, and only
 * where what the block records changes. A body without governor's marker
 * gets no write and an error naming the repo and issue, so a wrong number
 * never overwrites a ticket. A read or write that fails is logged, leaves
 * the other repos to go, and comes back so the turn fails.
 *
 * @param {Deps} deps
 * @param {(repo: string) => Promise<string>} tokenFor
 * @param {import('./repos.mjs').Served[]} served
 * @param {RepoBeat[]} beats
 * @returns {Promise<{ written: string[], unwritten: string[] }>}
 */
const writeBeats = async (deps, tokenFor, served, beats) => {
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const unwritten = [];
  for (const { repo, config } of served) {
    const heartbeat = config.heartbeat;
    if (!turnsOn(config, 'heartbeat') || heartbeat === undefined || heartbeat.marker !== undefined) continue;
    const own = beats.filter((b) => b.repo.toLowerCase() === repo.toLowerCase()).map((b) => b.beat);
    if (own.length === 0) continue;
    /** @type {import('./heartbeat.mjs').Beat} */
    const beat = {
      ...own.reduce((/** @type {{ pickup?: import('./heartbeat.mjs').PickupLine }} */ p, b) => (b.pickup === undefined ? p : { pickup: b.pickup }), {}),
      periodics: own.flatMap((b) => b.periodics ?? []),
      signedOff: own.flatMap((b) => b.signedOff ?? []),
      ...own.reduce((/** @type {{ rules?: import('./heartbeat.mjs').RulesLine | null }} */ r, b) => (b.rules === undefined ? r : { rules: b.rules }), {}),
    };
    const { issue } = heartbeat;
    // A write that only changes the session rules line pages nobody and
    // fails nothing: that line reports the repo's CLAUDE.md, not governor.
    const rulesOnly = own.every((b) => Object.keys(b).every((k) => k === 'rules'));
    const outcome = await writeHeartbeatIssue({
      reader: async () => deps.reader(await tokenFor(repo), await deps.appId(), repo),
      repo,
      issue,
      marker: HEARTBEAT_MARKER,
      refusal: `the issue's body has no ${HEARTBEAT_MARKER} marker, so the heartbeat is not written: fix the issue number in the repo's ${CONFIG_PATH}, or add the marker to the issue`,
      stamp: (body) => {
        const next = stampHeartbeat(body, beat);
        return JSON.stringify(readHeartbeat(next)) === JSON.stringify(readHeartbeat(body)) ? undefined : next;
      },
      log: deps.log,
      level: rulesOnly ? 'warn' : 'error',
    });
    if (typeof outcome === 'object' && !rulesOnly) unwritten.push(outcome.unwritten);
    if (outcome !== 'written') continue;
    deps.log('dispatch-heartbeat', { repo, issue, ...(beat.pickup === undefined ? {} : { pickup: beat.pickup }), periodics: beat.periodics?.map((p) => p.name), signedOff: beat.signedOff, ...(beat.rules === undefined ? {} : { rules: beat.rules }) });
    written.push(repo);
  }
  return { written, unwritten };
};

/**
 * The periodics an event brought due (dispatch/periodics.mjs), started
 * after the carrying turn's own work, on the login it left restored. Each
 * launch runs under the launch budget and starts only inside
 * {@link EVENT_PERIODIC_WINDOW_MS} of the turn's start, whatever the
 * carrying turn spent; one left unstarted keeps its record, so it is due on
 * the next event or sweep. A cap of 0 starts nothing here either. A login a
 * launch refreshed goes back to the secret.
 *
 * @param {{
 *   repo: string,
 *   config: import('./repo-config.mjs').RepoConfig,
 *   counted: import('./webhook/fire.mjs').Count,
 *   base: string | undefined,
 *   started: number,
 *   carried: Dispatched[],
 *   start: import('./launcher.mjs').Launcher['start'],
 *   deps: Deps,
 * }} args `base`: the default branch, where the fire names it.
 *   `carried`: the carrying turn's own launches in the repo. `start`: the
 *   turn's launcher, which runs each launch under the launch budget.
 * @returns {Promise<{ dispatched: Dispatched[], unread: Array<{ repo: string, error: string }>, beats: RepoBeat[] }>}
 *   `beats`: the heartbeat lines its fires, held fires and nothing-to-dos change.
 */
const eventPeriodics = async ({ repo, config, counted, base, started, carried, start, deps }) => {
  /** @type {Dispatched[]} */
  const dispatched = [];
  /** @type {import('./periodics.mjs').Due[]} */
  let due;
  /** @type {Array<{ repo: string, error: string }>} */
  let unread;
  /** @type {import('./heartbeat.mjs').PeriodicChange[]} */
  let lines;
  /** @type {import('../scripts/lib/claude-login.mjs').LoginAccount | null} */
  let account;
  /** The login the secret holds once the periodics are read. @type {string} */
  let stored;
  // A read before any launch that fails is the check's fault alone: the
  // carrying turn's result and the sign-off sweep still stand.
  try {
    const reader = deps.reader(await deps.githubToken(repo), await deps.appId(), repo);
    ({ due, unread, beats: lines } = await duePeriodics({ repo, periodics: config.periodics, state: deps.state, now: deps.now(), log: deps.log, window: windowOf(reader, base, autoOf(config)), open: runOpen(deps), event: counted }));
    ({ credentials: stored, account } = readStoredLogin(await deps.secret.get()));
  } catch (error) {
    deps.log('dispatch-periodic-unread', { level: 'error', repo, counted, error: messageOf(error), reason: 'the periodics could not be checked: they wait for the next event or sweep' });
    return { dispatched, unread: [{ repo, error: `periodics: ${messageOf(error)}` }], beats: [] };
  }
  // A login on disk the secret does not hold goes back to it, whatever
  // starts: a refresh to read a last run's session (`runOpen`) may have
  // rotated it and failed to write it back.
  try {
    return await startPeriodics({ repo, config, counted, started, carried, start, deps, due, unread, dispatched, lines });
  } finally {
    await storeIfRefreshed(deps, stored, account);
  }
};

/**
 * The due periodics {@link eventPeriodics} read, started in turn.
 *
 * @param {{
 *   repo: string,
 *   config: import('./repo-config.mjs').RepoConfig,
 *   counted: import('./webhook/fire.mjs').Count,
 *   started: number,
 *   carried: Dispatched[],
 *   start: import('./launcher.mjs').Launcher['start'],
 *   deps: Deps,
 *   due: import('./periodics.mjs').Due[],
 *   unread: Array<{ repo: string, error: string }>,
 *   dispatched: Dispatched[],
 *   lines: import('./heartbeat.mjs').PeriodicChange[],
 * }} args `lines`: the heartbeat lines the read changed, which each fire adds to.
 * @returns {Promise<{ dispatched: Dispatched[], unread: Array<{ repo: string, error: string }>, beats: RepoBeat[] }>}
 */
const startPeriodics = async ({ repo, config, counted, started, carried, start, deps, due, unread, dispatched, lines }) => {
  const beats = () => (lines.length === 0 ? [] : [{ repo, beat: { periodics: lines } }]);
  if (due.length === 0) return { dispatched, unread, beats: beats() };
  const why = deps.cap === 0 ? CAP_ZERO_REASON
    : carried.length > 0 && carried.every((d) => d.outcome === 'failed') ? 'the turn\'s own launch in this repo started nothing, and a periodic\'s would fail the same way: each stays due for the next event or sweep'
      : null;
  if (why !== null) {
    logNotStarted(deps.log, repo, due, why);
    return { dispatched, unread, beats: beats() };
  }
  const ordered = due.sort((a, b) => a.due - b.due);
  for (const [i, { periodic, read, by, windows, asOf }] of ordered.entries()) {
    if (deps.now() - started > EVENT_PERIODIC_WINDOW_MS) {
      logNotStarted(deps.log, repo, ordered.slice(i), `out of time: past ${EVENT_PERIODIC_WINDOW_MS} ms into the turn, a launch might outrun the deadline; each stays due for the next event or sweep`);
      break;
    }
    const firedAt = new Date(deps.now()).toISOString();
    const launched = await start({ prompt: periodicPrompt(periodic.prompt, read, windows), sessionName: periodic.name, model: DEFAULT_MODEL, repo, environment: config.environment, ...connectorsOf(periodic) });
    if (routineFault(deps, repo, periodic.name, launched)) continue;
    const { status, outcome, sessionUrl } = launched;
    deps.log('dispatch-launch', { repo, issue: null, sessionName: periodic.name, periodic: periodic.name, counted, outcome, status, sessionUrl });
    dispatched.push({ repo, issue: null, outcome, sessionUrl });
    if (outcome === 'failed') {
      // As on the sweep: the next launch would fail the same way.
      deps.log(REPO_SKIPPED, { level: 'error', repo, issue: null, periodic: periodic.name, status, reason: 'its launch started nothing: the rest of its periodics wait for the next fire' });
      break;
    }
    const unrecorded = await recordFire(deps, repo, { name: periodic.name, read }, asOf ?? firedAt, sessionUrl);
    if (unrecorded !== null) unread.push(unrecorded);
    lines.push({ name: periodic.name, at: asOf ?? firedAt, by, session: sessionUrl, state: 'open' });
  }
  return { dispatched, unread, beats: beats() };
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
 * The login's access token, read at most once: the one on disk, or the
 * stored login refreshed where that has expired. A refresh that fails
 * throws, saying what the token was for.
 *
 * @param {Deps} deps
 * @param {string} what
 * @returns {() => Promise<string>}
 */
const loginToken = (deps, what) => {
  /** @type {Promise<string> | null} */
  let token = null;
  return () => (token ??= (async () => {
    let usable = accessToken(deps.workspace.readLogin(), deps.now());
    if ('reason' in usable) {
      const { credentials, account } = readStoredLogin(await deps.secret.get());
      usable = await refreshedLogin(deps, credentials, account);
    }
    if ('reason' in usable) throw new Error(`cannot ${what}: ${usable.reason}`);
    return usable.token;
  })());
};

/**
 * Whether a periodic's last run is still open (dispatch/periodics.mjs): its
 * session's own record, read under the login's token, is neither archived,
 * by the sign-off sweep or by hand, nor gone (null, as a 404 answers).
 * The sweep's candidates are idle, unarchived sessions only, so the hold
 * reads the session's state itself rather than wait for the sweep. An
 * expired token is refreshed once a turn, as for the environment list: a
 * quiet repo may launch nothing that would refresh it. A record that
 * carries no status, or a refresh that fails, throws: the periodic is
 * refused, never taken for a finished run.
 *
 * @param {Deps} deps
 * @returns {import('./periodics.mjs').Open}
 */
const runOpen = (deps) => {
  const tokenOf = loginToken(deps, 'read the last run\'s session');
  return async (session) => {
    const id = /^session_([A-Za-z0-9]+)$/.exec(sessionId(session))?.[1];
    if (id === undefined) throw new Error(`the last run's session is not a session link: ${session}`);
    const row = sessionRecord(await deps.sessions.get(`cse_${id}`, await tokenOf()));
    if (row === null) return false;
    const fields = /** @type {Record<string, unknown>} */ (typeof row === 'object' ? row : {});
    if (typeof (fields.session_status ?? fields.status) !== 'string') throw new Error(`the last run's session record carries no status: it ${typeof row === 'object' ? `has ${Object.keys(fields).join(', ')}` : `is ${typeof row}`}`);
    return !archived(row);
  };
};

/**
 * What the fire kinds that start sessions (schedule, hook, unblocked and
 * dispatch) read of the turn: `turnFor` builds one from its closures and
 * arguments, and those branches read the turn through it alone, so each can
 * move into a planner of its own handed `(invocation, ctx)`.
 *
 * @typedef {{
 *   readerFor: (repo: string) => Promise<Reader>,
 *   configOf: (repo: string) => import('./repo-config.mjs').RepoConfig,
 *   served: import('./repos.mjs').Served[],
 *   bare: boolean,
 *   prompts: import('./repo-config.mjs').RepoConfig['prompts'] | {},
 *   delivery: (repo?: string) => ReturnType<typeof turnDeliveries>,
 *   storeLogin: () => Promise<boolean>,
 *   state: DispatchState,
 *   start: import('./launcher.mjs').Launcher['start'],
 *   open: import('./periodics.mjs').Open,
 *   claims: Set<string>,
 *   beats: RepoBeat[],
 *   now: Deps['now'],
 *   log: Deps['log'],
 *   sleep: Deps['sleep'],
 *   cap: number,
 *   findAuthor: import('./author.mjs').FindAuthor,
 *   findEditor: import('./editor.mjs').FindEditor,
 * }} TurnContext
 *   `readerFor`: a repo's reader, one a turn. `configOf`: a served repo's
 *   config. `prompts`: the fire's repo's, none for the bare schedule fire.
 *   `delivery`: whom a message reaches, and the send, in the fire's repo
 *   or the served repo named. `storeLogin`: the
 *   login the CLI refreshed, put back. `start`: the launcher's. `open`:
 *   whether a periodic's or a hook's last session is still open, under a
 *   token refreshed once a turn. `claims`: the tickets the turn claimed that
 *   no marker covers yet ({@link Deps}). `beats`: where the bare fire adds
 *   its heartbeat lines, for `run` to write. `findAuthor`: the search of
 *   the login's live sessions for a session's unsigned post in the fire's
 *   repo (dispatch/author.mjs). `findEditor`: the search for who made a
 *   body edit on an issue in the fire's repo, its owner first
 *   (dispatch/editor.mjs).
 */

/**
 * @typedef {{
 *   repo: string,
 *   issue: number | null,
 *   claim: boolean,
 *   holdsRepo: boolean,
 *   asked: import('./launcher.mjs').Asked,
 *   periodic?: string,
 *   started?: (outcome: import('./launcher.mjs').Started, firedAt: string) => Promise<void>,
 *   ask?: () => Promise<{ outcome: import('./deliveries.mjs').LaunchOutcome, sessionUrl: string | null } | null>,
 *   told?: boolean,
 * }} PlannedLaunch
 *   One session a planner wants started, on `asked`, which the launcher's
 *   `start` takes with the repo. `claim`: the ticket is claimed
 *   before the launch and released on a failure (a picked-up ticket, not a
 *   spec session). A claimed ticket's launch leaves a dispatch comment
 *   naming its builder; an unclaimed one, a spec session, is written into
 *   the ticket's body as its owner instead, and the turn that posts the
 *   comment tells the ticket's spec owner of its new builder, unless `told`:
 *   the plan's own `done` sends the spec owner one message naming it.
 *   `holdsRepo`: a failed launch skips the repo's later
 *   launches (a ticket's or a periodic's). `periodic`: the periodic's name,
 *   which its launch line and a repo skip's line carry. `started`: the
 *   record this launch moves, called after the launch line with what the
 *   launch printed and when it was fired, unless a routine fault skipped it.
 *   `ask`: a message sent in place of the launch, whose fallback is `asked`
 *   and names itself in the ticket's body. It settles its own records, and answers the
 *   fallback's launch, or null where none was tried.
 *
 * @typedef {{
 *   launches: PlannedLaunch[],
 *   unread: Array<{ repo: string, error: string }>,
 *   done?: (ran: { dispatched: Array<Dispatched & { planned: PlannedLaunch }>, left: PlannedLaunch[] }) => Promise<void>,
 *   result?: Record<string, unknown>,
 * } | { answer: { kind: import('./webhook/fire.mjs').Fire['kind'], dispatched: Dispatched[], loginStored?: boolean, messaged?: import('./deliveries.mjs').Delivery | null, row?: import('./unblocked.mjs').Row, refusal?: string, commented?: boolean, announced?: number[] } }} Plan
 *   What a planner for a fire kind that starts sessions hands the turn
 *   (`planSweep` in dispatch/sweep.mjs, `planHook` in dispatch/hooks.mjs, `planUnblocked` in
 *   dispatch/unblocked-fire.mjs, `planDispatch` in dispatch/dispatch-fire.mjs, `planTicket` in dispatch/ticket-fire.mjs). `unread`: what failed the turn, which
 *   `started` and `done` may add to. `done`: called after every launch, with
 *   the launches that ran, a failed claim's included, and what the launch
 *   window or a repo skip left unstarted. `result`: the
 *   kind's own fields in the turn's result. `answer`: the turn's whole
 *   result where the kind starts nothing.
 */

/**
 * The turn itself, for the fire's repo, or every served repo for the bare
 * schedule fire.
 *
 * @param {import('./webhook/fire.mjs').Fire} invocation
 * @param {Deps} deps
 * @param {(token: string) => import('../scripts/lib/session-branch.mjs').FindOnBranch} finder
 * @param {{ served: import('./repos.mjs').Served[], bare: boolean, refusal: string | null, repo: string | undefined, beats: RepoBeat[], start: import('./launcher.mjs').Launcher['start'], budgeted: import('./launcher.mjs').Budgeted }} scope
 *   `repo`: the fire's, none for the bare schedule fire. `beats`: where the
 *   bare fire adds what it changes in each repo's governor heartbeat block,
 *   for `run` to write, whether the turn returns or throws. `start`: the
 *   turn's launcher, through which every session it starts goes.
 *   `budgeted`: the turn's launch budget, which message sends and the PR
 *   review's model run share with the launcher.
 */
const turnFor = async (invocation, deps, finder, { served, bare, refusal, repo, beats, start, budgeted }) => {
  if (invocation.kind === 'probe') throw new Error('a probe is not a turn: run answers it');
  /**
   * The fire's repo. The bare schedule fire names none, and reads
   * only the served repos it found; nothing falls back to a default repo.
   */
  const fireRepo = () => fireRepoOf({ kind: invocation.kind, repo });
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
  // An event a periodic counts that queued no other fire: its check is the
  // whole turn, and runs after this (`run`).
  if (invocation.kind === 'periodics') return { kind: invocation.kind };

  /**
   * A served repo's config: the fire's repo's, or, in the bare schedule
   * fire, each launch's.
   *
   * @param {string} repo
   */
  const configOf = (repo) => servedConfig(served, repo);

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
  // names no repo, and sends only in a served repo it names (`delivery`).
  const prompts = repo === undefined ? {} : configOf(repo).prompts;
  /** @type {ReturnType<typeof turnDeliveries> | null} */
  let made = null;
  /**
   * One repo's deliveries: its prompts, sign-off, reader and repo, with the
   * turn's send, launcher and sessions finder.
   *
   * @param {Pick<import('./deliveries.mjs').DeliveryDeps, 'prompts' | 'signOff' | 'reader' | 'repo' | 'relay' | 'claim' | 'launch'>} own
   */
  const deliveriesOf = (own) => turnDeliveries({
    ...own,
    send: (message, until) => budgeted(() => deps.message(message), message.session, until),
    count: ({ session, subject, kind }) => deps.state.countMessage(session, subject, kind, deps.now(), deps.messageCeiling ?? MESSAGE_CEILING),
    sessions: sessionsFinder,
    now: deps.now,
    log: deps.log,
    sleep: deps.sleep,
    launchTimeoutMs: deps.launchTimeoutMs,
  });
  /** Each other served repo's deliveries, made on first use. @type {Map<string, ReturnType<typeof turnDeliveries>>} */
  const others = new Map();
  /**
   * The fire's repo's deliveries, or, given `served`, a served repo's: the
   * bare schedule fire names no repo, and messages a ticket's owner in
   * the ticket's repo, under that repo's reader and prompts, and starts
   * a fallback there. There it reaches a session by its link only: finding
   * one by a PR's head branch throws, since the sessions finder is the
   * fire's repo's.
   *
   * @param {string} [served]
   */
  const delivery = (served) => {
    if (served === undefined) {
      return (made ??= deliveriesOf({ prompts, signOff: repo !== undefined && turnsOn(configOf(repo), 'signOff'), reader: getReader, repo: fireRepo(), relay: repo === undefined ? RELAY : relayOf(configOf(repo)), ...(repo === undefined ? {} : { claim: configOf(repo).labels.claim, ...holdingOf(configOf(repo)) }), launch: start }));
    }
    let other = others.get(served);
    if (other === undefined) {
      const config = configOf(served);
      others.set(served, other = deliveriesOf({
        prompts: config.prompts,
        signOff: turnsOn(config, 'signOff'),
        reader: () => readerFor(served),
        repo: served,
        relay: relayOf(config),
        claim: config.labels.claim,
        ...holdingOf(config),
        launch: (launch, until) => start({ ...launch, repo: served }, until),
      }));
    }
    return other;
  };

  /** The login's token for the author search, read at most once a turn. */
  const authorToken = loginToken(deps, 'search the sessions for a post\'s author');
  /**
   * What a search of the login's live sessions in the fire's repo reads,
   * under the login's token, refreshed once where it has expired: the
   * search runs before any send, so no CLI has refreshed it yet. Rejects
   * where the refresh fails.
   */
  const sessionSearch = async () => {
    const token = await authorToken();
    return {
      list: () => sessionRows((after) => deps.sessions.list(token, after), { log: deps.log }),
      /** @param {string} id @param {string | undefined} [cursor] */
      events: (id, cursor) => deps.sessions.events(id, token, cursor),
      repo: fireRepo(),
    };
  };
  /**
   * The search for the author of a session's unsigned post in the fire's
   * repo (dispatch/author.mjs). An author fire sends nothing else. A
   * refresh that fails, or a list that cannot be read, is no search.
   *
   * @type {import('./author.mjs').FindAuthor}
   */
  const findAuthor = async (on, post) => {
    let search;
    try {
      search = await sessionSearch();
    } catch (error) {
      return { searched: false, reason: messageOf(error) };
    }
    return searchAuthor({ ...search, on, post });
  };
  /**
   * The search for who made a body edit on an issue in the fire's repo,
   * the owner first (dispatch/editor.mjs). A refresh that fails reads no
   * events: the owner hears the edit as before.
   *
   * @type {import('./editor.mjs').FindEditor}
   */
  const findEditor = async (on, edit, owner) => {
    let search;
    try {
      search = await sessionSearch();
    } catch (error) {
      return { by: 'unknown', reason: messageOf(error) };
    }
    return searchEditor({ ...search, owner, on, edit });
  };

  if (invocation.kind === 'message') {
    const { on, event, commit, closing, text, fallback } = invocation;
    // A session's unsigned post, under sessionRules: its author is searched
    // for before the relay, which then drops its UNSIGNED line, and is not
    // relayed its own post (dispatch/author.mjs).
    const post = invocation.unsigned !== undefined && on !== undefined && repo !== undefined && turnsOn(configOf(repo), 'sessionRules') ? invocation.unsigned : null;
    /** @type {import('./author.mjs').Found | null} */
    let found = null;
    /** The author's nudge, or each candidate's. @type {import('./deliveries.mjs').Delivery[]} */
    let nudged = [];
    /** @type {import('./deliveries.mjs').Delivery} */
    let told = { ok: false, answered: null, refused: false, sessionUrl: null, error: null, fallback: null, dropped: null, skipped: null, relinked: null };
    let loginStored = false;
    /** The offer of the issue to the session that commented, where its owner refused. @type {import('./deliveries.mjs').Delivery | null} */
    let offered = null;
    // A body edit that moved the issue's owner link, under sessionRules: the
    // notice goes to the old owner, not to the session the new body names,
    // which made the edit (dispatch/take.mjs).
    const moved = invocation.moved !== undefined && 'session' in invocation && on !== undefined && repo !== undefined && turnsOn(configOf(repo), 'sessionRules') ? invocation.moved : null;
    /** The take's confirmation or the correction. @type {import('./deliveries.mjs').Delivery | null} */
    let took = null;
    // A body edit that left the owner link in place, under sessionRules:
    // who made it is searched for, the owner first, and the owner is not
    // told of its own edit (dispatch/editor.mjs).
    const edit = invocation.edited !== undefined && moved === null && 'session' in invocation && on !== undefined && repo !== undefined && turnsOn(configOf(repo), 'sessionRules') ? invocation.edited : null;
    /** @type {import('./editor.mjs').EditFound | null} */
    let edited = null;
    try {
      if (post !== null && on !== undefined) found = await findAuthor(on, post);
      if (edit !== null && on !== undefined && 'session' in invocation) edited = await findEditor(on, edit, invocation.session);
      if (moved !== null && moved.from === undefined) {
        told = { ...told, skipped: 'the old body named no owner to tell of the edit' };
      } else if ('session' in invocation && wroteIt(found, invocation.session)) {
        told = { ...told, skipped: 'the session wrote the post, unsigned: it is told to sign it instead' };
      } else if (edited?.by === 'owner') {
        told = { ...told, skipped: 'the session made the edit itself: it is not told of its own edit' };
      } else told = await delivery().deliver(
        'byBranch' in invocation ? { pr: invocation.on, ...(invocation.poster === undefined ? {} : { poster: invocation.poster }) } : { session: moved?.from ?? invocation.session },
        editedText(relayedText(text, found), edited),
        {
          source: GITHUB_SOURCE,
          kind: 'relay',
          fallback,
          takeover: true,
          on: on === undefined ? [] : [on],
          closing: closing === true,
          dropFrom: event === undefined || on === undefined ? [] : [on],
          commit,
          // The owner's message, not a subscriber's: an archived owner's
          // goes to the live session on the PR's head branch.
          owns: on === undefined || invocation.subscribed === true ? [] : [on],
        },
      );
      // An issue's owner refused as archived: nobody owns the issue, so the
      // session that signed the comment is offered it, unless it builds the
      // ticket (dispatch/offer.mjs). The ticket is read only here.
      if (told.refused && invocation.offer !== undefined && on !== undefined && repo !== undefined) {
        offered = await offerAfterRefusal({ repo, issue: on, session: invocation.offer, config: configOf(repo), reader: getReader, deliveries: delivery(), log: deps.log });
      }
      if (moved !== null && 'session' in invocation && on !== undefined && repo !== undefined) {
        took = await takeAfterNotice({
          repo,
          issue: on,
          editor: invocation.session,
          moved,
          notice: moved.from === undefined ? null : told,
          config: configOf(repo),
          reader: getReader,
          tellOnce: (session, kind) => deps.state.recordTold(session, kind),
          deliveries: delivery(),
          log: deps.log,
        });
      }
      if (post !== null && found !== null && on !== undefined && repo !== undefined) {
        nudged = await tellAuthor({ repo, on, post, found, tellOnce: (session, kind) => deps.state.recordTold(session, kind), deliveries: delivery(), log: deps.log });
      }
      if (edit !== null && edited !== null && on !== undefined && repo !== undefined) {
        nudged = [...nudged, ...await tellEditor({ repo, on, edit, edited, tellOnce: (session, kind) => deps.state.recordTold(session, kind), deliveries: delivery(), log: deps.log })];
      }
    } finally {
      loginStored = await storeIfRefreshed(deps, original, account);
    }
    // The session is gone and nothing else was tried: the dispatcher reached
    // it with a live login, so the refusal is the caller's to read, not a
    // dispatcher failure (dispatch/cli.mjs). Any other answer with ok:false
    // (a revoked login, a 5xx), or a fallback that was tried, stays one.
    const archived = told.refused && told.fallback === null;
    return { kind: 'message', ...told, archived, loginStored, ...(offered === null ? {} : { offered }), ...(took === null ? {} : { took }), ...(nudged.length === 0 ? {} : { nudged }) };
  }

  // A red run on the default branch, or a shipping job that succeeded there: the PR(s)
  // it is about hear it in the session that wrote them and each subscribed
  // to it (dispatch/workflow.mjs), and a job's tickets get its label. Whom
  // nobody hears of, and why, is a `dispatch-workflow` line, or
  // `dispatch-stale-runs` when the runs list was stale.
  if (invocation.kind === 'workflow' || invocation.kind === 'job') {
    /** @type {Array<{ prs: number[], session: string } & Omit<import('./deliveries.mjs').Delivery, 'sessionUrl' | 'dropped' | 'skipped' | 'relinked'>>} */
    const deliveries = [];
    /** @type {string | null} */
    let reason = null;
    /** @type {{ outcome: Dispatched['outcome'], sessionUrl: string | null } | null} */
    let triage = null;
    let loginStored = false;
    /** @type {Omit<NonNullable<Awaited<ReturnType<typeof labelTickets>>>, 'commented'> | null} */
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
        coverage = await coverageOf({ invocation, reader, repo: fireRepo(), workflows, relay: relayOf(config), sleep: deps.sleep, cursor: (file, label) => deps.state.cursor(fireRepo(), file, label), onBranch: delivery().onBranch });
      } catch (error) {
        if (invocation.kind === 'job') deps.log('dispatch-labels', { ...about, error: messageOf(error) });
        throw error;
      }
      /** @type {Commented[]} */
      let commented = [];
      if (turnsOn(config, 'deployedLabels')) {
        const labelled = await labelTickets(invocation, reader, coverage, deps, about);
        if (labelled !== null) {
          const { commented: those, ...rest } = labelled;
          labels = rest;
          commented = those;
        }
      }
      /** @type {import('./workflow.mjs').TargetPlan} */
      let plan = await planWorkflow({ invocation, coverage, prompts, workflows });
      reason = plan.reason;
      // A green shipping job tells the roles of each ticket it commented
      // on, beside the PRs' sessions: one turn decides who hears the deploy.
      const ticketed = invocation.kind === 'job' && plan.deploy !== undefined && turnsOn(config, 'deployedLabels');
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
      if (plan.advance !== null && (plan.notes.length > 0 || ticketed)) {
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
      /** Each lookup of a ticket's roles that failed this turn, as `#<ticket>`. @type {string[]} */
      const unlooked = [];
      /** The tickets whose roles the range owes the deploy. @type {number[]} */
      let owedTickets = [];
      if (before !== null && ticketed) {
        // Recorded before any send: a turn that dies sending still leaves
        // the next one the tickets it commented on, which it finds labelled.
        // With no cursor, the range's baseline is pinned first, or the next
        // run's range would start past this one and never read the record.
        if (commented.length > 0) {
          try {
            if (pin !== null) {
              await deps.state.advance(fireRepo(), workflow, label, pin);
              pin = null;
            }
            await deps.state.record(fireRepo(), workflow, label, from?.runId ?? null, { told: [], failed: [], tickets: commented.map((c) => c.ticket) });
          } catch (error) {
            // The sends still go, and the hold path records the tickets
            // again; the turn fails, since a death before then loses them.
            for (const { ticket } of commented) (labels ??= { label: coverage.label ?? '', added: [], failed: [] }).failed.push({ ticket, error: `could not record it before the sends: ${messageOf(error)}` });
            deps.log('dispatch-labels', { ...about, tickets: commented.map((c) => c.ticket), error: `could not record the tickets commented on before the sends: ${messageOf(error)}` });
          }
        }
        owedTickets = [...new Set([...(before.tickets ?? []), ...commented.map((c) => c.ticket)])].sort((a, b) => a - b);
        const tried = before.failed.map(sessionId);
        const looked = await shippedRolesOf(owedTickets.filter((t) => tried.filter((f) => f === `#${t}`).length < WORKFLOW_SEND_TRIES), {
          invocation, coverage, commented, reader, config, ownerOf: (pr) => delivery().ownerOf(pr),
        });
        for (const { ticket, error } of looked.failed) {
          const gaveUp = tried.filter((f) => f === `#${ticket}`).length + 1 >= WORKFLOW_SEND_TRIES;
          unlooked.push(`#${ticket}`);
          (labels ??= { label: coverage.label ?? '', added: [], failed: [] }).failed.push({ ticket, error });
          deps.log('dispatch-labels', { ...about, ticket, error: `could not find its roles, so they are ${gaveUp ? `given up on after ${WORKFLOW_SEND_TRIES} turns` : 'owed the deploy by the next turn'}: ${error}` });
        }
        if (looked.skipped.length > 0) deps.log('dispatch-labels', { ...about, tickets: looked.skipped, reason: 'owed the deploy by the record, but no PR this range shipped closes them: nobody to tell of them' });
        plan = withTickets(plan, looked.found);
      }
      if (before !== null) {
        if (plan.triage !== null) {
          const launched = await start({ prompt: fromDispatcher(plan.triage.prompt, GITHUB_SOURCE), sessionName: plan.triage.sessionName, model: DEFAULT_MODEL });
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
        const now = { told: [], failed: [...unlooked], tickets: owedTickets };
        // A lookup that failed leaves its ticket's roles untold.
        let untold = unlooked.filter((t) => tries(t) + 1 < WORKFLOW_SEND_TRIES).length;
        for (const [i, note] of owed.entries()) {
          if (deps.now() - started > WORKFLOW_SEND_WINDOW_MS) {
            untold += owed.length - i;
            deps.log('dispatch-workflow', { ...about, untold: owed.slice(i).map((n) => ({ session: n.session, prs: n.prs })), reason: `out of time: past ${WORKFLOW_SEND_WINDOW_MS} ms, another delivery might outrun the deadline` });
            break;
          }
          const { ok, answered, refused, error, fallback, capped } = await delivery().deliver({ session: note.session }, note.text, { source: GITHUB_SOURCE, kind: invocation.kind === 'job' ? 'deploy' : 'ci', fallback: note.fallback, on: [...note.prs, ...(note.about ?? []), ...(note.tickets ?? [])], closing: note.closing, dropFrom: note.subscribed, owns: note.owns ?? note.prs.filter((n) => !note.subscribed.includes(n)) });
          // A note held at the ceiling is no fault (dispatch/cli.mjs), and stays owed to a later run.
          deliveries.push({ prs: note.prs, session: note.session, ok, answered, refused, error, fallback, ...(capped ? { capped } : {}) });
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
  // it tested, or the newest live session holding the branch, hears it, with no
  // fallback (dispatch/branch-run.mjs). A `dispatch-branch-run` line says
  // whom, or why nobody.
  if (invocation.kind === 'branch-run') {
    /** @type {Array<{ prs: number[], session: string } & Omit<import('./deliveries.mjs').Delivery, 'sessionUrl' | 'dropped' | 'skipped' | 'relinked'>>} */
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
        const { ok, answered, refused, error, fallback, capped } = await delivery().deliver({ session: plan.session }, plan.text, { source: GITHUB_SOURCE, kind: 'branch-run' });
        deliveries.push({ prs: [], session: plan.session, ok, answered, refused, error, fallback, ...(capped ? { capped } : {}) });
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
        auto: autoOf(configOf(fireRepo())),
      }));
      for (const check of checks) deps.log('dispatch-conflicts', { merged: invocation.pr, sha: invocation.sha, head, ...check });
    } finally {
      loginStored = await storeIfRefreshed(deps, original, account);
    }
    return { kind: 'conflicts', head, checks, loginStored };
  }

  // The PR review: one PR, the open PRs at one commit, or every open one, through the checklist. No
  // run but the CI workflow's at the PR's head holds a merge. Each run's transcript goes to the drop
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
      const config = configOf(fireRepo());
      const { review, labels, workflows } = config;
      const trusted = reviewOf(config);
      // The schema holds a section wherever prReview is on, and the switch was checked.
      if (review === undefined) throw new Error(`${fireRepo()}'s ${CONFIG_PATH} has no prReview section with a prompt`);
      const base = await github.defaultBranch();
      // A fire naming the PR reviews it; one carrying a commit alone, from a
      // check run, a status or a run whose payload may list no PR, reviews
      // each open PR at that head as if named; one with neither, every open PR.
      const { pr, headSha } = invocation;
      const targets = pr !== undefined
        ? [{ number: pr, ...(headSha === undefined ? {} : { headSha }) }]
        : headSha !== undefined
          ? (await github.openPulls()).filter((p) => p.headSha === headSha).map((p) => ({ number: p.number, headSha, byCommit: true }))
          : (await github.openPulls()).filter((p) => !p.draft).map((p) => ({ number: p.number }));
      // What each PR's run spent, for its log line: a run that reports
      // nothing leaves the line without it.
      /** @type {Map<number, import('./checklist.mjs').Usage>} */
      const spent = new Map();
      const judge = cliJudge({
        skill: review.checklist,
        run: (request, pr) => budgeted(() => deps.review(request), `review #${pr}`),
        transcript: deps.transcript,
        log: deps.log,
        spent: (pr, usage) => { spent.set(pr, usage); },
      });
      // Each new comment's owner hears it from this turn: its message goes
      // onto the lane as a `message` fire, which runs as a turn of its own,
      // so the send and any takeover have their own deadline however late in
      // a sweep the comment was posted. The relay sends the comment itself
      // to nobody. With prMessages off, nobody is told, as before.
      /** @type {import('./review.mjs').Tell} */
      const tell = async (n, comment, message) => {
        if (!turnsOn(config, 'prMessages')) return `${fireRepo()}'s ${CONFIG_PATH} does not turn prMessages on: no session is told`;
        if (deps.enqueue === undefined) throw new Error(`this turn has no fire lane to queue #${n}'s message to its owner on`);
        await deps.enqueue({ fire: { ...message, repo: fireRepo() }, reason: `the PR review commented on ${fireRepo()}#${n}: its message to the PR's owner` }, ownerMessageId(fireRepo(), n, comment, started));
        return "queued for the PR's owner";
      };
      for (const [i, target] of targets.entries()) {
        // Past the window no review starts: each PR left gets a `failure`
        // check, through the review's usual skips, so a ruleset requiring
        // `governor` does not wait on one that never comes. Past the second
        // limit nothing more is written.
        const spentMs = deps.now() - started;
        if (spentMs > REVIEW_MARK_WINDOW_MS) {
          deps.log('dispatch-review', { unreviewed: targets.slice(i).map((t) => t.number), reason: `out of time: past ${REVIEW_MARK_WINDOW_MS} ms, another check might outrun the deadline; each is reviewed on its next push or edit` });
          break;
        }
        const outOfTime = spentMs > REVIEW_WINDOW_MS;
        const reviewed = await reviewPull({ ...target, reader: github, judge, sleep: deps.sleep, review, labels, base, started: deps.state.startedSession, verdicts: { read: (n) => deps.state.verdict(fireRepo(), n), record: (n, read, verdict) => deps.state.recordVerdict(fireRepo(), n, read, verdict) }, trusted, outOfTime, tell, ...(workflows.ci === undefined || !review.waitForCi ? {} : { ci: workflows.ci }) });
        const usage = spent.get(reviewed.pr);
        // An owner's message the lane refused warns while a later review
        // turn will try it again, and is an error on its last try, which
        // fails the turn and drops it.
        const level = reviewed.untold !== undefined ? 'error' : reviewed.owed !== undefined ? 'warn' : undefined;
        deps.log('dispatch-review', { ...(level === undefined ? {} : { level }), ...reviewed, ...(usage === undefined ? {} : { usage }) });
        reviews.push(reviewed);
      }
    } finally {
      loginStored = await storeIfRefreshed(deps, original, account);
    }
    return { kind: 'review', reviews, loginStored };
  }

  // The issue reviews: each review the repo lists whose selector the
  // issue meets and whose marker its body has moved past, one `claude -p`
  // apiece with no tools (dispatch/issue-review.mjs).
  if (invocation.kind === 'issueReview') {
    let loginStored = false;
    /** @type {{ reviews: import('./issue-review.mjs').Reviewed[], skipped?: string }} */
    let reviewed;
    try {
      reviewed = await reviewIssue({
        repo: fireRepo(),
        issue: invocation.issue,
        reader: await getReader(),
        config: configOf(fireRepo()),
        run: (request, label) => budgeted(() => deps.review(request), label),
        transcript: deps.transcript,
        log: deps.log,
        tell: tellerFor({ readerFor: () => getReader(), configOf, delivery: () => delivery(), log: deps.log }, fireRepo(), GITHUB_SOURCE),
      });
    } finally {
      loginStored = await storeIfRefreshed(deps, original, account);
    }
    return { kind: 'issueReview', issue: invocation.issue, ...reviewed, loginStored };
  }

  if (invocation.kind === 'wait') {
    // A ticket opened or edited with a `Blocked until:` line: its wait item
    // put, rewritten or deleted to match (dispatch/waits.mjs).
    // With the file's `waits.issue`, the ticket's link to the wait ticket
    // follows its line too, for its sidebar.
    // A warning it posts, a fix only the spec owner can make, tells the
    // ticket's spec owner from this turn: the relay sends governor's
    // comment to nobody.
    const reader = await getReader();
    const tell = tellerFor({ readerFor: async () => reader, configOf, delivery: () => delivery(), log: deps.log }, fireRepo(), GITHUB_SOURCE);
    const links = waitLinks({ reader, repo: fireRepo(), board: configOf(fireRepo()).waits?.issue, log: deps.log, tell });
    /** @type {string} */
    let outcome;
    let loginStored = false;
    try {
      outcome = await holdWait({ reader, state: deps.state, repo: fireRepo(), issue: invocation.issue, labels: configOf(fireRepo()).labels, prompts, now: deps.now(), log: deps.log, tell, ...(links === undefined ? {} : { links }) });
    } finally {
      loginStored = await storeIfRefreshed(deps, original, account);
    }
    return { kind: invocation.kind, issue: invocation.issue, outcome, loginStored };
  }

  // A close: one `unblocked` fire for each open ticket the issue blocked,
  // in whichever repo, for that repo's own turn (dispatch/unblocked.mjs).
  // It starts nothing, so DispatchCap does not hold it, and calls GitHub
  // only under the closed issue's repo. No failed turn is tried again
  // (dispatch/lane.mjs), so a fire the lane refuses is logged at
  // error by its ticket, the rest still go, and the turn exits 1.
  if (invocation.kind === 'schedule' && invocation.freed !== undefined) {
    const freed = invocation.freed;
    const reader = await getReader();
    const rows = await reader.blocking(freed);
    if (!rows.some((r) => r.state === 'open' && ownerListed(deps.owners, r.repo.split('/')[0] ?? ''))) {
      deps.log('dispatch-unblocked', { repo: fireRepo(), closed: freed, queued: [], reason: `#${freed} blocked no open ticket in a listed owner's repo` });
      return { kind: invocation.kind, freed, queued: [], passedOver: [] };
    }
    const { title, reason, pr, closedAt } = await reader.closure(freed);
    const config = configOf(fireRepo());
    const { queue, skipped } = closingFires({
      closed: { repo: fireRepo(), number: freed, title, ...(reason === null ? {} : { reason }), ...(closedAt === undefined ? {} : { closedAt }) },
      pr,
      rows,
      owners: deps.owners,
      ownOff: !turnsOn(config, 'pickup') && !turnsOn(config, 'unblocked'),
    });
    const enqueue = deps.enqueue;
    if (queue.length > 0 && enqueue === undefined) throw new Error(`#${freed} blocked open tickets, and this turn has no fire lane to queue them on`);
    /** @type {string[]} */
    const queued = [];
    /** @type {Array<{ repo: string, error: string }>} */
    const unqueued = [];
    for (const { fire, dedupId } of queue) {
      const ticket = `${fire.repo}#${fire.issue}`;
      try {
        await /** @type {NonNullable<Deps['enqueue']>} */ (enqueue)({ fire, reason: `${fireRepo()}#${freed} closed, which blocked ${ticket}` }, dedupId);
        queued.push(ticket);
      } catch (error) {
        deps.log('dispatch-unblocked-unqueued', { level: 'error', repo: fireRepo(), closed: freed, ticket, error: messageOf(error), reason: 'its fire is lost: the ticket waits for its repo\'s sweep, or a fire by hand' });
        unqueued.push({ repo: fireRepo(), error: `unblocked fire for ${ticket} not queued: ${messageOf(error)}` });
      }
    }
    deps.log('dispatch-unblocked', { repo: fireRepo(), closed: freed, reason, pr: pr?.number ?? null, queued, passedOver: skipped });
    return { kind: invocation.kind, freed, queued, passedOver: skipped, ...(unqueued.length === 0 ? {} : { unread: unqueued }) };
  }

  /** @type {TurnContext} */
  const ctx = {
    readerFor,
    configOf,
    served,
    bare,
    prompts,
    delivery,
    storeLogin: () => storeIfRefreshed(deps, original, account),
    state: deps.state,
    start,
    open: runOpen(deps),
    claims: deps.claims ?? new Set(),
    beats,
    now: deps.now,
    log: deps.log,
    sleep: deps.sleep,
    cap: deps.cap,
    findAuthor,
    findEditor,
  };
  const started = deps.now();
  /** The plan a kind's planner returned. @type {Plan | undefined} */
  let planned;
  if (invocation.kind === 'schedule') {
    planned = await planSweep(invocation, ctx);
  } else if (invocation.kind === 'hook') {
    planned = await planHook(invocation, ctx);
  } else if (invocation.kind === 'unblocked') {
    planned = await planUnblocked(invocation, ctx);
  } else if (invocation.kind === 'ticket') {
    planned = await planTicket(invocation, ctx);
  } else if (invocation.kind === 'closingPr') {
    planned = await planClosingPr(invocation, ctx);
  } else if (invocation.kind === 'offer') {
    planned = await planOffer(invocation, ctx);
  } else if (invocation.kind === 'prEdit') {
    planned = await planPrEdit(invocation, ctx, { closing: planClosingPr });
  } else if (invocation.kind === 'author') {
    planned = await planAuthor(invocation, ctx);
  } else if (invocation.kind === 'dispatch') {
    planned = await planDispatch(invocation, ctx);
  }
  if (planned !== undefined && 'answer' in planned) return planned.answer;
  // The plan's launches: claims, the window, markers and releases.
  let loginStored = false;
  /** @type {Awaited<ReturnType<typeof launchPlan>>} */
  let ran;
  try {
    ran = await launchPlan(planned ?? { launches: [], unread: [] }, ctx, started);
  } finally {
    // Whatever the turn threw, a login the CLI refreshed goes back: the
    // rotation has already happened server-side, and a turn that restored
    // the copy from before it would hold a dead refresh token.
    loginStored = await storeIfRefreshed(deps, original, account);
  }
  const failed = planned?.unread ?? [];
  /** @type {Dispatched[]} */
  const dispatched = ran.map(({ repo, issue, outcome, sessionUrl }) => ({ repo, issue, outcome, sessionUrl }));
  return { kind: invocation.kind, heartbeat: false, ...planned?.result, dispatched, loginStored, ...(failed.length === 0 ? {} : { unread: failed }) };
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
 * How long into an event's turn a periodic the event brought due may still
 * start: the schedule's own window, counted from the turn's start, whatever
 * the carrying turn's own work spent. One launch at the budget above from
 * there, its record and the sign-off sweep still end inside the task's
 * deadline (dispatch/cli.mjs). Past it, the periodic stays due for the next
 * event or sweep.
 */
export const EVENT_PERIODIC_WINDOW_MS = SCHEDULE_LAUNCH_WINDOW_MS;

/**
 * One delivery's budget: its send and a fallback launch together. A
 * quick send leaves the launch its full budget; a slow one cuts
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
 * @returns {Promise<{ label: string, added: number[], failed: Array<{ ticket: number, error: string }>, commented: Commented[] } | null>}
 *   `commented`: each ticket the turn commented on, as read before its label.
 */
const labelTickets = async (invocation, reader, coverage, deps, about) => {
  const plan = ticketsOf(invocation, coverage);
  if (plan.label === null || plan.tickets.length === 0) {
    if (invocation.kind === 'job') deps.log('dispatch-labels', { ...about, label: plan.label, ...(plan.range ?? {}), reason: plan.reason });
    return null;
  }
  const target = deployedTarget(plan.label);
  // The one comment each newly labelled ticket gets; a label that names no
  // target, or a run, gets none.
  const note = target !== null && invocation.kind === 'job' ? deployedComment({ target, workflow: invocation.workflow, url: invocation.url, commit: invocation.commit }) : null;
  const added = [];
  /** @type {Commented[]} */
  const commented = [];
  const failed = [];
  for (const { ticket, prs } of plan.tickets) {
    // Whether the ticket had the label before this turn: one that did was
    // told already, by the turn that added it.
    /** @type {boolean | null} */
    let had = null;
    /** @type {import('../scripts/lib/github-app.mjs').TicketRow | null} */
    let row = null;
    if (note !== null) {
      try {
        row = await reader.ticket(ticket);
        had = row.labels.includes(plan.label);
      } catch (error) {
        failed.push({ ticket, error: messageOf(error) });
        deps.log('dispatch-labels', { ...about, label: plan.label, ticket, prs, error: `could not read its labels, so no comment: ${messageOf(error)}` });
      }
    }
    try {
      await reader.addLabels(ticket, [plan.label]);
      added.push(ticket);
    } catch (error) {
      failed.push({ ticket, error: messageOf(error) });
      deps.log('dispatch-labels', { ...about, label: plan.label, ticket, prs, error: messageOf(error) });
      continue;
    }
    if (had !== false || note === null || row === null) continue;
    try {
      await reader.comment(ticket, note);
      commented.push({ ticket, prs, row });
    } catch (error) {
      failed.push({ ticket, error: messageOf(error) });
      deps.log('dispatch-labels', { ...about, label: plan.label, ticket, prs, error: `comment refused: ${messageOf(error)}` });
    }
  }
  deps.log('dispatch-labels', { ...about, label: plan.label, ...plan.range, added, commented: commented.map((c) => c.ticket) });
  return { label: plan.label, added, failed, commented };
};

/**
 * @typedef {{ ticket: number, prs: number[], row: import('../scripts/lib/github-app.mjs').TicketRow }} Commented
 *   A ticket a shipping job commented on, the PRs it shipped that close it,
 *   and the ticket as read before the turn labelled it.
 */

/**
 * The roles of each ticket a green deploy owes its news (`tickets`), found
 * as every path finds a ticket's roles (`rolesOf`, dispatch/roles.mjs): the
 * spec owner its body names, read under the repo's `trust.relay` with a
 * ticket governor's App filed let in as the receiver lets it in, and on a
 * claimed ticket each builder the one lookup finds. Each ticket is looked up once a turn. A ticket
 * the turn commented on is read as it was before its label; any other is
 * read again. A read that fails names nobody: it is returned as failed, so
 * the turn holds its cursor and the next turn looks again.
 *
 * @param {number[]} tickets
 * @param {{ invocation: import('./webhook/fire.mjs').WorkflowFire | import('./webhook/fire.mjs').JobFire, coverage: import('./coverage.mjs').Coverage, commented: Commented[], reader: Reader, config: import('./repo-config.mjs').RepoConfig, ownerOf: (pr: number) => Promise<{ session: string | null }> }} ctx
 * @returns {Promise<{ found: import('./workflow.mjs').ShippedTicket[], failed: Array<{ ticket: number, error: string }>, skipped: number[] }>}
 *   `skipped`: each ticket no PR of the range closes, which names nobody.
 */
const shippedRolesOf = async (tickets, { invocation, coverage, commented, reader, config, ownerOf }) => {
  /** @type {import('./workflow.mjs').ShippedTicket[]} */
  const found = [];
  /** @type {Array<{ ticket: number, error: string }>} */
  const failed = [];
  /** @type {number[]} */
  const skipped = [];
  if (tickets.length === 0) return { found, failed, skipped };
  const relay = relayOf(config);
  const { claim } = config.labels;
  const shipped = new Map(ticketsOf(invocation, coverage).tickets.map((t) => [t.ticket, t.prs]));
  for (const ticket of tickets) {
    const prs = shipped.get(ticket) ?? commented.find((c) => c.ticket === ticket)?.prs ?? [];
    if (prs.length === 0) {
      skipped.push(ticket);
      continue;
    }
    try {
      const row = commented.find((c) => c.ticket === ticket)?.row ?? await reader.ticket(ticket);
      const roles = await rolesOf({ issue: ticket, relay, claim, ticket: row, reader, ownerOf });
      found.push({ ticket, title: row.title, prs, roles });
    } catch (error) {
      failed.push({ ticket, error: messageOf(error) });
    }
  }
  return { found, failed, skipped };
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

/** How long a PR review's verdict outlives its last write: a lost one only asks the model again. */
const VERDICT_TTL_S = 90 * 24 * 60 * 60;

/** How long a delivered record outlives its last write: past any cursor held that long, it is never read again. */
const DELIVERED_TTL_S = 30 * 24 * 60 * 60;

/** How long a PR's record of a merge's conflict is kept: a merge's fire is redelivered within hours, and never a month on. */
const CONFLICT_TTL_S = 30 * 24 * 60 * 60;

/**
 * How long a held session's record lasts: longer than a PR stays open, so a
 * session is told once. A lost item costs one more message.
 */
const HELD_TTL_S = 90 * 24 * 60 * 60;

/** How long a correction's record lasts, three months, as a held session's: a session is told once. */
const TOLD_TTL_S = 90 * 24 * 60 * 60;

/** How long past its date a wait item stays, should no fire delete it: a month. */
const WAIT_TTL_S = 30 * 24 * 60 * 60;

/** The attribute the state table's TTL expires on (infra/governor.cfn.yml). */
export const STATE_TTL_ATTRIBUTE = 'ttl';

/** One clock hour, the window a session's count of messages about one subject covers. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * How long into a review turn a review may still start: one more `claude
 * -p` run at the launch budget above, the mergeable reads and the upload
 * still end inside the task's deadline (dispatch/cli.mjs).
 */
export const REVIEW_WINDOW_MS = 5 * 60 * 1000;

/**
 * How long into a review turn the `governor` check may still go on a PR the
 * window kept the turn from reaching. A review the window let start can run
 * its whole launch budget past it, so the checks start late. Each is a few
 * reads and one write with no budget of its own, so the limit leaves the
 * deadline (dispatch/cli.mjs) six minutes for a slow one and the login's
 * store-back.
 */
export const REVIEW_MARK_WINDOW_MS = 12 * 60 * 1000;

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
    const { Attributes } = await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: [...LANE_COUNTS] }));
    return laneCount(Attributes);
  },
});

/**
 * A fire onto the dispatcher's fire lane, on its one message group, as the
 * receiver queues one (dispatch/webhook/handler.mjs): a close's
 * `unblocked` fires (dispatch/unblocked.mjs). The deduplication id drops
 * one a retried close queues again.
 *
 * @param {Pick<SQSClient, 'send'>} client
 * @param {string} url
 * @returns {NonNullable<Deps['enqueue']>}
 */
export const sqsEnqueue = (client, url) => async (message, dedupId) => {
  const sent = await client.send(new SendMessageCommand({ QueueUrl: url, MessageBody: JSON.stringify(message), MessageGroupId: LANE, MessageDeduplicationId: dedupId }));
  return String(sent.MessageId ?? '');
};

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

/** The API the routines and the connector list are on. */
const API = 'https://api.anthropic.com';

/** The beta each path of the routines API asks for, as the CLI sends it. */
const ROUTINES_BETA = 'ccr-triggers-2026-01-30';
const CONNECTORS_BETA = 'mcp-servers-2025-12-04';

/**
 * The routines API and the account's connector list (dispatch/routines.mjs)
 * under the login's token and organization, as the CLI's routine commands
 * call them: each answer parsed, and any answer but a 2xx thrown as a
 * `RoutinesApiError` with its status, naming the path and status. A routine
 * id the path cannot carry rejects before any request, with a status of
 * null. A refusal's body is cut short: it may quote a prompt.
 *
 * @param {string} token
 * @param {string | null} organization
 * @returns {import('./routines.mjs').RoutinesApi}
 */
export const routinesApi = (token, organization) => {
  /** @param {'GET' | 'POST'} method @param {string} path @param {string} beta @param {object} [body] */
  const call = async (method, path, beta, body) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': beta,
        ...(organization === null ? {} : { 'x-organization-uuid': organization }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new RoutinesApiError(`${method} ${path.replace(/\?.*$/, '')}: ${response.status} ${text.slice(0, 200)}`, response.status);
    return text === '' ? {} : JSON.parse(text);
  };
  /** @param {string} id */
  const trigger = (id) => {
    if (!/^[\w-]+$/.test(id)) throw new RoutinesApiError(`not a routine id: ${id}`, null);
    return `/v1/code/triggers/${id}`;
  };
  return {
    connectors: () => call('GET', '/v1/mcp_servers?limit=1000', CONNECTORS_BETA),
    triggers: (cursor) => call('GET', cursor === undefined ? '/v1/code/triggers' : `/v1/code/triggers?cursor=${encodeURIComponent(cursor)}`, ROUTINES_BETA),
    create: (body) => call('POST', '/v1/code/triggers', ROUTINES_BETA, body),
    update: async (id, body) => call('POST', trigger(id), ROUTINES_BETA, body),
    run: async (id) => call('POST', `${trigger(id)}/run`, ROUTINES_BETA, {}),
    sessions: (id) => call('GET', `/v1/code/sessions?trigger_id=${encodeURIComponent(id)}&limit=100`, ROUTINES_BETA),
  };
};

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
 * and expired by `ttl`. A periodic's record is the item `periodic#<repo>` /
 * `<name>`, put only over the record the turn read, and never expired: a
 * lost one costs a late run. A session governor started is the item
 * `session#<session id>` / `started`, under no repo, since a session may
 * open its PR in another served repo, and put with no expiry, since the
 * review reads it for every PR the session opens and a lost one lets a
 * mode label waive a human-only path. A repo's last pickup sweep is
 * the item `pickup#<repo>` / `sweep`, put only where none or an earlier
 * one stands, and never expired: a lost one means sweep now. A hook's last
 * session is the item `hook#<repo>` / `<name>`, put only over the record the
 * turn read, and never expired: a lost one costs one extra session. A
 * waiting ticket's item is `wait#<repo>` / `<issue>`, holding its date, put
 * only where none or the date the turn read stands, deleted only over that
 * date, and expired a month after its date: a lost one costs that ticket's
 * wait-ended comment and spec session, or, for a ticket linked to the wait
 * ticket by hand and parked twenty years out, one more read of it and its
 * thread. A PR review's verdict is the item
 * `review#<repo>` / `<pr>`, put only over the item the review read, and
 * expired three months after its write: the review reads it back in place
 * of its comment's text, which a person can edit, and a lost one costs a
 * model call. It may hold the owner's message the review could not queue,
 * as JSON, which the next review turn at the same head and body sends: a
 * lost one costs that message. A ticket whose launch started nothing is the item
 * `pickup-failed#<repo>` / `<issue>`, holding the time pickup holds it
 * until, put after the launch over any earlier one, and expired at that
 * time: a lost one lets one more launch go.
 *
 * @param {Pick<DynamoDBClient, 'send'>} client
 * @param {string} table
 * @returns {DispatchState}
 */
export const dynamoState = (client, table) => {
  const pk = (/** @type {string} */ repo, /** @type {string} */ workflow) => ({ S: `workflow#${repo}#${workflow}` });
  const key = (/** @type {string} */ repo, /** @type {string} */ workflow, /** @type {string | null} */ label) => ({ pk: pk(repo, workflow), sk: { S: label === null ? 'cursor' : `cursor#${label}` } });
  const periodicKey = (/** @type {string} */ repo, /** @type {string} */ name) => ({ pk: { S: `periodic#${repo}` }, sk: { S: name } });
  const hookKey = (/** @type {string} */ repo, /** @type {string} */ name) => ({ pk: { S: `hook#${repo}` }, sk: { S: name } });
  const sweepKey = (/** @type {string} */ repo) => ({ pk: { S: `pickup#${repo}` }, sk: { S: 'sweep' } });
  const failedPk = (/** @type {string} */ repo) => ({ S: `pickup-failed#${repo}` });
  const waitPk = (/** @type {string} */ repo) => ({ S: `wait#${repo.toLowerCase()}` });
  const waitKey = (/** @type {string} */ repo, /** @type {number} */ issue) => ({ pk: waitPk(repo), sk: { S: String(issue) } });
  /** An item's date, or a throw: a malformed item is a failed read, never a missing one. @param {Record<string, any>} item */
  const untilOf = (item) => {
    const until = item.until?.S;
    if (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(`${until}T00:00:00Z`))) throw new Error(`the wait item ${item.pk?.S} ${item.sk?.S} is malformed: ${JSON.stringify(item)}`);
    return until;
  };
  /** @param {unknown} error */
  const refused = (error) => error instanceof ConditionalCheckFailedException || /** @type {any} */ (error)?.name === 'ConditionalCheckFailedException';
  /**
   * A verdict's owed message, from its JSON: undefined where it is
   * malformed, which fails the read.
   *
   * @param {string | undefined} text
   * @returns {import('./review.mjs').Owed | undefined}
   */
  const owedOf = (text) => {
    if (text === undefined) return undefined;
    try {
      const owed = JSON.parse(text);
      const ok = typeof owed?.comment === 'string' && Number.isInteger(owed.tries) && owed.tries > 0
        && owed.message !== null && typeof owed.message === 'object' && owed.message.kind === 'message' && typeof owed.message.text === 'string';
      return ok ? owed : undefined;
    } catch {
      return undefined;
    }
  };
  const verdictKey = (/** @type {string} */ repo, /** @type {number} */ pr) => ({ pk: { S: `review#${repo}` }, sk: { S: String(pr) } });
  const sessionKey = (/** @type {string} */ session) => ({ pk: { S: `session#${sessionId(session)}` }, sk: { S: 'started' } });
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
      const tickets = (item.tickets?.NS ?? []).map(Number);
      if ((item.told !== undefined && item.told.SS === undefined) || (item.failed !== undefined && item.failed.L === undefined) || failed.some((s) => s === undefined)
        || (item.tickets !== undefined && item.tickets.NS === undefined) || tickets.some((n) => !Number.isSafeInteger(n))) {
        throw new Error(`the delivered item for ${workflow} ${label ?? ''} from ${from ?? 'none'} is malformed: ${JSON.stringify(item)}`);
      }
      return { told: item.told?.SS ?? [], failed: /** @type {string[]} */ (failed), ...(tickets.length === 0 ? {} : { tickets: tickets.sort((a, b) => a - b) }) };
    },
    // One update merges into what a racing turn wrote: never a read, then a write.
    record: async (repo, workflow, label, from, { told, failed, tickets = [] }) => {
      if (told.length === 0 && failed.length === 0 && tickets.length === 0) return;
      const added = [...(told.length === 0 ? [] : ['told :told']), ...(tickets.length === 0 ? [] : ['tickets :tickets'])];
      await client.send(new UpdateItemCommand({
        TableName: table,
        Key: sent(repo, workflow, label, from),
        UpdateExpression: [
          `SET #ttl = :ttl${failed.length === 0 ? '' : ', failed = list_append(if_not_exists(failed, :none), :failed)'}`,
          ...(added.length === 0 ? [] : [`ADD ${added.join(', ')}`]),
        ].join(' '),
        ExpressionAttributeNames: { '#ttl': STATE_TTL_ATTRIBUTE },
        ExpressionAttributeValues: {
          ':ttl': { N: String(Math.floor(Date.now() / 1000) + DELIVERED_TTL_S) },
          ...(failed.length === 0 ? {} : { ':none': { L: [] }, ':failed': { L: failed.map((s) => ({ S: s })) } }),
          ...(told.length === 0 ? {} : { ':told': { SS: [...new Set(told)] } }),
          ...(tickets.length === 0 ? {} : { ':tickets': { NS: [...new Set(tickets)].map(String) } }),
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
    // The same put twice is one record: no condition, nothing to race.
    recordSession: async (session) => {
      await client.send(new PutItemCommand({ TableName: table, Item: { ...sessionKey(session), at: { S: new Date().toISOString() } } }));
    },
    // Put before the message, only where none stands: a session hears it once.
    recordHeld: async (session) => {
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: { pk: { S: `held#${sessionId(session)}` }, sk: { S: 'told' }, at: { S: new Date().toISOString() }, [STATE_TTL_ATTRIBUTE]: { N: String(Math.floor(Date.now() / 1000) + HELD_TTL_S) } },
          ConditionExpression: 'attribute_not_exists(pk)',
        }));
        return true;
      } catch (error) {
        if (refused(error)) return false;
        throw error;
      }
    },
    // Put before the correction, only where none stands: a session hears each kind once.
    recordTold: async (session, kind) => {
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: { pk: { S: `told#${sessionId(session)}` }, sk: { S: kind }, at: { S: new Date().toISOString() }, [STATE_TTL_ATTRIBUTE]: { N: String(Math.floor(Date.now() / 1000) + TOLD_TTL_S) } },
          ConditionExpression: 'attribute_not_exists(pk)',
        }));
        return true;
      } catch (error) {
        if (refused(error)) return false;
        throw error;
      }
    },
    startedSession: async (session) => {
      const { Item: item } = await client.send(new GetItemCommand({ TableName: table, Key: sessionKey(session), ConsistentRead: true }));
      return item !== undefined;
    },
    verdict: async (repo, pr) => {
      const { Item: item } = await client.send(new GetItemCommand({ TableName: table, Key: verdictKey(repo, pr), ConsistentRead: true }));
      if (item === undefined) return null;
      const headSha = item.headSha?.S;
      const bodySha = item.bodySha?.S;
      const at = item.at?.S;
      const again = item.again?.BOOL;
      const reason = item.passReason?.S;
      const passAt = item.passAt?.S;
      // A malformed item is a failed read, never a missing one.
      const owed = item.owed === undefined ? null : owedOf(item.owed.S);
      if (headSha === undefined || bodySha === undefined || at === undefined || typeof again !== 'boolean' || (item.readSha !== undefined && item.readSha.S === undefined) || (reason === undefined) !== (passAt === undefined) || owed === undefined) {
        throw new Error(`the review verdict item for ${repo}#${pr} is malformed: ${JSON.stringify(item)}`);
      }
      return { headSha, bodySha, readSha: item.readSha?.S ?? null, pass: reason === undefined || passAt === undefined ? null : { reason, at: passAt }, again, at, ...(owed === null ? {} : { owed }) };
    },
    recordVerdict: async (repo, pr, read, { headSha, bodySha, readSha, pass, again, owed }) => {
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: {
            ...verdictKey(repo, pr),
            headSha: { S: headSha },
            bodySha: { S: bodySha },
            ...(readSha === null ? {} : { readSha: { S: readSha } }),
            ...(pass === null ? {} : { passReason: { S: pass.reason }, passAt: { S: pass.at } }),
            again: { BOOL: again },
            ...(owed == null ? {} : { owed: { S: JSON.stringify(owed) } }),
            at: { S: new Date().toISOString() },
            [STATE_TTL_ATTRIBUTE]: { N: String(Math.floor(Date.now() / 1000) + VERDICT_TTL_S) },
          },
          ...(read === null
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : { ConditionExpression: '#at = :read', ExpressionAttributeNames: { '#at': 'at' }, ExpressionAttributeValues: { ':read': { S: read.at } } }),
        }));
        return true;
      } catch (error) {
        if (refused(error)) return false;
        throw error;
      }
    },
    periodic: async (repo, name) => {
      const { Item: item } = await client.send(new GetItemCommand({ TableName: table, Key: periodicKey(repo, name), ConsistentRead: true }));
      if (item === undefined) return null;
      const at = item.at?.S;
      // A malformed item is a failed read, never a missing one.
      if (at === undefined || Number.isNaN(Date.parse(at)) || (item.session !== undefined && item.session.S === undefined)) {
        throw new Error(`the periodic item for ${repo} ${name} is malformed: ${JSON.stringify(item)}`);
      }
      return {
        at,
        session: item.session?.S ?? null,
        baseline: item.baseline?.BOOL === true,
        ...(item.nothing?.BOOL === true ? { nothing: /** @type {const} */ (true) } : {}),
        ...(item.lastRun?.S === undefined ? {} : { lastRun: item.lastRun.S }),
      };
    },
    recordPeriodic: async (repo, name, read, { at, session, baseline, nothing, lastRun }) => {
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: { ...periodicKey(repo, name), at: { S: at }, ...(session === null ? {} : { session: { S: session } }), ...(baseline ? { baseline: { BOOL: true } } : {}), ...(nothing === true ? { nothing: { BOOL: true } } : {}), ...(lastRun === undefined ? {} : { lastRun: { S: lastRun } }) },
          ...(read === null
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : { ConditionExpression: '#at = :read', ExpressionAttributeNames: { '#at': 'at' }, ExpressionAttributeValues: { ':read': { S: read.at } } }),
        }));
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException || /** @type {any} */ (error)?.name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
    hookSession: async (repo, name) => {
      const { Item: item } = await client.send(new GetItemCommand({ TableName: table, Key: hookKey(repo, name), ConsistentRead: true }));
      if (item === undefined) return null;
      const session = item.session?.S;
      const at = item.at?.S;
      // A malformed item is a failed read, never a missing one.
      if (session === undefined || at === undefined || Number.isNaN(Date.parse(at))) {
        throw new Error(`the hook item for ${repo} ${name} is malformed: ${JSON.stringify(item)}`);
      }
      return { session, at };
    },
    recordHookSession: async (repo, name, read, { session, at }) => {
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: { ...hookKey(repo, name), session: { S: session }, at: { S: at } },
          ...(read === null
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : { ConditionExpression: '#session = :read', ExpressionAttributeNames: { '#session': 'session' }, ExpressionAttributeValues: { ':read': { S: read.session } } }),
        }));
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException || /** @type {any} */ (error)?.name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
    waits: async (repo) => {
      /** @type {Array<{ issue: number, until: string }>} */
      const found = [];
      /** @type {Record<string, any> | undefined} */
      let after;
      do {
        const page = await client.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': waitPk(repo) },
          ConsistentRead: true,
          ...(after === undefined ? {} : { ExclusiveStartKey: after }),
        }));
        for (const item of page.Items ?? []) {
          const issue = Number(item.sk?.S);
          if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error(`the wait item ${item.pk?.S} ${item.sk?.S} is malformed: ${JSON.stringify(item)}`);
          found.push({ issue, until: untilOf(item) });
        }
        after = page.LastEvaluatedKey;
      } while (after !== undefined);
      return found;
    },
    wait: async (repo, issue) => {
      const { Item: item } = await client.send(new GetItemCommand({ TableName: table, Key: waitKey(repo, issue), ConsistentRead: true }));
      return item === undefined ? null : { until: untilOf(item) };
    },
    recordWait: async (repo, issue, read, until) => {
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: { ...waitKey(repo, issue), until: { S: until }, [STATE_TTL_ATTRIBUTE]: { N: String(Math.floor(Date.parse(`${until}T00:00:00Z`) / 1000) + WAIT_TTL_S) } },
          ...(read === null
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : { ConditionExpression: '#until = :read', ExpressionAttributeNames: { '#until': 'until' }, ExpressionAttributeValues: { ':read': { S: read } } }),
        }));
        return true;
      } catch (error) {
        if (refused(error)) return false;
        throw error;
      }
    },
    dropWait: async (repo, issue, read) => {
      try {
        await client.send(new DeleteItemCommand({
          TableName: table,
          Key: waitKey(repo, issue),
          ConditionExpression: '#until = :read',
          ExpressionAttributeNames: { '#until': 'until' },
          ExpressionAttributeValues: { ':read': { S: read } },
        }));
        return true;
      } catch (error) {
        if (refused(error)) return false;
        throw error;
      }
    },
    sweep: async (repo) => {
      const { Item: item } = await client.send(new GetItemCommand({ TableName: table, Key: sweepKey(repo), ConsistentRead: true }));
      if (item === undefined) return null;
      const at = item.at?.S;
      // A malformed item is a failed read, never a missing one.
      if (at === undefined || Number.isNaN(Date.parse(at))) throw new Error(`the pickup sweep item for ${repo} is malformed: ${JSON.stringify(item)}`);
      return at;
    },
    recordSweep: async (repo, at) => {
      try {
        await client.send(new PutItemCommand({
          TableName: table,
          Item: { ...sweepKey(repo), at: { S: at } },
          ConditionExpression: 'attribute_not_exists(pk) OR #at < :at',
          ExpressionAttributeNames: { '#at': 'at' },
          ExpressionAttributeValues: { ':at': { S: at } },
        }));
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException || /** @type {any} */ (error)?.name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
    failedLaunches: async (repo) => {
      /** @type {Array<{ issue: number, until: string }>} */
      const found = [];
      /** @type {Record<string, any> | undefined} */
      let after;
      do {
        const page = await client.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': failedPk(repo) },
          ConsistentRead: true,
          ...(after === undefined ? {} : { ExclusiveStartKey: after }),
        }));
        for (const item of page.Items ?? []) {
          const issue = Number(item.sk?.S);
          const until = item.until?.S;
          // A malformed item is a failed read, never a missing one.
          if (!Number.isSafeInteger(issue) || issue <= 0 || typeof until !== 'string' || Number.isNaN(Date.parse(until))) {
            throw new Error(`the failed-launch item ${item.pk?.S} ${item.sk?.S} is malformed: ${JSON.stringify(item)}`);
          }
          found.push({ issue, until });
        }
        after = page.LastEvaluatedKey;
      } while (after !== undefined);
      return found;
    },
    // Raised in one conditional update, never read then written: two turns
    // racing cannot both take the last place. The refusal returns the item,
    // its counts by kind; a second conditional update marks the hour's
    // first refusal, so only that one pages.
    countMessage: async (session, subject, kind, at, ceiling) => {
      const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
      const Key = { pk: { S: `messages#${sessionId(session)}` }, sk: { S: `${subject ?? 'none'}@${new Date(hour).toISOString().slice(0, 13)}` } };
      try {
        await client.send(new UpdateItemCommand({
          TableName: table,
          Key,
          UpdateExpression: 'ADD #count :one, #kind :one SET #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :ceiling',
          ExpressionAttributeNames: { '#count': 'count', '#kind': `kind:${kind}`, '#ttl': STATE_TTL_ATTRIBUTE },
          ExpressionAttributeValues: { ':one': { N: '1' }, ':ceiling': { N: String(ceiling) }, ':ttl': { N: String((hour + HOUR_MS) / 1000) } },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }));
        return { raised: true };
      } catch (error) {
        if (!refused(error)) throw error;
        const item = /** @type {Record<string, { N?: string, BOOL?: boolean }> | undefined} */ (/** @type {any} */ (error).Item) ?? {};
        /** @type {Record<string, number>} */
        const counts = {};
        for (const [name, value] of Object.entries(item)) if (name.startsWith('kind:') && value.N !== undefined) counts[name.slice('kind:'.length)] = Number(value.N);
        const count = Number(item.count?.N ?? ceiling);
        let first = item.capped?.BOOL !== true;
        if (first) {
          try {
            await client.send(new UpdateItemCommand({
              TableName: table,
              Key,
              UpdateExpression: 'SET #capped = :true',
              ConditionExpression: 'attribute_exists(#count) AND attribute_not_exists(#capped)',
              ExpressionAttributeNames: { '#count': 'count', '#capped': 'capped' },
              ExpressionAttributeValues: { ':true': { BOOL: true } },
            }));
          } catch (marking) {
            // Another turn marked it first. Any other failure pages again
            // rather than not at all.
            if (refused(marking)) first = false;
          }
        }
        return { raised: false, first, count, counts };
      }
    },
    // A later failure moves the record on: the same put again, nothing to race.
    recordFailedLaunch: async (repo, issue, until) => {
      await client.send(new PutItemCommand({
        TableName: table,
        Item: { pk: failedPk(repo), sk: { S: String(issue) }, until: { S: until }, [STATE_TTL_ATTRIBUTE]: { N: String(Math.ceil(Date.parse(until) / 1000)) } },
      }));
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

/**
 * The paths a turn writes under: the CLI's config and login under HOME, the
 * turn's own working directory, and each launch's beside it (`realDeps`).
 *
 * @param {Record<string, string | undefined>} env
 */
const turnPaths = (env) => {
  const home = env.HOME || '/home/dispatch';
  const cwd = env.DISPATCH_WORKDIR || '/tmp/repo';
  return { home, cwd, repos: join(dirname(cwd), 'repos') };
};

/**
 * Clear what a turn leaves behind, before the next fire's turn in the same
 * task (dispatch/lane.mjs): the CLI's config, login and transcripts, the
 * turn's working directory and each launch's. The turn's directory keeps
 * the first origin it is given, so left, a message for one repo would run
 * in the last fire's. Each turn restores the login from the secret anyway.
 *
 * @param {Record<string, string | undefined>} env
 */
export const clearTurnState = (env) => {
  const { home, cwd, repos } = turnPaths(env);
  for (const path of [join(home, '.claude'), join(home, '.claude.json'), cwd, repos]) rmSync(path, { recursive: true, force: true });
};

/** @returns {Deps} */
export const realDeps = () => {
  const env = process.env;
  const { home, cwd, repos } = turnPaths(env);
  const configPath = join(home, '.claude.json');
  const credentials = join(home, '.claude', '.credentials.json');
  /** The restored login's account, which every CLI call is handed. @type {import('../scripts/lib/claude-login.mjs').LoginAccount | null} */
  let account = null;
  const secrets = new SecretsManagerClient({});
  // The fire lane: counted by the sign-off wait, and sent to by a close.
  const sqs = new SQSClient({});
  const secretText = async (/** @type {string} */ id) =>
    (await secrets.send(new GetSecretValueCommand({ SecretId: id }))).SecretString ?? '';
  const log = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ context = {}) =>
    console.log(JSON.stringify({ event, ...context }));

  // One call that spends its sends in a GitHub outage stops every later
  // call's resends for the rest of the turn, the reader's and the mints'.
  const resends = turnResends();

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
    const dir = join(repos, ...launched.split('/'));
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
    installations: async () => appInstallations({ ...(await appKey()), owners, log, resends }),
    configFile: (served, token, path) => githubReader({ token, repo: served, log, resends }).configFile(path),
    environments: async (token, organization) => {
      const response = await fetch(ENVIRONMENTS_API, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', ...(organization === null ? {} : { 'x-organization-uuid': organization }) },
        signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GET /v1/environment_providers: ${response.status}`);
      return response.json();
    },
    cap: dispatchCap(env.DISPATCH_CAP),
    messageCeiling: messageCeiling(env.MESSAGE_CEILING),
    now: () => Date.now(),
    log,
    secret: {
      get: () => secretText(String(env.CLAUDE_LOGIN_SECRET_ID)),
      put: async (text) => {
        await secrets.send(new PutSecretValueCommand({ SecretId: String(env.CLAUDE_LOGIN_SECRET_ID), SecretString: text }));
      },
    },
    githubToken: async (served) => installationToken({ ...(await appKey()), repo: served, log, resends }),
    appId: async () => {
      const id = Number((await app()).appId);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`the GitHub App secret's appId is not an App ID: ${String((await app()).appId)}`);
      return id;
    },
    reader: (token, appId, served) => githubReader({ token, repo: served, appId, log, resends }),
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
    launch: async ({ prompt, sessionName, model, repo: launched, environment, branch }) => {
      const dir = mkdtempSync(join(tmpdir(), 'governor-'));
      try {
        const promptFile = join(dir, 'prompt.txt');
        writeFileSync(promptFile, `${prompt}\n`);
        const result = await collect(spawn('python3', [launcherPath(), promptFile], {
          cwd: workspaceFor(launched, environment),
          env: cliEnv({ ...env, CLAUDE_MODEL: model, CLAUDE_SESSION_NAME: sessionName, CLAUDE_ON_BRANCH: branch ?? '' }, home, account),
          stdio: ['ignore', 'pipe', 'pipe'],
        }));
        log('dispatch-launcher-output', { sessionName, status: result.status, tail: result.output.slice(-OUTPUT_TAIL) });
        return result;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    routines: routinesApi,
    uuid: () => randomUUID(),
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
    // Every review's frame and checklist go in place of Claude Code's own
    // system prompt, which is written for a coding agent with tools.
    review: async ({ system, prompt, schema }) => {
      const dir = mkdtempSync(join(tmpdir(), 'governor-review-'));
      try {
        const systemFile = join(dir, 'system.md');
        writeFileSync(systemFile, system);
        const child = spawn('claude', [
          '-p', '--output-format', 'json', '--model', DEFAULT_MODEL,
          '--system-prompt-file', systemFile, '--json-schema', JSON.stringify(schema), '--tools', '',
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
    // own writer, named for the review so a reader tells it from a session's:
    // the PR review's by its PR, an issue review's by the key it gives.
    transcript: async (run) => {
      const { sessionId } = run;
      const url = env.SESSION_LOG_URL;
      if (!url || !env.SESSION_LOG_SECRET_ID) return { skipped: 'no drop box configured' };
      const secret = (await secretText(env.SESSION_LOG_SECRET_ID)).trim();
      if (!/^[0-9a-f]{32,}$/.test(secret)) return { skipped: 'the writer secret is not set' };
      const projects = join(home, '.claude', 'projects');
      const file = existsSync(projects)
        ? readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find((f) => existsSync(f))
        : undefined;
      if (file === undefined) return { skipped: `no transcript for ${sessionId}` };
      const name = 'key' in run ? run.key : `pr-review-${run.pr}-${sessionId}`;
      const key = `${new Date().toISOString().slice(0, 10)}/${name}.jsonl.gz`;
      const response = await fetch(`${url.replace(/\/+$/, '')}/${key}`, {
        method: 'PUT',
        headers: { referer: secret, 'content-type': 'application/gzip', ...('pr' in run ? { 'x-amz-meta-pr': String(run.pr) } : {}) },
        body: gzipSync(redactTranscript(readFileSync(file, 'utf8'), secret)),
      });
      if (!response.ok) throw new Error(`PUT ${key} failed: ${response.status} ${response.statusText}`);
      return { key };
    },
    sleep: (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); }),
    fires: env.DISPATCH_FIRES_QUEUE_URL ? sqsFires(sqs, env.DISPATCH_FIRES_QUEUE_URL) : undefined,
    enqueue: env.DISPATCH_FIRES_QUEUE_URL ? sqsEnqueue(sqs, env.DISPATCH_FIRES_QUEUE_URL) : undefined,
    // No table named: every read and write fails, so a workflow turn refuses, and a conflicts turn tells nobody, no periodic starts, no repo is swept, and every PR review fails, rather than guess.
    state: env.DISPATCH_STATE_TABLE
      ? dynamoState(new DynamoDBClient({}), env.DISPATCH_STATE_TABLE)
      : {
        cursor: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        advance: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        delivered: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        verdict: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordVerdict: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        periodic: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordPeriodic: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        sweep: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordSweep: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        failedLaunches: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordFailedLaunch: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        hookSession: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordHookSession: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        record: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordConflict: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordSession: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordHeld: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordTold: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        startedSession: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        waits: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        wait: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        recordWait: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        dropWait: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
        countMessage: async () => { throw new Error('DISPATCH_STATE_TABLE is unset'); },
      },
    // No table named: every write fails and is logged at error, and the
    // turn goes on, its own checks on a hook fire unchanged.
    hookTable: env.DISPATCH_HOOK_TABLE
      ? hookTable(new DynamoDBClient({}), env.DISPATCH_HOOK_TABLE)
      : { publish: async () => { throw new Error('DISPATCH_HOOK_TABLE is unset'); } },
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
