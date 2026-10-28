/**
 * The session that has a branch checked out.
 *
 * A session running locally (the CLI, or the desktop app with Remote Control
 * on) cannot name itself: nothing gives it its own link, so its PR body ends
 * in the attribution line alone and its commits carry no `Claude-Session`
 * trailer. Its record in the sessions API carries the branch it has checked
 * out, which its process pushes as it changes. So the dispatcher finds a
 * PR's owner by the PR's head branch.
 *
 * The API is the one the CLI lists and teleports with, under the stored
 * login's bearer token (dispatch/turn.mjs `realDeps().sessions`); it is not a
 * documented one. A list row, as the API listed a local session on
 * 2026-09-27, carries `id`, `session_status`
 * (`SESSION_STATUS_ARCHIVED` once archived), `environment_kind` (`bridge`
 * for a local session) and the branch twice: `external_metadata.current_branches`,
 * an object from repository (`""` on a cloud row) to branch, and
 * the outcomes' `git_info` with `repo` and `branches` (`config.outcomes[]` as
 * the API answered on 2026-10-27; `session_context.outcomes[].
 * git_repository` as the 2026-09-27 rows were read). Only a branch of
 * `repo` counts; a `""` key counts unless the row's outcomes name only other
 * repositories. A local row naming no branch of any repository yet is
 * fetched, in case its own record has one.
 */

/**
 * @typedef {{ list: (after?: string) => Promise<unknown>, get: (id: string) => Promise<unknown> }} SessionsApi
 *   Each answer as the API returned it, parsed JSON; a session it does not
 *   have, null. Any other refusal throws, and so does the finder: a record
 *   it could not read is not a session holding no branch. `list` reads the
 *   page after the row `after`, or the first.
 * @typedef {{ bridgeOnly?: boolean }} FindOptions
 * @typedef {(branch: string, options?: FindOptions) => Promise<string | null>} FindOnBranch
 *   The most recently updated live session's claude.ai/code link, or null.
 */

/**
 * How many pages of the list a finder reads, as many as the CLI's own
 * listing of its peers. The list is newest first, a hundred a page, and
 * each page may take the request's timeout inside a sweep with minutes
 * left; past this, the log says the list was cut.
 */
export const MAX_PAGES = 5;

/** A session id as the API gives it (`cse_…`) or as a link names it (`session_…`). */
const ID = /^(?:cse|session)_([A-Za-z0-9]{4,128})$/;

/** @param {unknown} value @returns {string[]} */
const names = (value) => {
  if (typeof value === 'string') return value === '' ? [] : [value];
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v !== '') : [];
};

/** @param {unknown} a @param {string} repo lower-cased */
const sameRepo = (a, repo) => typeof a === 'string' && a.toLowerCase() === repo;

/**
 * The branches of `repo` a row or a record says the session holds, and
 * whether it names a branch of any repository. A cloud row keys its one
 * checkout `""`; that counts unless its outcomes name only other
 * repositories.
 *
 * @param {any} row
 * @param {string} repo lower-cased
 * @returns {{ held: string[], any: boolean }}
 */
const branchesOf = (row, repo) => {
  const current = row?.external_metadata?.current_branches;
  const entries = current && typeof current === 'object' ? Object.entries(current) : [];
  const infos = gitInfos(row);
  /** @type {unknown[]} */
  const repos = infos.map((/** @type {any} */ info) => info.repo).filter((/** @type {unknown} */ r) => typeof r === 'string');
  const unkeyed = repos.length === 0 || repos.some((r) => sameRepo(r, repo));
  return {
    held: [
      ...entries.filter(([key]) => (key === '' ? unkeyed : sameRepo(key, repo))).flatMap(([, branch]) => names(branch)),
      ...infos.filter((/** @type {any} */ info) => info.repo === undefined || sameRepo(info.repo, repo)).flatMap((/** @type {any} */ info) => names(info.branches)),
    ],
    any: entries.some(([, branch]) => names(branch).length > 0) || infos.some((/** @type {any} */ info) => names(info.branches).length > 0),
  };
};

