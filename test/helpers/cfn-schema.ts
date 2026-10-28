import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// The CloudFormation YAML schema and template shapes, apart from the
// readers: the repo model (repo-model.ts) parses with these, and cfn.ts reads
// through the model, so neither imports the other. Callers import cfn.ts.
// ---------------------------------------------------------------------------

/**
 * CFN pseudo-parameter substitutions applied inside `!Sub` bodies, keyed by
 * the bare parameter name (e.g. `'AWS::AccountId'`). Each `${<key>}` in a
 * `!Sub` template is replaced by its value so the parsed string approximates
 * what CloudFormation sends after intrinsic resolution. Callers register only
 * the substitutions their assertions depend on; anything left out stays a
 * literal `${...}` token, which is a safe over-approximation for the length
 * and glob checks these tests run.
 */
export type Substitutions = Record<string, string>;

/**
 * Build a js-yaml schema that tolerates the CloudFormation intrinsic tags that
 * appear across our templates. Standard YAML rejects `!Sub`/`!Ref`/`!GetAtt`,
 * so every template test needs this just to load the document.
 *
 * - `!Ref X` / `!GetAtt X` / `!GetAtt [A, B]` collapse to a `${X}` / `${A.B}`
 *   placeholder — enough for the parse to succeed; the resolved value never
 *   affects a measured size or a matched glob.
 * - `!Sub` (scalar and single-element sequence form) applies `substitutions`.
 *   The map form (`!Sub [tpl, {vars}]`) throws loud rather than silently
 *   leaving its custom `${Key}`s unresolved — no template uses it today, and a
 *   future one that does must register its keys here deliberately.
 * - `!Join` concatenates its list under the given delimiter. Elements — and the
 *   delimiter — that are themselves unresolved intrinsics have already become
 *   their `${X}` placeholders by the time they reach here and join like any
 *   other string, so the result stays faithful about the literal parts and
 *   honest about the rest. Only a list that is not a list (an intrinsic
 *   standing in for the whole operand) collapses to `${Join}`.
 * - `!Split` / `!Select` resolve for real when their operands are literals
 *   (`!Select [2, !Split ['/', 'https://host/path']]` → `'host'`), and collapse
 *   to a placeholder when an operand is itself an unresolved intrinsic — which
 *   is the common case, since they mostly destructure `!GetAtt` outputs.
 * - `!If [Cond, a, b]` collapses to a `${If:Cond}` placeholder rather than
 *   silently picking a branch. Which branch applies is stage-dependent (our
 *   conditions gate prod-only resources), so resolving one here would let two
 *   tests read the same template as different shapes — the drift this module
 *   exists to prevent. A test that needs a branch must resolve it deliberately.
 */
