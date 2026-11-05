/**
 * A thrown value as a log line carries it: its stack where it has one, the
 * value itself where it has none. A value that cannot be turned into a
 * string gives its `[object Tag]` form, or `[unprintable value]`, so this
 * never throws. The task's entrypoint (dispatch/cli.mjs), the receiver
 * (route.mjs) and the starter (starter.mjs) all write it this way, so a
 * change here, such as adding the cause, reaches all three. It lives here,
 * not in scripts/lib/, because both Lambdas ship this directory and nothing
 * else.
 *
 * @param {unknown} error
 */
export const errorText = (error) => {
  // Each step can throw: a stack getter, a toString, a Symbol.toStringTag
  // getter or a Proxy trap. The callers run this in a catch or in the
  // deadline's timer, where a throw would lose the error or skip the exit,
  // so each failed step falls through to the next.
  let stack;
  try {
    stack = /** @type {any} */ (error)?.stack;
  } catch {
    // A stack getter or a Proxy trap that throws: the value itself is next.
  }
  const texts = stack === undefined || stack === null ? [error] : [stack, error];
  for (const text of texts) {
    try {
      return String(text);
    } catch {
      // String() fails on an object with no prototype or a toString that throws.
    }
  }
  try {
    return Object.prototype.toString.call(error);
  } catch {
    return '[unprintable value]';
  }
};
