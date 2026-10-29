/**
 * Which repos the dispatcher serves: a repo an owner on the
 * stack's list installed the App on, whose default branch carries a config
 * file that reads valid. Every read is injected.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repoServed, servedRepos } from '../dispatch/repos.mjs';
import { CONFIG_PATH, GENERIC_SWITCHES, environmentFrom, readConfig, switchOf } from '../dispatch/repo-config.mjs';
import { factoryFile } from './helpers/factory.ts';

const FACTORY_FILE = factoryFile(CONFIG_PATH);
/** The factory's config file and the checklist file it names, as its default branch holds them. */
const FACTORY_FILES = { 'acme/factory': FACTORY_FILE, 'acme/factory:.claude/skills/pr-review/SKILL.md': factoryFile('.claude/skills/pr-review/SKILL.md') };
const ASKME_FILE = JSON.stringify({
  environment: 'env_01ASK',
  labels: { ready: ['mode: afk'], claim: 'claimed' },
  features: { pickup: true },
});

type Logged = { event: string; [key: string]: unknown };

const reads = (files: Record<string, string | null | Error>) => {
  const logged: Logged[] = [];
  const asked: string[] = [];
  return {
    logged,
    asked,
    owners: ['acme', 't-d-d'],
    log: (event: string, context: Record<string, unknown> = {}) => { logged.push({ event, ...context }); },
    token: async (repo: string) => { asked.push(`token ${repo}`); return `ghs_${repo}`; },
    config: async (repo: string, token: string, path = CONFIG_PATH) => {
      asked.push(path === CONFIG_PATH ? `config ${repo} ${token}` : `file ${repo} ${path}`);
      const file = files[path === CONFIG_PATH ? repo : `${repo}:${path}`];
      if (file instanceof Error) throw file;
      return file ?? null;
    },
    environments: async () => { asked.push('environments'); return ENVIRONMENTS; },
  };
};

/** The login's environment list, as `GET /v1/environment_providers` answers it. */
const ENVIRONMENTS = JSON.parse(readFileSync('test/fixtures/environment-providers.json', 'utf8'));
const named = (environment: string) => JSON.stringify({ environment, labels: { ready: ['mode: afk'], claim: 'claimed' }, features: { pickup: true } });

