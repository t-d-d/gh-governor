/**
 * The dispatcher's GitHub identity: an installation token minted from the
 * GitHub App the repository carries (the APP_ID variable and APP_PRIVATE_KEY
 * secret the deploy writes into the dispatcher's secret), and a small REST
 * reader over `fetch`.
 *
 * The dispatcher's image has no `gh` and no `gh-deps` shim, so this reads the
 * endpoints directly and returns the row shapes `scripts/lib/ready-work.mjs`
 * selects over: `readyIssues(labels)` the issues carrying every ready label, `blockers(n)` what
 * `gh-deps list-blockers` emits, `parent(n)` the parent with its labels.
 *
 * Node built-ins only: the dispatcher image carries this directory and no
 * `node_modules` for it.
 */

import { createSign } from 'node:crypto';
import { postedByApp } from '../../dispatch/webhook/review-comment.mjs';

const API = 'https://api.github.com';
/** The version the gh-deps shim pins, so both read the same endpoint shapes. */
const API_VERSION = '2022-11-28';

/**
 * Sends of a GET whose connection drops (`fetch` or the body read throws), and
 * the pause before each resend. A dropped connection to GitHub is a blip that
 * the next send clears; before these, one failed a whole dispatcher turn.
 * Only a GET, or a write the caller marks safe to repeat, is sent again: a
 * write whose connection dropped may have landed.
 * An answer, even a 5xx, is never resent here.
 */
const SENDS = 3;
const RESEND_PAUSE_MS = 1_000;

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

/**
 * @param {{ fetch: typeof globalThis.fetch, sleep: (ms: number) => Promise<unknown> }} io
 * @param {string} auth The Authorization header value.
 * @param {string} method
 * @param {string} path Under the API host.
 * @param {unknown} [body]
 * @param {boolean} [repeatable] Safe to send twice; a GET always is.
 * @returns {Promise<any>} The JSON body, or null for an empty answer.
 */
