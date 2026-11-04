/**
 * The config check (checker/config-check.mjs): the reusable workflow a
 * served repo calls on its pull requests, pinned to a commit of this repo,
 * to read the pull request's `.github/dispatch.json` and the prompt files it
 * names with governor's own `readConfig` and `resolveFiles`. It fails on a
 * file governor would refuse, and warns on one that is valid but cannot
 * work. It runs in the served repo, on that repo's own token, never in
 * governor.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { check, restReads, run } from '../checker/config-check.mjs';
import { HEARTBEAT_MARKER } from '../dispatch/heartbeat.mjs';
import { readConfig } from '../dispatch/repo-config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW_PATH = join(ROOT, '.github/workflows/config-check.yml');

/** Every file under `dir`, as a path from it. */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full).map((p) => `${name}/${p}`) : [name];
});

type Files = Record<string, string>;
type Reads = Parameters<typeof check>[0];

/**
 * The reads over an in-memory repo: its files at the pull request's head,
 * its labels and its issues' bodies.
 */
const reads = (files: Files, { labels = [] as string[], issues = {} as Record<number, string> } = {}): Reads => ({
  read: async (path) => files[path] ?? null,
  paths: async () => ({ paths: Object.keys(files), truncated: false }),
  labels: async () => labels,
  issueBody: async (n) => issues[n] ?? null,
});

/** A repo on disk, every file it holds at the head. */
const onDisk = (dir: string, more: Partial<Reads> = {}): Reads => ({
  read: async (path) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : null),
  paths: async () => ({ paths: walk(dir), truncated: false }),
  labels: async () => [],
  issueBody: async () => null,
  ...more,
});

const base = () => ({
  environment: 'my-env',
  labels: { ready: ['mode: afk'], claim: 'claimed' },
  features: { pickup: true },
});
const file = (config: unknown) => JSON.stringify(config, null, 2);

describe('the check fails on a file governor refuses', () => {
  test('a file that is not JSON gives readConfig\'s fault', async () => {
    const got = await check(reads({ '.github/dispatch.json': '{ nope' }));
    assert.equal(got.errors.length, 1);
    assert.match(String(got.errors[0]), /not JSON/);
  });

  test('a schema fault gives readConfig\'s text, a refine among them', async () => {
    const text = file({ ...base(), labels: { ready: ['mode: afk'], claim: 'mode: afk' } });
    const fault = readConfig(text);
    assert.ok(!fault.ok);
    const got = await check(reads({ '.github/dispatch.json': text }));
    assert.deepEqual(got.errors, [fault.fault]);
  });

  test('prReview on with no review section is refused', async () => {
    const got = await check(reads({ '.github/dispatch.json': file({ ...base(), features: { prReview: true } }) }));
    assert.match(String(got.errors[0]), /prReview is on, so the file needs a review section/);
  });

  test('a prompt file that is missing, empty, or names a fact its kind lacks gives resolveFiles\'s fault', async () => {
    const config = { ...base(), prompts: { signOff: { file: 'prompts/sign-off.md' }, ciBreaker: { file: 'prompts/ci.md' } }, periodics: [{ name: 'Weekly', prompt: { file: 'prompts/weekly.md' }, days: 7 }] };
    const got = await check(reads({
      '.github/dispatch.json': file(config),
      'prompts/sign-off.md': 'Sign off on {pr}.',
      'prompts/ci.md': '---\nname: ci\n---\n',
    }));
    assert.equal(got.errors.length, 1);
    const fault = String(got.errors[0]);
    assert.match(fault, /prompts\.signOff: signOff has no fact \{pr\}/);
    assert.match(fault, /prompts\.ciBreaker: prompts\/ci\.md is empty/);
    assert.match(fault, /periodics\.Weekly\.prompt: prompts\/weekly\.md is not on the default branch/);
  });

  test('a pull request that deletes the file warns that governor stops serving the repo, and fails nothing', async () => {
    const got = await check(reads({}));
    assert.deepEqual(got.errors, []);
    assert.match(String(got.warnings[0]), /no \.github\/dispatch\.json, so governor will not serve this repo/);
  });

  test('a read that fails throws rather than reading as a missing file', async () => {
    await assert.rejects(check({ ...reads({}), read: async () => { throw new Error('HTTP 500'); } }), /HTTP 500/);
  });
});

