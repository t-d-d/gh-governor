/**
 * A served repo's heartbeat: what governor writes into the issue the repo's
 * config file names (`heartbeat` in `.github/dispatch.json`), so a check
 * outside governor can tell a dispatcher that stopped from one that found
 * nothing to do. The rest of the issue's body stays as its owner wrote it.
 *
 * A file in the `{ issue, marker }` shape gets one `last-run:` line under
 * the repo's own marker, which the schedule turn stamps
 * ({@link stampLastRun}). A file in the `{ issue }` shape gets governor's own
 * block under {@link HEARTBEAT_MARKER}, which the body must already carry,
 * ended by {@link HEARTBEAT_END}: one line for pickup and one per periodic
 * ({@link stampHeartbeat}), each changed only by the fire it reports, and a
 * periodic's state by the sign-off sweep. A periodic governor has read but
 * not fired yet gets a line at its baseline's time, which only a missing line
 * takes.
 */

import { sessionId } from './webhook/subscribe.mjs';

const LAST_RUN = /^last-run:\s*(\S+)\s*$/m;
const LAST_RUN_LINE = /^last-run:[^\n]*$/m;

/**
 * A heartbeat issue's last run, or undefined where none is recorded yet.
 * Throws where the body lacks the marker: that is a wrong issue number, and
 * reading it as "never ran" would report a lapse on a healthy dispatcher.
 *
 * @param {string | null | undefined} body
 * @param {string} marker
 */
export const readLastRun = (body, marker) => {
  const text = String(body ?? '');
  if (!text.includes(marker)) throw new Error(`issue body has no ${marker} marker`);
  const at = Date.parse(text.match(LAST_RUN)?.[1] ?? '');
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
};

/**
 * `body` with its `last-run:` line set to `at`, or one added after the
 * marker's line where it has none; the rest of the body as it was. Throws
 * where the body lacks the marker, so a wrong issue number never overwrites
 * someone's ticket.
 *
 * @param {string | null | undefined} body
 * @param {string} marker
 * @param {string | number} at
 */
export const stampLastRun = (body, marker, at) => {
  const text = String(body ?? '');
  if (!text.includes(marker)) throw new Error(`issue body has no ${marker} marker`);
  const line = `last-run: ${new Date(at).toISOString()}`;
  if (LAST_RUN_LINE.test(text)) return text.replace(LAST_RUN_LINE, line);
  const end = text.indexOf('\n', text.indexOf(marker));
  return end === -1 ? `${text}\n${line}` : `${text.slice(0, end + 1)}${line}\n${text.slice(end + 1)}`;
};

/** Where governor's block starts: the body must carry it before any write. */
export const HEARTBEAT_MARKER = '<!-- governor:heartbeat -->';

/** Where governor's block ends: governor writes it with the first lines. */
export const HEARTBEAT_END = '<!-- governor:heartbeat-end -->';

/**
 * @typedef {import('./webhook/fire.mjs').Count} Count
 * @typedef {{ days: number } | { count: Count, number: number }} Limit
 *   What fired a periodic: its day limit, or the count that reached its number.
 * @typedef {'open' | 'signed off' | 'held' | 'nothing to do' | 'not fired'} RunState
 *   `held`: the fire came due while the session the line names was still open.
 *   `not fired`: governor wrote the periodic's baseline and has not fired it
 *   since; the line's time is the baseline's, not a fire's.
 * @typedef {{ at: string, started: number }} PickupLine
 *   The last sweep's time, and how many ticket sessions it started.
 * @typedef {{ name: string, at: string, by?: Limit, session: string | null, state: RunState }} PeriodicLine
 *   `at`: the last fire's time, or the baseline's while `not fired`. `by`: the
 *   limit that fired it, where known.
 *   `session`: the session the fire started, null where none did.
 * @typedef {{ pickup?: PickupLine, periodics: PeriodicLine[] }} Heartbeat
 * @typedef {Partial<PeriodicLine> & { name: string }} PeriodicChange
 *   A periodic's line, or the fields of it that change.
 * @typedef {{ pickup?: PickupLine, periodics?: PeriodicChange[], signedOff?: string[] }} Beat
 *   What a turn changes in the block. `signedOff`: the sessions the sign-off
 *   sweep archived, each `session_…`.
 */

/** What a line calls each count, one and many. */
const COUNTED = /** @type {Record<Count, [string, string]>} */ ({
  merges: ['merge', 'merges'],
  issuesOpened: ['issue opened', 'issues opened'],
  issuesClosed: ['issue closed', 'issues closed'],
});

/** What a line calls each state. */
const STATES = /** @type {Record<RunState, string>} */ ({
  open: 'open',
  'signed off': 'signed off',
  held: 'held while that session is open',
  'nothing to do': 'nothing to do',
  'not fired': 'not fired yet',
});

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const PICKUP = /^- pickup: last sweep (\S+), started (\d+) sessions?$/;
const PERIODIC = new RegExp([
  '^- periodic ("(?:[^"\\\\]|\\\\.)*"): (last fire|first read) (\\S+)',
  '(?:, by (?:its day limit of (\\d+) days?|(\\d+) (merges?|issues? opened|issues? closed)))?',
  `, session (\\S+), (${Object.values(STATES).join('|')})$`,
].join(''));

