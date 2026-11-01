/**
 * A periodic that names claude.ai connectors (dispatch/repo-config.mjs)
 * starts as a routine run, not with `claude --cloud`. The CLI's create
 * request has no field for connectors, so a session it starts has none of
 * the account's. A routine takes the connectors to attach
 * (`mcp_connections`), each run starts a fresh cloud session with them,
 * and the session acts on its prompt as the owner's own.
 *
 * Governor keeps one routine for each such periodic, named after the repo
 * and the periodic ({@link routineName}), and finds it by that name, so a
 * lost record costs nothing. Before each fire it points the routine at this
 * fire: the prompt with governor's lines, the repo's environment and
 * source, the model and the named connectors. It then fires it with
 * `POST /v1/code/triggers/{id}/run`. Governor still decides when the
 * periodic is due: the routine's own schedule never comes due
 * ({@link NEVER_DUE}), and every update sets it back.
 *
 * After the fire, the run's session is the one the fire answers with, or
 * the routine's first run session not listed before the fire
 * (`GET /v1/code/sessions?trigger_id=<id>`). The answer has the launcher's
 * shape (`status`, `output`), so the turn records and holds it as it does a
 * session `claude --cloud` started: 0 with the session's link, 3 for a
 * fire whose session it could not find (unconfirmed), 1 for nothing
 * started. A fire the API refused ({@link refusedFire}: a 4xx other than
 * 408 and 429, or a call that threw before its request went out) started
 * nothing. Any other fire that throws may still have started a run (a
 * timeout, a 502 after the server queued it), so it is read as a fire that
 * answered without its session. A named connector the account has not connected starts nothing and is
 * named in `missing`.
 *
 * Every shape here is read from the bundled CLI's routine commands, not a
 * published API, so the turn logs each answer's shape ({@link observed}).
 */

import { messageOf } from '../scripts/lib/error-message.mjs';
import { CONNECTOR_NAME } from './repo-config.mjs';

/**
 * The routine's own schedule: midnight on 30 February, a day no year has.
 * The routines API takes exactly one of `cron_expression` and
 * `run_once_at`, and a `run_once_at` would come due one day.
 */
export const NEVER_DUE = '0 0 30 2 *';

/**
 * A routines API call that failed with a known cause: the HTTP status of an
 * answer that was not a 2xx, or null for a call that threw before any
 * request was sent. A timeout or a network error is not one of these, as
 * the request may have reached the server.
 */
export class RoutinesApiError extends Error {
  /** @param {string} message @param {number | null} status */
  constructor(message, status) {
    super(message);
    this.name = 'RoutinesApiError';
    /** @type {number | null} */
    this.status = status;
  }
}

/**
 * Whether a fire's error says no run started: an answer of 4xx other than
 * 408 (timed out) and 429 (too many requests), or a call that threw before
 * its request was sent. A 409 counts as a refusal: the run it may name is an
 * earlier one, never this fire's. Any other error, a 5xx, a timeout or a
 * network error, may follow a run the server queued.
 *
 * @param {unknown} error
 */
export const refusedFire = (error) => error instanceof RoutinesApiError
  && (error.status === null || (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429));

/** How many times the routine's run sessions are read after a fire, and how long apart. */
export const ROUTINE_SESSION_TRIES = 6;
export const ROUTINE_SESSION_PAUSE_MS = 5_000;

/** A session id as the sessions API writes one, either form. */
const SESSION_ID = /^(?:cse|session)_([A-Za-z0-9]{4,128})$/;

/** Any session id in a text, either form. */
const ANY_SESSION_ID = /\b(?:cse|session)_[A-Za-z0-9]+/g;