describe('the check passes the files governor ships', () => {
  test('the factory fixture\'s file and its checklist file', async () => {
    const got = await check(onDisk(join(ROOT, 'test/fixtures/factory')));
    assert.deepEqual(got.errors, []);
  });

  test('the starter kit\'s file', async () => {
    const got = await check(onDisk(join(ROOT, 'examples/starter'), {
      labels: async () => ['mode: afk', 'claimed'],
      issueBody: async () => `Governor records its fires here.\n\n${HEARTBEAT_MARKER}\n`,
    }));
    assert.deepEqual(got, { errors: [], templates: [], warnings: [] });
  });
});

describe('the check warns, without failing, on a valid file that cannot work', () => {
  const full = () => ({
    ...base(),
    labels: { ready: ['mode: afk', 'ready'], claim: 'claimed' },
    features: { pickup: true, heartbeat: true, prReview: true, ciMessages: true },
    heartbeat: { issue: 7 },
    workflows: { ci: '.github/workflows/ci.yml' },
    review: {
      checklist: 'Review it.',
      humanOnly: [{ glob: 'infra/**', reason: 'the stack' }, { glob: '/CLAUDE.md', reason: 'the instructions' }],
      quote: ['docs/constraints/*.md', '!docs/constraints/README.md'],
    },
  });
  const tree = (config: unknown): Files => ({
    '.github/dispatch.json': file(config),
    '.github/workflows/ci.yml': 'name: ci\n',
    'infra/stack.yml': '',
    'CLAUDE.md': '',
    'docs/constraints/README.md': '',
    'docs/constraints/repos.md': '',
  });
  const good = { labels: ['Mode: AFK', 'ready'], issues: { 7: `Fires.\n\n${HEARTBEAT_MARKER}\n` } };

  test('a file whose every name resolves warns of nothing', async () => {
    assert.deepEqual(await check(reads(tree(full()), good)), { errors: [], templates: [], warnings: [] });
  });

  test('a ready label the repo lacks', async () => {
    const got = await check(reads(tree(full()), { ...good, labels: ['mode: afk'] }));
    assert.deepEqual(got.errors, []);
    assert.deepEqual(got.warnings, ['labels.ready: the repo has no label "ready", so no ticket can carry it and pickup finds nothing']);
  });

  test('a workflows.ci file that is not there', async () => {
    const files = tree(full());
    delete files['.github/workflows/ci.yml'];
    const got = await check(reads(files, good));
    assert.deepEqual(got.errors, []);
    assert.deepEqual(got.warnings, ['workflows.ci: .github/workflows/ci.yml is not in the repo, so no run counts as CI']);
  });

  test('a heartbeat issue without governor\'s marker, or not there', async () => {
    const without = await check(reads(tree(full()), { ...good, issues: { 7: 'A ticket.' } }));
    assert.deepEqual(without.errors, []);
    assert.deepEqual(without.warnings, [`heartbeat.issue: #7 does not carry ${HEARTBEAT_MARKER}, so governor writes nothing into it`]);
    const missing = await check(reads(tree(full()), { ...good, issues: {} }));
    assert.deepEqual(missing.warnings, ['heartbeat.issue: #7 is not an issue in the repo']);
  });

  test('the older heartbeat shape needs its own marker', async () => {
    const marker = '<!-- acme:heartbeat -->';
    const config = { ...full(), heartbeat: { issue: 7, marker } };
    assert.deepEqual((await check(reads(tree(config), { ...good, issues: { 7: `Fires.\n${marker}\n` } }))).warnings, []);
    assert.deepEqual((await check(reads(tree(config), good))).warnings, [`heartbeat.issue: #7 does not carry ${marker}, so governor writes nothing into it`]);
  });

  test('a humanOnly or quote glob that matches no path', async () => {
    const config = full();
    config.review.humanOnly.push({ glob: 'serverless/**', reason: 'gone' });
    config.review.quote.push('adr/*.md', '!adr/README.md');
    const got = await check(reads(tree(config), good));
    assert.deepEqual(got.errors, []);
    assert.deepEqual(got.warnings, [
      'review.humanOnly: serverless/** matches no path in the repo',
      'review.quote: adr/*.md matches no path in the repo',
      'review.quote: !adr/README.md matches no path in the repo',
    ]);
  });

  test('a tree too large for GitHub to list whole skips the globs, and says so', async () => {
    const got = await check({ ...reads(tree(full()), good), paths: async () => ({ paths: [], truncated: true }) });
    assert.deepEqual(got.warnings, [
      'review: the repo\'s tree is too large for GitHub to list whole, so the humanOnly and quote globs went unchecked',
      '.github/ISSUE_TEMPLATE: the repo\'s tree is too large for GitHub to list whole, so the template folder went unchecked for ready labels',
    ]);
  });

  test('a label or issue read the token may not make warns that it went unchecked', async () => {
    const refused = async () => { throw new Error('HTTP 403'); };
    const got = await check({ ...reads(tree(full()), good), labels: refused, issueBody: refused });
    assert.deepEqual(got.errors, []);
    assert.deepEqual(got.warnings, [
      'labels.ready: could not read the repo\'s labels, so the ready labels went unchecked: HTTP 403',
      'heartbeat.issue: could not read #7, so its marker went unchecked: HTTP 403',
    ]);
  });

  test('a heartbeat section the switch leaves off is not checked', async () => {
    const config = { ...full(), features: { ...full().features, heartbeat: false } };
    assert.deepEqual((await check(reads(tree(config), { ...good, issues: {} }))).warnings, []);
  });

  test('a file governor refuses still gets its warnings, and a missing prompt file too', async () => {
    const config = { ...full(), prompts: { signOff: { file: 'nope.md' } } };
    const got = await check(reads(tree(config), { ...good, labels: [] }));
    assert.equal(got.errors.length, 1);
    assert.equal(got.warnings.length, 2);
  });
});

