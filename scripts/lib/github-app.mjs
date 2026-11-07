/**
 * The dispatcher's GitHub identity: an installation token minted from the
 * GitHub App the repository carries (the APP_ID variable and APP_PRIVATE_KEY
 * secret the deploy writes into the dispatcher's secret), and a small REST
 * reader over `fetch`.
 *
 * The dispatcher's image has no `gh` and no `gh-deps` shim, so this reads the
 * endpoints directly and returns the row shapes `scripts/lib/ready-work.mjs`
 * selects over: `readyIssues(labels)` the issues carrying every ready label,
 * and `blockers(n)` what `gh-deps list-blockers` emits.
 *
 * Node built-ins only: the dispatcher image carries this directory and no
 * `node_modules` for it.
 */

import { createSign } from 'node:crypto';
import { postedByApp } from '../../dispatch/webhook/review-comment.mjs';
import { closedBy } from '../../dispatch/pr-body.mjs';
import { relayedBody, sessionId, sessionsNamedIn } from '../../dispatch/webhook/subscribe.mjs';
import { waitOf } from './ready-work.mjs';
import { lets, ticketAuthor } from '../../dispatch/trust.mjs';
import { lastDispatch } from '../../dispatch/webhook/fire.mjs';
import { messageOf } from './error-message.mjs';

const API = 'https://api.github.com';
/** The version the gh-deps shim pins, so both read the same endpoint shapes. */
const API_VERSION = '2022-11-28';

/**
 * Sends of a call whose answer shows nothing changed, and the first pause
 * before a resend, doubled for each one after. Nothing changed where the
 * connection dropped (`fetch` or the body read throws), GitHub answered with
 * a server error (`RESENT_STATUSES`), or it rate limited the call and asked
 * for a wait of `RESEND_WAIT_MAX_S` or less, which is the pause then. Each is
 * a blip the next send clears; before these, one failed a whole dispatcher
 * turn. Only a GET, or a write the caller marks safe to repeat, is sent
 * again: a write may have landed whatever came back. Any other answer, a 404,
 * a 422, a 403 for a missing permission or a longer rate limit, is never
 * resent here.
 *
 * A call that spends all its sends on server errors or dropped connections
 * turns resends off for the rest of the turn (`Resends`): a fault that
 * outlasts two resends is an outage, not a blip, and every later read would spend 3 sends and 3 seconds
 * of pauses failing, which a sweep or a review would take out of its window.
 */
const SENDS = 3;
const RESEND_PAUSE_MS = 1_000;
const RESENT_STATUSES = new Set([500, 502, 503, 504]);
const RESEND_WAIT_MAX_S = 10;

/** @type {Log} */
const noLog = () => {};

/** @param {number} ms */
const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** @param {string | Buffer} data */
const b64url = (data) => Buffer.from(data).toString('base64url');

/**
 * A JWT that identifies the App itself, for the two calls that take one.
 * Issued a minute in the past for clock skew, and good for nine minutes, one
 * inside GitHub's ten-minute cap.
 *
 * @param {{ appId: string, privateKeyPem: string, now?: number }} args
 * @returns {string}
 */
export const appJwt = ({ appId, privateKeyPem, now = Date.now() }) => {
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
};

/** @typedef {(event: string, context?: Record<string, unknown>) => void} Log */

/**
 * @typedef {{ spent: boolean }} Resends Whether a call this turn has spent
 * its sends, after which every call sharing the switch is sent once. A turn
 * makes one (`turnResends`) and hands it to every client it builds; a client
 * given none has its own.
 */

/** A turn's resend switch, on. @returns {Resends} */
export const turnResends = () => ({ spent: false });

/**
 * @param {{ fetch: typeof globalThis.fetch, sleep: (ms: number) => Promise<unknown>, log: Log, resends: Resends }} io
 * @param {string} auth The Authorization header value.
 * @param {string} method
 * @param {string} path Under the API host.
 * @param {unknown} [body]
 * @param {boolean} [repeatable] Safe to send twice; a GET always is.
 * @returns {Promise<any>} The JSON body, or null for an empty answer.
 */
const request = async ({ fetch, sleep, log, resends }, auth, method, path, body, repeatable = method.toUpperCase() === 'GET') => {
  /** What the last answer asks of a resend: see `resendOf`. @type {Resend} */
  let resend = 'backoff';
  const send = async () => {
    resend = 'backoff';
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: auth,
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      // The status rides the error as a field: the path carries an issue
      // number, so a caller reading the status off the message would take
      // issue #404's 502 for a 404. The body's `message` rides the text: a
      // 403 for a permission the App lacks says which only there.
      const detail = await apiMessage(response);
      const limited = rateLimited(response, detail);
      resend = resendOf(response, limited);
      throw Object.assign(
        new Error(`${method} ${path} failed: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`.trim()),
        { status: response.status, rateLimited: limited, planLimited: planLimited(response, detail) },
      );
    }
    if (response.status === 204) return null;
    // Read inside the send: fetch resolves on the headers, so a connection
    // that drops mid-body throws here.
    return response.json();
  };
  const sends = repeatable ? SENDS : 1;
  for (let sent = 1; ; sent += 1) {
    try {
      return await send();
    } catch (error) {
      // A dropped connection leaves `resend` at its backoff: no answer came.
      if (resend === null || resends.spent) throw error;
      const status = /** @type {{ status?: number }} */ (error)?.status;
      const answer = status === undefined ? { error: messageOf(error) } : { status };
      if (sent >= sends) {
        // A rate limit is the one token's, not GitHub's: the turn's other
        // installations keep their resends.
        if (sends > 1 && /** @type {{ rateLimited?: boolean }} */ (error)?.rateLimited !== true) {
          resends.spent = true;
          log('dispatch-github-resends-off', { level: 'warn', method, path, ...answer });
        }
        throw error;
      }
      log('dispatch-github-retry', { level: 'info', method, path, ...answer, try: sent });
      await sleep(resend === 'backoff' ? RESEND_PAUSE_MS * 2 ** (sent - 1) : resend);
    }
  }
};

/** @typedef {'backoff' | number | null} Resend */

/**
 * What a failed answer asks of a resend. A server error or a rate limit that
 * gives a `retry-after` waits it, where that is a whole number of seconds no
 * more than `RESEND_WAIT_MAX_S`, and is not resent where GitHub asks for
 * longer. A server error that gives none waits the doubling pause
 * (`'backoff'`). Any other answer, a rate limit naming no wait among them,
 * is null: never resent.
 *
 * @param {Response} response
 * @param {boolean} limited Whether `rateLimited` classes it.
 * @returns {Resend}
 */
const resendOf = (response, limited) => {
  const server = RESENT_STATUSES.has(response.status);
  if (!server && !limited) return null;
  const after = response.headers.get('retry-after');
  if (after === null) return server ? 'backoff' : null;
  if (!/^\d+$/.test(after.trim())) return null;
  const seconds = Number(after.trim());
  return seconds <= RESEND_WAIT_MAX_S ? seconds * 1_000 : null;
};

/**
 * Whether a refusal is GitHub's rate limit: a 429, or a 403 with the primary
 * limit spent (`x-ratelimit-remaining: 0`), a secondary limit's
 * `retry-after`, or a body naming a secondary limit, which GitHub sends at
 * times with neither header. Read here, where the refusal is GitHub's, so a
 * caller reads the class and never the error's text.
 *
 * @param {Response} response
 * @param {string} detail The body's `message`.
 * @returns {boolean}
 */
const rateLimited = (response, detail) =>
  response.status === 429 ||
  (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /\bsecondary rate limit\b/i.test(detail)));

/**
 * Whether a refusal is the repo's plan lacking the feature: a 403 whose body
 * says to upgrade the plan, which GitHub sends for a private repo on a free plan
 * (rulesets among them). Read here for the reason `rateLimited` is.
 *
 * @param {Response} response
 * @param {string} detail The body's `message`.
 * @returns {boolean}
 */
