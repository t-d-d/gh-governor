/**
 * The fire: the one message the receiver queues and the dispatcher task
 * runs, and the vocabulary both ends read it in.
 *
 * The receiver (route.mjs, mention.mjs) builds every fire with
 * {@link build}; the task (dispatch/lane.mjs, dispatch/turn.mjs) and
 * scripts/run-turn.mjs read one with {@link parseFire}, which refuses
 * anything the receiver could
 * not have built: a session costs money and attention. The builders are
 * where a field is spelled, so a new kind of fire, or a new field, is one
 * edit here and one test.
 *
 * Twelve kinds. A `schedule` fire (EventBridge, every hour) selects
 * ready work up to the cap; one naming an `issue` (an issue just given a
 * label on the stack's SelectLabels) selects that issue alone, if the label
 * is one of the repo's ready labels and the selection would; one naming a
 * `freed` issue (an issue just closed) selects nothing: its turn queues an
 * `unblocked` fire for each open ticket the issue blocked, in whichever
 * repo the ticket is (dispatch/unblocked.mjs). An `unblocked` fire names
 * that ticket, in its own repo, the blocker and the PR that closed it; its
 * turn acts on the ticket under its own repo's config. A `dispatch` fire carries one prompt, for a mention of
 * @claude, a scheduled run gone red, a probe run or an operator's one-off. A
 * `probe` proves the runtime can hold a pseudo-terminal and starts nothing.
 * A `message` carries text into a cloud session that already exists (its id
 * or its claude.ai/code URL); one with a `fallback` names the prompt to
 * start a fresh session on, the name for it, and the PR it is on, should the
 * session refuse. A subscriber's names what it is `on`, the `event`,
 * a push's `commit`, and `closing` for a close. One on a PR whose body names
 * no session carries `byBranch` in place of the session, and the `poster` to
 * skip. A message queued before the receiver stopped marking a merge may
 * still carry `merged`, which the parser drops. A `workflow` names a red
 * run on the repo's default branch
 * (dispatch/workflow.mjs); a `job` a shipping job that succeeded there,
 * the one that earns a `deployed: ` label ({@link shippingJob});
 * a `branch-run` a finished run dispatched on another
 * branch (dispatch/branch-run.mjs); a `review` a PR and the head it was
 * queued for, or no PR for every open one (dispatch/review.mjs); a
 * `conflicts` a PR merged into the default branch and its merge commit
 * (dispatch/conflicts.mjs). Each of those names the default branch its
 * payload did: no fire takes it for `main`. A `periodics` fire names an
 * event a periodic counts that queued no other fire; any fire may carry one
 * as `counted` (dispatch/periodics.mjs). A `hook` names a hook in the
 * repo's config file that an outside system fired, the key version it was
 * signed with, when the receiver took it, and the caller's text: no prompt,
 * since the task reads the hook's from the file (route.mjs, dispatch/hooks.mjs).
 *
 * Pure, and a leaf: the Lambda packages dispatch/webhook/ whole, and the
 * task image copies this file (dispatch/Dockerfile).
 */

// ── The vocabulary ───────────────────────────────────────────────────────

/**
 * What a subscriber can hear of. `comments` are issue comments and review
 * comments, `reviews` submitted reviews, `pushes` a PR's `synchronize`,
 * `close` a PR closed (merged or not) or an issue closed or reopened,
 * `labels` an issue labelled or unlabelled but for a `deployed: ` label
 * added, `ci` and `deploys` the runs on main after a PR merged
 * (dispatch/workflow.mjs). On an issue, `deploys` is a `deployed: ` label
 * added (`ticketsOf` in dispatch/turn.mjs), which its owner hears only through a line of
 * its own, as with `labels`.
 */
export const SUBSCRIPTION_EVENTS = /** @type {const} */ (['comments', 'reviews', 'pushes', 'close', 'labels', 'ci', 'deploys']);

/** @typedef {typeof SUBSCRIPTION_EVENTS[number]} SubscriptionEvent */

const EVENTS = /** @type {ReadonlySet<string>} */ (new Set(SUBSCRIPTION_EVENTS));

/**
 * The events a periodic can count (dispatch/periodics.mjs): a merge into
 * the default branch, an issue opened, an issue closed. A fire for one of
 * them carries it as `counted`, and the turn runs the repo's periodic check
 * on it, whatever else the fire is for.
 */
export const COUNTS = /** @type {const} */ (['merges', 'issuesOpened', 'issuesClosed']);

/** @typedef {typeof COUNTS[number]} Count */

/** A run's conclusions that mean it went red; a cancelled one was stopped by someone. */
export const RED = new Set(['failure', 'timed_out', 'startup_failure']);

/** A job conclusion that failed the run; `cancelled` is a fail-fast's echo, not a cause. */
export const FAILED = new Set(['failure', 'timed_out']);

/** A workflow file's path as a run names it, which the task reads the ticket label from. */
export const WORKFLOW_PATH = /^\.github\/workflows\/[\w.-]+\.ya?ml$/;

/**
 * A cloud session's link as the CLI prints it and a body carries it: an
 * alphanumeric id. Unanchored and unflagged; a reader anchors it or bounds
 * it as it needs (subscribe.mjs).
 */
export const SESSION_LINK = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{4,128}/;

/**
 * A message's session as a fire names it: a link subscribe.mjs reads out of
 * a body, or its bare id, which the operator's dispatch-task CLI takes.
 * Nothing narrower or wider, so the task parses only a fire the receiver
 * could have built.
 */
export const MESSAGE_SESSION = /^(https:\/\/claude\.ai\/code\/)?session_[A-Za-z0-9]{4,128}$/;

/** The family of labels the dispatcher adds as a ticket's change ships. */
export const LABEL_PREFIX = 'deployed: ';

