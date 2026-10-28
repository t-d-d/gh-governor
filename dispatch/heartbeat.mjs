/**
 * A served repo's heartbeat: the `last-run:` line the schedule turn writes
 * into the issue the repo's config file names (`heartbeat` in
 * `.github/dispatch.json`). The file names the issue and its marker, so the
 * rest of the issue's body stays as its owner wrote it. A watchdog in the
 * served repo reads the line to tell a dispatcher that stopped from one that
 * found nothing to do.
 */

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