/**
 * @typedef {{
 *   connectors: () => Promise<unknown>,
 *   triggers: () => Promise<unknown>,
 *   create: (body: object) => Promise<unknown>,
 *   update: (id: string, body: object) => Promise<unknown>,
 *   run: (id: string) => Promise<unknown>,
 *   sessions: (id: string) => Promise<unknown>,
 * }} RoutinesApi
 *   The account's connector list (`GET /v1/mcp_servers`), its routines
 *   (`GET /v1/code/triggers`), a routine created or updated, one fired, and
 *   one's run sessions, each answer parsed. Any refusal throws, as a
 *   {@link RoutinesApiError} where its cause is known.
 * @typedef {{ connector_uuid: string, name: string, url: string }} Connection
 * @typedef {{ status: number, output: string, missing?: string[] }} RoutineResult
 */

/**
 * The event each routines API call logs: the shape of what it answered.
 */
export const ROUTINE_ANSWER = 'dispatch-routine-answer';

/** A routine or session id, the only answered text a shape carries. */
const LOGGED_ID = /^(?:session|cse|trig|trigger)_[A-Za-z0-9]{4,128}$/;

/** A value's type as JSON names it. @param {unknown} value */
const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

/**
 * An object's keys and each one's type, and any routine or session id in
 * it or one level down, by its path (`session.id`).
 *
 * @param {Record<string, unknown>} object
 */