/**
 * The target a `deployed: ` label names, or null for any other label.
 *
 * @param {unknown} name
 * @returns {string | null}
 */
export const deployedTarget = (name) => {
  const text = String(name ?? '');
  return text.startsWith(LABEL_PREFIX) && text.length > LABEL_PREFIX.length ? text.slice(LABEL_PREFIX.length) : null;
};

/**
 * The marker a shipping job carries at the end of its name:
 * ` · deployed: <target>` (U+00B7, one space each side), and before it,
 * optionally, ` at <sha>`, the commit it built. Read from the end: a
 * reusable workflow's job is named `<caller job> / <inner name>`.
 */
const SHIPPING_JOB = /(?: at ([0-9a-f]{7,40}))? \u00b7 (deployed: .+)$/;

/**
 * What a job's name says it shipped: the label it earns, the target that
 * label names, and the commit it built where the name carries one; null
 * for a job with no marker. The one reading of the marker: the receiver
 * fires on it (route.mjs), the turn's label write and messages read it
 * (dispatch/runs.mjs, dispatch/labels.mjs), and a fitness test holds the
 * workflow files to it.
 *
 * @param {unknown} name
 * @returns {{ label: string, target: string, commit?: string } | null}
 */
export const shippingJob = (name) => {
  const found = SHIPPING_JOB.exec(String(name ?? ''));
  if (found === null) return null;
  const label = /** @type {string} */ (found[2]).trim();
  const target = deployedTarget(label);
  if (target === null || label.includes('\u00b7')) return null;
  return { label, target, ...(found[1] === undefined ? {} : { commit: found[1] }) };
};

/** The author associations GitHub reports that carry a say in the repository. */
export const SUMMONERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Dependabot's login: its bumps are reviewed by the Dependabot list, though it summons nothing, and no session owns them. */
export const DEPENDABOT = 'dependabot[bot]';

/**
 * The last line of a prompt that starts a session: the dispatcher started
 * it, and nobody is at it. A message into a session that exists carries no
 * such line: its owner may be a local, Remote Control or cloud
 * session with its operator at it, which the dispatcher cannot tell.
 */
export const UNATTENDED = 'Unattended session: nobody answers a question here. Decide, act, and report on GitHub.';

/**
 * How a session signs what it posts on GitHub, so the receiver can skip
 * its own posts (`postedBy`, subscribe.mjs). Claude Code ends a session's
 * comment in a footer that names no session, and a post naming none reaches
 * every session that hears of it, its author included. The turn ends every
 * launch's prompt with it (dispatch/turn.mjs), and a message about a post
 * naming no session carries it (mention.mjs). It names no literal link: a
 * refused message goes on, as it is, to the session a dispatch marker
 * names, and a cloud session knows its own link.
 */
export const SIGN_POSTS = "On every comment, review and reply you post on GitHub, put this session's link, its https://claude.ai/code/session_… URL, alone on the line just above the Claude Code footer. The dispatcher reads the link there, so it does not send you your own posts.";

/**
 * The lane's one message group: FIFO within it is what serialises the
 * fires. The receiver queues on it, a turn queues a close's unblocked fires
 * on it, and so does a fire by hand (scripts/run-turn.mjs).
 */
export const LANE = 'dispatch';

// ── The dispatch marker ──────────────────────────────────────────────────

/**
 * How long after a dispatch an issue stays out of selection: the schedule's
 * cadence. A fire can follow another within minutes, before the worker of
 * the first has claimed its ticket.
 */
export const DISPATCH_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * How the comment a dispatch leaves on its issue or PR starts: the receiver
 * keeps it off every subscriber, and the task reads the dispatch back by it.
 */
export const DISPATCH_MARKER = '<!-- governor:dispatched ';

const MARKER = /<!-- governor:dispatched (\S+) -->/;
const MARKED_SESSION = new RegExp(`Dispatched to (${SESSION_LINK.source})(?![A-Za-z0-9_-])`);

/**
 * The comment a dispatch leaves on its issue, carrying the session URL where
 * the launcher printed one: the in-flight list lives on the ticket.
 *
 * @param {{ at: string, sessionUrl: string | null }} args
 * @returns {string}
 */
export const dispatchMarker = ({ at, sessionUrl }) =>
  [
    `${DISPATCH_MARKER}${at} -->`,
    sessionUrl
      ? `Dispatched to ${sessionUrl} at ${at}.`
      : `Dispatched to a cloud session at ${at}; the launcher printed no session id.`,
  ].join('\n');

/**
 * The newest dispatch a comment records inside the window, and the session
 * it went to where the launcher printed one; null when none did. The
 * marker is the forwarding address: a message the PR's own session refuses
 * goes to the session the marker names rather than starting another.
 *
 * @param {Array<{ body: string } & Record<string, unknown>>} comments
 * @param {number} now
 * @param {number} [windowMs]
 * @returns {{ at: string, sessionUrl: string | null } | null}
 */
export const lastDispatch = (comments, now, windowMs = DISPATCH_WINDOW_MS) => {
  /** @type {{ at: string, sessionUrl: string | null, stamped: number } | null} */
  let newest = null;
  for (const comment of comments) {
    const body = comment.body ?? '';
    const at = MARKER.exec(body)?.[1];
    if (!at) continue;
    const stamped = Date.parse(at);
    if (!Number.isFinite(stamped) || now - stamped >= windowMs) continue;
    if (newest === null || stamped > newest.stamped) {
      newest = { at, sessionUrl: MARKED_SESSION.exec(body)?.[1] ?? null, stamped };
    }
  }
  return newest && { at: newest.at, sessionUrl: newest.sessionUrl };
};