/**
 * An issue template's `labels:` adds its labels whoever opens the issue, so
 * a template naming a ready label readies every ticket of its kind before
 * anyone has read it. The check fails such a template, whoever may open
 * issues, and whatever pickup's `by` says.
 */
describe('the check fails an issue template that names a ready label', () => {
  const config = file({ ...base(), labels: { ready: ['mode: afk', 'triaged'], claim: 'claimed' }, pickup: { by: ['OWNER'] } });
  const withTemplate = (path: string, text: string): Files => ({ '.github/dispatch.json': config, [path]: text });
  const form = (labels: string) => `name: Bug\ndescription: Report a bug\nlabels: ${labels}\nbody:\n  - type: textarea\n    attributes:\n      label: What happened\n`;
  const markdown = (labels: string) => `---\nname: Feature\nabout: Ask for a feature\nlabels: ${labels}\n---\n\nWhat do you want?\n`;

  test('an issue form, its labels a list or a comma-separated string, in any case', async () => {
    for (const labels of ['["type: bug", "Mode: AFK"]', '\n  - "type: bug"\n  - "mode: afk"', '"type: bug, mode: afk"']) {
      for (const path of ['.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/bug.yaml']) {
        const got = await check(reads(withTemplate(path, form(labels))));
        assert.deepEqual(got.errors, [], labels);
        assert.equal(got.templates.length, 1, `${path} ${labels}`);
        assert.equal(got.templates[0]?.file, path);
        assert.match(String(got.templates[0]?.fault), /"mode: afk"/i);
      }
    }
  });

  test('a Markdown template\'s front matter, its labels a list or a comma-separated string', async () => {
    for (const labels of ['"type: enhancement, triaged"', '["triaged"]', '\n  - triaged']) {
      const got = await check(reads(withTemplate('.github/ISSUE_TEMPLATE/feature.md', markdown(labels))));
      assert.deepEqual(got.templates.map((t) => t.file), ['.github/ISSUE_TEMPLATE/feature.md'], labels);
      assert.match(String(got.templates[0]?.fault), /"triaged"/);
    }
  });

  test('a single ISSUE_TEMPLATE.md at the root, in .github/ or in docs/', async () => {
    for (const path of ['ISSUE_TEMPLATE.md', '.github/ISSUE_TEMPLATE.md', 'docs/ISSUE_TEMPLATE.md', '.github/issue_template.md']) {
      const got = await check(reads(withTemplate(path, markdown('"mode: afk"'))));
      assert.deepEqual(got.templates.map((t) => t.file), [path], path);
    }
  });

  test('every ready label a template names is in its one fault, and each template has its own', async () => {
    const got = await check(reads({
      '.github/dispatch.json': config,
      '.github/ISSUE_TEMPLATE/a.yml': form('["mode: afk", triaged]'),
      '.github/ISSUE_TEMPLATE/b.md': markdown('triaged'),
    }));
    assert.deepEqual(got.templates.map((t) => t.file), ['.github/ISSUE_TEMPLATE/a.yml', '.github/ISSUE_TEMPLATE/b.md']);
    assert.match(String(got.templates[0]?.fault), /"mode: afk".*"triaged"/);
  });

  test('templates that name no ready label pass, and the template chooser\'s config is no template', async () => {
    const got = await check(reads({
      '.github/dispatch.json': config,
      '.github/ISSUE_TEMPLATE/bug.yml': form('[type: bug]'),
      '.github/ISSUE_TEMPLATE/feature.md': markdown('type: enhancement'),
      '.github/ISSUE_TEMPLATE/plain.md': 'No front matter.\n',
      '.github/ISSUE_TEMPLATE/config.yml': 'blank_issues_enabled: false\nlabels: [mode: afk]\n',
      'docs/ISSUE_TEMPLATE.md': markdown('question'),
      'docs/mode-afk.md': markdown('"mode: afk"'),
    }, { labels: ['mode: afk', 'triaged'] }));
    // This file's narrow pickup.by narrows the unset trust.auto, which the check notes.
    assert.deepEqual(got, { errors: [], templates: [], warnings: [], narrowed: ['trust.auto: the file leaves it unset, so governor narrows it to OWNER to fit inside pickup.by'] });
  });

  test('a labels line YAML cannot parse is still read as comma-separated labels', async () => {
    const got = await check(reads(withTemplate('.github/ISSUE_TEMPLATE/feature.md', markdown('type: enhancement, mode: afk'))));
    assert.deepEqual(got.templates.map((t) => t.file), ['.github/ISSUE_TEMPLATE/feature.md']);
    assert.match(String(got.templates[0]?.fault), /"mode: afk"/);
  });

  test('a template governor cannot parse, with no labels line it can read, warns that its labels went unchecked', async () => {
    const got = await check(reads(withTemplate('.github/ISSUE_TEMPLATE/bug.yml', 'name: [broken\n'), { labels: ['mode: afk', 'triaged'] }));
    assert.deepEqual(got.templates, []);
    assert.equal(got.warnings.length, 1);
    assert.match(String(got.warnings[0]), /^\.github\/ISSUE_TEMPLATE\/bug\.yml: .*unchecked/);
  });

  test('a tree too large to list whole warns that the template folder went unchecked, and still reads the single files', async () => {
    const got = await check({ ...reads(withTemplate('docs/ISSUE_TEMPLATE.md', markdown('"mode: afk"'))), paths: async () => ({ paths: [], truncated: true }) });
    assert.deepEqual(got.templates.map((t) => t.file), ['docs/ISSUE_TEMPLATE.md']);
    assert.ok(got.warnings.some((w) => /ISSUE_TEMPLATE.*unchecked/.test(w)), JSON.stringify(got.warnings));
  });

  test('an unquoted list item with a colon, which YAML reads as a one-pair mapping, still names its label', async () => {
    for (const labels of ['[type: bug, mode: afk]', '\n  - type: bug\n  - mode: afk']) {
      const got = await check(reads(withTemplate('.github/ISSUE_TEMPLATE/bug.yml', form(labels))));
      assert.deepEqual(got.templates.map((t) => t.file), ['.github/ISSUE_TEMPLATE/bug.yml'], labels);
      assert.match(String(got.templates[0]?.fault), /"mode: afk"/);
    }
  });

  test('a Markdown template saved with a byte order mark still has its front matter read', async () => {
    const got = await check(reads(withTemplate('.github/ISSUE_TEMPLATE/feature.md', `\uFEFF${markdown('"mode: afk"')}`)));
    assert.deepEqual(got.templates.map((t) => t.file), ['.github/ISSUE_TEMPLATE/feature.md']);
  });

  test('the repo\'s tree is listed once, for the globs and the templates both', async () => {
    let listed = 0;
    const files = withTemplate('.github/ISSUE_TEMPLATE/bug.yml', form('[triaged]'));
    const withReview = { ...files, '.github/dispatch.json': file({ ...base(), labels: { ready: ['mode: afk', 'triaged'], claim: 'claimed' }, review: { checklist: 'Check it.', humanOnly: [{ glob: '.github/**', reason: 'r' }] } }) };
    const got = await check({ ...reads(withReview), paths: async () => { listed += 1; return { paths: Object.keys(withReview), truncated: false }; } });
    assert.deepEqual(got.errors, []);
    assert.equal(got.templates.length, 1);
    assert.equal(listed, 1);
  });

  test('a template path with a comma or colon stays one annotation property', async () => {
    const lines: string[] = [];
    await run({
      env: { GITHUB_REPOSITORY: 'acme/factory', GITHUB_TOKEN: 'ghs_fake', CONFIG_CHECK_REF: 'a'.repeat(40) },
      reads: () => reads(withTemplate('.github/ISSUE_TEMPLATE/bug, crash: report.yml', form('["mode: afk"]'))),
      log: (line) => lines.push(line),
    });
    assert.ok(lines.some((l) => l.startsWith('::error file=.github/ISSUE_TEMPLATE/bug%2C crash%3A report.yml,title=')), lines.join('\n'));
  });

  test('the run fails, with an error annotation on the template', async () => {
    const lines: string[] = [];
    const code = await run({
      env: { GITHUB_REPOSITORY: 'acme/factory', GITHUB_TOKEN: 'ghs_fake', CONFIG_CHECK_REF: 'a'.repeat(40) },
      reads: () => reads(withTemplate('.github/ISSUE_TEMPLATE/bug.yml', form('["mode: afk"]'))),
      log: (line) => lines.push(line),
    });
    assert.equal(code, 1);
    assert.ok(lines.some((l) => /^::error file=\.github\/ISSUE_TEMPLATE\/bug\.yml,title=[^:]*ready label[^:]*::/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => l.startsWith('::error file=.github/dispatch.json')), lines.join('\n'));
  });
});