describe('readConfig', () => {
  test('the factory\'s own file turns every feature on', () => {
    const read = readConfig(FACTORY_FILE);
    assert.ok(read.ok, JSON.stringify(read));
    assert.ok(Object.values(read.config.features).every((on) => on === true));
  });

  // No switch is repo-specific. The factory's file, which turns every
  // switch on, serves any repo that commits it.
  test('the factory\'s file serves another repo with every switch on', async () => {
    const r = reads({ 't-d-d/askme-mcp': FACTORY_FILE, 't-d-d/askme-mcp:.claude/skills/pr-review/SKILL.md': FACTORY_FILES['acme/factory:.claude/skills/pr-review/SKILL.md'] });
    const served = await repoServed({ ...r, repo: 't-d-d/askme-mcp' });
    assert.ok(served, JSON.stringify(r.logged));
    for (const name of GENERIC_SWITCHES) assert.equal(served.config.features[name], true, name);
    assert.ok(GENERIC_SWITCHES.includes('heartbeat'));
  });

  test('a file that names no excluded labels keeps type: prd out, so no served repo\'s file needs to change', () => {
    const read = readConfig(ASKME_FILE);
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.labels.exclude, ['type: prd']);
  });

  test('a file names the labels that keep a ticket out, in place of the default', () => {
    const read = readConfig(JSON.stringify({ environment: 'env_1', labels: { ready: ['mode: afk'], claim: 'claimed', exclude: ['epic', 'needs design'] }, features: {} }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.labels.exclude, ['epic', 'needs design']);
  });

  test('a generic file reads in any repo, with nothing the claim takes off by default', () => {
    const read = readConfig(ASKME_FILE);
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.labels, { ready: ['mode: afk'], claim: 'claimed', claimRemoves: [], exclude: ['type: prd'] });
  });

  test('the red scheduled run and the merge hand-off are generic switches; the lessons ask is gone', () => {
    const read = readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), features: { pickup: true, redScheduledRun: true, mergeHandoff: true } }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.config.features.redScheduledRun, true);
    assert.equal(read.config.features.mergeHandoff, true);
    const lessons = readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), features: { pickup: true, lessonsAsk: true } }));
    assert.ok(!lessons.ok && /lessonsAsk/.test(lessons.fault), JSON.stringify(lessons));
  });

  // CI, deploy, branch-run, conflicts and deployed-label
  // messages are any served repo's, read from its own `workflows` section.
  test('the CI, deploy, branch-run, conflicts and deployed-label switches are generic', () => {
    const features = { ciMessages: true, deployMessages: true, branchRunMessages: true, conflicts: true, deployedLabels: true };
    const read = readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), features }));
    assert.ok(read.ok, JSON.stringify(read));
  });

  // The heartbeat is any served repo's, written into the issue its file names:
  // under the repo's own marker in today's shape, or governor's with no marker.
  test('heartbeat: any repo may turn it on, naming the issue, and its marker or none; on without an issue is a fault', () => {
    const on = (heartbeat: unknown) => readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), features: { heartbeat: true }, ...(heartbeat === undefined ? {} : { heartbeat }) }));
    const read = on({ issue: 12, marker: '<!-- askme:heartbeat -->' });
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.heartbeat, { issue: 12, marker: '<!-- askme:heartbeat -->' });
    const governor = on({ issue: 12 });
    assert.ok(governor.ok, JSON.stringify(governor));
    assert.deepEqual(governor.config.heartbeat, { issue: 12 });
    for (const bad of [undefined, {}, { issue: 0 }, { marker: '<!-- askme:heartbeat -->' }, { issue: 0, marker: '<!-- a -->' }, { issue: 12, marker: 'not a comment' }, { issue: 12, marker: '<!-- a -->', extra: 1 }]) {
      const refused = on(bad);
      assert.ok(!refused.ok && /heartbeat/.test(refused.fault), `${JSON.stringify(bad)}: ${JSON.stringify(refused)}`);
    }
  });

  // The PR review is any served repo's, run from its `review` section.
  test('review: any repo may turn the review on with its own section, merging on a pass unless it says not', () => {
    const on = (review: unknown) => readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), features: { prReview: true }, ...(review === undefined ? {} : { review }) }));
    const read = on({ checklist: 'Pass a PR that says what it changes.' });
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.review, {
      checklist: 'Pass a PR that says what it changes.', humanOnly: [], tickets: { require: [], forbid: [] }, quote: [], decides: [], dependabot: [], merge: true,
    });
    const full = on({
      checklist: { file: 'docs/review.md' },
      humanOnly: [{ glob: 'infra/**', reason: 'the stacks' }, { glob: '.claude/**', reason: 'the skills', unless: ['mode: hitl'] }],
      tickets: { require: [{ labels: ['mode: afk', 'mode: hitl'] }], forbid: [{ labels: ['type: adr'], unless: ['ready'] }] },
      quote: ['docs/rules/*.md', '!docs/rules/README.md'],
      dependabot: ['/package-lock.json'],
      merge: false,
    });
    assert.ok(full.ok, JSON.stringify(full));
    assert.deepEqual(full.config.review?.checklist, { file: 'docs/review.md' });
    assert.deepEqual(full.config.review?.humanOnly[0], { glob: 'infra/**', reason: 'the stacks', unless: [] });
    assert.deepEqual(full.config.review?.tickets.require, [{ labels: ['mode: afk', 'mode: hitl'], unless: [] }]);
    assert.equal(full.config.review?.merge, false);
    const fault = (review: unknown) => {
      const refused = on(review);
      assert.ok(!refused.ok, JSON.stringify(review));
      return refused.fault;
    };
    assert.match(fault(undefined), /review/, 'the review on with no section has no checklist');
    assert.match(fault({}), /review\.checklist/);
    assert.match(fault({ checklist: '  ' }), /review\.checklist/);
    assert.match(fault({ checklist: { file: '/etc/passwd' } }), /review\.checklist/);
    assert.match(fault({ checklist: { file: 'docs/../../x.md' } }), /review\.checklist/);
    assert.match(fault({ checklist: 'c', humanOnly: [{ glob: 'a' }] }), /review\.humanOnly/);
    assert.match(fault({ checklist: 'c', tickets: { require: [{ labels: [] }] } }), /review\.tickets/);
    assert.match(fault({ checklist: 'c', tickets: { needs: [] } }), /needs/);
    assert.match(fault({ checklist: 'c', quote: ['!'] }), /review\.quote/);
    assert.match(fault({ checklist: 'c', merge: 'no' }), /review\.merge/);
    assert.match(fault({ checklist: 'c', script: 'check.sh' }), /script/, 'no repo-supplied code');
  });

  test('workflows: a file names its CI file, its triage targets and each target\'s tag; one with none reads as none', () => {
    assert.deepEqual((readConfig(ASKME_FILE) as { config: { workflows: unknown } }).config.workflows, { triage: [], tags: {} });
    const workflows = { ci: '.github/workflows/gate.yml', triage: ['prod'], tags: { prod: 'release/prod' } };
    const read = readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), workflows }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.workflows, workflows);
    const fault = (bad: unknown) => {
      const refused = readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), workflows: bad }));
      assert.ok(!refused.ok, JSON.stringify(bad));
      return refused.fault;
    };
    assert.match(fault({ ci: 'gate.yml' }), /workflows\.ci/);
    assert.match(fault({ ci: '.github/workflows/../x.yml' }), /workflows\.ci/);
    assert.match(fault({ triage: [''] }), /workflows\.triage/);
    assert.match(fault({ tags: { prod: '' } }), /workflows\.tags/);
    assert.match(fault({ deploys: [] }), /deploys/);
  });

  test('prompts: any repo may replace a kind\'s instruction, and a file with none reads as no prompts', () => {
    assert.deepEqual((readConfig(ASKME_FILE) as { config: { prompts: unknown } }).config.prompts, {});
    const read = readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), prompts: { signOff: 'End with `Signing off.`', deployGreen: 'Check {target} for PR #{pr}.' } }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.prompts, { signOff: 'End with `Signing off.`', deployGreen: 'Check {target} for PR #{pr}.' });
  });

  test('prompts: a prompt may be the text or a file in the repo, by its path from the root', () => {
    const read = readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), prompts: { signOff: { file: '.github/sign-off.md' } } }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.prompts, { signOff: { file: '.github/sign-off.md' } });
    for (const bad of [{ file: '' }, { file: '../x.md' }, { file: 'a.md', also: 1 }]) {
      const refused = readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), prompts: { signOff: bad } }));
      assert.ok(!refused.ok && /prompts\.signOff/.test(refused.fault), JSON.stringify(bad));
    }
  });

  test('prompts: an unknown key, a placeholder the kind lacks, or an empty prompt is a fault naming it', () => {
    const fault = (prompts: unknown) => {
      const read = readConfig(JSON.stringify({ ...JSON.parse(ASKME_FILE), prompts }));
      assert.ok(!read.ok, JSON.stringify(prompts));
      return read.fault;
    };
    assert.match(fault({ signoff: 'x' }), /prompts.*signoff/);
    assert.match(fault({ signOff: 'Close PR #{pr}.' }), /prompts\.signOff.*\{pr\}/);
    assert.match(fault({ pickup: '  ' }), /prompts\.pickup/);
    assert.match(fault({ pickup: 3 }), /prompts\.pickup/);
  });

  test('refuses text that is not JSON, a missing environment, and a claim that removes a label it never read', () => {
    assert.match((readConfig('{') as { fault: string }).fault, /not JSON/);
    assert.match((readConfig(JSON.stringify({ labels: { ready: ['x'], claim: 'y' }, features: {} })) as { fault: string }).fault, /environment/);
    assert.match((readConfig(JSON.stringify({ environment: 'env_1', labels: { ready: ['x'], claim: 'y', claimRemoves: ['z'] }, features: {} })) as { fault: string }).fault, /claimRemoves/);
    assert.match((readConfig(JSON.stringify({ environment: 'env_1', labels: { ready: ['x'], claim: 'x' }, features: {} })) as { fault: string }).fault, /claim label/);
    // A ticket would need the label to be ready and lack it to be picked up.
    assert.match((readConfig(JSON.stringify({ environment: 'env_1', labels: { ready: ['x', 'afk'], claim: 'y', exclude: ['afk'] }, features: {} })) as { fault: string }).fault, /exclude cannot name a ready label/);
    // GitHub's issues query splits its labels on commas.
    assert.match((readConfig(JSON.stringify({ environment: 'env_1', labels: { ready: ['ready, afk'], claim: 'y' }, features: {} })) as { fault: string }).fault, /comma/);
  });
});