/**
 * Whether any comment records a dispatch inside the window.
 *
 * @param {Array<{ body: string } & Record<string, unknown>>} comments
 * @param {number} now
 * @param {number} [windowMs]
 * @returns {boolean}
 */
export const recentlyDispatched = (comments, now, windowMs = DISPATCH_WINDOW_MS) =>
  lastDispatch(comments, now, windowMs) !== null;

// ── The shape ────────────────────────────────────────────────────────────

/**
 * @typedef {{ kind: 'schedule', issue?: number, freed?: number, label?: string }} ScheduleFire
 *   `label`: the label just added to `issue` in a repo whose ready labels
 *   the receiver does not know; the turn ends before the login unless it is
 *   one of them.
 * @typedef {{ kind: 'probe' }} ProbeFire
 * @typedef {{ kind: 'dispatch', prompt: string, sessionName?: string, model?: string, scheduled?: ScheduledRun }} DispatchFire
 *   `scheduled`: the scheduled run gone red the session is for (route.mjs).
 * @typedef {{ kind: 'message', text: string, fallback?: Fallback, on?: number, event?: SubscriptionEvent, commit?: string, closing?: true, subscribed?: true }
 *   & ({ session: string } | { byBranch: true, on: number, poster?: string })} MessageFire
 *   `session`, or `byBranch` for the live session on a PR's head branch, which the task finds.
 *   `subscribed`: the session hears by subscription, a `governor:subscribe`
 *   line or as an issue's filer, which the repo's subscribe-messages switch
 *   turns on; without it, it is the PR's owner, whose is the PR-messages
 *   switch (dispatch/repo-config.mjs).
 * @typedef {{ kind: 'workflow', name: string, path?: string, branch: string, event?: string, runId: number, url: string, conclusion: string, headSha: string, runAttempt?: number }} WorkflowFire
 *   A run of any workflow on the default branch, `branch`, that ended red;
 *   `path`: its file, where the run named one; `event`: what started it.
 * @typedef {{ kind: 'branch-run', name: string, runId: number, url: string, conclusion: string, headSha: string, branch: string, runAttempt?: number }} BranchRunFire
 *   A run of any workflow dispatched on a branch other than the default, finished.
 * @typedef {{ kind: 'job', name: string, workflow: string, branch: string, runId: number, jobId: number, url: string, headSha: string, label: string, commit: string, runAttempt?: number }} JobFire
 *   A shipping job that succeeded on the default branch, `branch`: its name, carrying
 *   the marker; its workflow's name; its run and job ids; its page; the
 *   run's head; the label the marker names; and the commit it built, the
 *   one its name carries, else the head.
 * @typedef {{ kind: 'review', pr?: number, headSha?: string }} ReviewFire
 * @typedef {{ kind: 'conflicts', pr: number, sha: string, base: string }} ConflictsFire A PR merged into the default branch, `base`, and its merge commit.
 * @typedef {{ kind: 'periodics' }} PeriodicsFire An event a periodic counts, which queued no other fire: the turn checks the repo's periodics alone.
 * @typedef {{ kind: 'hook', hook: string, keyVersion: number, text: string, at: string }} HookFire
 *   A hook an outside system fired: its name, the key version its request
 *   was signed with, the caller's text, and when the receiver took it.
 * @typedef {{ repo: string, number: number, title: string, reason?: string }} Blocker
 *   An issue that closed: its repo, number and title, and GitHub's
 *   `state_reason` for the close where it gave one.
 * @typedef {{ number: number, title: string, url: string }} ClosingPull The PR whose merge closed a blocker, in the blocker's repo.
 * @typedef {{ kind: 'unblocked', issue: number, blocker: Blocker, pr?: ClosingPull }} UnblockedFire
 *   A ticket of the fire's repo that `blocker` blocked, which just closed,
 *   by `pr` where a merge closed it. No body or diff: the fire must fit
 *   the lane ({@link FIRE_BUDGET}).
 * @typedef {(ScheduleFire | ProbeFire | DispatchFire | MessageFire | WorkflowFire | BranchRunFire | JobFire | ReviewFire | ConflictsFire | PeriodicsFire | HookFire | UnblockedFire) & { repo?: string, counted?: Count }} Fire
 *   `repo`: the `owner/name` the fire is for. Every fire names
 *   one but a probe and the bare schedule fire; {@link parseFire} refuses
 *   any other without one: nothing falls back to a default repo.
 *   `counted`: the event a periodic counts that the fire is for ({@link COUNTS}),
 *   so the turn checks the repo's periodics after its own work, under the
 *   repo's periodics switch whatever switch its own work needs. A
 *   `periodics` fire always carries one.
 *
 * @typedef {{ workflowId: number, runId: number, branch: string }} ScheduledRun A scheduled run on the default branch, `branch`, gone red, and its workflow.
 * @typedef {{ prompt: string, sessionName?: string, issue?: number }} Fallback
 *   `issue`: the PR the remark is on, where the turn leaves the dispatch marker and reads it back.
 *
 * @typedef {{ fire: Fire, reason: string, delivery?: string, github?: string, attempt?: number, retryOf?: string }} FireMessage
 *   One lane message: the fire, and why and for which delivery it was queued.
 */

/**
 * `fields` without the ones that are undefined, so a fire carries an absent
 * field as absent and the parser reads back what was built.
 *
 * @template {Record<string, unknown>} T
 * @param {T} fields
 * @returns {{ [K in keyof T]?: Exclude<T[K], undefined> }}
 */
const present = (fields) => /** @type {any} */ (Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));

/**
 * The fires the receiver queues, one builder per kind.
 */