export function makeCfnSchema(substitutions: Substitutions = {}): yaml.Schema {
  const applySubstitutions = (tpl: string): string => {
    let out = tpl;
    for (const [name, value] of Object.entries(substitutions)) {
      out = out.split(`\${${name}}`).join(value);
    }
    return out;
  };

  const constructSub = (data: unknown[]): string => {
    if (data.length > 1) {
      throw new Error(
        '!Sub with a substitution map is not supported by the shared CFN test schema — ' +
          'add the map’s keys to the substitutions passed to makeCfnSchema()/loadTemplate() ' +
          '(test/helpers/cfn.ts).',
      );
    }
    return applySubstitutions(data[0] as string);
  };

  /** `!Split [delimiter, source]` — a real split when both operands are literal. */
  const constructSplit = (data: unknown[]): string[] => {
    const [delimiter, source] = data as [unknown, unknown];
    return typeof delimiter === 'string' && typeof source === 'string'
      ? source.split(delimiter)
      : ['${Split}'];
  };

  /** `!Select [index, list]` — the element when the list is already resolved. */
  const constructSelect = (data: unknown[]): unknown => {
    const [index, list] = data as [unknown, unknown];
    const position = Number(index);
    return Array.isArray(list) && Number.isInteger(position) && position in list
      ? list[position]
      : '${Select}';
  };

  const constructJoin = (data: unknown[]): string => {
    const [delimiter, list] = data as [unknown, unknown];
    if (typeof delimiter !== 'string' || !Array.isArray(list)) return '${Join}';
    // Every tag handler above yields a string, so a non-string element here is
    // a JSON-form intrinsic (`{Fn::GetAtt: …}`) that no handler touched.
    // `String()` would render it "[object Object]" and quietly corrupt the
    // joined value; a placeholder says so instead.
    return list.map((item) => (typeof item === 'string' ? item : '${Join:element}')).join(delimiter);
  };

  return yaml.DEFAULT_SCHEMA.extend([
    new yaml.Type('!Sub', { kind: 'scalar', construct: (d: string) => applySubstitutions(d) }),
    new yaml.Type('!Sub', { kind: 'sequence', construct: constructSub }),
    new yaml.Type('!Ref', { kind: 'scalar', construct: (d: string) => `\${${d}}` }),
    new yaml.Type('!GetAtt', { kind: 'scalar', construct: (d: string) => `\${${d}}` }),
    new yaml.Type('!GetAtt', {
      kind: 'sequence',
      construct: (d: unknown[]) => `\${${(d as string[]).join('.')}}`,
    }),
    new yaml.Type('!Split', { kind: 'sequence', construct: constructSplit }),
    new yaml.Type('!Select', { kind: 'sequence', construct: constructSelect }),
    new yaml.Type('!Join', { kind: 'sequence', construct: constructJoin }),
    new yaml.Type('!If', {
      kind: 'sequence',
      construct: (d: unknown[]) => `\${If:${String((d as unknown[])[0])}}`,
    }),
    // Condition functions, as they appear in a `Conditions:` block. Like
    // `!If` above these resolve to a placeholder rather than a real boolean —
    // the tests read resource *shape*, and a condition's truth depends on
    // stack parameters that only exist at deploy time. Modelled so that a
    // template using them parses at all (js-yaml rejects an unknown tag
    // outright, failing every assertion in the file, not just condition ones).
    new yaml.Type('!Equals', {
      kind: 'sequence',
      construct: (d: unknown[]) => `\${Equals:${(d as unknown[]).map(String).join(',')}}`,
    }),
    new yaml.Type('!Not', {
      kind: 'sequence',
      construct: (d: unknown[]) => `\${Not:${String((d as unknown[])[0])}}`,
    }),
  ]);
}

// --- Shared template shape ---------------------------------------------------
// These are deliberately permissive *views* onto `yaml.load(...) as Template`,
// not exhaustive CFN schemas. `Properties` is an open bag because different
// tests read different resource attributes (BucketName, AlarmDescription, …).

export type Statement = {
  Effect?: string;
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

export type PolicyDocument = { Statement?: Statement[] };

export type InlinePolicy = { PolicyName: string; PolicyDocument: PolicyDocument };

export type ResourceProps = Record<string, any> & {
  PolicyDocument?: PolicyDocument;
  Policies?: InlinePolicy[];
};

export type Resource = {
  Type: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  /** A single logical id, or the list form when a resource depends on several. */
  DependsOn?: string | string[];
  /**
   * The condition gating this resource, for the same reason `TemplateOutput`
   * carries one: whether an optional feature's resource is created on a stage
   * that lacks its configuration is an assertion, not a detail.
   */
  Condition?: string;
  Properties?: ResourceProps;
};

/**
 * A template output. `Condition` matters to assertions: an output guarded by
 * the same condition as the resource it exports is the difference between an
 * optional feature and a template that fails to deploy without it.
 */
export type TemplateOutput = {
  Description?: string;
  Value?: unknown;
  Condition?: string;
  Export?: { Name?: unknown };
};

/**
 * A template parameter. `Default` is the value an apply that passes no
 * override gets — and `aws cloudformation deploy` RESETS any parameter it is
 * not given, so a parameter's default is what a careless apply actually
 * deploys. That makes it worth asserting on, rather than re-parsing the raw
 * YAML with a regex per test.
 */
export type TemplateParameter = {
  Type?: string;
  Default?: unknown;
  Description?: string;
  AllowedValues?: unknown[];
  MinValue?: number;
  MaxValue?: number;
};

export type Template = {
  Parameters?: Record<string, TemplateParameter>;
  Resources: Record<string, Resource>;
  Outputs?: Record<string, TemplateOutput>;
  Conditions?: Record<string, unknown>;
};

/** Every `[logicalId, resource]` pair of a given `Type` in a template. */
export function resourcesOfType(tpl: Template, type: string): Array<[string, Resource]> {
  return Object.entries(tpl.Resources ?? {}).filter(([, r]) => r.Type === type);
}