const planLimited = (response, detail) => response.status === 403 && /\bUpgrade to GitHub (Pro|Team|Enterprise)\b/.test(detail);

/**
 * The `message` of a failed answer's JSON body, or '' where there is none:
 * a body that is not JSON, or one without the field.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
const apiMessage = async (response) => {
  try {
    const body = await response.json();
    return typeof body?.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
};

/**
 * A REST call as an installation token, by method and path. The shape
 * every fetch-side caller takes its `api` in.
 *
 * @param {{ token: string, fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<unknown>, log?: Log, resends?: Resends }} args
 * @returns {(method: string, path: string, body?: unknown) => Promise<any>}
 */
export const githubApi = ({ token, fetch = globalThis.fetch, sleep = realSleep, log = noLog, resends = turnResends() }) => {
  const auth = `Bearer ${token}`;
  return (method, path, body) => request({ fetch, sleep, log, resends }, auth, method, path, body);
};

/**
 * An installation token for the repository: the App's identity, scoped to the
 * one installation, good for an hour.
 *
 * @param {{ appId: string, privateKeyPem: string, repo: string, fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<unknown>, log?: Log, resends?: Resends, now?: number }} args
 * @returns {Promise<string>}
 */
export const installationToken = async ({ appId, privateKeyPem, repo, fetch = globalThis.fetch, sleep = realSleep, log = noLog, resends = turnResends(), now }) => {
  const auth = `Bearer ${appJwt({ appId, privateKeyPem, ...(now === undefined ? {} : { now }) })}`;
  const installation = await request({ fetch, sleep, log, resends }, auth, 'GET', `/repos/${repo}/installation`);
  // A second mint only issues a second token, so it is resent like a read.
  const minted = await request({ fetch, sleep, log, resends }, auth, 'POST', `/app/installations/${installation.id}/access_tokens`, undefined, true);
  return String(minted.token);
};

/**
 * The App's installations and the repos each was granted: the
 * bare schedule fire's list of what it might serve. An installation whose
 * account is not on `owners`, or that is suspended, is listed with no repos:
 * it gets no token, and nothing of it is read. A refusal anywhere throws.
 *
 * @param {{ appId: string, privateKeyPem: string, owners: readonly string[], fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<unknown>, log?: Log, resends?: Resends, now?: number }} args
 * @returns {Promise<Array<{ account: string, repos: string[] }>>}
 */
export const appInstallations = async ({ appId, privateKeyPem, owners, fetch = globalThis.fetch, sleep = realSleep, log = noLog, resends = turnResends(), now }) => {
  const auth = `Bearer ${appJwt({ appId, privateKeyPem, ...(now === undefined ? {} : { now }) })}`;
  const listed = owners.map((o) => o.toLowerCase());
  /** @type {Array<{ account: string, repos: string[] }>} */
  const out = [];
  for (let page = 1; ; page += 1) {
    /** @type {any[]} */
    const batch = await request({ fetch, sleep, log, resends }, auth, 'GET', `/app/installations?per_page=100&page=${page}`);
    for (const installation of batch) {
      const account = String(installation?.account?.login ?? '');
      // A suspended installation refuses a token mint: read it as granting
      // nothing, so one owner's suspension does not refuse every repo's turn.
      if (!listed.includes(account.toLowerCase()) || installation?.suspended_at != null) {
        out.push({ account, repos: [] });
        continue;
      }
      const minted = await request({ fetch, sleep, log, resends }, auth, 'POST', `/app/installations/${installation.id}/access_tokens`, undefined, true);
      const call = githubApi({ token: String(minted.token), fetch, sleep, log, resends });
      /** @type {string[]} */
      const repos = [];
      for (let p = 1; ; p += 1) {
        const answer = await call('GET', `/installation/repositories?per_page=100&page=${p}`);
        /** @type {any[]} */
        const rows = answer?.repositories ?? [];
        repos.push(...rows.map((r) => String(r.full_name)));
        if (rows.length < 100) break;
      }
      out.push({ account, repos });
    }
    if (batch.length < 100) return out;
  }
};

/**
 * An issue's open blockers by its dependency summary, as `{ openBlockers }`,
 * or `{}` where the row has no summary. The summary counts a blocker the
 * caller cannot see, which `blocked_by` leaves out.
 *
 * @param {any} row
 * @returns {{ openBlockers?: number }}
 */
const openBlockersOf = (row) => {
  const count = row?.issue_dependencies_summary?.blocked_by;
  return Number.isInteger(count) && count >= 0 ? { openBlockers: count } : {};
};

/** @param {any} row */
const labelNames = (row) =>
  (row.labels ?? []).map((/** @type {any} */ l) => (typeof l === 'string' ? l : l.name));

/**
 * @typedef {{ number: number, title: string, state: string, created_at: string, labels: string[], openBlockers?: number, wait?: import('./ready-work.mjs').Wait, author?: string, association?: string }} IssueRow
 *   `author`: the login that opened it; `association`: its `author_association`.
 *   `openBlockers`: the open blockers by its dependency summary, where it has one.
 *   `wait`: what its body's `Blocked until:` line says, where it has one (`waitOf`).
 * @typedef {{ number: number, state: string, title: string, id?: number }} BlockerRow
 * @typedef {{ id: number, body: string, created_at: string }} CommentRow
 * @typedef {{ number: number, title: string, html_url: string, body: string, merged_at: string | null, merge_commit_sha: string | null, head: string } & Required<import('../../dispatch/webhook/fire.mjs').Author>} PullRow
 *   `head`: its head branch, '' for a fork's; `author`: the login that opened it, with its
 *   `association`, whether it is a bot, and whether governor's own App opened it (`own`).
 * @typedef {{ name: string, conclusion: string | null, html_url: string }} JobRow
 * @typedef {{ id: number, status: string, conclusion: string | null, event: string, head_branch: string | null, head_sha: string, html_url: string, created_at: string }} RunRow
 * @typedef {RunRow & { path: string, run_attempt: number }} RunDetail One run read by id: a RunRow and its workflow file.
 * @typedef {{ sha: string, message: string }} CommitRow
 * @typedef {{ number: number, title: string, html_url: string, pull: boolean, holds?: boolean }} OpenRow
 *   `holds`: given the labels that hold a session, whether this row holds
 *   its sign-off ask (`openNaming`).
 * @typedef {{ number: number, title: string, body: string, state: string, draft: boolean, base: string, headSha: string, mergeable: boolean | null, html_url: string, association: string, author: string, bot?: boolean }} PullRequestRow
 *   `author`: the login that opened it; `bot`: whether GitHub marks its account as a bot, which `trust.review` judges as `BOT`.
 * @typedef {{ filename: string, status: string, previous?: string }} FileRow `previous`: the path a rename left.
 * @typedef {{ sha: string, author: string | null, committer: string | null, verified: boolean }} PullCommitRow
 *   `author`, `committer`: the logins GitHub ties them to, null for none; `verified`: GitHub verified its signature.
 * @typedef {{ number: number, id?: number, title: string, body: string, state: string, labels: string[], pull: boolean, created_at?: string, openBlockers?: number, wait?: import('./ready-work.mjs').Wait, author?: string, association?: string, app?: boolean }} TicketRow
 *   `author`: the login that opened it; `association`: its `author_association`.
 *   `app`: the reader's own App opened it, which a trust list judges as
 *   it judges that App's PRs (`own`) where a caller asks it to.
 * @typedef {{ id: number, body: string, created_at: string, ours: boolean }} ThreadRow `ours`: the reader's own App posted it.
 * @typedef {{ number: number, draft: boolean, base: string, head: string, headSha: string, title: string, html_url: string, body: string } & Required<import('../../dispatch/webhook/fire.mjs').Author>} OpenPullRow
 */