export const build = Object.freeze({
  /** @param {{ issue?: number | undefined, freed?: number | undefined, label?: string | undefined }} args @returns {ScheduleFire} */
  schedule: ({ issue, freed, label }) => ({ kind: 'schedule', ...present({ issue, freed, label }) }),

  /**
   * @param {{ prompt: string, sessionName?: string | undefined, model?: string | undefined, scheduled?: ScheduledRun | undefined }} args
   * @returns {DispatchFire}
   */
  dispatch: ({ prompt, sessionName, model, scheduled }) => ({ kind: 'dispatch', prompt, ...present({ sessionName, model, scheduled }) }),

  /**
   * @param {({ session: string, byBranch?: undefined, poster?: undefined } | { session?: undefined, byBranch: true, poster?: string | undefined }) & {
   *   text: string, on?: number | undefined, event?: SubscriptionEvent | undefined, commit?: string | undefined,
   *   closing?: boolean | undefined, subscribed?: boolean | undefined, fallback?: Fallback | undefined,
   * }} args
   * @returns {MessageFire}
   */
  message: ({ session, byBranch, poster, text, on, event, commit, closing, subscribed, fallback }) => /** @type {MessageFire} */ ({
    kind: 'message',
    ...(byBranch === true ? { byBranch, ...present({ poster }) } : { session }),
    text,
    ...present({
      on,
      event,
      commit,
      closing: closing === true ? /** @type {true} */ (true) : undefined,
      subscribed: subscribed === true ? /** @type {true} */ (true) : undefined,
      fallback: fallback && present(fallback),
    }),
  }),

  /**
   * @param {Omit<WorkflowFire, 'kind' | 'path' | 'event' | 'runAttempt'> & { path?: string | undefined, event?: string | undefined, runAttempt?: number | undefined }} args
   * @returns {WorkflowFire}
   */
  workflow: ({ name, path, branch, event, runId, url, conclusion, headSha, runAttempt }) => ({ kind: 'workflow', name, ...present({ path }), branch, ...present({ event }), runId, url, conclusion, headSha, ...present({ runAttempt }) }),

  /**
   * @param {Omit<BranchRunFire, 'kind' | 'runAttempt'> & { runAttempt?: number | undefined }} args
   * @returns {BranchRunFire}
   */
  branchRun: ({ name, runId, url, conclusion, headSha, branch, runAttempt }) => ({ kind: 'branch-run', name, runId, url, conclusion, headSha, branch, ...present({ runAttempt }) }),

  /**
   * @param {Omit<JobFire, 'kind' | 'runAttempt'> & { runAttempt?: number | undefined }} args
   * @returns {JobFire}
   */
  job: ({ name, workflow, branch, runId, jobId, url, headSha, label, commit, runAttempt }) => ({ kind: 'job', name, workflow, branch, runId, jobId, url, headSha, label, commit, ...present({ runAttempt }) }),

  /** @param {{ pr?: number | undefined, headSha?: string | undefined }} args @returns {ReviewFire} */
  review: ({ pr, headSha }) => ({ kind: 'review', ...present({ pr, headSha }) }),

  /** @param {{ pr: number, sha: string, base: string }} args @returns {ConflictsFire} */
  conflicts: ({ pr, sha, base }) => ({ kind: 'conflicts', pr, sha, base }),

  /** @param {{ counted: Count }} args @returns {PeriodicsFire & { counted: Count }} */
  periodics: ({ counted }) => ({ kind: 'periodics', counted }),

  /** @param {Omit<HookFire, 'kind'>} args @returns {HookFire} */
  hook: ({ hook, keyVersion, text, at }) => ({ kind: 'hook', hook, keyVersion, text, at }),

  /**
   * Each title on one line and at most {@link TITLE_LIMIT} characters, so
   * any title fits the lane.
   *
   * @param {{ issue: number, blocker: Omit<Blocker, 'reason'> & { reason?: string | null | undefined }, pr?: ClosingPull | null | undefined }} args
   * @returns {UnblockedFire}
   */
  unblocked: ({ issue, blocker, pr }) => ({
    kind: 'unblocked',
    issue,
    blocker: { repo: blocker.repo, number: blocker.number, title: shortTitle(blocker.title), ...present({ reason: blocker.reason ?? undefined }) },
    ...(pr === undefined || pr === null ? {} : { pr: { number: pr.number, title: shortTitle(pr.title), url: pr.url } }),
  }),
});

/** The most characters of a title an `unblocked` fire carries. */
export const TITLE_LIMIT = 200;

/** @param {unknown} title */
const shortTitle = (title) => {
  const flat = String(title ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= TITLE_LIMIT ? flat : `${flat.slice(0, TITLE_LIMIT - 1)}\u2026`;
};

// ── The lane message and the container override ─────────────────────────

/**
 * What a fire may weigh on the lane ({@link fireWeight}): the queue takes a
 * message of 256 KiB, and the fire shares it with its reason and the
 * receiver's context. An owner's message fire carries its prompt twice
 * (the text, the fallback). The standing line the task appends is added
 * after the lane, and costs it nothing.
 */
export const FIRE_BUDGET = 200 * 1024;

/** A fire's weight on the lane: its JSON, in bytes. @param {unknown} fire */
export const fireWeight = (fire) => Buffer.byteLength(JSON.stringify(fire));

/**
 * The queue attributes that count the fires on the lane: visible, and in
 * flight, since a fire a dying task received but never deleted comes back
 * once its visibility timeout ends. The starter (starter-handler.mjs) and a
 * turn's sign-off wait (dispatch/turn.mjs sqsFires) count the same way.
 */
export const LANE_COUNTS = /** @type {const} */ (['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']);

/**
 * The fires on the lane, from a GetQueueAttributes answer for LANE_COUNTS.
 * An attribute missing or not a count is a throw, never a quiet lane.
 *
 * @param {Record<string, string> | undefined} attributes
 * @returns {number}
 */
export const laneCount = (attributes) => LANE_COUNTS.reduce((sum, name) => {
  const count = Number(attributes?.[name]);
  if (attributes?.[name] === undefined || !Number.isInteger(count)) throw new Error(`the fire lane did not say ${name}`);
  return sum + count;
}, 0);

/**
 * The task's environment variable a fire by hand rides in: a probe, which
 * scripts/run-turn.mjs starts beside the lane. dispatch/cli.mjs runs that
 * one fire; a task without it reads the lane.
 */
export const FIRE_VARIABLE = 'DISPATCH_EVENT';

/** What ECS takes of a RunTask's overrides, in characters of JSON. */
export const OVERRIDE_CAP = 8192;

/**
 * The RunTask overrides that carry `fire` to the task's container: a probe's
 * (scripts/run-turn.mjs).
 *
 * @param {string} containerName
 * @param {unknown} fire
 */
export const containerOverride = (containerName, fire) => ({
  containerOverrides: [{ name: containerName, environment: [{ name: FIRE_VARIABLE, value: JSON.stringify(fire) }] }],
});

// ── The parser ───────────────────────────────────────────────────────────

/** A fire's numbers (issue, PR, run) are positive integers. @param {unknown} v */
const isPositiveInt = (v) => Number.isInteger(v) && Number(v) > 0;

/** A full commit id. @param {unknown} v @returns {v is string} */
export const isCommit = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);

