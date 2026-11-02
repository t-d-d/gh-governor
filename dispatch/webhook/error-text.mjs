/**
 * A thrown value as a log line carries it: its stack where it has one, the
 * value itself where it has none. The task's entrypoint (dispatch/cli.mjs),
 * the receiver (route.mjs) and the starter (starter.mjs) all write it this
 * way, so a change here, such as adding the cause, reaches all three. It
 * lives here, not in scripts/lib/, because both Lambdas ship this directory
 * and nothing else.
 *
 * @param {unknown} error
 */
export const errorText = (error) => String(/** @type {any} */ (error)?.stack ?? error);