/**
 * Each `git_info` a row's outcomes carry: under `config.outcomes[]`, as the
 * deployed list and record answer (2026-10-27), or
 * `session_context.outcomes[].git_repository`, as the rows read on
 * 2026-09-27 had it.
 *
 * @param {any} row
 * @returns {any[]}
 */
const gitInfos = (row) => [
  ...(Array.isArray(row?.config?.outcomes) ? row.config.outcomes : []).map((/** @type {any} */ o) => o?.git_info),
  ...(Array.isArray(row?.session_context?.outcomes) ? row.session_context.outcomes : []).map((/** @type {any} */ o) => o?.git_repository?.git_info),
].filter((info) => info && typeof info === 'object');

/** A GitHub repository URL's `owner/name`. */
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/**
 * The repositories a row's session works in, lower-cased `owner/name`: each
 * `config.sources[].url` on github.com (a cloud session's checkout) and each
 * outcome's `git_info.repo` (where it pushes, a Remote Control session's
 * too). Measured on the deployed list and record, 2026-10-27; the
 * account's session tools show the same fields reshaped under
 * `session_context`, which the raw API does not carry.
 *
 * @param {any} row
 * @returns {string[]}
 */
export const reposOf = (row) => {
  const sources = Array.isArray(row?.config?.sources) ? row.config.sources : [];
  return [...new Set([
    ...sources.map((/** @type {any} */ s) => GITHUB_REPO.exec(String(s?.url ?? ''))?.[1]),
    ...gitInfos(row).map((info) => info.repo),
  ].filter((r) => typeof r === 'string' && /^[^/\s]+\/[^/\s]+$/.test(r)).map((r) => r.toLowerCase()))];
};

/** Whether the API's row (a list row or one session's record) reads archived. @param {any} row */
export const archived = (row) => /(?:^|_)ARCHIVED$/i.test(String(row?.session_status ?? row?.status ?? ''));

/** When the API's row was last updated, in ms; 0 when it does not say. @param {any} row */
const updated = (row) => Date.parse(String(row?.updated_at ?? row?.created_at ?? '')) || 0;

/** Sorts the API's rows most recently updated first. @param {any} a @param {any} b */
export const newestFirst = (a, b) => updated(b) - updated(a);

/**
 * One page of a list answer: `data`, and the row to read the next page
 * after, as the CLI pages it (`has_more`, `last_id`), or null.
 *
 * @param {unknown} answer
 * @returns {{ rows: any[], next: string | null }}
 */
const pageOf = (answer) => {
  const rows = Array.isArray(answer) ? answer : /** @type {any} */ (answer)?.data;
  if (!Array.isArray(rows)) throw new Error(`the sessions list is not a list of sessions: ${JSON.stringify(answer).slice(0, 300)}`);
  const last = /** @type {any} */ (answer)?.last_id;
  return { rows, next: /** @type {any} */ (answer)?.has_more === true && typeof last === 'string' && last !== '' ? last : null };
};

/** @param {string} id */
const linkOf = (id) => `https://claude.ai/code/session_${ID.exec(id)?.[1]}`;

/**
 * Every row of the sessions list, up to MAX_PAGES pages, by id: a session
 * that moves up the list between two page reads is listed twice, and the
 * later read is the later word. A list that runs past the pages is logged.
 *
 * @param {SessionsApi['list']} list
 * @param {{ log?: (event: string, context?: Record<string, unknown>) => void }} [options]
 * @returns {Promise<any[]>}
 */
export const sessionRows = async (list, { log = () => {} } = {}) => {
  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {string | undefined} */
  let after;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { rows: more, next } = pageOf(await list(after));
    for (const row of more) rows.set(row?.id, row);
    if (next === null || next === after) return [...rows.values()];
    after = next;
  }
  log('dispatch-sessions', { truncated: true, pages: MAX_PAGES, rows: rows.size, reason: 'the sessions list runs past the pages a finder reads; older sessions are not looked at' });
  return [...rows.values()];
};