/** A branch's name, as a payload names it: one line, not empty. @param {unknown} v @returns {v is string} */
export const isBranch = (v) => typeof v === 'string' && v !== '' && !/\s/.test(v);

/**
 * A dispatch fire's scheduled run: a positive workflow id and run id, and
 * the default branch it ran on.
 *
 * @param {unknown} value
 * @returns {ScheduledRun}
 */
const parseScheduled = (value) => {
  const v = /** @type {Record<string, unknown> | null} */ (value);
  if (!isPositiveInt(v?.workflowId) || !isPositiveInt(v?.runId) || !isBranch(v?.branch)) {
    throw new Error(`a dispatch invocation's scheduled names a positive workflowId and runId, and its branch, got: ${JSON.stringify(value)}`);
  }
  return { workflowId: Number(v?.workflowId), runId: Number(v?.runId), branch: /** @type {string} */ (v?.branch) };
};

/**
 * The stack's owner list, off its comma-separated
 * `DISPATCH_OWNERS`; unset is no owner. The receiver's and the task's.
 *
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export const ownersOf = (raw) => (raw ?? '').split(',').map((o) => o.trim()).filter((o) => o !== '');

/**
 * The stack's SelectLabels, off its comma-separated
 * `SELECT_LABELS`: the labels whose addition queues a selection fire.
 * Unset or empty is every label. The receiver's.
 *
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export const selectLabelsOf = ownersOf;

/**
 * Whether `account` is on the owner list, in any case.
 *
 * @param {readonly string[]} owners
 * @param {string} account
 */
export const ownerListed = (owners, account) => owners.some((o) => o.toLowerCase() === account.toLowerCase());

/**
 * A hook's name, as the config file lists it and its URL path names it:
 * lower-case letters, digits and hyphens, safe in a path.
 */
export const HOOK_NAME = /^[a-z0-9-]{1,64}$/;

/**
 * The most fires a hook takes in a clock hour when its file sets no
 * `perHour`, and for a repo the hook table has no item for yet.
 */
export const HOOK_PER_HOUR = 20;

/**
 * The largest `perHour` a hook may set. An hour's count item holds each
 * signature it counted, 64 hex characters apiece, so this keeps the item
 * under 7 KB, and a count or a refusal at most 7 write units. Governor runs
 * about 100 fires an hour in all, so a larger cap buys nothing.
 */
export const HOOK_PER_HOUR_MAX = 100;

/** The event a fire signed with a stale key version logs, at error, at the receiver or the task; `governor-hook-key-stale` pages on it. */
export const HOOK_KEY_STALE = 'hook-key-stale';

