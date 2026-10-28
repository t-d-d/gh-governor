import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Whether a module is the process entry point — the one guard every `scripts/`
 * CLI puts between its exports and its `main()`.
 *
 * ## Why it is shared rather than copied
 *
 * The guard's failure mode is silence. A miss does not throw and does not
 * print: `main()` simply never runs and the process leaves with whatever exit
 * code it started with, which is 0. Every caller reads that 0 as the good
 * answer — `operator-drain-check` as "drained, safe to remove the
 * compatibility branch", the nightly sweep as "nothing leaked", a generator's
 * `--check` as "the committed file is current". So a guard that misses is not
 * merely broken, it is confidently wrong, and it is wrong in the direction
 * nobody investigates.
 *
 * That is the whole reason this is one function. Two copies of a false-green
 * guard are two chances to fix only one of them, which is exactly what
 * happened once: a verbatim copy was fixed for symlinks and the original was
 * not.
 *
 * ## Why neither comparison is a string compare
 *
 * `import.meta.url` and `process.argv[1]` describe the same file in two
 * spellings, and node produces both differently:
 *
 *   - `pathToFileURL` rather than `file://` + the path, because the URL
 *     percent-encodes and the argv path does not: a checkout under a path with
 *     a space fails the naive compare.
 *   - `realpathSync` as the second try, because node resolves the MAIN
 *     module's symlinks before building `import.meta.url` and leaves
 *     `process.argv[1]` the spelling it was handed: a workspace reached
 *     through a link — a runner whose checkout is linked elsewhere, a macOS
 *     `/tmp` — disagrees with itself otherwise.
 *
 * Both tries are exact. There is no basename fallback: `argv1.endsWith('/x.mjs')`
 * answers "some file called that" rather than "this file", so it says yes to a
 * same-named script anywhere on disk — a looser answer in a guard whose wrong
 * answers are already invisible.
 *
 * Unit-tested in `test/scripts/cli-entry.test.ts`.
 *
 * @param {string} moduleUrl `import.meta.url` of the module asking.
 * @param {string | undefined} argv1 `process.argv[1]`, absent when node was
 *   given no script at all (`node -e`, a REPL) — never the entry point.
 * @returns {boolean}
 */
export const isCliEntry = (moduleUrl, argv1) => {
  if (argv1 === undefined) return false;
  try {
    if (moduleUrl === pathToFileURL(argv1).href) return true;
    // `realpathSync` throws on a path that does not exist, which is not a
    // question this guard answers: an argv path we cannot resolve is not this
    // module, and the catch below is what says so.
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
};