describe('environmentFrom', () => {
  test('an ID is kept; a name is the ID of the one environment of that name', () => {
    assert.deepEqual(environmentFrom('env_01ASK', ENVIRONMENTS), { id: 'env_01ASK' });
    assert.deepEqual(environmentFrom('askme', ENVIRONMENTS), { id: 'env_01ASKME' });
  });

  test('a name matching no environment, or more than one, is a fault naming it', () => {
    assert.match((environmentFrom('nowhere', ENVIRONMENTS) as { fault: string }).fault, /no cloud environment is named "nowhere"/);
    assert.match((environmentFrom('shared', ENVIRONMENTS) as { fault: string }).fault, /2 cloud environments are named "shared"/);
  });

  test('a list not in the API\'s shape throws: a failed read, never no match', () => {
    assert.throws(() => environmentFrom('askme', { environments: [{ name: 'askme' }] }), /environment/);
    assert.throws(() => environmentFrom('askme', null), /environment/);
  });

  test('the schema takes a name or an ID, and refuses an empty one', () => {
    assert.ok(readConfig(named('askme')).ok);
    assert.ok(readConfig(named('env_01ASK')).ok);
    assert.match((readConfig(named(' ')) as { fault: string }).fault, /environment/);
  });
});

describe('switchOf', () => {
  test('pickup for a schedule fire; each kind its own switch; summons, PR messages and subscribe messages for the rest', () => {
    assert.equal(switchOf({ kind: 'schedule' }), 'pickup');
    assert.equal(switchOf({ kind: 'review' }), 'prReview');
    assert.equal(switchOf({ kind: 'conflicts', pr: 1, sha: 'a'.repeat(40), base: 'main' }), 'conflicts');
    assert.equal(switchOf({ kind: 'dispatch', prompt: 'p', scheduled: { workflowId: 1, runId: 2, branch: 'main' } }), 'redScheduledRun');
    assert.equal(switchOf({ kind: 'dispatch', prompt: 'p' }), 'summons');
    assert.equal(switchOf({ kind: 'message', session: 'session_1', text: 't' }), 'prMessages');
    assert.equal(switchOf({ kind: 'message', byBranch: true, on: 3, text: 't' }), 'prMessages');
    assert.equal(switchOf({ kind: 'message', session: 'session_1', text: 't', subscribed: true }), 'subscribeMessages');
  });

  test('a red run of the repo\'s CI needs CI messages; a red deploy, like a green shipping job, deploy messages', () => {
    const workflows = { ci: '.github/workflows/gate.yml', triage: [], tags: {} };
    const red = (path: string) => ({ kind: 'workflow' as const, name: 'X', path, branch: 'trunk', runId: 1, url: 'https://x', conclusion: 'failure', headSha: 'a'.repeat(40) });
    assert.equal(switchOf(red('.github/workflows/gate.yml'), workflows), 'ciMessages');
    assert.equal(switchOf(red('.github/workflows/release.yml'), workflows), 'deployMessages');
    assert.equal(switchOf({ kind: 'job', name: 'n', workflow: 'Release', branch: 'trunk', runId: 1, jobId: 2, url: 'https://x', headSha: 'a'.repeat(40), label: 'deployed: dev', commit: 'a'.repeat(40) }, workflows), 'deployMessages');
  });
});