/** How a check run, or a workflow run, ends that blocks a merge on a check it is. */
export const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/**
 * A row of a workflow's runs list, as a RunRow.
 *
 * @param {any} row
 * @returns {RunRow}
 */
const runRow = (row) => ({
  id: row.id,
  status: row.status,
  conclusion: row.conclusion ?? null,
  event: row.event,
  head_branch: row.head_branch,
  head_sha: row.head_sha,
  html_url: row.html_url,
  created_at: row.created_at,
});

/** The runs a page of a workflow's runs list holds. */
export const RUNS_PER_PAGE = 50;

/**
 * How long after a PR merges its issues' `closed` events may come. GitHub
 * closes them one to three seconds after the merge.
 */
const CLOSE_LAG_MS = 5 * 60 * 1000;

/**
 * The `owner/repo` an API row's `repository_url` names, or undefined.
 *
 * @param {unknown} url
 * @returns {string | undefined}
 */
const repoOf = (url) => /\/repos\/([^/]+\/[^/]+)$/.exec(String(url ?? ''))?.[1];

/**
 * The row that merged last, by the merge time `mergedAt` reads from it.
 *
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string} mergedAt
 * @returns {T | undefined}
 */
const lastMerged = (rows, mergedAt) => rows.reduce((/** @type {T | undefined} */ last, row) => (last === undefined || Date.parse(mergedAt(row)) > Date.parse(mergedAt(last)) ? row : last), undefined);

/**
 * Every page of a list endpoint that pages a hundred at a time, up to
 * `pages` of them. `rowsOf` takes a page's rows from its answer, for an
 * endpoint that wraps its list in an object.
 *
 * @param {(method: string, path: string, body?: unknown) => Promise<any>} call
 * @param {string} path Without a query string of its own.
 * @param {Record<string, string>} query
 * @param {number} [pages]
 * @param {(answer: any) => any[]} [rowsOf]
 * @returns {Promise<any[]>}
 */
