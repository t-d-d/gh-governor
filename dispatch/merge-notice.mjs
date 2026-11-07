/**
 * What a session told its PR merged hears about the deploys to come.
 *
 * The receiver builds the merge's message from the payload, and cannot read
 * the repo's file or workflows, so its text says nothing of deploys. The
 * task reads the repo's switches: where `deployMessages` is off, no deploy
 * message will come, and the merge asks the session to sign off as a close
 * does. Where it is on, the message names the repo's own deploy targets,
 * the `deployed:` labels its shipping jobs earn (`shippingLabelsOf`,
 * dispatch/labels.mjs), read from its workflows at the merge, and says the
 * session is told as each deploy finishes (docs/constraints/dispatcher-workflows.md).
 */

import { shippingLabelsOf } from './labels.mjs';
import { LABEL_PREFIX } from './webhook/fire.mjs';

/**
 * @typedef {{
 *   workflowFiles: (ref: string) => Promise<string[]>,
 *   fileAt: (path: string, ref: string) => Promise<string>,
 * }} WorkflowReader
 */

/**
 * The repo's deploy targets: the target of each shipping job in its
 * workflow files at `ref`, each once, in the order the files and their jobs
 * list them. A job that calls a reusable workflow names the called file's
 * jobs, with its inputs put in. A read that fails throws, so a list read
 * short never names the wrong targets.
 *
 * @param {WorkflowReader} reader
 * @param {string} ref
 * @returns {Promise<string[]>}
 */
export const deployTargets = async (reader, ref) => {
  /** @param {string} file */
  const read = (file) => reader.fileAt(`.github/workflows/${file}`, ref);
  /** @type {string[]} */
  const targets = [];
  for (const file of await reader.workflowFiles(ref)) {
    for (const label of await shippingLabelsOf(await read(file), read)) {
      const target = label.slice(LABEL_PREFIX.length);
      if (!targets.includes(target)) targets.push(target);
    }
  }
  return targets;
};

/** `a`, `a and b`, `a, b and c`. @param {readonly string[]} items */
const listed = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The paragraph a merge's message gains in a repo with deploy messages on.
 * `targets`: the repo's deploy targets, or null where governor could not
 * read them; none read names none.
 *
 * @param {{ deployedLabels: boolean, targets: readonly string[] | null }} options
 * @returns {string}
 */
export const deployNote = ({ deployedLabels, targets }) => {
  const known = targets ?? [];
  if (deployedLabels) {
    const labels = known.length === 0 ? '' : ` ${listed(known.map((t) => `\`${LABEL_PREFIX}${t}\``))}`;
    return `As its change deploys, governor labels the tickets it closes${labels}, and tells you as each label is applied.`;
  }
  if (known.length === 0) return 'Governor tells you as each deploy of its change finishes.';
  return `Its change deploys to ${listed(known)}, and governor tells you as each deploy finishes.`;
};