/** A repository's `owner/name`, as GitHub spells one. */
export const REPO_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * Read the fire off the raw event: a lane message's fire, a fire by hand, or
 * EventBridge's own scheduled event. Anything unrecognised is refused rather
 * than dispatched: a session costs money and attention. A fire's `repo` rides
 * along (a probe's is dropped: it touches no repo). Every fire but a probe
 * and the bare schedule fire names one, and is refused without: a
 * fire queued before the dispatcher served more than one repo is refused,
 * not read as the stack's.
 *
 * @param {unknown} event
 * @returns {Fire}
 */
export const parseFire = (event) => {
  const fire = parseKind(event);
  const { repo, counted } = /** @type {Record<string, unknown> | null} */ (event) ?? {};
  if (fire.kind === 'probe') return fire;
  if (repo === undefined) {
    if (fire.kind === 'schedule' && fire.issue === undefined && fire.freed === undefined && counted === undefined) return fire;
    throw new Error(`a ${fire.kind} fire names its repo, and this one names none: ${JSON.stringify(event)?.slice(0, 300)}`);
  }
  if (typeof repo !== 'string' || !REPO_NAME.test(repo)) throw new Error(`a fire's repo is an owner/name, got: ${JSON.stringify(repo)}`);
  if (counted === undefined) {
    if (fire.kind === 'periodics') throw new Error(`a periodics fire names the event it counted, and this one names none: ${JSON.stringify(event)?.slice(0, 300)}`);
    return { ...fire, repo };
  }
  if (!COUNTS.includes(/** @type {Count} */ (counted))) throw new Error(`a fire's counted is one of ${COUNTS.join(', ')}, got: ${JSON.stringify(counted)}`);
  return { ...fire, repo, counted: /** @type {Count} */ (counted) };
};

/**
 * @param {unknown} event
 * @returns {Fire}
 */
const parseKind = (event) => {
  const e = /** @type {Record<string, unknown> | null} */ (event);
  if (e && e.source === 'aws.events') return { kind: 'schedule' };
  const kind = e?.kind;
  if (kind === 'probe') return { kind };
  if (kind === 'schedule') {
    if (e?.issue !== undefined && e?.freed !== undefined) {
      throw new Error(`a schedule fire names an issue or a freed one, not both: ${JSON.stringify(event)}`);
    }
    const positive = (/** @type {'issue' | 'freed'} */ key) => {
      if (!isPositiveInt(e?.[key])) {
        throw new Error(`a schedule fire's ${key} must be a positive integer, got: ${JSON.stringify(e?.[key])}`);
      }
      return Number(e?.[key]);
    };
    if (e?.label !== undefined && (e?.issue === undefined || typeof e.label !== 'string' || e.label.trim() === '')) {
      throw new Error(`a schedule fire's label names the label just added to its issue, got: ${JSON.stringify(e?.label)}`);
    }
    if (e?.issue !== undefined) return { kind, issue: positive('issue'), ...(e?.label === undefined ? {} : { label: /** @type {string} */ (e.label) }) };
    if (e?.freed !== undefined) return { kind, freed: positive('freed') };
    return { kind };
  }
  if (kind === 'dispatch') {
    if (typeof e?.prompt !== 'string' || e.prompt.trim() === '') {
      throw new Error('a dispatch invocation needs a prompt');
    }
    return {
      kind,
      prompt: e.prompt,
      ...(typeof e.sessionName === 'string' ? { sessionName: e.sessionName } : {}),
      ...(typeof e.model === 'string' ? { model: e.model } : {}),
      ...(e.scheduled === undefined ? {} : { scheduled: parseScheduled(e.scheduled) }),
    };
  }
  if (kind === 'message') return parseMessage(e, event);
  if (kind === 'workflow') return parseWorkflow(e);
  if (kind === 'branch-run') return parseBranchRun(e);
  if (kind === 'job') return parseJob(e);
  if (kind === 'review') {
    if (e?.pr !== undefined && !isPositiveInt(e.pr)) {
      throw new Error(`a review invocation's pr must be a positive integer, got: ${JSON.stringify(e.pr)}`);
    }
    if (e?.headSha !== undefined && !(e.pr !== undefined && isCommit(e.headSha))) {
      throw new Error(`a review invocation's headSha must be a commit id on a named pr, got: ${JSON.stringify(e.headSha)}`);
    }
    return {
      kind,
      ...(e?.pr === undefined ? {} : { pr: Number(e.pr) }),
      ...(e?.headSha === undefined ? {} : { headSha: /** @type {string} */ (e.headSha) }),
    };
  }
  if (kind === 'periodics') return { kind };
  if (kind === 'hook') return parseHook(e);
  if (kind === 'unblocked') return parseUnblocked(e);
  if (kind === 'conflicts') {
    if (!isPositiveInt(e?.pr)) {
      throw new Error(`a conflicts invocation's pr must be a positive integer, got: ${JSON.stringify(e?.pr)}`);
    }
    if (!isCommit(e?.sha)) {
      throw new Error(`a conflicts invocation's sha must be a commit id, got: ${JSON.stringify(e?.sha)}`);
    }
    if (!isBranch(e?.base)) {
      throw new Error(`a conflicts invocation's base must name the default branch, got: ${JSON.stringify(e?.base)}`);
    }
    return { kind, pr: Number(e?.pr), sha: /** @type {string} */ (e?.sha), base: /** @type {string} */ (e?.base) };
  }
  throw new Error(`invocation has no recognised kind: ${JSON.stringify(event)}`);
};

/**
 * A message fire, refused unless it names a session it could have read out
 * of a body (or byBranch and the PR it is on) and text.
 *
 * @param {Record<string, unknown> | null} e
 * @param {unknown} event
 * @returns {MessageFire}
 */
const parseMessage = (e, event) => {
  if (e?.byBranch !== undefined) {
    if (e.byBranch !== true || e.session !== undefined) {
      throw new Error(`a message invocation names a session or byBranch: true, not both: ${JSON.stringify(event).slice(0, 300)}`);
    }
    if (!isPositiveInt(e.on)) throw new Error(`a byBranch message invocation needs the PR it is on, got: ${JSON.stringify(e.on)}`);
    if (e.poster !== undefined && !(typeof e.poster === 'string' && MESSAGE_SESSION.test(e.poster))) {
      throw new Error(`a message invocation's poster must be a session id or claude.ai/code URL, got: ${JSON.stringify(e.poster)}`);
    }
  } else if (typeof e?.session !== 'string' || !MESSAGE_SESSION.test(e.session)) {
    throw new Error(`a message invocation needs a session id or claude.ai/code URL, got: ${JSON.stringify(e?.session)}`);
  }
  if (typeof e?.text !== 'string' || e.text.trim() === '') throw new Error('a message invocation needs text');
  if (e.on !== undefined && !isPositiveInt(e.on)) {
    throw new Error(`a message invocation's on must be a positive integer, got: ${JSON.stringify(e.on)}`);
  }
  if (e.event !== undefined && !EVENTS.has(String(e.event))) {
    throw new Error(`a message invocation's event is not one a session subscribes to: ${JSON.stringify(e.event)}`);
  }
  if (e.commit !== undefined && !isCommit(e.commit)) {
    throw new Error(`a message invocation's commit must be a commit id, got: ${JSON.stringify(e.commit)}`);
  }
  if (e.closing !== undefined && e.closing !== true) {
    throw new Error(`a message invocation's closing is true or absent, got: ${JSON.stringify(e.closing)}`);
  }
  if (e.subscribed !== undefined && e.subscribed !== true) {
    throw new Error(`a message invocation's subscribed is true or absent, got: ${JSON.stringify(e.subscribed)}`);
  }
  const to = e.byBranch === true
    ? { byBranch: /** @type {true} */ (true), on: Number(e.on), ...(typeof e.poster === 'string' ? { poster: e.poster } : {}) }
    : { session: /** @type {string} */ (e.session) };
  return {
    kind: 'message',
    ...to,
    text: e.text,
    ...(e.fallback === undefined ? {} : { fallback: parseFallback(e.fallback) }),
    ...(e.on === undefined ? {} : { on: Number(e.on) }),
    ...(e.event === undefined ? {} : { event: /** @type {SubscriptionEvent} */ (e.event) }),
    ...(e.commit === undefined ? {} : { commit: e.commit }),
    ...(e.closing === true ? { closing: /** @type {true} */ (true) } : {}),
    ...(e.subscribed === true ? { subscribed: /** @type {true} */ (true) } : {}),
  };
};

/**
 * A workflow fire, refused unless it names a workflow and the run whole:
 * the turn reads the jobs by the id, the PRs by the commit, and the ticket
 * label from the file at `path`.
 *
 * @param {Record<string, unknown> | null} e
 * @returns {WorkflowFire}
 */
const parseWorkflow = (e) => {
  const name = e?.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`a workflow invocation must name its workflow, got: ${JSON.stringify(name)}`);
  }
  if (e?.path !== undefined && !(typeof e.path === 'string' && WORKFLOW_PATH.test(e.path))) {
    throw new Error(`a workflow invocation's path must be a file under .github/workflows, got: ${JSON.stringify(e.path)}`);
  }
  if (!isPositiveInt(e?.runId)) throw new Error(`a workflow invocation's runId must be a positive integer, got: ${JSON.stringify(e?.runId)}`);
  if (typeof e?.url !== 'string' || !e.url.startsWith('https://')) throw new Error(`a workflow invocation needs the run's url, got: ${JSON.stringify(e?.url)}`);
  if (typeof e?.conclusion !== 'string' || e.conclusion === '') throw new Error(`a workflow invocation needs the run's conclusion, got: ${JSON.stringify(e?.conclusion)}`);
  if (!isCommit(e?.headSha)) throw new Error(`a workflow invocation's headSha must be a commit id, got: ${JSON.stringify(e?.headSha)}`);
  if (!isBranch(e?.branch)) throw new Error(`a workflow invocation's branch must name the default branch, got: ${JSON.stringify(e?.branch)}`);
  if (e.event !== undefined && !(typeof e.event === 'string' && e.event !== '')) throw new Error(`a workflow invocation's event must name what started the run, got: ${JSON.stringify(e.event)}`);
  if (e.runAttempt !== undefined && !isPositiveInt(e.runAttempt)) {
    throw new Error(`a workflow invocation's runAttempt must be a positive integer, got: ${JSON.stringify(e.runAttempt)}`);
  }
  return {
    kind: 'workflow',
    name,
    ...(e.path === undefined ? {} : { path: /** @type {string} */ (e.path) }),
    branch: /** @type {string} */ (e.branch),
    ...(e.event === undefined ? {} : { event: /** @type {string} */ (e.event) }),
    runId: Number(e.runId),
    url: e.url,
    conclusion: e.conclusion,
    headSha: e.headSha,
    ...(e.runAttempt === undefined ? {} : { runAttempt: Number(e.runAttempt) }),
  };
};