describe('servedRepos', () => {
  test('keeps the repos on listed owners whose file reads valid, each with its own token', async () => {
    const r = reads({ ...FACTORY_FILES, 't-d-d/askme-mcp': ASKME_FILE });
    const { served, unread } = await servedRepos({
      ...r,
      installations: async () => [{ account: 'acme', repos: ['acme/factory'] }, { account: 't-d-d', repos: ['t-d-d/askme-mcp'] }],
    });
    assert.deepEqual(served.map((s) => s.repo), ['acme/factory', 't-d-d/askme-mcp']);
    assert.deepEqual(unread, []);
    assert.ok(r.asked.includes('config t-d-d/askme-mcp ghs_t-d-d/askme-mcp'));
  });

  test('an unlisted owner\'s installation is read no further and pages nobody', async () => {
    const r = reads({ 'stranger/repo': ASKME_FILE });
    const { served } = await servedRepos({ ...r, installations: async () => [{ account: 'stranger', repos: ['stranger/repo'] }] });
    assert.deepEqual(served, []);
    assert.deepEqual(r.asked, []);
    assert.ok(r.logged.every((l) => l.level !== 'error'), JSON.stringify(r.logged));
  });

  test('no file is not served, at info; an invalid file is an alarmed dispatch-config-invalid naming the repo and the fault', async () => {
    const r = reads({ 't-d-d/none': null, 't-d-d/bad': '{"environment": 1}' });
    const { served } = await servedRepos({ ...r, installations: async () => [{ account: 't-d-d', repos: ['t-d-d/none', 't-d-d/bad'] }] });
    assert.deepEqual(served, []);
    assert.deepEqual(r.logged.find((l) => l.repo === 't-d-d/none'), { event: 'dispatch-not-served', level: 'info', repo: 't-d-d/none', reason: `no ${CONFIG_PATH} on its default branch` });
    const invalid = r.logged.find((l) => l.event === 'dispatch-config-invalid');
    assert.equal(invalid?.repo, 't-d-d/bad');
    assert.equal(invalid?.level, 'error');
    assert.match(String(invalid?.fault), /environment/);
  });

  test('an unknown prompt key is an alarmed dispatch-config-invalid naming the repo and the key, never a default', async () => {
    const r = reads({ 't-d-d/typo': JSON.stringify({ ...JSON.parse(ASKME_FILE), prompts: { signoff: 'Sign off.' } }) });
    const { served } = await servedRepos({ ...r, installations: async () => [{ account: 't-d-d', repos: ['t-d-d/typo'] }] });
    assert.deepEqual(served, []);
    const invalid = r.logged.find((l) => l.event === 'dispatch-config-invalid');
    assert.equal(invalid?.repo, 't-d-d/typo');
    assert.equal(invalid?.level, 'error');
    assert.match(String(invalid?.fault), /signoff/);
  });

  test('a prompt in a file is read from the default branch beside the config file, and served as if the file held its text', async () => {
    const file = JSON.stringify({
      ...JSON.parse(ASKME_FILE),
      features: { pickup: true, prReview: true },
      prompts: { deployGreen: { file: '.github/green.md' } },
      review: { checklist: { file: 'docs/review.md' } },
    });
    const r = reads({ 't-d-d/askme-mcp': file, 't-d-d/askme-mcp:.github/green.md': 'Check {target} for PR #{pr}.\n', 't-d-d/askme-mcp:docs/review.md': '---\nname: review\n---\n\n# Review\n' });
    const served = await repoServed({ ...r, repo: 't-d-d/askme-mcp' });
    assert.equal(served?.config.prompts.deployGreen, 'Check {target} for PR #{pr}.');
    assert.equal(served?.config.review?.checklist, '# Review', 'a skill file\'s frontmatter is the CLI\'s metadata, not the prompt');
    assert.deepEqual(r.asked.filter((a) => a.startsWith('file')).sort(), ['file t-d-d/askme-mcp .github/green.md', 'file t-d-d/askme-mcp docs/review.md']);
  });

  test('a prompt file that is missing, empty, or names a fact its kind lacks is an alarmed dispatch-config-invalid naming the repo and the path; a failed read leaves the repo unread', async () => {
    const file = JSON.stringify({ ...JSON.parse(ASKME_FILE), features: { pickup: true, prReview: true }, review: { checklist: { file: 'docs/review.md' } }, prompts: { signOff: { file: 'docs/sign-off.md' } } });
    for (const [files, named] of [
      [{ 't-d-d/askme-mcp:docs/sign-off.md': 'Sign off.' }, /review\.checklist.*docs\/review\.md/],
      [{ 't-d-d/askme-mcp:docs/review.md': ' \n', 't-d-d/askme-mcp:docs/sign-off.md': 'Sign off.' }, /review\.checklist.*docs\/review\.md.*empty/],
      [{ 't-d-d/askme-mcp:docs/review.md': 'R', 't-d-d/askme-mcp:docs/sign-off.md': 'Close PR #{pr}.' }, /prompts\.signOff.*\{pr\}/],
    ] as const) {
      const r = reads({ 't-d-d/askme-mcp': file, ...files });
      assert.equal(await repoServed({ ...r, repo: 't-d-d/askme-mcp' }), null);
      const invalid = r.logged.find((l) => l.event === 'dispatch-config-invalid');
      assert.equal(invalid?.repo, 't-d-d/askme-mcp');
      assert.equal(invalid?.level, 'error');
      assert.match(String(invalid?.fault), named);
    }
    const failing = reads({ 't-d-d/askme-mcp': file, 't-d-d/askme-mcp:docs/review.md': new Error('GET contents: 502'), 't-d-d/askme-mcp:docs/sign-off.md': 'Sign off.' });
    await assert.rejects(repoServed({ ...failing, repo: 't-d-d/askme-mcp' }), /docs\/review\.md.*502/);
  });

  test('a contents read that fails is never a missing file: that repo is unread, the rest still served', async () => {
    const r = reads({ ...FACTORY_FILES, 't-d-d/askme-mcp': new Error('GET contents: 502') });
    const { served, unread } = await servedRepos({ ...r, installations: async () => [{ account: 'acme', repos: ['acme/factory'] }, { account: 't-d-d', repos: ['t-d-d/askme-mcp'] }] });
    assert.deepEqual(served.map((s) => s.repo), ['acme/factory']);
    assert.deepEqual(unread, [{ repo: 't-d-d/askme-mcp', error: 'GET contents: 502' }]);
    assert.ok(!r.logged.some((l) => l.event === 'dispatch-not-served'));
    assert.ok(r.logged.some((l) => l.event === 'dispatch-config-unread' && l.repo === 't-d-d/askme-mcp' && l.level === 'error'));
  });

  test('a failed installation listing, or a failed token mint, refuses the turn', async () => {
    const r = reads({});
    await assert.rejects(servedRepos({ ...r, installations: async () => { throw new Error('GET /app/installations: 500'); } }), /500/);
    await assert.rejects(servedRepos({ ...r, token: async () => { throw new Error('mint: 403'); }, installations: async () => [{ account: 'acme', repos: ['acme/factory'] }] }), /403/);
  });
});

