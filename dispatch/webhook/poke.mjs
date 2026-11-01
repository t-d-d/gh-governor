/**
 * The receiver's call to the starter once a request has queued its fires
 * (dispatch/webhook/starter.mjs), so the task starts in seconds rather than
 * at the backstop's next minute. One call a request, however many fires it
 * queued: the starter only needs to hear that one waits.
 *
 * A call that failed is logged at error, and the request still answers as
 * it would have: the fire is on the lane, and the backstop starts it within
 * a minute. Turns that queue fires do not call it: the running task takes
 * those itself.
 *
 * Pure: handler.mjs binds the invoke.
 */

/**
 * @template {{ enqueue: (message: any, dedupId?: string) => Promise<string>, log: (event: string, context?: Record<string, unknown>) => void }} D
 * @param {D} base
 * @param {(payload: { caller: 'receiver', messageIds: string[] }) => Promise<void>} invoke
 * @returns {{ deps: D, poke: () => Promise<void> }}
 */
export const poking = (base, invoke) => {
  /** @type {string[]} */
  const queued = [];
  return {
    deps: {
      ...base,
      enqueue: async (message, dedupId) => {
        const id = await base.enqueue(message, dedupId);
        queued.push(id);
        return id;
      },
    },
    poke: async () => {
      if (queued.length === 0) return;
      try {
        await invoke({ caller: 'receiver', messageIds: queued });
      } catch (error) {
        base.log('starter-poke-failed', { level: 'error', messageIds: queued, error: String(/** @type {any} */ (error)?.message ?? error) });
      }
    },
  };
};
