/**
 * What a task keeps in its memory from one turn to the next
 * (dispatch/lane.mjs runs a burst of fires as turns in one process): each
 * repo's installation token, and each config and prompt file with the ETag
 * GitHub answered for it.
 *
 * Nothing here decides a turn. Every turn still asks GitHub for each file,
 * sending the ETag held (scripts/lib/github-app.mjs `configFile`): a 304
 * means the held text is the file, and a 200 replaces it. A token is used
 * until it is close to its expiry or GitHub refuses it. The memory dies with
 * the task: nothing is written to the state table, and a new task starts
 * with nothing held.
 */

/**
 * A kept token with this long or less left to run is minted again. It
 * outlasts a turn's deadline (dispatch/cli.mjs `DEADLINE_MS`), so a turn
 * never runs past the token it took at its start.
 */
export const TOKEN_LEFT_MS = 20 * 60 * 1000;

/**
 * @typedef {{ token: string, expiresAt: number }} Grant An installation
 *   token and when it expires, in ms.
 * @typedef {() => Promise<Grant>} Mint
 * @typedef {{ etag: string, text: string }} HeldFile
 */

/**
 * A task's memory.
 *
 * @param {{ now: () => number }} clock
 */
export const taskMemory = ({ now }) => {
  /** Each repo's token, as minted, or being minted. @type {Map<string, Promise<Grant>>} */
  const tokens = new Map();
  /** Each file by repo and path. @type {Map<string, HeldFile>} */
  const files = new Map();
  /** @param {string} repo @param {string} path */
  const fileKey = (repo, path) => `${repo}\n${path}`;

  /**
   * A new token for the repo, kept once minted. A mint that fails is not
   * kept, so the next ask mints again.
   *
   * @param {string} repo
   * @param {Mint} mint
   */
  const minted = (repo, mint) => {
    const grant = mint();
    tokens.set(repo, grant);
    grant.catch(() => {
      if (tokens.get(repo) === grant) tokens.delete(repo);
    });
    return grant;
  };

  /**
   * The repo's kept grant, when it has more than TOKEN_LEFT_MS still to run.
   *
   * @param {string} repo
   * @returns {Promise<Grant | null>}
   */
  const usable = async (repo) => {
    const held = tokens.get(repo);
    if (held === undefined) return null;
    const grant = await held.catch(() => null);
    return grant !== null && grant.expiresAt - now() > TOKEN_LEFT_MS ? grant : null;
  };

  return {
    /**
     * The repo's token: the one kept, or a new one where none is kept or the
     * one kept is close to its expiry.
     *
     * @param {string} repo
     * @param {Mint} mint
     * @returns {Promise<string>}
     */
    token: async (repo, mint) => (await usable(repo) ?? await minted(repo, mint)).token,

    /**
     * A token for the repo in place of `stale`, which GitHub refused. Where
     * another client already renewed it, the kept one; else a new one.
     *
     * @param {string} repo
     * @param {string} stale
     * @param {Mint} mint
     * @returns {Promise<string>}
     */
    renew: async (repo, stale, mint) => {
      const kept = await usable(repo);
      if (kept !== null && kept.token !== stale) return kept.token;
      return (await minted(repo, mint)).token;
    },

    /**
     * The file the task holds for the repo and path, if any.
     *
     * @param {string} repo
     * @param {string} path
     * @returns {HeldFile | undefined}
     */
    held: (repo, path) => files.get(fileKey(repo, path)),

    /**
     * Keep the text and ETag GitHub answered for the repo and path.
     *
     * @param {string} repo
     * @param {string} path
     * @param {HeldFile} file
     */
    keep: (repo, path, file) => {
      files.set(fileKey(repo, path), file);
    },
  };
};

/** @typedef {ReturnType<typeof taskMemory>} TaskMemory */