describe('a file naming its environment', () => {
  test('is served with the ID of the environment of that name; a file giving an ID reads no list', async () => {
    const r = reads({ 't-d-d/a': named('askme'), 't-d-d/b': named('acme'), 't-d-d/c': ASKME_FILE });
    const { served } = await servedRepos({ ...r, installations: async () => [{ account: 't-d-d', repos: ['t-d-d/a', 't-d-d/b', 't-d-d/c'] }] });
    assert.deepEqual(served.map((s) => s.config.environment), ['env_01ASKME', 'env_01FACTORY', 'env_01ASK']);
    const one = reads({ 't-d-d/c': ASKME_FILE });
    await repoServed({ ...one, repo: 't-d-d/c' });
    assert.ok(!one.asked.includes('environments'));
  });

  test('a name matching nothing is an alarmed dispatch-config-invalid naming the repo; a failed list read leaves the repo unread', async () => {
    const r = reads({ 't-d-d/a': named('nowhere') });
    const { served } = await servedRepos({ ...r, installations: async () => [{ account: 't-d-d', repos: ['t-d-d/a'] }] });
    assert.deepEqual(served, []);
    const invalid = r.logged.find((l) => l.event === 'dispatch-config-invalid');
    assert.equal(invalid?.repo, 't-d-d/a');
    assert.match(String(invalid?.fault), /^environment: no cloud environment is named "nowhere"/);

    const failed = reads({ 't-d-d/a': named('askme'), 't-d-d/c': ASKME_FILE });
    const listing = await servedRepos({ ...failed, environments: async () => { throw new Error('503'); }, installations: async () => [{ account: 't-d-d', repos: ['t-d-d/a', 't-d-d/c'] }] });
    assert.deepEqual(listing.served.map((s) => s.repo), ['t-d-d/c']);
    assert.deepEqual(listing.unread, [{ repo: 't-d-d/a', error: '503' }]);
    assert.ok(!failed.logged.some((l) => l.event === 'dispatch-config-invalid'));
    await assert.rejects(repoServed({ ...failed, environments: async () => { throw new Error('503'); }, repo: 't-d-d/a' }), (error: Error) => {
      assert.match(error.message, /cloud environment list.*503/);
      assert.doesNotMatch(error.message, /dispatch\.json/, 'the file was read: the list was not');
      return true;
    });
  });
});

describe('repoServed', () => {
  test('a named repo on a listed owner with a valid file is served; one without, or unlisted, is not', async () => {
    const r = reads({ ...FACTORY_FILES, 't-d-d/none': null });
    assert.equal((await repoServed({ ...r, repo: 'acme/factory' }))?.repo, 'acme/factory');
    assert.equal(await repoServed({ ...r, repo: 't-d-d/none' }), null);
    assert.equal(await repoServed({ ...r, repo: 'stranger/repo' }), null);
    assert.ok(!r.asked.some((a) => a.includes('stranger')), 'an unlisted owner\'s repo is never read');
  });

  test('a failed read refuses the turn', async () => {
    const r = reads({ 'acme/factory': new Error('GET contents: 502') });
    await assert.rejects(repoServed({ ...r, repo: 'acme/factory' }), /502/);
  });
});