describe('the run on the runner', () => {
  const env = { GITHUB_REPOSITORY: 'acme/factory', GITHUB_TOKEN: 'ghs_fake', CONFIG_CHECK_REF: 'a'.repeat(40) };

  test('writes each fault as an error annotation on the file, each warning as a warning, and fails on an error', async () => {
    const lines: string[] = [];
    const code = await run({
      env,
      reads: () => ({ ...reads({ '.github/dispatch.json': '{ nope\n%' }) }),
      log: (line) => lines.push(line),
    });
    assert.equal(code, 1);
    const error = lines.find((l) => l.startsWith('::error '));
    assert.match(String(error), /^::error file=\.github\/dispatch\.json,title=governor would refuse this file once it merges::not JSON/);
    assert.doesNotMatch(String(error), /\n/);
  });

  test('passes with warnings, which never fail the run', async () => {
    const lines: string[] = [];
    const code = await run({ env, reads: () => reads({}), log: (line) => lines.push(line) });
    assert.equal(code, 0);
    assert.ok(lines.some((l) => l.startsWith('::warning file=.github/dispatch.json')));
  });

  test('refuses an environment that names no repo, token or commit', async () => {
    for (const drop of ['GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'CONFIG_CHECK_REF']) {
      const { [drop]: _gone, ...rest } = env as Record<string, string>;
      await assert.rejects(run({ env: rest, reads: () => reads({}), log: () => {} }), new RegExp(drop));
    }
  });
});

describe('the REST reads, on the caller\'s token', () => {
  const REF = 'b'.repeat(40);
  type Answer = { status: number, body: unknown };
  const fake = (answers: Record<string, Answer>) => {
    const asked: string[] = [];
    const api = async (path: string) => {
      asked.push(path);
      const a = answers[path];
      if (a === undefined) throw new Error(`unexpected ${path}`);
      if (a.status !== 200) throw Object.assign(new Error(`GET ${path}: HTTP ${a.status}`), { status: a.status });
      return a.body;
    };
    return { asked, r: restReads(api, 'acme/factory', REF) };
  };
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  test('reads a file at the pull request\'s head, and a 404 as no file', async () => {
    const { r, asked } = fake({
      [`/repos/acme/factory/contents/.github/dispatch.json?ref=${REF}`]: { status: 200, body: { type: 'file', encoding: 'base64', content: b64('{}') } },
      [`/repos/acme/factory/contents/prompts/a%20b.md?ref=${REF}`]: { status: 404, body: null },
      [`/repos/acme/factory/contents/prompts?ref=${REF}`]: { status: 200, body: [] },
    });
    assert.equal(await r.read('.github/dispatch.json'), '{}');
    assert.equal(await r.read('prompts/a b.md'), null);
    await assert.rejects(r.read('prompts'), /no file GitHub sent the text of/);
    assert.equal(asked.length, 3);
  });

  test('lists the head\'s tree, the repo\'s labels page by page, and an issue\'s body', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `l${i}` }));
    const { r } = fake({
      [`/repos/acme/factory/git/trees/${REF}?recursive=1`]: { status: 200, body: { truncated: false, tree: [{ path: 'a', type: 'blob' }, { path: 'd', type: 'tree' }, { path: 'd/b', type: 'blob' }] } },
      '/repos/acme/factory/labels?per_page=100&page=1': { status: 200, body: page(100) },
      '/repos/acme/factory/labels?per_page=100&page=2': { status: 200, body: page(3) },
      '/repos/acme/factory/issues/7': { status: 200, body: { body: 'hello' } },
      '/repos/acme/factory/issues/8': { status: 404, body: null },
    });
    assert.deepEqual(await r.paths(), { paths: ['a', 'd/b'], truncated: false });
    assert.equal((await r.labels()).length, 103);
    assert.equal(await r.issueBody(7), 'hello');
    assert.equal(await r.issueBody(8), null);
  });
});

