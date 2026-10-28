// app-events: the events the App's webhook delivers, as GitHub answers for
// the App, against the events the receiver routes (HOOK_EVENTS,
// dispatch/webhook/route.mjs).
//
// Every served repo's deliveries come through the App's one webhook. The
// deploy writes the webhook's URL and key (scripts/point-app-webhook.mjs), but
// the events it subscribes to are ticked by hand in the App's settings, which
// the API cannot write. An event left unticked is one the receiver never
// hears, with no error anywhere: a red run nobody is told of, a summons that
// starts nothing.
//
// The read is GitHub's public App endpoint, which answers a public App with
// no credential. The App arrives in GOVERNOR_APP_SLUG, which the deploy sets,
// so a run that names none reports not-applicable out loud
// (scripts/conformance.mjs).

import { HOOK_EVENTS } from '../../dispatch/webhook/route.mjs';

/** Names the App whose events are read; .github/workflows/deploy.yml sets it. */
export const APP_SLUG_VAR = 'GOVERNOR_APP_SLUG';

const READ_TIMEOUT_MS = 30_000;

/**
 * The findings on the events the App delivers.
 *
 * @param {object} sides
 * @param {string} sides.slug
 * @param {readonly string[] | undefined} sides.events - What GitHub says the
 *   App subscribes to; undefined when GitHub answers for no such App.
 * @param {readonly string[]} [sides.declared]
 * @returns {string[]}
 */
export function dispatchAppEventFindings({ slug, events, declared = HOOK_EVENTS }) {
  if (events === undefined) {
    return [`GitHub answers for no App ${slug}. It was renamed, deleted or made private, and no repo's events reach the dispatcher`];
  }
  const missing = declared.filter((e) => !events.includes(e));
  if (missing.length === 0) return [];
  return [
    `the ${slug} App's webhook does not deliver ${missing.join(', ')}, which the receiver routes `
    + '(HOOK_EVENTS, dispatch/webhook/route.mjs), so no repo\'s such events reach the dispatcher. Tick them '
    + 'under the App\'s settings, Permissions & events',
  ];
}

/**
 * The events GitHub says the App subscribes to, or undefined for no such App.
 *
 * @param {string} slug
 * @returns {Promise<string[] | undefined>}
 */
async function readAppEvents(slug) {
  const response = await fetch(`https://api.github.com/apps/${encodeURIComponent(slug)}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET /apps/${slug} failed: ${response.status} ${response.statusText}`);
  const body = /** @type {{ events?: unknown }} */ (await response.json());
  return Array.isArray(body.events) ? body.events.map(String) : [];
}

/**
 * The runner reports it not applicable, and never calls it, while
 * GOVERNOR_APP_SLUG is unset.
 *
 * @param {{
 *   env: Readonly<Record<string, string | undefined>>,
 *   readEvents?: typeof readAppEvents,
 * }} options - `env` from the runner; the io from this member's own tests.
 * @returns {Promise<import('../conformance.mjs').CheckOutcome>}
 */
export async function checkDispatchAppEvents({ env, ...io }) {
  const slug = /** @type {string} */ (env[APP_SLUG_VAR]);
  const events = await (io.readEvents ?? readAppEvents)(slug);
  return {
    findings: dispatchAppEventFindings({ slug, events }),
    // Said out loud on every run, finding or not.
    notes: [`${slug} delivers: ${events === undefined ? '(no such App)' : events.slice().sort().join(', ')}`],
  };
}