/**
 * A branch-run fire, refused unless it names the run whole and a branch
 * other than main: the turn reads the jobs by the id and the session by the
 * commit.
 *
 * @param {Record<string, unknown> | null} e
 * @returns {BranchRunFire}
 */
const parseBranchRun = (e) => {
  const refuse = (/** @type {string} */ what) => { throw new Error(`a branch-run invocation's ${what}, got: ${JSON.stringify(e)?.slice(0, 300)}`); };
  if (typeof e?.name !== 'string' || e.name.trim() === '') refuse('name must name the workflow');
  if (!isPositiveInt(e?.runId)) refuse('runId must be a positive integer');
  if (typeof e?.url !== 'string' || !e.url.startsWith('https://')) refuse("url must be the run's");
  if (typeof e?.conclusion !== 'string' || e.conclusion === '') refuse("conclusion must be the run's");
  if (!isCommit(e?.headSha)) refuse('headSha must be a commit id');
  if (!isBranch(e?.branch)) refuse('branch must name it');
  if (e?.runAttempt !== undefined && !isPositiveInt(e.runAttempt)) refuse('runAttempt must be a positive integer');
  return {
    kind: 'branch-run',
    name: /** @type {string} */ (e?.name),
    runId: Number(e?.runId),
    url: /** @type {string} */ (e?.url),
    conclusion: /** @type {string} */ (e?.conclusion),
    headSha: /** @type {string} */ (e?.headSha),
    branch: /** @type {string} */ (e?.branch),
    ...(e?.runAttempt === undefined ? {} : { runAttempt: Number(e.runAttempt) }),
  };
};

/**
 * A job fire, refused unless it names the job whole and its name carries
 * the marker for the label it claims: the turn reads the run by the id for
 * its workflow file, the range by the commit, and the label is what it
 * writes.
 *
 * @param {Record<string, unknown> | null} e
 * @returns {JobFire}
 */