type Step = { name?: string, run?: string, uses?: string, env?: Record<string, string> };
type Job = { 'runs-on': string, permissions: Record<string, string>, steps: Step[] };
type Workflow = { on: { workflow_call: { inputs: Record<string, { description?: string, type: string, required?: boolean, default?: unknown }>, secrets?: unknown } }, permissions?: unknown, jobs: Record<string, Job> };

describe('the workflow a served repo calls', () => {
  const text = () => readFileSync(WORKFLOW_PATH, 'utf8');
  const workflow = () => yaml.load(text()) as Workflow;
  const job = () => {
    const jobs = Object.values(workflow().jobs);
    assert.equal(jobs.length, 1, 'one job');
    return jobs[0] as Job;
  };

  test('is called with workflow_call and takes the commit it is pinned to, required', () => {
    const { on } = workflow();
    assert.deepEqual(Object.keys(on), ['workflow_call']);
    assert.deepEqual(on.workflow_call.inputs.commit, { description: on.workflow_call.inputs.commit?.description, type: 'string', required: true });
  });

  test('runs on the caller\'s own token with contents: read alone, uses no action, and holds no secret', () => {
    const wf = workflow();
    assert.equal(wf.on.workflow_call.secrets, undefined);
    assert.deepEqual(wf.permissions, {});
    assert.deepEqual(job().permissions, { contents: 'read' });
    for (const s of job().steps) assert.equal(s.uses, undefined, `${s.name} uses an action`);
    assert.doesNotMatch(text(), /secrets\./);
    assert.ok(job().steps.some((s) => s.env?.GITHUB_TOKEN === '${{ github.token }}'));
  });

  test('fetches this repo at the commit it is given, installs the task\'s dependencies, and runs the check on the pull request\'s head', () => {
    const steps = job().steps;
    const all = steps.map((s) => s.run ?? '').join('\n');
    const commitVar = Object.entries(steps.flatMap((s) => Object.entries(s.env ?? {})).reduce<Record<string, string>>((o, [k, v]) => ({ ...o, [k]: v }), {}))
      .find(([, v]) => v === '${{ inputs.commit }}')?.[0];
    assert.ok(commitVar !== undefined, 'the commit reaches the step through env, never spliced into the script');
    assert.match(all, new RegExp(`git fetch [^\\n]*https://github\\.com/t-d-d/gh-governor(\\.git)? "\\$${commitVar}"`));
    assert.match(all, /\[0-9a-f\]\{40\}/, 'refuses a commit that is not 40 hex digits');
    assert.match(all, /npm ci --ignore-scripts --omit=dev/);
    assert.match(all, /node "?\$RUNNER_TEMP\/governor\/checker\/config-check\.mjs"?/);
    const checkStep = steps.find((s) => (s.run ?? '').includes('config-check.mjs'));
    assert.equal(checkStep?.env?.CONFIG_CHECK_REF, '${{ github.event.pull_request.head.sha || github.sha }}');
    assert.doesNotMatch(all, /\$\{\{/, 'no expression inside a script, where GitHub would splice it in');
  });
});

describe('the check says what a trust list exposes, and which unset list it narrowed', () => {
  const env = { GITHUB_REPOSITORY: 'acme/factory', GITHUB_TOKEN: 'ghs_fake', CONFIG_CHECK_REF: 'a'.repeat(40) };
  const WIDE = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'];
  const wide = () => reads({ '.github/dispatch.json': file({ ...base(), trust: { auto: WIDE }, pickup: { by: WIDE } }) }, { labels: ['mode: afk'] });

  test('trust.auto beyond owners, members and collaborators is an exposure, in its own wording and not among the cannot-work warnings', async () => {
    const got = await check(wide());
    assert.deepEqual([got.errors, got.templates, got.warnings], [[], [], []]);
    assert.equal(got.exposures?.length, 1);
    const [said] = got.exposures ?? [];
    assert.match(String(said), /^trust\.auto: lets in CONTRIBUTOR authors/);
    for (const route of [/wait ends/, /blocker closes/, /periodic/, /conflicts/]) assert.match(String(said), route);
    assert.doesNotMatch(String(said), /cannot work/);
  });

  test('the run writes it as a warning under a title of its own, and passes', async () => {
    const lines: string[] = [];
    const code = await run({ env, reads: () => wide(), log: (line) => lines.push(line) });
    assert.equal(code, 0);
    const line = lines.find((l) => l.startsWith('::warning ') && l.includes('trust.auto'));
    assert.ok(line !== undefined, lines.join('\n'));
    assert.match(line, /^::warning file=\.github\/dispatch\.json,title=this file lets more authors' text set governor going::/);
    assert.doesNotMatch(line, /cannot work/);
  });

  test('an unset trust.auto narrowed to fit pickup.by is listed as a notice', async () => {
    const narrow = reads({ '.github/dispatch.json': file({ ...base(), pickup: { by: ['OWNER'] } }) }, { labels: ['mode: afk'] });
    const got = await check(narrow);
    assert.deepEqual(got.exposures, undefined);
    assert.deepEqual(got.narrowed, ['trust.auto: the file leaves it unset, so governor narrows it to OWNER to fit inside pickup.by']);
    const lines: string[] = [];
    assert.equal(await run({ env, reads: () => narrow, log: (line) => lines.push(line) }), 0);
    assert.ok(lines.some((l) => /^::notice file=\.github\/dispatch\.json,title=governor narrowed a trust list this file leaves unset::trust\.auto: /.test(l)), lines.join('\n'));
  });

  test('at the defaults the verdict carries neither', async () => {
    const got = await check(reads({ '.github/dispatch.json': file(base()) }, { labels: ['mode: afk'] }));
    assert.deepEqual(got, { errors: [], templates: [], warnings: [] });
  });
});