const request = async ({ fetch, sleep }, auth, method, path, body, repeatable = method.toUpperCase() === 'GET') => {
  const send = async () => {
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
      throw Object.assign(
        new Error(`${method} ${path} failed: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`.trim()),
        { status: response.status, rateLimited: rateLimited(response, detail), planLimited: planLimited(response, detail) },
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
      // A refusal carries its status: it is an answer, never resent here.
      if (sent >= sends || /** @type {{ status?: number }} */ (error)?.status !== undefined) throw error;
      await sleep(RESEND_PAUSE_MS * sent);
    }
  }
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
 * @param {{ token: string, fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<unknown> }} args
 * @returns {(method: string, path: string, body?: unknown) => Promise<any>}
 */
export const githubApi = ({ token, fetch = globalThis.fetch, sleep = realSleep }) => {
  const auth = `Bearer ${token}`;
  return (method, path, body) => request({ fetch, sleep }, auth, method, path, body);
};

/**
 * An installation token for the repository: the App's identity, scoped to the
 * one installation, good for an hour.
 *
 * @param {{ appId: string, privateKeyPem: string, repo: string, fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<unknown>, now?: number }} args
 * @returns {Promise<string>}
 */
export const installationToken = async ({ appId, privateKeyPem, repo, fetch = globalThis.fetch, sleep = realSleep, now }) => {
  const auth = `Bearer ${appJwt({ appId, privateKeyPem, ...(now === undefined ? {} : { now }) })}`;
  const installation = await request({ fetch, sleep }, auth, 'GET', `/repos/${repo}/installation`);
  // A second mint only issues a second token, so a dropped one is resent.
  const minted = await request({ fetch, sleep }, auth, 'POST', `/app/installations/${installation.id}/access_tokens`, undefined, true);
  return String(minted.token);
};

/**
 * The App's installations and the repos each was granted: the
 * bare schedule fire's list of what it might serve. An installation whose
 * account is not on `owners`, or that is suspended, is listed with no repos:
 * it gets no token, and nothing of it is read. A refusal anywhere throws.
 *
 * @param {{ appId: string, privateKeyPem: string, owners: readonly string[], fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<unknown>, now?: number }} args
 * @returns {Promise<Array<{ account: string, repos: string[] }>>}
 */
export const appInstallations = async ({ appId, privateKeyPem, owners, fetch = globalThis.fetch, sleep = realSleep, now }) => {
  const auth = `Bearer ${appJwt({ appId, privateKeyPem, ...(now === undefined ? {} : { now }) })}`;
  const listed = owners.map((o) => o.toLowerCase());
  /** @type {Array<{ account: string, repos: string[] }>} */
  const out = [];
  for (let page = 1; ; page += 1) {
    /** @type {any[]} */
    const batch = await request({ fetch, sleep }, auth, 'GET', `/app/installations?per_page=100&page=${page}`);
    for (const installation of batch) {
      const account = String(installation?.account?.login ?? '');
      // A suspended installation refuses a token mint: read it as granting
      // nothing, so one owner's suspension does not refuse every repo's turn.
      if (!listed.includes(account.toLowerCase()) || installation?.suspended_at != null) {
        out.push({ account, repos: [] });
        continue;
      }
      const minted = await request({ fetch, sleep }, auth, 'POST', `/app/installations/${installation.id}/access_tokens`, undefined, true);
      const call = githubApi({ token: String(minted.token), fetch, sleep });
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

/** @param {any} row */
const labelNames = (row) =>
  (row.labels ?? []).map((/** @type {any} */ l) => (typeof l === 'string' ? l : l.name));

/**
 * @typedef {{ number: number, title: string, state: string, created_at: string, labels: string[] }} IssueRow
 * @typedef {{ number: number, state: string, title: string }} BlockerRow
 * @typedef {{ number: number, state: string, labels: string[] }} ParentRow
 * @typedef {{ id: number, body: string, created_at: string }} CommentRow
 * @typedef {{ number: number, title: string, html_url: string, body: string, merged_at: string | null, merge_commit_sha: string | null, head: string, author: string }} PullRow
 *   `head`: its head branch, '' for a fork's; `author`: the login that opened it.
 * @typedef {{ name: string, conclusion: string | null, html_url: string }} JobRow
 * @typedef {{ id: number, status: string, conclusion: string | null, event: string, head_branch: string | null, head_sha: string, html_url: string, created_at: string }} RunRow
 * @typedef {RunRow & { path: string, run_attempt: number }} RunDetail One run read by id: a RunRow and its workflow file.
 * @typedef {{ sha: string, message: string }} CommitRow
 * @typedef {{ number: number, title: string, html_url: string, pull: boolean }} OpenRow
 * @typedef {{ number: number, title: string, body: string, state: string, draft: boolean, base: string, headSha: string, mergeable: boolean | null, html_url: string, association: string, author: string }} PullRequestRow
 *   `author`: the login that opened it.
 * @typedef {{ filename: string, status: string, previous?: string }} FileRow `previous`: the path a rename left.
 * @typedef {{ sha: string, author: string | null, committer: string | null, verified: boolean }} PullCommitRow
 *   `author`, `committer`: the logins GitHub ties them to, null for none; `verified`: GitHub verified its signature.
 * @typedef {{ number: number, title: string, body: string, state: string, labels: string[], pull: boolean }} TicketRow
 * @typedef {{ id: number, body: string, created_at: string, ours: boolean }} ThreadRow `ours`: the reader's own App posted it.
 * @typedef {{ number: number, draft: boolean, base: string, head: string, title: string, html_url: string, body: string }} OpenPullRow
 */

/** How a check run ends that blocks a merge on a check it is. */
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/** The runs a page of a workflow's runs list holds. */
export const RUNS_PER_PAGE = 50;

/**
 * Every page of a list endpoint that pages a hundred at a time, up to
 * `pages` of them.
 *
 * @param {(method: string, path: string, body?: unknown) => Promise<any>} call
 * @param {string} path Without a query string of its own.
 * @param {Record<string, string>} query
 * @param {number} [pages]
 * @returns {Promise<any[]>}
 */
const allPages = async (call, path, query, pages = 30) => {
  /** @type {any[]} */
  const rows = [];
  for (let page = 1; page <= pages; page += 1) {
    /** @type {any[]} */
    const batch = await call('GET', `${path}?${new URLSearchParams({ ...query, per_page: '100', page: String(page) })}`);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
};

/**
 * The pages of a list read newest first, up to `pages` of them, until one
 * ends short or its last row is `past` the window: every row after it is too.
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
 * from an issues list.
 *
 * @param {any[]} rows
 * @param {string} field
 * @param {string} since
 * @returns {CountedRow[]}
 */
const after = (rows, field, since) => {
  const from = Date.parse(since);
  return rows
    .filter((row) => !row.pull_request && typeof row[field] === 'string' && Date.parse(row[field]) > from)
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
 * commit; its writes are a comment edited, a merge and an approval. The
 * conflict check's: the open PRs, and the commit main is at.
 *
 * @param {{ token: string, repo: string, appId?: number, fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<unknown> }} args
 * `appId`: the App the token is an installation of, whose comments `allComments` marks.
 */
export const githubReader = ({ token, repo, appId, fetch = globalThis.fetch, sleep = realSleep }) => {
  /**
   * A pull request's head branch, or '' for one on a fork (or a deleted
   * fork): a fork's branch is not this repository's, and a session holding
   * a branch of that name elsewhere is not its owner.
   *
   * @param {any} row
   */
  const headOf = (row) => (String(row?.head?.repo?.full_name ?? '').toLowerCase() === repo.toLowerCase() ? String(row.head.ref ?? '') : '');

  const call = githubApi({ token, fetch, sleep });
  /** Every open issue and PR, read once for `openNaming`. @type {Promise<Array<OpenRow & { body: string }>> | null} */
  let openRows = null;

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
     * The issues opened after `since`, newest first until a page's last predates it.
     *
     * @param {string} since
     * @returns {Promise<CountedRow[]>}
     */
    issuesOpenedSince: async (since) => {
      const rows = await pagesUntil(call, `/repos/${repo}/issues`, { state: 'all', sort: 'created', direction: 'desc' }, (row) => Date.parse(row.created_at) <= Date.parse(since));
      return after(rows, 'created_at', since);
    },

    /**
     * The issues closed after `since`: the closed ones updated since, a
     * close being an update, kept where the close itself is after it.
     *
     * @param {string} since
     * @returns {Promise<CountedRow[]>}
     */
    issuesClosedSince: async (since) => after(await allPages(call, `/repos/${repo}/issues`, { state: 'closed', since, sort: 'updated', direction: 'desc' }), 'closed_at', since),

    /** The native `blocked by` relationships. @param {number} number @returns {Promise<BlockerRow[]>} */
    blockers: async (number) => {
      /** @type {any[]} */
      const rows = await call('GET', `/repos/${repo}/issues/${number}/dependencies/blocked_by?per_page=100`);
      return rows.map((row) => ({ number: row.number, state: row.state, title: row.title }));
    },

    /**
     * The native `blocking` relationships, the reverse of `blockers`, this
     * repository's only: a dependency can cross repositories, and the caller
     * plans by number, so another repo's #12 would read as this one's.
     *
     * @param {number} number
     * @returns {Promise<BlockerRow[]>}
     */
    blocking: async (number) => {
      /** @type {any[]} */
      const rows = await call('GET', `/repos/${repo}/issues/${number}/dependencies/blocking?per_page=100`);
      const here = `/repos/${repo}`.toLowerCase();
      return rows
        .filter((row) => typeof row.repository_url !== 'string' || row.repository_url.toLowerCase().endsWith(here))
        .map((row) => ({ number: row.number, state: row.state, title: row.title }));
    },

    /** The parent issue, or null where there is none. @param {number} number @returns {Promise<ParentRow | null>} */
    parent: async (number) => {
      try {
        const row = await call('GET', `/repos/${repo}/issues/${number}/parent`);
        return { number: row.number, state: row.state, labels: labelNames(row) };
      } catch (error) {
        if (/** @type {{ status?: number }} */ (error)?.status === 404) return null;
        throw error;
      }
    },

    /** Post a comment. @param {number} number @param {string} body */
    comment: async (number, body) => {
      await call('POST', `/repos/${repo}/issues/${number}/comments`, { body });
    },

    /** A pull request's body, a null one as '', and its head branch ({@link headOf}). @param {number} number @returns {Promise<{ number: number, body: string, head: string }>} */
    pull: async (number) => {
      const row = await call('GET', `/repos/${repo}/pulls/${number}`);
      return { number: row.number, body: row.body ?? '', head: headOf(row) };
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
     * The open issues and PRs whose body holds `term` (a session's id). Read
     * from the issues list, which carries PRs too and is on the core rate
     * limit, once per reader (one per turn) and filtered here: the search
     * API allows an installation about thirty calls a minute, which the
     * App's other callers spend too. `term` counts only where no id
     * character is glued to either side, as the search's phrase matched it:
     * `session_01ABC` is not named by `session_01ABCDEF`.
     *
     * @param {string} term
     * @returns {Promise<OpenRow[]>}
     */
    openNaming: async (term) => {
      openRows ??= allPages(call, `/repos/${repo}/issues`, { state: 'open' })
        .then((rows) => rows.map((row) => ({ number: row.number, title: row.title, html_url: row.html_url, pull: Boolean(row.pull_request), body: String(row.body ?? '') })))
        .catch((error) => { openRows = null; throw error; });
      const named = new RegExp(`(?<![A-Za-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`);
      return (await openRows).filter((row) => named.test(row.body)).map(({ body: _body, ...row }) => row);
    },

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
        author: String(row.user?.login ?? ''),
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
      return (answer?.workflow_runs ?? []).map((/** @type {any} */ row) => ({
        id: row.id,
        status: row.status,
        conclusion: row.conclusion ?? null,
        event: row.event,
        head_branch: row.head_branch,
        head_sha: row.head_sha,
        html_url: row.html_url,
        created_at: row.created_at,
      }));
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
    configFile: async (path = '.github/dispatch.json') => {
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
     * The latest check run of each name, and the latest status of each
     * context, at a commit: red when it ended in a way that blocks a merge,
     * pending while it has not ended, green otherwise. Needs the App's
     * Checks and Commit statuses read.
     *
     * @param {string} sha
     * @returns {Promise<Array<{ name: string, state: 'red' | 'green' | 'pending' }>>}
     */
    checksAt: async (sha) => {
      /** @type {any[]} */
      const runs = [];
      for (let page = 1; page <= 30; page += 1) {
        const answer = await call('GET', `/repos/${repo}/commits/${sha}/check-runs?${new URLSearchParams({ filter: 'latest', per_page: '100', page: String(page) })}`);
        const batch = answer?.check_runs ?? [];
        runs.push(...batch);
        if (batch.length < 100) break;
      }
      const status = await call('GET', `/repos/${repo}/commits/${sha}/status?per_page=100`);
      /** @type {(red: boolean, pending: boolean) => 'red' | 'green' | 'pending'} */
      const stateOf = (red, pending) => (red ? 'red' : pending ? 'pending' : 'green');
      return [
        ...runs.map((r) => ({ name: String(r?.name ?? ''), state: stateOf(RED_CONCLUSIONS.has(String(r?.conclusion)), typeof r?.conclusion !== 'string') })),
        ...(status?.statuses ?? []).map((/** @type {any} */ st) => ({ name: String(st?.context ?? ''), state: stateOf(st?.state === 'failure' || st?.state === 'error', st?.state === 'pending') })),
      ];
    },

    /**
     * Approve a pull request at `sha`, the head reviewed: a pass in a repo
     * whose owner merges.
     *
     * @param {number} number
     * @param {{ sha: string, body: string }} options
     */
    approve: async (number, { sha, body }) => {
      await call('POST', `/repos/${repo}/pulls/${number}/reviews`, { commit_id: sha, event: 'APPROVE', body });
    },

    /** A pull request's submitted reviews, each with whether a bot wrote it. @param {number} number @returns {Promise<Array<{ id: number, state: string, body: string, bot: boolean }>>} */
    pullReviews: async (number) =>
      (await allPages(call, `/repos/${repo}/pulls/${number}/reviews`, {})).map((row) => ({
        id: row.id, state: String(row.state ?? ''), body: row.body ?? '', bot: row.user?.type === 'Bot',
      })),

    /** Dismiss a review, saying why. @param {number} number @param {number} id @param {string} message */
    dismissReview: async (number, id, message) => {
      await call('PUT', `/repos/${repo}/pulls/${number}/reviews/${id}/dismissals`, { message, event: 'DISMISS' });
    },

    /**
     * Create `name` in the repo unless it has it: the claim label, in a repo
     * that lacks one.
     *
     * @param {string} name
     */
    ensureLabel: async (name) => {
      try {
        await call('GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`);
        return;
      } catch (error) {
        if (/** @type {{ status?: number }} */ (error)?.status !== 404) throw error;
      }
      await call('POST', `/repos/${repo}/labels`, { name, color: 'ededed', description: 'Claimed by the dispatcher for the session it launched' });
    },

    /** The open pull requests, each with whether it is a draft, its base branch, its head ({@link headOf}), title, link and body. @returns {Promise<OpenPullRow[]>} */
    openPulls: async () =>
      (await allPages(call, `/repos/${repo}/pulls`, { state: 'open' })).map((row) => ({
        number: row.number,
        draft: row.draft === true,
        base: String(row.base?.ref ?? ''),
        head: headOf(row),
        title: String(row.title ?? ''),
        html_url: String(row.html_url ?? ''),
        body: row.body ?? '',
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
      return { number: row.number, title: row.title ?? '', body: row.body ?? '', state: row.state, labels: labelNames(row), pull: Boolean(row.pull_request) };
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