const parseJob = (e) => {
  const refuse = (/** @type {string} */ what) => { throw new Error(`a job invocation's ${what}, got: ${JSON.stringify(e)?.slice(0, 300)}`); };
  if (typeof e?.name !== 'string' || e.name.trim() === '') refuse('name must name the job');
  if (typeof e?.workflow !== 'string' || e.workflow.trim() === '') refuse('workflow must name the workflow');
  if (!isBranch(e?.branch)) refuse('branch must name the default branch');
  if (!isPositiveInt(e?.runId)) refuse('runId must be a positive integer');
  if (!isPositiveInt(e?.jobId)) refuse('jobId must be a positive integer');
  if (typeof e?.url !== 'string' || !e.url.startsWith('https://')) refuse("url must be the job's");
  if (!isCommit(e?.headSha)) refuse('headSha must be a commit id');
  if (!isCommit(e?.commit)) refuse('commit must be a commit id');
  if (typeof e?.label !== 'string' || shippingJob(e?.name)?.label !== e.label) refuse('label must be the one its name carries');
  if (e?.runAttempt !== undefined && !isPositiveInt(e.runAttempt)) refuse('runAttempt must be a positive integer');
  return {
    kind: 'job',
    name: /** @type {string} */ (e?.name),
    workflow: /** @type {string} */ (e?.workflow),
    branch: /** @type {string} */ (e?.branch),
    runId: Number(e?.runId),
    jobId: Number(e?.jobId),
    url: /** @type {string} */ (e?.url),
    headSha: /** @type {string} */ (e?.headSha),
    label: /** @type {string} */ (e?.label),
    commit: /** @type {string} */ (e?.commit),
    ...(e?.runAttempt === undefined ? {} : { runAttempt: Number(e.runAttempt) }),
  };
};

/**
 * A hook fire, refused unless it names a hook the file could list, a
 * positive key version, the caller's text and when it was taken. One that
 * carries a prompt is refused: the prompt is the file's, never the caller's.
 *
 * @param {Record<string, unknown> | null} e
 * @returns {HookFire}
 */
const parseHook = (e) => {
  const refuse = (/** @type {string} */ what) => { throw new Error(`a hook invocation's ${what}, got: ${JSON.stringify({ ...e, text: undefined })?.slice(0, 300)}`); };
  if (e?.prompt !== undefined) refuse('prompt is the config file\'s, so it carries none');
  if (typeof e?.hook !== 'string' || !HOOK_NAME.test(e.hook)) refuse('hook must be a hook name');
  if (!isPositiveInt(e?.keyVersion)) refuse('keyVersion must be a positive integer');
  if (typeof e?.text !== 'string' || e.text.trim() === '') refuse('text must be the caller\'s');
  if (typeof e?.at !== 'string' || !Number.isFinite(Date.parse(e.at))) refuse('at must be when the receiver took it');
  return { kind: 'hook', hook: /** @type {string} */ (e?.hook), keyVersion: Number(e?.keyVersion), text: /** @type {string} */ (e?.text), at: /** @type {string} */ (e?.at) };
};

/** A title an `unblocked` fire carries: one line, not empty, short. @param {unknown} v @returns {v is string} */
const isTitle = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= TITLE_LIMIT && !/[\r\n]/.test(v);

/**
 * An unblocked fire, refused unless it names the ticket and the blocker
 * whole, and the closing PR whole where it names one.
 *
 * @param {Record<string, unknown> | null} e
 * @returns {UnblockedFire}
 */
const parseUnblocked = (e) => {
  const refuse = (/** @type {string} */ what) => { throw new Error(`an unblocked invocation's ${what}, got: ${JSON.stringify(e)?.slice(0, 300)}`); };
  if (!isPositiveInt(e?.issue)) refuse('issue must be a positive integer');
  const b = /** @type {Record<string, unknown> | null} */ (e?.blocker ?? null);
  if (b === null || typeof b !== 'object' || typeof b.repo !== 'string' || !REPO_NAME.test(b.repo) || !isPositiveInt(b.number) || !isTitle(b.title)) refuse('blocker must name its repo, number and title');
  if (b?.reason !== undefined && !(typeof b.reason === 'string' && /^[a-z_]{1,40}$/.test(b.reason))) refuse('blocker reason must be a close reason');
  const p = /** @type {Record<string, unknown> | null | undefined} */ (e?.pr);
  if (p !== undefined && (p === null || typeof p !== 'object' || !isPositiveInt(p.number) || !isTitle(p.title) || typeof p.url !== 'string' || !/^https:\/\/github\.com\/\S+$/.test(p.url))) refuse('pr must name its number, title and github.com url');
  const blocker = /** @type {Record<string, unknown>} */ (b);
  return {
    kind: 'unblocked',
    issue: Number(e?.issue),
    blocker: { repo: String(blocker.repo), number: Number(blocker.number), title: String(blocker.title), ...(blocker.reason === undefined ? {} : { reason: String(blocker.reason) }) },
    ...(p === undefined ? {} : { pr: { number: Number(p?.number), title: String(p?.title), url: String(p?.url) } }),
  };
};

/**
 * A message's fallback, refused unless it names a prompt: a fallback with
 * nothing to start would report a refused message as answered.
 *
 * @param {unknown} raw
 * @returns {Fallback}
 */
const parseFallback = (raw) => {
  const f = /** @type {Record<string, unknown> | null} */ (raw);
  if (!f || typeof f !== 'object' || typeof f.prompt !== 'string' || f.prompt.trim() === '') {
    throw new Error(`a message invocation's fallback needs a prompt, got: ${JSON.stringify(raw)}`);
  }
  if (f.issue !== undefined && !isPositiveInt(f.issue)) {
    throw new Error(`a message invocation's fallback names an issue that is not a positive integer: ${JSON.stringify(f.issue)}`);
  }
  return {
    prompt: f.prompt,
    ...(typeof f.sessionName === 'string' ? { sessionName: f.sessionName } : {}),
    ...(f.issue === undefined ? {} : { issue: Number(f.issue) }),
  };
};
