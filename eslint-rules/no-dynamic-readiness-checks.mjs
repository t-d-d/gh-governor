/**
 * Only scripts/lib/ready-work.mjs combines the readiness checks
 * (docs/constraints/dispatcher-repos.md). `no-restricted-imports` refuses a
 * static import of a check, but reads no names from `import()`, so this rule
 * covers the dynamic form.
 *
 * It reads the names an `import()` of ready-work.mjs takes: a destructure of
 * the awaited module, a property read off it, or the first parameter of a
 * `then()` callback. A name in `checks` other than `allowed` is refused.
 * Where the names cannot be read, such as a module kept whole in a variable
 * or a rest element, the import is refused too, since it could reach any
 * check. Such a caller destructures the names it needs instead. An
 * `import()` whose path is not a plain string is not seen.
 *
 * Armed over dispatch/ and scripts/ in eslint.config.js, beside the static
 * rule, with the same checks and the same two kept callers.
 */

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */
/** @typedef {import('estree').Node} Node */
/** @typedef {import('estree').Pattern} Pattern */

const TARGET = /(^|\/)ready-work\.mjs$/;

/** @param {Node} source */
const sourceText = (source) => {
  if (source.type === 'Literal' && typeof source.value === 'string') return source.value;
  if (source.type === 'TemplateLiteral' && source.expressions.length === 0) return source.quasis[0]?.value.cooked ?? undefined;
  return undefined;
};

/**
 * The names an object pattern takes, or undefined when it may take any.
 * @param {Pattern} pattern
 * @returns {string[] | undefined}
 */
const patternNames = (pattern) => {
  if (pattern.type !== 'ObjectPattern') return undefined;
  /** @type {string[]} */
  const names = [];
  for (const p of pattern.properties) {
    if (p.type !== 'Property') return undefined;
    if (!p.computed && p.key.type === 'Identifier') names.push(p.key.name);
    else if (p.key.type === 'Literal' && typeof p.key.value === 'string') names.push(p.key.value);
    else return undefined;
  }
  return names;
};

/**
 * The names read off the awaited module `node`, or undefined when unreadable.
 * @param {Node & { parent?: Node }} node
 * @returns {string[] | undefined}
 */
const namesReadOff = (node) => {
  const { parent } = node;
  if (parent?.type === 'VariableDeclarator' && parent.init === node) return patternNames(parent.id);
  if (parent?.type === 'AssignmentExpression' && parent.right === node) return patternNames(parent.left);
  if (parent?.type === 'MemberExpression' && parent.object === node) {
    if (!parent.computed && parent.property.type === 'Identifier') return [parent.property.name];
    if (parent.property.type === 'Literal' && typeof parent.property.value === 'string') return [parent.property.value];
  }
  return undefined;
};

/**
 * The names an `import()` takes, or undefined when unreadable.
 * @param {Node & { parent?: Node }} node
 * @returns {string[] | undefined}
 */
const namesTaken = (node) => {
  /** @type {(Node & { parent?: Node }) | undefined} */
  const parent = node.parent;
  if (parent?.type === 'AwaitExpression') return namesReadOff(parent);
  if (
    parent?.type === 'MemberExpression'
    && parent.object === node
    && !parent.computed
    && parent.property.type === 'Identifier'
    && parent.property.name === 'then'
  ) {
    /** @type {Node | undefined} */
    const call = /** @type {Node & { parent?: Node }} */ (parent).parent;
    if (call?.type !== 'CallExpression' || call.callee !== parent) return undefined;
    const [callback] = call.arguments;
    if (callback?.type !== 'ArrowFunctionExpression' && callback?.type !== 'FunctionExpression') return undefined;
    const [param] = callback.params;
    return param === undefined ? [] : patternNames(param);
  }
  return undefined;
};

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'An import() of ready-work.mjs takes no readiness check outside the file that combines them.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          checks: { type: 'array', items: { type: 'string' } },
          allowed: { type: 'string' },
        },
        required: ['checks'],
        additionalProperties: false,
      },
    ],
    messages: {
      refused:
        '`{{name}}` taken from ready-work.mjs with import(). Ask ticketStatus, mayPickUp or mayStartSpec '
        + 'in scripts/lib/ready-work.mjs instead of combining the readiness checks here.',
      unreadable:
        'An import() of ready-work.mjs whose names lint cannot read, so it could reach a readiness check. '
        + 'Destructure the names it needs, and ask ticketStatus, mayPickUp or mayStartSpec for readiness.',
    },
  },
  create(context) {
    const { checks, allowed } = /** @type {{ checks: string[], allowed?: string }} */ (context.options[0] ?? { checks: [] });
    const refused = new Set(checks.filter((name) => name !== allowed));
    return {
      ImportExpression(node) {
        const path = sourceText(node.source);
        if (path === undefined || !TARGET.test(path)) return;
        const names = namesTaken(node);
        if (names === undefined) {
          context.report({ node, messageId: 'unreadable' });
          return;
        }
        for (const name of names) {
          if (refused.has(name)) context.report({ node, messageId: 'refused', data: { name } });
        }
      },
    };
  },
};

export default rule;
