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
export const errorText = (error) => {
  // Each step can throw: a stack getter, a toString, a Symbol.toStringTag
  // getter or a Proxy trap. Every caller runs this inside a catch, so a throw
  // here would escape it, and the next step is tried instead.
  let stack;
  try {
    stack = /** @type {any} */ (error)?.stack;
  } catch {
    stack = undefined;
  }
  try {
    return String(stack ?? error);
  } catch {
    // String() fails on an object with no prototype or a toString that throws.
  }
  try {
    return Object.prototype.toString.call(error);
  } catch {
    return '[unprintable value]';
  }
};
