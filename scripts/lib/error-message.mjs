/**
 * The text of whatever a `catch` bound. A catch binding is `unknown`, so this
 * is the one place it is narrowed; the ticket scripts share it.
 *
 * @param {unknown} error
 */
export const messageOf = (error) => (error instanceof Error ? error.message : String(error));