/**
 * A session's own record (`GET /v1/code/sessions/<id>`) as the rows the
 * list carries. The API answers some records with the session under
 * `response_shape` alone (2026-10-27), as an object or as its JSON
 * text: the log that saw it prints either the same way. Any other answer is
 * the record as is.
 *
 * @param {unknown} answer
 * @returns {unknown}
 */
export const sessionRecord = (answer) => {
  if (answer === null || typeof answer !== 'object') return answer;
  const keys = Object.keys(answer);
  if (keys.length !== 1 || keys[0] !== 'response_shape') return answer;
  let inner = /** @type {Record<string, unknown>} */ (answer).response_shape;
  if (typeof inner === 'string') {
    try {
      inner = JSON.parse(inner);
    } catch {
      return answer;
    }
  }
  return inner !== null && typeof inner === 'object' && !Array.isArray(inner) ? inner : answer;
};

/**
 * One session's row in the sessions list, read afresh, page by page until a
 * page names it, up to MAX_PAGES; undefined where none does.
 *
 * @param {SessionsApi['list']} list
 * @param {string} id
 * @returns {Promise<any>}
 */
export const sessionRow = async (list, id) => {
  /** @type {string | undefined} */
  let after;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { rows, next } = pageOf(await list(after));
    const row = rows.find((r) => r?.id === id);
    if (row !== undefined || next === null || next === after) return row;
    after = next;
  }
  return undefined;
};

/**
 * A finder over one read of the sessions list: the list is read on the first
 * question, every page of it up to MAX_PAGES, and each record at most once,
 * so a turn asking about several branches pays for one list. A read that
 * fails is not kept: the next question asks again. It takes the
 * sessions on the branch that are not archived; `bridgeOnly`, local ones
 * alone.
 *
 * @param {SessionsApi} sessions
 * @param {string} repo `owner/name`: a branch of another repository is not this one's.
 * @param {{ log?: (event: string, context?: Record<string, unknown>) => void }} [options]
 * @returns {FindOnBranch}
 */
export const branchFinder = (sessions, repo, { log = () => {} } = {}) => {
  const want = repo.toLowerCase();
  /** @type {Promise<any[]> | null} */
  let listed = null;
  // Rows by id (sessionRows): a session listed twice would otherwise count
  // as two sessions on its branch.
  const list = () => sessionRows(sessions.list, { log });
  /** @type {Map<string, Promise<any>>} */
  const records = new Map();
  /** @param {string} id */
  const record = (id) => {
    let got = records.get(id);
    if (got === undefined) {
      records.set(id, got = Promise.resolve(sessions.get(id)).catch((error) => { records.delete(id); throw error; }));
    }
    return got;
  };
  /** @param {FindOptions} options */
  const rowsFor = async ({ bridgeOnly = false }) => (await (listed ??= list().catch((error) => { listed = null; throw error; })))
    .filter((row) => typeof row?.id === 'string' && ID.test(row.id) && !archived(row))
    .filter((row) => !bridgeOnly || row.environment_kind === 'bridge')
    .sort(newestFirst);
  /**
   * The branches of the repository a row's session holds, and the row or
   * record that says so: a local row naming none is read from its own
   * record, which may say it is archived since. Null for a session the API
   * no longer has.
   *
   * @param {any} row
   * @returns {Promise<{ held: string[], source: any } | null>}
   */
  const heldBy = async (row) => {
    const { held, any } = branchesOf(row, want);
    if (any || row.environment_kind !== 'bridge') return { held, source: row };
    const own = await record(row.id);
    if (own === null || own === undefined) return null;
    return { held: branchesOf(own, want).held, source: own };
  };
  /** @type {FindOnBranch} */
  const find = async (branch, options = {}) => {
    for (const row of await rowsFor(options)) {
      const got = await heldBy(row);
      if (got !== null && !archived(got.source) && got.held.includes(branch)) return linkOf(row.id);
    }
    return null;
  };
  return find;
};
