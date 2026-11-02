/**
 * Only scripts/lib/ready-work.mjs combines the readiness checks
 * (docs/constraints/dispatcher-repos.md). This rule refuses a check taken
 * from ready-work.mjs by any import form, so the checks, the kept callers and
 * the message live in one rule rather than two that could disagree.
 *
 * A static import or an export-from names what it takes. A namespace import,
 * `export *` or `export * as` could reach any check, so it is refused. An
 * import kept only for its side effects takes nothing.
 *
 * For `import()` it reads the names taken: a destructure of
 * the awaited module, a property read off it, or the first parameter of a
 * `then()` callback. A name in `checks` other than `allowed` is refused.
 * Where the names cannot be read, such as a module kept whole in a variable
 * or a rest element, the import is refused too, since it could reach any
 * check. Such a caller destructures the names it needs instead. A `then()`
 * callback written as a `function` that reads `arguments` could take any
 * check that way, so it is refused too. An `import()` whose path is not a
 * plain string is not seen.
 *
 * A call that names ready-work.mjs as its first argument is refused
 * whatever it takes, even in a kept caller. That is `require`, or a
 * `createRequire` result under any name, which loads ESM on some Node
 * versions. No caller needs one, since an import names what it takes.
 *
 * Armed over dispatch/ and scripts/ in eslint.config.js, with each of the
 * two kept callers allowed its one check.
 */

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */
/** @typedef {import('estree').Node} Node */
/** @typedef {import('estree').Pattern} Pattern */
/** @typedef {import('estree').Identifier | import('estree').Literal} ModuleName */

// A query or fragment on the specifier still loads the same module.
const TARGET = /(^|\/)ready-work\.mjs([?#].*)?$/s;

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
 * @param {(fn: import('estree').FunctionExpression) => boolean} readsArguments whether a function reads its `arguments`
 * @returns {string[] | undefined}
 */
const namesTaken = (node, readsArguments) => {
  /** @type {(Node & { parent?: Node }) | undefined} */
  const parent = node.parent;
  // An import() kept only for its side effects takes no name.
  if (parent?.type === 'ExpressionStatement') return [];
  if (parent?.type === 'AwaitExpression') {
    if (parent.parent?.type === 'ExpressionStatement') return [];
    return namesReadOff(parent);
  }
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
    if (callback.type === 'FunctionExpression' && readsArguments(callback)) return undefined;
    const [param] = callback.params;
    return param === undefined ? [] : patternNames(param);
  }
  return undefined;
};

/** @param {ModuleName} name */
const moduleName = (name) => (name.type === 'Identifier' ? name.name : String(name.value));

/**
 * The names a static import or export-from takes, or undefined when it may
 * take any.
 * @param {import('estree').ImportDeclaration | import('estree').ExportNamedDeclaration | import('estree').ExportAllDeclaration} node
 * @returns {string[] | undefined}
 */
const staticNames = (node) => {
  if (node.type === 'ExportAllDeclaration') return undefined;
  /** @type {string[]} */
  const names = [];
  for (const s of node.specifiers) {
    if (s.type === 'ImportNamespaceSpecifier') return undefined;
    if (s.type === 'ImportDefaultSpecifier') names.push('default');
    else if (s.type === 'ImportSpecifier') names.push(moduleName(s.imported));
    else names.push(moduleName(/** @type {ModuleName} */ (s.local)));
  }
  return names;
};

/** @type {RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'No import of ready-work.mjs takes a readiness check outside the file that combines them.',
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
        '`{{name}}` taken from ready-work.mjs. Ask ticketStatus, mayPickUp or mayStartSpec '
        + 'in scripts/lib/ready-work.mjs instead of combining the readiness checks here.',
      required:
        'ready-work.mjs loaded by a call such as require. Import the exports it needs, '
        + 'and ask ticketStatus, mayPickUp or mayStartSpec for readiness.',
      unreadable:
        'An import of ready-work.mjs whose names lint cannot read, so it could reach a readiness check. '
        + 'Name the exports it needs, and ask ticketStatus, mayPickUp or mayStartSpec for readiness.',
    },
  },
  create(context) {
    const { checks, allowed } = /** @type {{ checks: string[], allowed?: string }} */ (context.options[0] ?? { checks: [] });
    const refused = new Set(checks.filter((name) => name !== allowed));
    // Scope analysis counts a read from an arrow inside the function, and
    // not a property that happens to be named `arguments`.
    /** @param {import('estree').FunctionExpression} fn */
    const readsArguments = (fn) => (context.sourceCode.getScope(fn).set.get('arguments')?.references.length ?? 0) > 0;
    /**
     * @param {Node} node
     * @param {string[] | undefined} names
     */
    const judge = (node, names) => {
      if (names === undefined) {
        context.report({ node, messageId: 'unreadable' });
        return;
      }
      for (const name of names) {
        if (refused.has(name)) context.report({ node, messageId: 'refused', data: { name } });
      }
    };
    /** @param {Node | null | undefined} source */
    const targets = (source) => {
      const path = source ? sourceText(source) : undefined;
      return path !== undefined && TARGET.test(path);
    };
    return {
      ImportDeclaration(node) {
        if (targets(node.source)) judge(node, staticNames(node));
      },
      ExportNamedDeclaration(node) {
        if (targets(node.source)) judge(node, staticNames(node));
      },
      ExportAllDeclaration(node) {
        if (targets(node.source)) judge(node, staticNames(node));
      },
      ImportExpression(node) {
        if (targets(node.source)) judge(node, namesTaken(node, readsArguments));
      },
      CallExpression(node) {
        const [first] = node.arguments;
        if (first !== undefined && first.type !== 'SpreadElement' && targets(first)) {
          context.report({ node, messageId: 'required' });
        }
      },
    };
  },
};

export default rule;
