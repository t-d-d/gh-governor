/**
 * What governor's two reviews share in reading a `claude -p --output-format
 * json` run: the result line, what the run spent, and its error and
 * usage-limit handling. The PR review (dispatch/checklist.mjs) and the
 * issue reviews (dispatch/issue-review.mjs) each check the answer against
 * their own schema.
 *
 * Pure: no I/O.
 */

/**
 * @typedef {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheCreationTokens?: number, costUsd?: number }} Usage
 *   What a run spent, as its result line reports it. A field the line does
 *   not carry as a count, or a cost, of zero or more is left out.
 */

/** The result line's field for each of `Usage`'s token counts. */
const USAGE_FIELDS = /** @type {const} */ ([
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_input_tokens'],
  ['cacheCreationTokens', 'cache_creation_input_tokens'],
]);

/**
 * The tokens and cost a CLI result line reports, or null when it reports
 * none. A missing or malformed number is left out, never a fault: the
 * measurement must not fail a review.
 *
 * @param {any} result
 * @returns {Usage | null}
 */
const usageOf = (result) => {
  /** @type {Record<string, number>} */
  const usage = {};
  const tokens = result.usage && typeof result.usage === 'object' ? result.usage : {};
  for (const [name, field] of USAGE_FIELDS) {
    if (Number.isInteger(tokens[field]) && tokens[field] >= 0) usage[name] = tokens[field];
  }
  if (Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0) usage.costUsd = result.total_cost_usd;
  return Object.keys(usage).length === 0 ? null : usage;
};

/**
 * The object inside the model's text: the whole of it, or the first `{` to
 * the last `}` (a fenced block, a sentence before it).
 *
 * @param {string} text
 * @returns {unknown}
 */
const objectIn = (text) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

/**
 * Which of the account's allowances a refusal of the CLI's names, or null.
 * The session allowance resets within hours, and the review runs again on
 * its next trigger, so no operator acts: the review is `limited`, not
 * `failed`. A weekly one stays a fault.
 *
 * @param {string} text the CLI's error result
 * @returns {'session' | 'weekly' | null}
 */
export const usageLimit = (text) => (/\bweekly limit\b/i.test(text) ? 'weekly' : /\bsession limit\b/i.test(text) ? 'session' : null);

/**
 * The run's result line read: its session id for the transcript, what it
 * spent where the line says, and the answer, the structured output or the
 * object in the result text, unchecked (null where there is none). A run
 * that printed no result line throws; so does one the CLI marks an error,
 * carrying the session id, the spend, and the allowance it met as `limit`.
 *
 * @param {string} output
 * @returns {{ sessionId: string | null, usage?: Usage, answer: unknown }}
 */
export const cliResult = (output) => {
  /** @type {any} */
  let result = null;
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && parsed.type === 'result') {
        result = parsed;
        break;
      }
    } catch {
      // not this line
    }
  }
  if (result === null) throw new Error(`the CLI printed no answer: ${output.trim().slice(-500) || '(nothing)'}`);
  const sessionId = typeof result.session_id === 'string' ? result.session_id : null;
  const usage = usageOf(result);
  const reported = usage === null ? {} : { usage };
  if (result.is_error) {
    const text = String(result.result ?? result.subtype);
    const limit = usageLimit(text);
    throw Object.assign(new Error(`the CLI's run failed: ${text.slice(0, 500)}`), { sessionId, ...reported, ...(limit === null ? {} : { limit }) });
  }
  return { sessionId, ...reported, answer: result.structured_output ?? objectIn(String(result.result ?? '')) };
};
