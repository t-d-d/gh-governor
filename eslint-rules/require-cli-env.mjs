/**
 * Every `claude` CLI call the dispatcher task spawns takes its environment
 * from `cliEnv` (dispatch/turn.mjs), which names the stored login's org as
 * CLAUDE_CODE_ORGANIZATION_UUID.
 *
 * Without it the CLI finds the org with a profile fetch on every cloud call,
 * and when that fetch fails it prints `Unable to get organization UUID` and
 * drops the cause. A spawn that builds its own environment works on every
 * day the fetch does, so the miss shows only on the day it does not.
 *
 * A spawn (`spawn`, `spawnSync`, `execFile`, `execFileSync`, bare or off a
 * namespace) is a CLI call when its program is `claude`, or when its argument
 * list calls `launcherPath()`: the pseudo-terminal launcher runs the CLI and
 * hands it the environment it was given.
 *
 * A property of every call site, so an eslint rule rather than a test. Armed
 * over `dispatch/**` in eslint.config.js.
 */

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */
/** @typedef {import('estree').Node} Node */

/** The child_process calls that take (file, args, options). */
const SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);

/** @param {Node | undefined} node */
const isCliProgram = (node) => node?.type === 'Literal' && node.value === 'claude';

/** @param {Node | undefined} node */
const callsLauncher = (node) =>
  node?.type === 'ArrayExpression'
  && node.elements.some(
    (el) => el?.type === 'CallExpression' && el.callee.type === 'Identifier' && el.callee.name === 'launcherPath',
  );

/** @param {Node | undefined} options */
const envFromCliEnv = (options) => {
  if (options?.type !== 'ObjectExpression') return false;
  return options.properties.some(
    (p) =>
      p.type === 'Property'
      && !p.computed
      && p.key.type === 'Identifier'
      && p.key.name === 'env'
      && p.value.type === 'CallExpression'
      && p.value.callee.type === 'Identifier'
      && p.value.callee.name === 'cliEnv',
  );
};

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'A CLI call the dispatcher spawns names the stored org through cliEnv.',
    },
    schema: [],
    messages: {
      noCliEnv:
        'A `claude` CLI call without `env: cliEnv(...)`. The CLI then looks the org up with a profile fetch '
        + 'on every cloud call, and reports that fetch’s failure only as `Unable to get organization UUID`.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        const name = callee.type === 'Identifier' ? callee.name
          : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' ? callee.property.name
            : undefined;
        if (name === undefined || !SPAWNERS.has(name)) return;
        const [program, argv, third] = /** @type {Node[]} */ (node.arguments);
        if (!isCliProgram(program) && !callsLauncher(argv)) return;
        // The argument list is optional, so the options may come second.
        const options = argv?.type === 'ObjectExpression' ? argv : third;
        if (envFromCliEnv(options)) return;
        context.report({ node, messageId: 'noCliEnv' });
      },
    };
  },
};

export default rule;