const allPages = async (call, path, query, pages = 30, rowsOf = (answer) => answer) => {
  /** @type {any[]} */
  const rows = [];
  for (let page = 1; page <= pages; page += 1) {
    const batch = rowsOf(await call('GET', `${path}?${new URLSearchParams({ ...query, per_page: '100', page: String(page) })}`));
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
};

/**
 * The pages of a list read newest first, up to `pages` of them, until one
 * ends short or its last row is `past` the window: every row after it is too.
 * Thirty pages hold three thousand rows, past any count a periodic sets.
 *
 * @param {(method: string, path: string, body?: unknown) => Promise<any>} call
 * @param {string} path
 * @param {Record<string, string>} query
 * @param {(row: any) => boolean} past
 * @param {number} [pages]
 * @returns {Promise<any[]>}
 */
const pagesUntil = async (call, path, query, past, pages = 30) => {
  /** @type {any[]} */
  const rows = [];
  for (let page = 1; page <= pages; page += 1) {
    /** @type {any[]} */
    const batch = await call('GET', `${path}?${new URLSearchParams({ ...query, per_page: '100', page: String(page) })}`);
    rows.push(...batch);
    if (batch.length < 100 || past(batch[batch.length - 1])) break;
  }
  return rows;
};

/**
 * Rows whose time `field` is after `since`, as a periodic's window counts
 * them (dispatch/periodics.mjs), oldest first. Pull requests are dropped
 * from an issues list. With `by`, a trust list (dispatch/trust.mjs), only
 * the rows whose author it lets in are kept, judged as the receiver judges
 * them (`ticketAuthor`): an issue `appId`'s App filed is let in as the App.
 *
 * @param {any[]} rows
 * @param {string} field
 * @param {string} since
 * @param {readonly string[]} [by]
 * @param {number} [appId]
 * @returns {CountedRow[]}
 */
const after = (rows, field, since, by, appId) => {
  const from = Date.parse(since);
  return rows
    .filter((row) => !row.pull_request && typeof row[field] === 'string' && Date.parse(row[field]) > from)
    .filter((row) => by === undefined || lets(by, ticketAuthor({ author: row.user?.login, association: row.author_association, bot: row.user?.type === 'Bot', app: postedByApp(row, appId) })))
    .map((row) => ({ number: row.number, title: String(row.title ?? ''), at: row[field] }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
};

/** @typedef {{ number: number, title: string, at: string }} CountedRow One merge or issue in a periodic's window, and its time. */

/**
 * The reads the dispatcher makes, and its writes: a comment, a PR body a
 * fallback points at the session it started, and a body a refusing
 * subscriber is dropped from. Four reads are the workflow turn's: a run's
 * jobs, the runs before it, the PRs a commit merged, and the commits a prod
 * promotion ships; a fifth, one run by id, is a job fire's way to its
 * workflow file. Three are the subscriptions': a body, a
 * commit's message, and what is open naming a session. The PR review's:
 * a PR whole, its files, the open PRs, a ticket, a whole thread,
 * the repo's default branch, the checks it requires and the checks at a
 * commit; its writes are a comment edited, a merge and the `governor` check run. The
 * conflict check's: the open PRs, and the commit main is at.
 *
 * @param {{ token: string, repo: string, appId?: number, fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<unknown>, log?: Log, resends?: Resends }} args
 * `appId`: the App the token is an installation of, whose comments `allComments` marks,
 * and whose issues and PRs every trust list lets in (`own`).
 */
export const githubReader = ({ token, repo, appId, fetch = globalThis.fetch, sleep = realSleep, log = noLog, resends = turnResends() }) => {
  /**
   * The author of an issue or PR row, as a trust list judges it
   * (dispatch/webhook/fire.mjs): `NONE` where GitHub gave no association.
   *
   * @param {any} row
   * @returns {Required<import('../../dispatch/webhook/fire.mjs').Author>}
   */
  const authorOf = (row) => ({
    author: String(row?.user?.login ?? ''),
    association: String(row?.author_association ?? 'NONE'),
    bot: row?.user?.type === 'Bot',
    own: postedByApp(row, appId),
  });
  /**
   * A pull request's head branch, or '' for one on a fork (or a deleted
   * fork): a fork's branch is not this repository's, and a session holding
   * a branch of that name elsewhere is not its owner.
   *
   * @param {any} row
   */
  const headOf = (row) => (String(row?.head?.repo?.full_name ?? '').toLowerCase() === repo.toLowerCase() ? String(row.head.ref ?? '') : '');

  const call = githubApi({ token, fetch, sleep, log, resends });
  /** Every open issue and PR, its body, labels and author, read once for `openNaming`. @type {Promise<Array<OpenRow & { body: unknown, labels: string[] } & import('../../dispatch/webhook/fire.mjs').Author>> | null} */
  let openRows = null;
  /** Every open issue and PR, read once a reader, and again after a read that failed. */
  const openList = () => openRows ??= allPages(call, `/repos/${repo}/issues`, { state: 'open' })
    .then((rows) => rows.map((row) => ({ number: row.number, title: row.title, html_url: row.html_url, pull: Boolean(row.pull_request), body: row.body, labels: (row.labels ?? []).map((/** @type {{ name?: unknown } | string} */ l) => (typeof l === 'string' ? l : String(l?.name ?? ''))), ...authorOf(row) })))
    .catch((error) => { openRows = null; openSessions.clear(); throw error; });
  /** Each open issue's and PR's sessions under a trust list, keyed by the list, each body read once per list. @type {Map<string, Promise<Array<OpenRow & { sessions: Set<string> }>>>} */
  const openSessions = new Map();
  /** Each claimed ticket's builder by its newest dispatch comment governor's App posted, its thread read once a reader. @type {Map<number, Promise<string | null>>} */
  const dispatchedTo = new Map();
  /** @param {number} number */
  const dispatchedOf = (number) => {
    let found = dispatchedTo.get(number);
    if (found === undefined) {
      dispatchedTo.set(number, found = allPages(call, `/repos/${repo}/issues/${number}/comments`, {})
        .then((rows) => { const marked = lastDispatch(rows.map((row) => ({ body: row.body ?? '', ours: postedByApp(row, appId) })))?.sessionUrl; return marked === undefined || marked === null ? null : sessionId(marked); })
        .catch((error) => { dispatchedTo.delete(number); throw error; }));
    }
    return found;
  };
  /** The repo owner's type, read once a reader: a narrowed `trust.start` asks it of every ready ticket. @type {Promise<string> | null} */
  let ownerType = null;
  /** The repo's outside collaborators, read once a reader, for the same reason. @type {Promise<string[]> | null} */
  let outside = null;
  /**
   * An issue's `event` rows that name a label, oldest first: the one read
   * behind `labelAdds` and `labelRemovals`.
   *
   * @param {number} number
   * @param {'labeled' | 'unlabeled'} event
   * @returns {Promise<any[]>}
   */
  const labelEvents = async (number, event) =>
    (await allPages(call, `/repos/${repo}/issues/${number}/events`, {}))
      .filter((row) => row?.event === event && typeof row.label?.name === 'string');

  return {
    /**
     * Open issues carrying every ready label, pull requests dropped: the
     * repo's own labels (dispatch/repo-config.mjs).
     *
     * @param {readonly string[]} labels
     * @returns {Promise<IssueRow[]>}
     */
    readyIssues: async (labels) => {
      /** @type {IssueRow[]} */
      const rows = [];
      for (let page = 1; ; page += 1) {
        const query = new URLSearchParams({
          state: 'open',
          labels: labels.join(','),
          per_page: '100',
          page: String(page),
        });
        /** @type {any[]} */
        const batch = await call('GET', `/repos/${repo}/issues?${query}`);
        for (const row of batch) {
          if (row.pull_request) continue;
          rows.push({
            number: row.number,
            title: row.title,
            state: row.state,
            created_at: row.created_at,
            labels: labelNames(row),
            author: String(row.user?.login ?? ''),
            association: String(row.author_association ?? 'NONE'),
            ...openBlockersOf(row),
            ...waitOf(row.body),
          });
        }
        if (batch.length < 100) return rows;
      }
    },

    /**
     * The PRs merged into `base` after `since`, by their merge time: closed
     * PRs, newest updated first, read until a page's last predates it, since
     * a PR's merge never postdates its last update.
     *
     * @param {string} base
     * @param {string} since
     * @returns {Promise<CountedRow[]>}
     */
    mergedSince: async (base, since) => {
      const rows = await pagesUntil(call, `/repos/${repo}/pulls`, { state: 'closed', base, sort: 'updated', direction: 'desc' }, (row) => Date.parse(row.updated_at) <= Date.parse(since));
      return after(rows, 'merged_at', since);
    },

    /**
     * The issues opened after `since`, newest first until a page's last
     * predates it; with `by`, only those whose author it lets in.
     *
     * @param {string} since
     * @param {readonly string[]} [by]
     * @returns {Promise<CountedRow[]>}
     */
    issuesOpenedSince: async (since, by) => {
      const rows = await pagesUntil(call, `/repos/${repo}/issues`, { state: 'all', sort: 'created', direction: 'desc' }, (row) => Date.parse(row.created_at) <= Date.parse(since));
      return after(rows, 'created_at', since, by, appId);
    },

    /**
     * The issues closed after `since`: the closed ones updated since, a
     * close being an update, kept where the close itself is after it; with
     * `by`, only those whose author it lets in.
     *
     * @param {string} since
     * @param {readonly string[]} [by]
     * @returns {Promise<CountedRow[]>}
     */
    issuesClosedSince: async (since, by) => after(await allPages(call, `/repos/${repo}/issues`, { state: 'closed', since, sort: 'updated', direction: 'desc' }), 'closed_at', since, by, appId),

    /**
     * The native `blocked by` relationships, each naming its repo where
     * GitHub says it. A relative wait reads whether its issue is linked
     * (dispatch/waits.mjs).
     *
     * @param {number} number
     * @returns {Promise<Array<BlockerRow & { repo?: string }>>}
     */
    blockers: async (number) => {
      /** @type {any[]} */
      const rows = await call('GET', `/repos/${repo}/issues/${number}/dependencies/blocked_by?per_page=100`);
      return rows.map((row) => {
        const named = repoOf(row.repository_url);
        return { number: row.number, state: row.state, title: row.title, ...(named === null || named === undefined ? {} : { repo: named }), ...(Number.isInteger(row.id) ? { id: row.id } : {}) };
      });
    },

    /**
     * Link an issue as blocked by another, named by its id (`blocked_by`):
     * a relative wait's blocker (`issueClose`), or the repo's wait ticket.
     * A refusal throws with its status, as every call does; GitHub's cap of
     * 50 issues one issue may block is a 422.
     *
     * @param {number} number
     * @param {number} id
     */
    addBlocker: async (number, id) => {
      await call('POST', `/repos/${repo}/issues/${number}/dependencies/blocked_by`, { issue_id: id });
    },

    /**
     * Remove an issue's `blocked by` link to another, named by its id. A link
     * already gone answers 404, which is the state removing it asked for.
     *
     * @param {number} number
     * @param {number} blockerId
     */
    removeBlocker: async (number, blockerId) => {
      try {
        await call('DELETE', `/repos/${repo}/issues/${number}/dependencies/blocked_by/${blockerId}`);
      } catch (error) {
        if (/** @type {{ status?: number }} */ (error)?.status !== 404) throw error;
      }
    },
    /**
     * An issue's id, title, state, GitHub's `state_reason` and when it
     * closed, each null where it gives none, and whether it is a pull
     * request: what a relative wait reads of the issue it names
     * (dispatch/waits.mjs).
     *
     * @param {number} number
     * @returns {Promise<{ id: number, number: number, title: string, state: string, reason: string | null, closedAt: string | null, pull: boolean }>}
     */
    issueClose: async (number) => {
      const row = await call('GET', `/repos/${repo}/issues/${number}`);
      return {
        id: row.id,
        number: row.number,
        title: row.title ?? '',
        state: row.state,
        reason: typeof row.state_reason === 'string' ? row.state_reason : null,
        closedAt: typeof row.closed_at === 'string' ? row.closed_at : null,
        pull: Boolean(row.pull_request),
      };
    },

    /**
     * The native `blocking` relationships, the reverse of `blockers`, each
     * naming its repo: a dependency can cross repositories, so a number
     * alone would read another repo's #12 as this one's. A row naming no
     * repository is this one's. Each carries what its body's `Blocked
     * until:` line says (`waitOf`), so a close can tell a ticket that waits
     * on it (dispatch/unblocked.mjs).
     *
     * @param {number} number
     * @returns {Promise<Array<BlockerRow & { repo: string, wait?: import('./ready-work.mjs').Wait }>>}
     */
    blocking: async (number) => {
      /** @type {any[]} */
      const rows = await call('GET', `/repos/${repo}/issues/${number}/dependencies/blocking?per_page=100`);
      return rows.map((row) => ({
        number: row.number,
        state: row.state,
        title: row.title,
        repo: repoOf(row.repository_url) ?? repo,
        ...waitOf(row.body),
      }));
    },

    /**
     * How an issue closed: its title, GitHub's `state_reason` (null where
     * it gave none), and the PR of this repository whose merge closed it.
     * That PR merged in the {@link CLOSE_LAG_MS} before the issue's last
     * `closed` event, and after any reopen before it, and either holds the commit the event names (GitHub
     * closed the issue from that commit's message) or closes the issue
     * from its body, read from the issue's timeline (the event then names
     * no commit). A close by hand, or a PR that merged long before the
     * close (one that also holds a commit pushed straight to the branch),
     * names no PR. Nothing outside this repository is read, and a PR in
     * another repository is never named.
     *
     * @param {number} number
     * Where GitHub gives it, also when the issue closed (`closedAt`).
     *
     * @returns {Promise<{ title: string, reason: string | null, pr: { number: number, title: string, url: string } | null, closedAt?: string }>}
     */
    closure: async (number) => {
      const issue = await call('GET', `/repos/${repo}/issues/${number}`);
      const title = issue.title ?? '';
      const reason = typeof issue.state_reason === 'string' ? issue.state_reason : null;
      const when = typeof issue.closed_at === 'string' ? { closedAt: issue.closed_at } : {};
      const events = await allPages(call, `/repos/${repo}/issues/${number}/events`, {});
      const closed = events.filter((e) => e.event === 'closed').at(-1);
      if (closed === undefined) return { title, reason, pr: null, ...when };
      const at = Date.parse(closed.created_at);
      const since = Math.max(at - CLOSE_LAG_MS, ...events.filter((e) => e.event === 'reopened').map((e) => Date.parse(e.created_at)).filter((t) => t <= at));
      const justBefore = (/** @type {unknown} */ merged) => typeof merged === 'string' && Date.parse(merged) <= at && Date.parse(merged) >= since;
      const named = (/** @type {any} */ row) => ({ number: row.number, title: row.title ?? '', url: row.html_url });
      const sha = closed.commit_id;
      const here = typeof closed.commit_url !== 'string' || closed.commit_url.toLowerCase().startsWith(`https://api.github.com/repos/${repo}/commits/`.toLowerCase());
      if (typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) && here) {
        /** @type {any[]} */
        const pulls = await call('GET', `/repos/${repo}/commits/${sha}/pulls?per_page=100`);
        const row = lastMerged(pulls.filter((p) => justBefore(p.merged_at)), (p) => p.merged_at);
        if (row !== undefined) return { title, reason, pr: named(row), ...when };
      }
      const timeline = await allPages(call, `/repos/${repo}/issues/${number}/timeline`, {});
      const closers = timeline
        .filter((e) => e.event === 'cross-referenced')
        .map((e) => e.source?.issue)
        .filter((i) => i?.pull_request
          && repoOf(i.repository_url)?.toLowerCase() === repo.toLowerCase()
          && justBefore(i.pull_request.merged_at)
          && closedBy(i.body ?? '', repo).includes(number));
      const row = lastMerged(closers, (i) => i.pull_request.merged_at);
      return { title, reason, pr: row === undefined ? null : named(row), ...when };
    },

    /** Post a comment. @param {number} number @param {string} body */
    comment: async (number, body) => {
      await call('POST', `/repos/${repo}/issues/${number}/comments`, { body });
    },

    /** A pull request's body, a null one as '', its head branch ({@link headOf}), the repo's default branch from its base, '' where none is read, whether it is open, neither closed nor merged, and its author ({@link authorOf}). @param {number} number @returns {Promise<{ number: number, body: string, head: string, defaultBranch: string, open: boolean } & Required<import('../../dispatch/webhook/fire.mjs').Author>>} */
    pull: async (number) => {
      const row = await call('GET', `/repos/${repo}/pulls/${number}`);
      return { number: row.number, body: row.body ?? '', head: headOf(row), defaultBranch: String(row?.base?.repo?.default_branch ?? ''), open: row.state === 'open', ...authorOf(row) };
    },

    /** Rewrite a pull request's body. @param {number} number @param {{ body: string }} change */
    updatePull: async (number, { body }) => {
      await call('PATCH', `/repos/${repo}/pulls/${number}`, { body });
    },

    /** An issue's or a PR's body, a null one as '', and whether it is a PR. @param {number} number @returns {Promise<{ number: number, body: string, pull: boolean }>} */
    issue: async (number) => {
      const row = await call('GET', `/repos/${repo}/issues/${number}`);
      return { number: row.number, body: row.body ?? '', pull: Boolean(row.pull_request) };
    },

    /** Rewrite an issue's or a PR's body. @param {number} number @param {{ body: string }} change */
    updateIssue: async (number, { body }) => {
      await call('PATCH', `/repos/${repo}/issues/${number}`, { body });
    },

    /** A commit's message and its parents' ids. @param {string} sha @returns {Promise<{ sha: string, message: string, parents: string[] }>} */
    commit: async (sha) => {
      const row = await call('GET', `/repos/${repo}/commits/${sha}`);
      return { sha: row.sha, message: row.commit?.message ?? '', parents: (row.parents ?? []).map((/** @type {{ sha: string }} */ p) => p.sha) };
    },

    /**
     * The open issues and PRs whose body names `session` (its link or id)
     * as its owner or in a subscribe line ({@link sessionsNamedIn}), where
     * `relay`, the repo's `trust.relay`, lets the body's author in
     * (`relayedBody`). A member's body that quotes or cites the session is
     * not one, nor a stranger's that names it. Read from
     * the issues list, which carries PRs too and is on the core rate limit,
     * once per reader (one per turn), each body read for its sessions once,
     * and filtered here: the search API allows an installation about thirty
     * calls a minute, which the App's other callers spend too.
     *
     * Given the repo's claim label (`claim`), an open claimed issue that no
     * open PR closes counts too where its newest dispatch comment names the
     * session: a builder's ticket counts before its PR exists
     * (dispatch/builders.mjs). Each such thread is read once per reader.
     * One an open PR closes counts through the PR.
     *
     * Given the labels that hold a session (`holding`: the repo's ready
     * labels and its claim label, where `sessionRules` is on), each row
     * says whether it holds the session's sign-off ask (`holds`): a PR and
     * a built ticket always do, and an issue only where it carries one of
     * those labels. The labels come from the list already read.
     *
     * @param {string} session
     * @param {readonly string[]} relay
     * @param {{ claim?: string, holding?: readonly string[] }} [options]
     * @returns {Promise<OpenRow[]>}
     */
    openNaming: async (session, relay, { claim, holding } = {}) => {
      const read = openList();
      const key = relay.join(',');
      let named = openSessions.get(key);
      if (named === undefined) {
        openSessions.set(key, named = read.then((rows) => rows.map((row) => ({ number: row.number, title: row.title, html_url: row.html_url, pull: row.pull, sessions: sessionsNamedIn(relayedBody(row, relay)) }))));
      }
      const id = sessionId(session);
      const mine = (await named).filter((row) => row.sessions.has(id));
      const rows = await read;
      const labelsOf = holding === undefined ? null : new Map(rows.map((r) => [r.number, r.labels]));
      const holds = (/** @type {OpenRow} */ row) => {
        if (labelsOf === null || holding === undefined) return row;
        const labels = labelsOf.get(row.number) ?? [];
        return { ...row, holds: row.pull || labels.some((/** @type {string} */ l) => holding.includes(l)) };
      };
      const naming = mine.map(({ sessions: _sessions, ...row }) => holds(row));
      if (claim === undefined || claim === '') return naming;
      const closed = new Set(rows.filter((row) => row.pull).flatMap((row) => closedBy(String(row.body ?? ''), repo)));
      const claimed = rows.filter((row) => !row.pull && row.labels.includes(claim) && !closed.has(row.number) && !naming.some((n) => n.number === row.number));
      const building = [];
      for (const row of claimed) {
        if (await dispatchedOf(row.number) === id) building.push({ number: row.number, title: row.title, html_url: row.html_url, pull: false, ...(holding === undefined ? {} : { holds: true }) });
      }
      return [...naming, ...building];
    },

    /**
     * The open PRs whose body closes issue `number` by GitHub's closing
     * keywords (`closedBy`, dispatch/pr-body.mjs), read from the same list
     * as `openNaming`, once per reader: the builder lookup
     * (dispatch/builders.mjs) pays no read the standing line has not.
     *
     * @param {number} number
     * @returns {Promise<Array<{ number: number, title: string, html_url: string }>>}
     */
    openClosing: async (number) =>
      (await openList())
        .filter((row) => row.pull && closedBy(String(row.body ?? ''), repo).includes(number))
        .map((row) => ({ number: row.number, title: row.title, html_url: row.html_url })),

    /**
     * An issue's comments, oldest first, one page of a hundred. `since`
     * (ISO time) narrows it to comments updated at or after that moment:
     * the endpoint pages oldest first, so without it a long thread's newest
     * comment sits past the page.
     *
     * @param {number} number
     * @param {{ since?: string }} [options]
     * @returns {Promise<CommentRow[]>}
     */
    comments: async (number, { since } = {}) => {
      const query = new URLSearchParams({ per_page: '100', ...(since === undefined ? {} : { since }) });
      /** @type {any[]} */
      const rows = await call('GET', `/repos/${repo}/issues/${number}/comments?${query}`);
      return rows.map((row) => ({ id: row.id, body: row.body, created_at: row.created_at }));
    },

    /**
     * The pull requests a commit belongs to, merged or open. The one a merge
     * commit merged is the row whose `merge_commit_sha` is that commit.
     *
     * @param {string} sha
     * @returns {Promise<PullRow[]>}
     */
    pullsForCommit: async (sha) => {
      /** @type {any[]} */
      const rows = await call('GET', `/repos/${repo}/commits/${sha}/pulls?per_page=100`);
      return rows.map((row) => ({
        number: row.number,
        title: row.title,
        html_url: row.html_url,
        body: row.body ?? '',
        merged_at: row.merged_at ?? null,
        merge_commit_sha: row.merge_commit_sha ?? null,
        head: headOf(row),
        ...authorOf(row),
      }));
    },

    /**
     * One run by id: the workflow file it is of, which a job fire does not
     * carry, beside what a runs list row holds.
     *
     * @param {number} runId
     * @returns {Promise<RunDetail>}
     */
    run: async (runId) => {
      const row = await call('GET', `/repos/${repo}/actions/runs/${runId}`);
      return {
        id: row.id,
        path: row.path,
        status: row.status,
        conclusion: row.conclusion ?? null,
        event: row.event,
        head_branch: row.head_branch,
        head_sha: row.head_sha,
        html_url: row.html_url,
        created_at: row.created_at,
        run_attempt: row.run_attempt,
      };
    },

    /** A run's jobs, its latest attempt's only. @param {number} runId @returns {Promise<JobRow[]>} */
    runJobs: async (runId) => {
      const answer = await call('GET', `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
      return (answer?.jobs ?? []).map((/** @type {any} */ row) => ({
        name: row.name,
        conclusion: row.conclusion ?? null,
        html_url: row.html_url,
      }));
    },

    /**
     * A workflow's runs of every branch, event and status, newest first, one
     * page of fifty. Unfiltered: GitHub's `branch`-filtered list has served
     * an index months old (Deploy run 36879724895), so a caller filters by
     * `head_branch`, `event` and `status` itself.
     *
     * @param {string} file The workflow's file name, e.g. `ci.yml`, or its id.
     * @param {{ page?: number }} options
     *   `page`: which page of RUNS_PER_PAGE, from 1; a short page is the last.
     * @returns {Promise<RunRow[]>}
     */
    workflowRuns: async (file, { page = 1 }) => {
      const query = new URLSearchParams({
        per_page: String(RUNS_PER_PAGE),
        page: String(page),
      });
      const answer = await call('GET', `/repos/${repo}/actions/workflows/${file}/runs?${query}`);
      return (answer?.workflow_runs ?? []).map(runRow);
    },

    /**
     * A workflow's runs at one commit, newest first, each with its workflow
     * file: the PR review reads its CI workflow's run at a PR's head. The
     * first hundred are plenty: a commit is pushed once, and re-runs are
     * attempts of the same run.
     *
     * @param {string} path The workflow's file, e.g. `.github/workflows/ci.yml`.
     * @param {string} sha
     * @returns {Promise<Array<RunRow & { path: string }>>}
     */
    ciRuns: async (path, sha) => {
      const file = encodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
      const query = new URLSearchParams({ head_sha: sha, per_page: '100' });
      const answer = await call('GET', `/repos/${repo}/actions/workflows/${file}/runs?${query}`);
      return (answer?.workflow_runs ?? []).map((/** @type {any} */ row) => ({ ...runRow(row), path: String(row.path ?? '') }));
    },

    /**
     * A pull request as the PR review reads it. `mergeable` is null until
     * GitHub has computed it, which a read starts.
     *
     * @param {number} number
     * @returns {Promise<PullRequestRow>}
     */
    pullRequest: async (number) => {
      const row = await call('GET', `/repos/${repo}/pulls/${number}`);
      return {
        number: row.number,
        title: row.title ?? '',
        body: row.body ?? '',
        state: row.state,
        draft: row.draft === true,
        base: String(row.base?.ref ?? ''),
        headSha: row.head?.sha ?? '',
        mergeable: typeof row.mergeable === 'boolean' ? row.mergeable : null,
        html_url: row.html_url ?? '',
        association: String(row.author_association ?? 'NONE'),
        author: String(row.user?.login ?? ''),
        bot: row.user?.type === 'Bot',
      };
    },

    /** A pull request's changed files, every page (GitHub lists 3000 at most), a rename with the path it left. @param {number} number @returns {Promise<FileRow[]>} */
    pullFiles: async (number) =>
      (await allPages(call, `/repos/${repo}/pulls/${number}/files`, {})).map((row) => ({
        filename: row.filename, status: row.status, ...(typeof row.previous_filename === 'string' ? { previous: row.previous_filename } : {}),
      })),

    /** A pull request's commits, oldest first, every page (GitHub lists 250 at most). @param {number} number @returns {Promise<PullCommitRow[]>} */
    pullCommits: async (number) =>
      (await allPages(call, `/repos/${repo}/pulls/${number}/commits`, {})).map((row) => ({
        sha: row.sha,
        author: typeof row.author?.login === 'string' ? row.author.login : null,
        committer: typeof row.committer?.login === 'string' ? row.committer.login : null,
        verified: row.commit?.verification?.verified === true,
      })),

    /**
     * The commit `head` branched from `base` at: what a pull request's diff
     * is read against, so a commit `base` gained since is not the PR's.
     *
     * @param {string} base
     * @param {string} head
     * @returns {Promise<string>}
     */
    mergeBase: async (base, head) => {
      const answer = await call('GET', `/repos/${repo}/compare/${base}...${head}?per_page=1`);
      const sha = answer?.merge_base_commit?.sha;
      if (typeof sha !== 'string' || sha === '') throw new Error(`compare ${base}...${head} names no merge base`);
      return sha;
    },

    /**
     * A file's text at a commit. A path missing there throws with GitHub's
     * 404, and a directory, or a file too large for GitHub to send its
     * text, throws too: a caller judging the text never judges a guess.
     *
     * @param {string} path
     * @param {string} ref
     * @returns {Promise<string>}
     */
    fileAt: async (path, ref) => {
      const answer = await call('GET', `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      if (answer?.type !== 'file' || answer?.encoding !== 'base64' || typeof answer?.content !== 'string') throw new Error(`${path} at ${ref} is no file GitHub sent the text of`);
      return Buffer.from(answer.content, 'base64').toString('utf8');
    },

    /**
     * The dispatcher's config file on the default branch (no ref: never a
     * PR head or another branch), or a prompt file it names beside it,
     * or null when GitHub says it is not there. Any other
     * refusal throws, and is never read as a missing file.
     *
     * @param {string} [path]
     * @returns {Promise<string | null>}
     */
    // dispatch/repo-config.mjs's CONFIG_PATH, written out so this file
    // takes no import of the schema (test/scripts/github-app.test.ts).
    configFile: async (path = '.github/governor.json') => {
      /** @type {any} */
      let answer;
      try {
        answer = await call('GET', `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
      } catch (error) {
        if (/** @type {{ status?: number }} */ (error)?.status === 404) return null;
        throw error;
      }
      if (answer?.type !== 'file' || answer?.encoding !== 'base64' || typeof answer?.content !== 'string') throw new Error(`${path} in ${repo} is no file GitHub sent the text of`);
      return Buffer.from(answer.content, 'base64').toString('utf8');
    },

    /** The repo's default branch, which the PR review reads PRs into. @returns {Promise<string>} */
    defaultBranch: async () => {
      const row = await call('GET', `/repos/${repo}`);
      const branch = row?.default_branch;
      if (typeof branch !== 'string' || branch === '') throw new Error(`${repo} names no default branch`);
      return branch;
    },

    /**
     * The status checks `branch` requires: its classic protection's, as the
     * branch read summarises it, and its rulesets'. Neither read needs
     * Administration permission. A private repo on GitHub's free plan has
     * no rulesets, and GitHub answers their read with a 403 saying so: that
     * reads as none. Any other refusal throws.
     *
     * @param {string} branch
     * @returns {Promise<string[]>}
     */
    requiredChecks: async (branch) => {
      const name = encodeURIComponent(branch);
      const rulesets = allPages(call, `/repos/${repo}/rules/branches/${name}`, {}).catch((error) => {
        if (/** @type {{ planLimited?: boolean }} */ (error)?.planLimited === true) return [];
        throw error;
      });
      const [row, rules] = await Promise.all([call('GET', `/repos/${repo}/branches/${name}`), rulesets]);
      const classic = row?.protection?.required_status_checks;
      /** @type {unknown[]} */
      const names = [
        ...(classic?.contexts ?? []),
        ...(classic?.checks ?? []).map((/** @type {any} */ c) => c?.context),
        ...(Array.isArray(rules) ? rules : []).filter((r) => r?.type === 'required_status_checks')
          .flatMap((r) => (r?.parameters?.required_status_checks ?? []).map((/** @type {any} */ c) => c?.context)),
      ];
      return [...new Set(names.filter((n) => typeof n === 'string' && n !== ''))].map(String);
    },

    /**
     * The latest check runs at a commit, as the API's `latest` filter
     * answers them, and the latest status of each context: red when it ended in a way that blocks a merge,
     * pending while it has not ended, green otherwise. A check run carries
     * the slug of the App that posted it; a status has none. Needs the
     * App's Checks and Commit statuses read.
     *
     * @param {string} sha
     * @returns {Promise<Array<{ name: string, state: 'red' | 'green' | 'pending', app?: string }>>}
     */
    checksAt: async (sha) => {
      const [runs, statuses] = await Promise.all([
        allPages(call, `/repos/${repo}/commits/${sha}/check-runs`, { filter: 'latest' }, undefined, (answer) => answer?.check_runs ?? []),
        allPages(call, `/repos/${repo}/commits/${sha}/status`, {}, undefined, (answer) => answer?.statuses ?? []),
      ]);
      /** @type {(red: boolean, pending: boolean) => 'red' | 'green' | 'pending'} */
      const stateOf = (red, pending) => (red ? 'red' : pending ? 'pending' : 'green');
      return [
        ...runs.map((r) => ({
          name: String(r?.name ?? ''),
          state: stateOf(RED_CONCLUSIONS.has(String(r?.conclusion)), typeof r?.conclusion !== 'string'),
          ...(typeof r?.app?.slug === 'string' && r.app.slug !== '' ? { app: r.app.slug } : {}),
        })),
        ...statuses.map((/** @type {any} */ st) => ({ name: String(st?.context ?? ''), state: stateOf(st?.state === 'failure' || st?.state === 'error', st?.state === 'pending') })),
      ];
    },

    /**
     * The latest run of the check `name` at `sha` that `appId`'s App posted,
     * newest by id, with its title: red when it ended in a way that blocks
     * a merge, pending while it has not ended, green otherwise. Null where
     * the App has no run of the name there, and for a reader without
     * `appId`, which cannot tell governor's runs from another App's and
     * reads nothing. Needs the App's Checks read.
     *
     * @param {string} name
     * @param {string} sha
     * @returns {Promise<{ state: 'red' | 'green' | 'pending', title: string } | null>}
     */
    ownCheck: async (name, sha) => {
      if (appId === undefined) return null;
      const runs = await allPages(call, `/repos/${repo}/commits/${sha}/check-runs`, { check_name: name, filter: 'latest', app_id: String(appId) }, undefined, (answer) => answer?.check_runs ?? []);
      const own = runs
        .filter((/** @type {any} */ r) => r?.name === name && r?.app?.id === appId && Number.isSafeInteger(r?.id))
        .reduce((/** @type {any} */ newest, /** @type {any} */ r) => (newest === null || r.id > newest.id ? r : newest), null);
      if (own === null) return null;
      const pending = typeof own.conclusion !== 'string';
      return { state: RED_CONCLUSIONS.has(String(own.conclusion)) ? 'red' : pending ? 'pending' : 'green', title: String(own.output?.title ?? '') };
    },

    /**
     * Write the check run named `name` at `sha`: in progress, or completed
     * with `state` as its conclusion. Where `appId`'s App has a run of the
     * name at `sha` still in progress, its latest, that run is updated, to
     * new waiting text or to the verdict, so a review that waited leaves no
     * run in progress under its answer. Otherwise a new run is created: a
     * completed run is a verdict and is never edited, and a run from another
     * App, or any run for a reader without `appId`, is never governor's.
     * GitHub shows the latest run of a name. The lane runs one turn at a
     * time, so no other governor write lands between the read and the
     * update. Needs the App's Checks write, and a refusal of the read or the
     * write throws with its status.
     *
     * @param {{ name: string, sha: string, state: 'in_progress' | 'success' | 'failure' | 'neutral', title: string, summary: string }} run
     */
    checkRun: async ({ name, sha, state, title, summary }) => {
      const result = state === 'in_progress' ? { status: 'in_progress' } : { status: 'completed', conclusion: state };
      if (appId !== undefined) {
        const answer = await call('GET', `/repos/${repo}/commits/${sha}/check-runs?${new URLSearchParams({ check_name: name, filter: 'latest', app_id: String(appId), per_page: '100' })}`);
        const waiting = (answer?.check_runs ?? []).find((/** @type {any} */ r) => r?.name === name && r?.app?.id === appId && r?.status !== 'completed' && Number.isSafeInteger(r?.id));
        if (waiting) {
          await call('PATCH', `/repos/${repo}/check-runs/${waiting.id}`, { ...result, output: { title, summary } });
          return;
        }
      }
      await call('POST', `/repos/${repo}/check-runs`, { name, head_sha: sha, ...result, output: { title, summary } });
    },

    /**
     * Create `name` in the repo unless it has it: the claim label, or a
     * issue review's conclusion label, in a repo that lacks it.
     *
     * @param {string} name
     * @param {string} [description] What the label is for; the claim's by default.
     */
    ensureLabel: async (name, description = 'Claimed by the dispatcher for the session it launched') => {
      try {
        await call('GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`);
        return;
      } catch (error) {
        if (/** @type {{ status?: number }} */ (error)?.status !== 404) throw error;
      }
      await call('POST', `/repos/${repo}/labels`, { name, color: 'ededed', description });
    },

    /** The open pull requests, each with whether it is a draft, its base branch, its head ({@link headOf}) and head commit, title, link and body. @returns {Promise<OpenPullRow[]>} */
    openPulls: async () =>
      (await allPages(call, `/repos/${repo}/pulls`, { state: 'open' })).map((row) => ({
        number: row.number,
        draft: row.draft === true,
        base: String(row.base?.ref ?? ''),
        head: headOf(row),
        headSha: String(row.head?.sha ?? ''),
        title: String(row.title ?? ''),
        html_url: String(row.html_url ?? ''),
        body: row.body ?? '',
        ...authorOf(row),
      })),

    /** The commit a branch is at. @param {string} branch @returns {Promise<string>} */
    branchHead: async (branch) => {
      const row = await call('GET', `/repos/${repo}/git/ref/heads/${branch}`);
      const sha = row?.object?.sha;
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`branch ${branch} names no commit: ${JSON.stringify(row?.object ?? null)}`);
      return sha;
    },

    /** An issue as a PR's ticket: title, body, state, label names. @param {number} number @returns {Promise<TicketRow>} */
    ticket: async (number) => {
      const row = await call('GET', `/repos/${repo}/issues/${number}`);
      return { number: row.number, ...(Number.isInteger(row.id) ? { id: row.id } : {}), title: row.title ?? '', body: row.body ?? '', state: row.state, labels: labelNames(row), pull: Boolean(row.pull_request), author: String(row.user?.login ?? ''), association: String(row.author_association ?? 'NONE'), ...(postedByApp(row, appId) ? { app: true } : {}), ...(typeof row.created_at === 'string' ? { created_at: row.created_at } : {}), ...openBlockersOf(row), ...waitOf(row.body) };
    },

    /**
     * An issue's sub-issue parent, with the repo it is in, or null for an
     * issue that has none (GitHub answers 404).
     *
     * @param {number} number
     * @returns {Promise<(TicketRow & { repo: string }) | null>}
     */
    parentIssue: async (number) => {
      /** @type {any} */
      let row;
      try {
        row = await call('GET', `/repos/${repo}/issues/${number}/parent`);
      } catch (error) {
        if (/** @type {{ status?: number }} */ (error)?.status === 404) return null;
        throw error;
      }
      const at = /\/repos\/([^/]+\/[^/]+)$/.exec(String(row?.repository_url ?? ''))?.[1] ?? repo;
      return { repo: at, number: row.number, title: row.title ?? '', body: row.body ?? '', state: row.state, labels: labelNames(row), pull: Boolean(row.pull_request) };
    },

    /**
     * The repo's open issues, pull requests left out, newest first, so a
     * cut drops the oldest, the least likely duplicates of a new ticket, up
     * to one more than `max`, so a caller can tell it was cut.
     *
     * @param {number} max
     * @returns {Promise<Array<{ number: number, title: string }>>}
     */
    openIssues: async (max) => {
      /** @type {Array<{ number: number, title: string }>} */
      const out = [];
      for (let page = 1; out.length <= max; page += 1) {
        /** @type {any[]} */
        const batch = await call('GET', `/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=100&page=${page}`);
        for (const row of batch) if (!row.pull_request && out.length <= max) out.push({ number: row.number, title: String(row.title ?? '') });
        if (batch.length < 100) break;
      }
      return out;
    },

    /**
     * An issue's or a PR's whole thread, oldest first, each marked with
     * whether `appId`'s App posted it as its bot (`postedByApp`); a reader
     * without `appId` owns no comment.
     *
     * @param {number} number
     * @returns {Promise<ThreadRow[]>}
     */
    allComments: async (number) =>
      (await allPages(call, `/repos/${repo}/issues/${number}/comments`, {})).map((row) => ({
        id: row.id, body: row.body ?? '', created_at: row.created_at, ours: postedByApp(row, appId),
      })),

    /**
     * An issue's label additions, oldest first, from its events: the label,
     * the login that added it, whether a bot did, and whether `appId`'s App
     * did as its bot (`postedByApp`); a reader without `appId` owns none.
     * Pickup reads who added a ready label (`uncountedReady`,
     * scripts/lib/ready-work.mjs).
     *
     * @param {number} number
     * @returns {Promise<Array<{ label: string, actor: string, bot: boolean, ours: boolean }>>}
     */
    labelAdds: async (number) =>
      (await labelEvents(number, 'labeled'))
        .map((row) => ({
          label: row.label.name,
          actor: String(row.actor?.login ?? ''),
          bot: row.actor?.type === 'Bot',
          ours: postedByApp({ user: row.actor, performed_via_github_app: row.performed_via_github_app }, appId),
        })),

    /**
     * Whether the repo's owner is a `User` or an `Organization`, from the
     * repo itself, read once a reader. Governor looks a ready label's adder
     * up by it where a repo narrows `trust.start` (`startKinds`,
     * dispatch/start.mjs).
     *
     * @returns {Promise<string>}
     */
    repoOwnerType: () => (ownerType ??= call('GET', `/repos/${repo}`).then((row) => String(row?.owner?.type ?? ''))),

    /**
     * The logins of the repo's outside collaborators, every page, read once
     * a reader: on an org's repo, a person who can add a label and is not
     * one is a member (`startKinds`, dispatch/start.mjs). A list that fills
     * every page read throws, since a collaborator past the last page would
     * read as a member.
     *
     * @returns {Promise<string[]>}
     */
    outsideCollaborators: () => (outside ??= (async () => {
      const pages = 30;
      const rows = await allPages(call, `/repos/${repo}/collaborators`, { affiliation: 'outside' }, pages);
      if (rows.length >= pages * 100) throw new Error(`the repo has more outside collaborators than the ${pages * 100} governor reads`);
      return rows.map((row) => String(row?.login ?? ''));
    })()),

    /**
     * An issue's label removals, oldest first, from its events: the label,
     * when, and whether `appId`'s App made it as its bot (`postedByApp`); a
     * reader without `appId` owns none.
     *
     * @param {number} number
     * @returns {Promise<Array<{ label: string, at: string, ours: boolean }>>}
     */
    labelRemovals: async (number) =>
      (await labelEvents(number, 'unlabeled'))
        .filter((row) => typeof row.created_at === 'string')
        .map((row) => ({ label: row.label.name, at: row.created_at, ours: postedByApp({ user: row.actor, performed_via_github_app: row.performed_via_github_app }, appId) })),

    /** Add labels to an issue, leaving the ones it has. @param {number} number @param {string[]} labels */
    addLabels: async (number, labels) => {
      await call('POST', `/repos/${repo}/issues/${number}/labels`, { labels });
    },

    /**
     * Remove one label from an issue. A label the issue lacks answers 404,
     * which is the state removing it asked for.
     *
     * @param {number} number
     * @param {string} label
     */
    removeLabel: async (number, label) => {
      try {
        await call('DELETE', `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
      } catch (error) {
        if (/** @type {{ status?: number }} */ (error)?.status !== 404) throw error;
      }
    },

    /** Rewrite a comment's body. @param {number} id @param {string} body */
    updateComment: async (id, body) => {
      await call('PATCH', `/repos/${repo}/issues/comments/${id}`, { body });
    },

    /**
     * Merge a pull request with a merge commit, only while its head is still
     * `sha`: a push after the review is not merged unread. A refusal (the
     * App without contents write, a head moved, a conflict) throws.
     *
     * @param {number} number
     * @param {{ sha: string }} options
     * @returns {Promise<{ merged: boolean, sha: string }>}
     */
    merge: async (number, { sha }) => {
      const answer = await call('PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: 'merge', sha });
      return { merged: answer?.merged === true, sha: String(answer?.sha ?? '') };
    },

    /**
     * The commits reachable from `head` and not from `base`, oldest first,
     * with their messages. The endpoint pages its commit list a hundred at a
     * time, up to 250 in all.
     *
     * @param {string} base
     * @param {string} head
     * @returns {Promise<CommitRow[]>}
     */
    compareCommits: async (base, head) => {
      /** @type {CommitRow[]} */
      const commits = [];
      for (let page = 1; ; page += 1) {
        const answer = await call('GET', `/repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}`);
        /** @type {any[]} */
        const batch = answer?.commits ?? [];
        for (const row of batch) commits.push({ sha: row.sha, message: row.commit?.message ?? '' });
        if (batch.length < 100) return commits;
      }
    },
  };
};