/** @param {Limit} by */
const limitText = (by) => ('days' in by ? `its day limit of ${plural(by.days, 'day', 'days')}` : plural(by.number, ...COUNTED[by.count]));

/** @param {PickupLine} line */
const pickupText = ({ at, started }) => `- pickup: last sweep ${at}, started ${plural(started, 'session', 'sessions')}`;

/** @param {PeriodicLine} line */
const periodicText = ({ name, at, by, session, state }) =>
  `- periodic ${JSON.stringify(name)}: ${state === 'not fired' ? 'first read' : 'last fire'} ${at}${by === undefined ? '' : `, by ${limitText(by)}`}, session ${session ?? 'none'}, ${STATES[state]}`;

/**
 * One line of the block, read; null for a line governor did not write.
 *
 * @param {string} text
 * @returns {{ pickup: PickupLine } | { periodic: PeriodicLine } | null}
 */
const lineOf = (text) => {
  const pickup = PICKUP.exec(text);
  if (pickup !== null) return { pickup: { at: String(pickup[1]), started: Number(pickup[2]) } };
  const m = PERIODIC.exec(text);
  if (m === null) return null;
  const [, name, read, at, days, number, counted, session, state] = m;
  // Governor writes `first read` only with `not fired yet`, and `last fire`
  // only with a fire's state: a line mixing them is not governor's.
  if ((read === 'first read') !== (state === STATES['not fired'])) return null;
  const count = /** @type {Count | undefined} */ (Object.keys(COUNTED).find((k) => COUNTED[/** @type {Count} */ (k)].includes(String(counted))));
  /** @type {Limit | undefined} */
  const by = days !== undefined ? { days: Number(days) } : count !== undefined ? { count, number: Number(number) } : undefined;
  return {
    periodic: {
      name: JSON.parse(String(name)),
      at: String(at),
      ...(by === undefined ? {} : { by }),
      session: session === 'none' ? null : String(session),
      state: /** @type {RunState} */ (Object.keys(STATES).find((k) => STATES[/** @type {RunState} */ (k)] === state)),
    },
  };
};

/**
 * The body cut at governor's block: what comes before it, ending with the
 * marker; the block's lines; and what comes after it. A body whose block
 * has no end yet has empty lines, and the text after the marker stays after
 * the block. Throws where the body lacks the marker, so a wrong issue
 * number never overwrites someone's ticket.
 *
 * @param {string | null | undefined} body
 */
const blockOf = (body) => {
  const text = String(body ?? '');
  const start = text.indexOf(HEARTBEAT_MARKER);
  if (start === -1) throw new Error(`issue body has no ${HEARTBEAT_MARKER} marker`);
  const open = start + HEARTBEAT_MARKER.length;
  const end = text.indexOf(HEARTBEAT_END, open);
  return {
    before: text.slice(0, open),
    lines: end === -1 ? [] : text.slice(open, end).split('\n').map((l) => l.trim()).filter((l) => l !== ''),
    after: end === -1 ? text.slice(open) : text.slice(end + HEARTBEAT_END.length),
  };
};

/**
 * What governor's block records. Throws where the body lacks the marker.
 *
 * @param {string | null | undefined} body
 * @returns {Heartbeat}
 */
export const readHeartbeat = (body) => {
  /** @type {Heartbeat} */
  const beat = { periodics: [] };
  for (const text of blockOf(body).lines) {
    const line = lineOf(text);
    if (line === null) continue;
    if ('pickup' in line) beat.pickup = line.pickup;
    else beat.periodics = [...beat.periodics.filter((p) => p.name !== line.periodic.name), line.periodic];
  }
  return beat;
};

/**
 * `body` with governor's block changed by `beat`: pickup's line replaced,
 * each periodic's line given the fields its change names (a periodic with
 * no line and no fire time gets none; a `not fired` change, from a baseline,
 * only adds a missing line and never replaces one), then each open or held
 * line whose session signed off marked so, its fire time kept. Lines the
 * change does not name stay; a line in the block governor did not write is
 * dropped. Nothing outside the block changes. Throws where the body lacks
 * the marker.
 *
 * @param {string | null | undefined} body
 * @param {Beat} beat
 */
export const stampHeartbeat = (body, beat) => {
  const { before, after } = blockOf(body);
  const read = readHeartbeat(body);
  const pickup = beat.pickup ?? read.pickup;
  const periodics = [...read.periodics];
  for (const change of beat.periodics ?? []) {
    const i = periodics.findIndex((p) => p.name === change.name);
    // A baseline is not a fire: after a lost record, the line keeps its last
    // real fire, so a check still sees the late run.
    if (change.state === 'not fired' && i !== -1) continue;
    const line = { ...periodics[i], ...change };
    if (line.at === undefined || line.session === undefined || line.state === undefined) continue;
    const full = /** @type {PeriodicLine} */ (line);
    if (i === -1) periodics.push(full);
    else periodics[i] = full;
  }
  const signed = new Set(beat.signedOff ?? []);
  const marked = periodics.map((p) => (p.session !== null && (p.state === 'open' || p.state === 'held') && signed.has(sessionId(p.session)) ? { ...p, state: /** @type {RunState} */ ('signed off') } : p));
  const lines = [...(pickup === undefined ? [] : [pickupText(pickup)]), ...marked.map(periodicText)];
  return `${before}\n${lines.map((l) => `${l}\n`).join('')}${HEARTBEAT_END}${after}`;
};