const keysOf = (object) => {
  /** @type {Record<string, string>} */
  const keys = {};
  /** @type {Record<string, string>} */
  const ids = {};
  for (const [key, value] of Object.entries(object)) {
    keys[key] = typeOf(value);
    if (typeof value === 'string' && LOGGED_ID.test(value)) ids[key] = value;
    if (typeOf(value) === 'object') {
      for (const [inner, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
        if (typeof v === 'string' && LOGGED_ID.test(v)) ids[`${key}.${inner}`] = v;
      }
    }
  }
  return { keys, ids };
};

/**
 * What a routines API answer looks like, with none of its text but ids: its
 * keys and their types, any routine or session id, and for a list, its
 * count, `has_more` and its first row's keys. The answers carry a
 * periodic's prompt and its sessions' titles, which stay out of the log.
 *
 * @param {unknown} answer
 * @returns {Record<string, unknown>}
 */
export const answerShape = (answer) => {
  if (Array.isArray(answer)) return { type: 'array', rows: answer.length };
  if (typeOf(answer) !== 'object') return { type: typeOf(answer) };
  const object = /** @type {Record<string, unknown>} */ (answer);
  const shape = /** @type {Record<string, unknown>} */ (keysOf(object));
  if (Array.isArray(object.data)) {
    shape.rows = object.data.length;
    shape.hasMore = object.has_more === true;
    const first = object.data[0];
    if (typeOf(first) === 'object') shape.firstRow = keysOf(/** @type {Record<string, unknown>} */ (first));
  }
  return shape;
};

/**
 * The routines API with each call's answer logged by its shape
 * ({@link answerShape}), and a call that throws logged as failed: the API's
 * answers are read from the bundled CLI, not a published shape, and the log
 * says what the live API answers. Each line names the repo and periodic
 * the call is for, and a failed call the HTTP status it was answered with.
 *
 * @param {RoutinesApi} api
 * @param {(event: string, context: Record<string, unknown>) => void} log
 * @param {{ repo: string, periodic: string }} about
 * @returns {RoutinesApi}
 */
export const observed = (api, log, { repo, periodic }) => {
  /**
   * @template T
   * @param {string} call
   * @param {string | undefined} routine
   * @param {() => Promise<T>} begin
   * @returns {Promise<T>}
   */
  const watch = async (call, routine, begin) => {
    const at = { level: 'info', repo, periodic, call, ...(routine === undefined ? {} : { routine }) };
    let answer;
    try {
      answer = await begin();
    } catch (error) {
      const status = error instanceof RoutinesApiError ? error.status : null;
      log(ROUTINE_ANSWER, { ...at, failed: true, ...(status === null ? {} : { status }) });
      throw error;
    }
    log(ROUTINE_ANSWER, { ...at, answer: answerShape(answer) });
    return answer;
  };
  return {
    connectors: () => watch('connectors', undefined, () => api.connectors()),
    triggers: () => watch('triggers', undefined, () => api.triggers()),
    create: (body) => watch('create', undefined, () => api.create(body)),
    update: (id, body) => watch('update', id, () => api.update(id, body)),
    run: (id) => watch('run', id, () => api.run(id)),
    sessions: (id) => watch('sessions', id, () => api.sessions(id)),
  };
};

/**
 * The name governor keeps a periodic's routine under. GitHub names a repo
 * in any case, and a fire may carry it in another case than the sweep, so
 * the repo is in lower case: it is the same routine. The periodic's name
 * keeps its case, as the file keeps two names apart by it.
 *
 * @param {string} repo
 * @param {string} periodic
 */
export const routineName = (repo, periodic) => `governor ${repo.toLowerCase()}: ${periodic}`;

/**
 * A connector's name as a routine takes it: the app's `claude.ai ` prefix
 * dropped, and every other character than a letter, digit, hyphen or
 * underscore made an underscore, as the CLI shows a routine's connectors.
 *
 * @param {string} name
 */
const routineConnectorName = (name) => name.replace(/^claude[.\s-]ai[.\s-]/i, '').replace(/[^A-Za-z0-9_-]+/g, '_');

/**
 * The connections a periodic's named connectors are, from the account's
 * connector list. A name matches a connector's own name or the name a
 * routine shows it under. An additional install is another account's
 * login to a connector, and never matches.
 *
 * @param {string[]} names
 * @param {unknown} listed
 * @returns {{ connections: Connection[] } | { missing: string[] }}
 */
export const connectionsFor = (names, listed) => {
  const rows = /** @type {any} */ (listed)?.data;
  if (!Array.isArray(rows)) throw new Error(`the connector list is not a list: ${JSON.stringify(listed)?.slice(0, 200)}`);
  /** @type {Connection[]} */
  const known = [];
  for (const row of rows) {
    if (typeof row?.uuid !== 'string' || typeof row?.name !== 'string' || typeof row?.url !== 'string') throw new Error(`the connector list holds a row without its uuid, name and url: ${Object.keys(row ?? {}).join(', ')}`);
    if (row.additional_install === true) continue;
    known.push({ connector_uuid: row.uuid, name: row.name, url: row.url });
  }
  /** @type {Connection[]} */
  const connections = [];
  /** @type {string[]} */
  const missing = [];
  for (const name of names) {
    const found = known.find((c) => c.name === name) ?? known.find((c) => routineConnectorName(c.name) === name);
    if (found === undefined) missing.push(name);
    else connections.push({ ...found, name: CONNECTOR_NAME.test(found.name) ? found.name : routineConnectorName(found.name) });
  }
  return missing.length > 0 ? { missing } : { connections };
};

/** The ids of a list answer's rows. @param {unknown} answer @param {string} what */
const rowsOf = (answer, what) => {
  const rows = /** @type {any} */ (answer)?.data;
  if (!Array.isArray(rows)) throw new Error(`${what} is not a list: ${JSON.stringify(answer)?.slice(0, 200)}`);
  return { rows, more: /** @type {any} */ (answer)?.has_more === true };
};

/** A session link for an id of either form, or null. @param {unknown} id */
const linkOf = (id) => {
  const bare = typeof id === 'string' ? SESSION_ID.exec(id)?.[1] : undefined;
  return bare === undefined ? null : `https://claude.ai/code/session_${bare}`;
};

/**
 * The session a fire's answer names, if it names one as its own.
 *
 * @param {unknown} answer
 */
const firedSession = (answer) => {
  const a = /** @type {any} */ (answer);
  return linkOf(a?.session_id) ?? linkOf(a?.session?.id) ?? null;
};

/**
 * Start a periodic's session as a run of its routine.
 *
 * @param {{
 *   api: RoutinesApi,
 *   repo: string,
 *   periodic: string,
 *   prompt: string,
 *   environment: string,
 *   model: string,
 *   connectors: string[],
 *   sleep: (ms: number) => Promise<void>,
 *   uuid: () => string,
 * }} args
 * @returns {Promise<RoutineResult>}
 */
export const launchRoutine = async ({ api, repo, periodic, prompt, environment, model, connectors, sleep, uuid }) => {
  const name = routineName(repo, periodic);
  /** @type {string} */
  let id;
  /** The routine's run sessions before this fire. @type {Set<string>} */
  const before = new Set();
  try {
    // Both lists are read together: neither answer shapes the other's request.
    const [listedConnectors, listedRoutines] = await Promise.all([api.connectors(), api.triggers()]);
    const found = connectionsFor(connectors, listedConnectors);
    if ('missing' in found) return { status: 1, output: `not connected on the account: ${found.missing.join(', ')}`, missing: found.missing };
    const body = {
      name,
      cron_expression: NEVER_DUE,
      enabled: true,
      job_config: {
        ccr: {
          environment_id: environment,
          session_context: { model, sources: [{ git_repository: { url: `https://github.com/${repo}` } }] },
          events: [{ data: { uuid: uuid(), session_id: '', type: 'user', parent_tool_use_id: null, message: { role: 'user', content: prompt } } }],
        },
      },
      mcp_connections: found.connections,
    };
    const { rows, more } = rowsOf(listedRoutines, 'the routines list');
    const existing = rows.find((r) => r?.name === name);
    if (existing === undefined && more) return { status: 1, output: `the routines list runs past one page without ${name}: none is created, so no second routine stands beside it` };
    if (existing === undefined) {
      const created = /** @type {any} */ (await api.create(body));
      if (typeof created?.id !== 'string' || created.id === '') return { status: 1, output: `the routine ${name} was created with no id` };
      id = created.id;
    } else {
      if (typeof existing.id !== 'string' || existing.id === '') return { status: 1, output: `the routine ${name} is listed with no id` };
      id = existing.id;
      await api.update(id, body);
      for (const row of rowsOf(await api.sessions(id), 'the routine\'s run sessions').rows) {
        const link = linkOf(row?.id);
        if (link !== null) before.add(link);
      }
    }
  } catch (error) {
    return { status: 1, output: `the routine for ${periodic} did not fire: ${messageOf(error)}` };
  }
  // From the fire on, a failure the API did not refuse leaves a run that may
  // have started: a fire that times out, or answers 502 after the server
  // queued the run, still starts a session. So such a fire is read as one
  // that answered without its session. A refusal started nothing.
  /** Why the fire's own answer named no session, when it threw. @type {string | null} */
  let threw = null;
  try {
    const fired = firedSession(await api.run(id));
    if (fired !== null) return { status: 0, output: `Routine ${id} fired: ${fired}` };
  } catch (error) {
    // The turn takes the session an answer names as this fire's, and a
    // refusal's body may name another run's, so none is kept.
    threw = messageOf(error).replace(ANY_SESSION_ID, 'a session');
    if (refusedFire(error)) return { status: 1, output: `the routine for ${periodic} did not fire: ${threw}` };
  }
  for (let tries = 0; tries < ROUTINE_SESSION_TRIES; tries += 1) {
    if (tries > 0) await sleep(ROUTINE_SESSION_PAUSE_MS);
    try {
      const fresh = rowsOf(await api.sessions(id), 'the routine\'s run sessions').rows
        .map((row) => linkOf(row?.id))
        .find((link) => link !== null && !before.has(link));
      if (fresh !== undefined && fresh !== null) return { status: 0, output: `Routine ${id} fired: ${fresh}` };
    } catch {
      // Read again: the run may have started all the same.
    }
  }
  const fire = threw === null ? 'fired' : `fired and the fire threw (${threw})`;
  return { status: 3, output: `Routine ${id} ${fire}, and none of its run sessions is new after ${ROUTINE_SESSION_TRIES} reads` };
};
