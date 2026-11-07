/**
 * Which repos the dispatcher serves: a repo an owner on the
 * stack's list installed the App on, whose default branch carries a config
 * file that reads valid. Every read is injected.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repoServed, servedRepos } from '../dispatch/repos.mjs';
import { CONFIG_PATH, GENERIC_SWITCHES, LABEL_READERS, OLD_CONFIG_PATH, PROMPT_KEYS, SECTIONS, SECTION_PROMPTS, environmentFrom, readConfig, resolveFiles, switchOf, turnsOn } from '../dispatch/repo-config.mjs';
import { PROMPTS } from '../dispatch/prompts.mjs';
import { factoryFile } from './helpers/factory.ts';

const FACTORY_FILE = factoryFile(CONFIG_PATH);
/** The factory's config file and the checklist file it names, as its default branch holds them. */
/** The prompt files the factory's config names, each by its path. */
const FACTORY_PROMPTS = ['.claude/skills/pr-review/SKILL.md', '.github/issue-review/triage.md', '.github/issue-review/bug.md'];
/** The factory's files under `repo`, as `reads` keys them. */
const factoryFilesOf = (repo: string) => Object.fromEntries([[repo, FACTORY_FILE], ...FACTORY_PROMPTS.map((path) => [`${repo}:${path}`, factoryFile(path)])]);
const FACTORY_FILES = factoryFilesOf('acme/factory');
const ASKME_FILE = JSON.stringify({
  environment: 'env_01ASK',
  pickup: { ready: ['mode: afk'], claim: 'claimed' },
});
/** The askme file with `more` laid over it, as text. */
const askme = (more: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(ASKME_FILE), ...more });

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
const named = (environment: string) => JSON.stringify({ environment, pickup: { ready: ['mode: afk'], claim: 'claimed' } });

describe('readConfig', () => {
  test('the factory\'s own file turns every feature on', () => {
    const read = readConfig(FACTORY_FILE);
    assert.ok(read.ok, JSON.stringify(read));
    assert.ok(Object.values(read.config.features).every((on) => on === true));
  });

  // No switch is repo-specific. The factory's file, which turns every
  // switch on, serves any repo that commits it.
  test('the factory\'s file serves another repo with every switch on', async () => {
    const r = reads(factoryFilesOf('t-d-d/askme-mcp'));
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
    const read = readConfig(JSON.stringify({ environment: 'env_1', pickup: { ready: ['mode: afk'], claim: 'claimed', exclude: ['epic', 'needs design'] } }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.labels.exclude, ['epic', 'needs design']);
  });

  test('a generic file reads in any repo, with nothing the claim takes off by default', () => {
    const read = readConfig(ASKME_FILE);
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.labels, { ready: ['mode: afk'], claim: 'claimed', claimRemoves: [], exclude: ['type: prd'] });
  });

  test('the red scheduled run and unblocked are generic switches; the lessons ask is gone', () => {
    const read = readConfig(askme({ redScheduledRun: {}, unblocked: {} }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.config.features.redScheduledRun, true);
    assert.equal(read.config.features.unblocked, true);
    const lessons = readConfig(askme({ lessonsAsk: {} }));
    assert.ok(!lessons.ok && /lessonsAsk/.test(lessons.fault), JSON.stringify(lessons));
  });

  // CI, deploy, branch-run, conflicts and deployed-label
  // messages are any served repo's, each read from its own section.
  test('the CI, deploy, branch-run, conflicts and deployed-label switches are generic', () => {
    const read = readConfig(askme({ ciMessages: {}, deployMessages: { deployedLabels: true }, branchRunMessages: {}, conflicts: {} }));
    assert.ok(read.ok, JSON.stringify(read));
    for (const name of ['ciMessages', 'deployMessages', 'branchRunMessages', 'conflicts', 'deployedLabels']) assert.equal(read.config.features[name], true, name);
  });

  // The heartbeat is any served repo's, written into the issue its section
  // names under governor's own marker. The older shape with a marker of the
  // repo's own is gone.
  test('heartbeat: any repo may turn it on, naming the issue; on without an issue, or with the older marker, is a fault', () => {
    const on = (heartbeat: unknown) => readConfig(askme({ heartbeat }));
    const governor = on({ issue: 12 });
    assert.ok(governor.ok, JSON.stringify(governor));
    assert.deepEqual(governor.config.heartbeat, { issue: 12 });
    assert.equal(governor.config.features.heartbeat, true);
    for (const bad of [{}, { issue: 0 }, { marker: '<!-- askme:heartbeat -->' }, { issue: 12, marker: '<!-- askme:heartbeat -->' }, { issue: 12, extra: 1 }]) {
      const refused = on(bad);
      assert.ok(!refused.ok && /heartbeat/.test(refused.fault), `${JSON.stringify(bad)}: ${JSON.stringify(refused)}`);
    }
    const older = on({ issue: 12, marker: '<!-- askme:heartbeat -->' });
    assert.ok(!older.ok && /heartbeat: Unrecognized key: "marker"/.test(older.fault), JSON.stringify(older));
  });

  // The PR review is any served repo's, run from its `prReview` section,
  // whose text is `prompt`, read into the review's checklist.
  test('prReview: any repo may turn the review on with its own section, merging on a pass unless it says not', () => {
    const on = (review: Record<string, unknown>) => readConfig(askme({ prReview: review }));
    const read = on({ prompt: 'Pass a PR that says what it changes.' });
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.review, {
      checklist: 'Pass a PR that says what it changes.', humanOnly: [], tickets: { require: [], forbid: [] }, quote: [], decides: [], dependabot: [], requireChecks: [], waitForCi: true, merge: true,
    });
    assert.equal(read.config.features.prReview, true);
    const full = on({
      prompt: { file: 'docs/review.md' },
      humanOnly: [{ glob: 'infra/**', reason: 'the stacks' }, { glob: '.claude/**', reason: 'the skills', unless: ['mode: hitl'] }],
      tickets: { require: [{ labels: ['mode: afk', 'mode: hitl'] }], forbid: [{ labels: ['type: adr'], unless: ['ready'] }] },
      quote: ['docs/rules/*.md', '!docs/rules/README.md'],
      dependabot: ['/package-lock.json'],
      requireChecks: ['codeql', 'ci/circleci', { name: 'scan', app: 'github-code-scanning' }],
      waitForCi: false,
      merge: false,
    });
    assert.ok(full.ok, JSON.stringify(full));
    assert.deepEqual(full.config.review?.checklist, { file: 'docs/review.md' });
    assert.deepEqual(full.config.review?.humanOnly[0], { glob: 'infra/**', reason: 'the stacks', unless: [] });
    assert.deepEqual(full.config.review?.tickets.require, [{ labels: ['mode: afk', 'mode: hitl'], unless: [] }]);
    assert.equal(full.config.review?.merge, false);
    assert.deepEqual(full.config.review?.requireChecks, ['codeql', 'ci/circleci', { name: 'scan', app: 'github-code-scanning' }]);
    assert.equal(full.config.review?.waitForCi, false);
    const fault = (review: Record<string, unknown>) => {
      const refused = on(review);
      assert.ok(!refused.ok, JSON.stringify(review));
      return refused.fault;
    };
    assert.match(fault({}), /prReview\.prompt: prReview is on, so its section needs a prompt/);
    assert.match(fault({ prompt: '  ' }), /prReview\.prompt/);
    assert.match(fault({ prompt: { file: '/etc/passwd' } }), /prReview\.prompt/);
    assert.match(fault({ prompt: { file: 'docs/../../x.md' } }), /prReview\.prompt/);
    assert.match(fault({ checklist: 'c' }), /prReview: Unrecognized key: "checklist"/, 'the text is prompt, as in every other section');
    assert.match(fault({ prompt: 'c', humanOnly: [{ glob: 'a' }] }), /prReview\.humanOnly/);
    assert.match(fault({ prompt: 'c', tickets: { require: [{ labels: [] }] } }), /prReview\.tickets/);
    assert.match(fault({ prompt: 'c', tickets: { needs: [] } }), /needs/);
    assert.match(fault({ prompt: 'c', quote: ['!'] }), /prReview\.quote/);
    assert.match(fault({ prompt: 'c', merge: 'no' }), /prReview\.merge/);
    assert.match(fault({ prompt: 'c', requireChecks: [{ name: 'scan' }] }), /prReview\.requireChecks/, 'an entry that is not a bare name names its App');
    assert.match(fault({ prompt: 'c', requireChecks: [{ name: 'scan', app: ' ' }] }), /prReview\.requireChecks/);
    for (const app of ['GitHub-Actions', 'github.com/apps/github-actions', 'github actions']) {
      assert.match(fault({ prompt: 'c', requireChecks: [{ name: 'scan', app }] }), /prReview\.requireChecks/, `${app} is no App slug, and no check run would ever meet it`);
    }
    assert.match(fault({ prompt: 'c', requireChecks: [{ name: 'scan', app: 'github-actions', id: 1 }] }), /prReview\.requireChecks/);
    assert.match(fault({ prompt: 'c', script: 'check.sh' }), /script/, 'no repo-supplied code');
  });

  test('workflows names only the CI file; the triage targets and each target\'s tag are the deploy messages\'', () => {
    assert.deepEqual((readConfig(ASKME_FILE) as { config: { workflows: unknown } }).config.workflows, { triage: [], tags: {} });
    const read = readConfig(askme({ workflows: { ci: '.github/workflows/gate.yml' }, deployMessages: { triage: ['prod'], tags: { prod: 'release/prod' } } }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.workflows, { ci: '.github/workflows/gate.yml', triage: ['prod'], tags: { prod: 'release/prod' } });
    const fault = (more: Record<string, unknown>) => {
      const refused = readConfig(askme(more));
      assert.ok(!refused.ok, JSON.stringify(more));
      return refused.fault;
    };
    assert.match(fault({ workflows: { ci: 'gate.yml' } }), /workflows\.ci/);
    assert.match(fault({ workflows: { ci: '.github/workflows/../x.yml' } }), /workflows\.ci/);
    assert.match(fault({ deployMessages: { triage: [''] } }), /deployMessages\.triage/);
    assert.match(fault({ deployMessages: { tags: { prod: '' } } }), /deployMessages\.tags/);
    assert.match(fault({ workflows: { deploys: [] } }), /deploys/);
    assert.match(fault({ workflows: { triage: ['prod'] } }), /workflows: Unrecognized key: "triage"/, 'the triage targets moved to deployMessages');
    assert.match(fault({ workflows: { tags: { prod: 'release/prod' } } }), /workflows: Unrecognized key: "tags"/, 'the tags moved to deployMessages');
  });

  test('prompts: any repo may replace a kind\'s instruction in its feature\'s section, and a file with none reads as no prompts', () => {
    assert.deepEqual((readConfig(ASKME_FILE) as { config: { prompts: unknown } }).config.prompts, {});
    const read = readConfig(askme({ signOff: { prompt: 'End with `Signing off.`' }, deployMessages: { prompts: { green: 'Check {target} for PR #{pr}.' } } }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.prompts, { signOff: 'End with `Signing off.`', deployGreen: 'Check {target} for PR #{pr}.' });
  });

  test('prompts: a prompt may be the text or a file in the repo, by its path from the root', () => {
    const read = readConfig(askme({ signOff: { prompt: { file: '.github/sign-off.md' } } }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.config.prompts, { signOff: { file: '.github/sign-off.md' } });
    for (const bad of [{ file: '' }, { file: '../x.md' }, { file: 'a.md', also: 1 }]) {
      const refused = readConfig(askme({ signOff: { prompt: bad } }));
      assert.ok(!refused.ok && /signOff\.prompt/.test(refused.fault), JSON.stringify(bad));
    }
  });

  test('prompts: an unknown key, a placeholder the kind lacks, or an empty prompt is a fault naming it', () => {
    const fault = (more: Record<string, unknown>) => {
      const read = readConfig(askme(more));
      assert.ok(!read.ok, JSON.stringify(more));
      return read.fault;
    };
    assert.match(fault({ signOff: { promt: 'x' } }), /signOff.*promt/);
    assert.match(fault({ unblocked: { prompts: { Spec: 'x' } } }), /unblocked\.prompts.*Spec/);
    assert.match(fault({ signOff: { prompt: 'Close PR #{pr}.' } }), /signOff\.prompt.*\{pr\}/);
    assert.match(fault({ pickup: { ...JSON.parse(ASKME_FILE).pickup, prompt: '  ' } }), /pickup\.prompt/);
    assert.match(fault({ pickup: { ...JSON.parse(ASKME_FILE).pickup, prompt: 3 } }), /pickup\.prompt/);
    assert.match(fault({ summons: { prompt: 'x' } }), /summons.*prompt/, 'a feature with no message kind has no prompt');
  });

  test('refuses text that is not JSON, a missing environment, and a claim that removes a label it never read', () => {
    assert.match((readConfig('{') as { fault: string }).fault, /not JSON/);
    assert.match((readConfig(JSON.stringify({ pickup: { ready: ['x'], claim: 'y' } })) as { fault: string }).fault, /environment/);
    assert.match((readConfig(JSON.stringify({ environment: 'env_1', pickup: { ready: ['x'], claim: 'y', claimRemoves: ['z'] } })) as { fault: string }).fault, /claimRemoves/);
    assert.match((readConfig(JSON.stringify({ environment: 'env_1', pickup: { ready: ['x'], claim: 'x' } })) as { fault: string }).fault, /claim label/);
    // A ticket would need the label to be ready and lack it to be picked up.
    assert.match((readConfig(JSON.stringify({ environment: 'env_1', pickup: { ready: ['x', 'afk'], claim: 'y', exclude: ['afk'] } })) as { fault: string }).fault, /exclude cannot name a ready label/);
    // Labels match in any case, as GitHub matches them, so these are the same label.
    assert.match((readConfig(JSON.stringify({ environment: 'env_1', pickup: { ready: ['X'], claim: 'x' } })) as { fault: string }).fault, /claim label/);
    assert.match((readConfig(JSON.stringify({ environment: 'env_1', pickup: { ready: ['x', 'AFK'], claim: 'y', exclude: ['afk'] } })) as { fault: string }).fault, /exclude cannot name a ready label/);
    assert.ok(!('fault' in readConfig(JSON.stringify({ environment: 'env_1', pickup: { ready: ['X'], claim: 'y', claimRemoves: ['x'] } }))), 'claimRemoves names a ready label in another case');
    // GitHub's issues query splits its labels on commas.
    assert.match((readConfig(JSON.stringify({ environment: 'env_1', pickup: { ready: ['ready, afk'], claim: 'y' } })) as { fault: string }).fault, /comma/);
  });
});

/**
 * The layout of `.github/governor.json` (#525): `environment`, `trust` and
 * `workflows` are shared, and every other top-level key is one feature's
 * section, holding every setting that feature reads. Each key the file
 * held before reads as the old key did.
 */
describe('one section per feature, in .github/governor.json', () => {
  const MINIMAL = { environment: 'env_1' };
  const PICKUP = { ready: ['mode: afk'], claim: 'claimed' };
  const ok = (file: Record<string, unknown>) => {
    const read = readConfig(JSON.stringify(file));
    assert.ok(read.ok, JSON.stringify(read));
    return read.config;
  };
  const fault = (file: Record<string, unknown>) => {
    const read = readConfig(JSON.stringify(file));
    assert.ok(!read.ok, JSON.stringify(file));
    return read.fault;
  };

  test('the file is .github/governor.json, and the older .github/dispatch.json is named only as the file governor no longer reads', () => {
    assert.equal(CONFIG_PATH, '.github/governor.json');
    assert.equal(OLD_CONFIG_PATH, '.github/dispatch.json');
  });

  test('pickup.ready, claim, claimRemoves and exclude read as labels.ready, claim, claimRemoves and exclude', () => {
    const config = ok({ ...MINIMAL, pickup: { ready: ['ready', 'mode: afk'], claim: 'building', claimRemoves: ['ready'], exclude: ['epic'] } });
    assert.deepEqual(config.labels, { ready: ['ready', 'mode: afk'], claim: 'building', claimRemoves: ['ready'], exclude: ['epic'] });
  });

  test('pickup.sweepHours keeps its place', () => {
    assert.deepEqual(ok({ ...MINIMAL, pickup: { ...PICKUP, sweepHours: 3 } }).pickup, { sweepHours: 3 });
  });

  test('signOff.heldMessage reads as signOff.heldMessage, false unless the file sets it, and only a boolean', () => {
    assert.deepEqual(ok({ ...MINIMAL, signOff: { heldMessage: true } }).signOff, { heldMessage: true });
    assert.equal(ok({ ...MINIMAL, signOff: { heldMessage: false } }).signOff, undefined);
    assert.equal(ok({ ...MINIMAL, signOff: {} }).signOff, undefined);
    assert.equal(ok(MINIMAL).signOff, undefined);
    assert.match(fault({ ...MINIMAL, signOff: { heldMessage: 'yes' } }), /heldMessage/);
  });

  test('every message kind has exactly one key, in the section of the feature it serves', () => {
    const keys = Object.values(PROMPT_KEYS);
    assert.deepEqual(Object.keys(PROMPT_KEYS).sort(), Object.keys(PROMPTS).sort(), 'each kind PROMPTS knows has a key, and no other');
    assert.equal(new Set(keys).size, keys.length, 'no two kinds share a key');
    for (const [kind, key] of Object.entries(PROMPT_KEYS)) {
      const [section] = key.split('.');
      assert.ok(SECTIONS.includes(String(section)), `${kind} sits in ${section}, a feature's section`);
      assert.match(key, /^\w+\.(prompt|prompts\.\w+)$/, kind);
    }
    assert.deepEqual(PROMPT_KEYS, {
      pickup: 'pickup.prompt',
      signOff: 'signOff.prompt',
      redScheduledRun: 'redScheduledRun.prompt',
      subscribed: 'subscribeMessages.prompt',
      conflicts: 'conflicts.prompt',
      unblockedReady: 'unblocked.prompts.ready',
      unblockedSpec: 'unblocked.prompts.spec',
      unblockedOwnerSpec: 'unblocked.prompts.ownerSpec',
      unblockedClaimed: 'unblocked.prompts.claimed',
      unblockedNotPlanned: 'unblocked.prompts.notPlanned',
      waitEndedSpec: 'waits.prompts.spec',
      waitEndedOwnerSpec: 'waits.prompts.ownerSpec',
      ciBreaker: 'ciMessages.prompts.breaker',
      ciTriage: 'ciMessages.prompts.triage',
      ciBumpTriage: 'ciMessages.prompts.bumpTriage',
      prodTriage: 'deployMessages.prompts.triage',
      deployGreen: 'deployMessages.prompts.green',
      deployGreenMany: 'deployMessages.prompts.greenMany',
      deployRed: 'deployMessages.prompts.red',
      deployRedMany: 'deployMessages.prompts.redMany',
    });
  });

  test('each section\'s prompt or prompts key reads as the message kind the old prompts key named', () => {
    // A prompt naming every fact its kind has, so the text is valid for it.
    const textFor = (kind: string) => `Do the ${kind} work.${PROMPTS[kind]?.fills.map((f) => ` {${f}}`).join('') ?? ''}`;
    const file: Record<string, any> = { ...MINIMAL, pickup: { ...PICKUP } };
    for (const [section, place] of Object.entries(SECTION_PROMPTS)) {
      file[section] ??= {};
      if ('prompt' in place) file[section].prompt = textFor(place.prompt);
      else file[section].prompts = Object.fromEntries(Object.entries(place.prompts).map(([key, kind]) => [key, textFor(kind)]));
    }
    const config = ok(file);
    assert.deepEqual(Object.keys(config.prompts).sort(), Object.keys(PROMPTS).sort());
    for (const kind of Object.keys(PROMPTS)) assert.equal(config.prompts[kind], textFor(kind), kind);
  });

  test('a prompt file is read under its new key, and a fault names that key', async () => {
    const file = { ...MINIMAL, unblocked: { prompts: { spec: { file: 'spec.md' } } }, periodics: { sessions: { Weekly: { prompt: { file: 'weekly.md' }, days: 7 } } }, hooks: { sessions: { alarm: { prompt: { file: 'alarm.md' }, keyVersion: 1 } } }, pickup: PICKUP };
    const read = readConfig(JSON.stringify(file));
    assert.ok(read.ok, JSON.stringify(read));
    const resolved = await resolveFiles(read.config, async () => null);
    assert.ok(!resolved.ok);
    assert.match(resolved.fault, /unblocked\.prompts\.spec: spec\.md is not on the default branch/);
    assert.match(resolved.fault, /periodics\.sessions\.Weekly\.prompt: weekly\.md/);
    assert.match(resolved.fault, /hooks\.sessions\.alarm\.prompt: alarm\.md/);
  });

  test('deployMessages.triage and tags read as workflows.triage and tags', () => {
    const config = ok({ ...MINIMAL, workflows: { ci: '.github/workflows/ci.yml' }, deployMessages: { triage: ['prod'], tags: { prod: 'deploy/prod' } } });
    assert.deepEqual(config.workflows, { ci: '.github/workflows/ci.yml', triage: ['prod'], tags: { prod: 'deploy/prod' } });
  });

  test('deployMessages.deployedLabels reads as the deployedLabels switch, true or false, and off with deployMessages off', () => {
    assert.equal(ok({ ...MINIMAL, deployMessages: { deployedLabels: true } }).features.deployedLabels, true);
    assert.equal(ok({ ...MINIMAL, deployMessages: { deployedLabels: false } }).features.deployedLabels, false);
    assert.equal(ok({ ...MINIMAL, deployMessages: {} }).features.deployedLabels, false);
    const off = ok({ ...MINIMAL, deployMessages: { enabled: false, deployedLabels: true } });
    assert.equal(off.features.deployMessages, false);
    assert.equal(off.features.deployedLabels, false, 'the labels are a deploy message\'s work');
    assert.ok(!SECTIONS.includes('deployedLabels'), 'deployedLabels is no section of its own');
    assert.match(fault({ ...MINIMAL, deployedLabels: {} }), /deployedLabels/);
  });

  test('prReview reads as the review, its prompt as the checklist', () => {
    const config = ok({ ...MINIMAL, pickup: PICKUP, prReview: { prompt: 'Check it.', merge: false } });
    assert.equal(config.features.prReview, true);
    assert.equal(config.review?.checklist, 'Check it.');
    assert.equal(config.review?.merge, false);
    assert.match(fault({ ...MINIMAL, pickup: PICKUP, review: { checklist: 'Check it.' }, features: { prReview: true } }), /Unrecognized key/);
  });

  test('periodics.sessions and hooks.sessions are keyed by name, and read as lists, each entry with its name', () => {
    const config = ok({
      ...MINIMAL,
      periodics: { sessions: { 'Code review': { prompt: 'Review.', days: 7 }, Retro: { prompt: 'Retro.', days: 14 } } },
      hooks: { sessions: { 'operator-prod': { prompt: 'Look.', keyVersion: 2 } } },
    });
    assert.deepEqual(config.periodics.map((p) => [p.name, p.days]), [['Code review', 7], ['Retro', 14]], 'in the order of the keys');
    assert.deepEqual(config.hooks.map((h) => [h.name, h.keyVersion]), [['operator-prod', 2]]);
    assert.equal(config.features.periodics, true);
    assert.equal(config.features.hooks, true);
  });

  test('an entry in periodics.sessions or hooks.sessions that sets name is refused: the key is the name', () => {
    assert.match(fault({ ...MINIMAL, periodics: { sessions: { Weekly: { name: 'Weekly', prompt: 'p', days: 7 } } } }), /periodics\.sessions\.Weekly: Unrecognized key: "name"/);
    assert.match(fault({ ...MINIMAL, hooks: { sessions: { alarm: { name: 'alarm', prompt: 'p', keyVersion: 1 } } } }), /hooks\.sessions\.alarm: Unrecognized key: "name"/);
  });

  test('each kind of name keeps its rules: a periodic\'s is one line, a hook\'s is safe in a URL path', () => {
    assert.match(fault({ ...MINIMAL, periodics: { sessions: { 'two\nlines': { prompt: 'p', days: 7 } } } }), /periodics\.sessions/);
    assert.match(fault({ ...MINIMAL, periodics: { sessions: { [' Padded ']: { prompt: 'p', days: 7 } } } }), /periodics\.sessions/);
    assert.match(fault({ ...MINIMAL, hooks: { sessions: { 'Not Safe': { prompt: 'p', keyVersion: 1 } } } }), /hooks\.sessions.*lower-case/);
  });

  test('a section with no enabled turns its feature on; one with "enabled": false turns it off; a missing section leaves it off', () => {
    for (const name of SECTIONS) {
      if (name === 'issueReviews') continue;
      const extra: Record<string, Record<string, unknown>> = { pickup: PICKUP, prReview: { prompt: 'p' }, heartbeat: { issue: 1 }, periodics: { sessions: { W: { prompt: 'p', days: 1 } } }, hooks: { sessions: { h: { prompt: 'p', keyVersion: 1 } } } };
      const settings = extra[name] ?? {};
      const needsPickup = LABEL_READERS.includes(name) && name !== 'pickup' ? { pickup: { enabled: false, ...PICKUP } } : {};
      const on = ok({ ...MINIMAL, ...needsPickup, [name]: settings });
      assert.equal(turnsOn(on, name), true, `${name} on by its section`);
      const off = ok({ ...MINIMAL, ...needsPickup, [name]: { ...settings, enabled: false } });
      assert.equal(turnsOn(off, name), false, `${name} off with enabled false`);
      const explicit = ok({ ...MINIMAL, ...needsPickup, [name]: { ...settings, enabled: true } });
      assert.equal(turnsOn(explicit, name), true, `${name} on with enabled true`);
      const missing = ok({ ...MINIMAL, ...needsPickup });
      assert.equal(turnsOn(missing, name), false, `${name} off with no section`);
    }
    const none = ok(MINIMAL);
    for (const name of GENERIC_SWITCHES) assert.equal(none.features[name], false, name);
    assert.equal(turnsOn(none, 'issueReviews'), false);
  });

  test('a section that is off needs none of its required settings', () => {
    for (const [name, missing] of [['prReview', /prompt/], ['heartbeat', /issue/], ['periodics', /periodic/], ['hooks', /hook/], ['pickup', /ready/]] as const) {
      assert.match(fault({ ...MINIMAL, [name]: {} }), missing, `${name} on needs its settings`);
      const off = ok({ ...MINIMAL, [name]: { enabled: false } });
      assert.equal(turnsOn(off, name), false, name);
    }
    assert.match(fault({ ...MINIMAL, periodics: { sessions: {} } }), /periodics is on, so its section lists at least one periodic/);
    assert.match(fault({ ...MINIMAL, pickup: { ready: ['mode: afk'] } }), /pickup\.claim: pickup is on, so the pickup section needs claim/);
  });

  test('a file in the layout before #525 is refused, naming a key it does not know', () => {
    const old = {
      environment: 'env_1',
      labels: { ready: ['mode: afk'], claim: 'claimed' },
      features: { pickup: true },
      prompts: { signOff: 'Sign off.' },
      review: { checklist: 'Check it.' },
    };
    const said = fault(old);
    for (const key of ['labels', 'features', 'prompts', 'review']) {
      assert.match(said, new RegExp(`"${key}"`), `names ${key}`);
      const { [key]: kept } = old as Record<string, unknown>;
      assert.match(fault({ environment: 'env_1', pickup: PICKUP, [key]: kept }), new RegExp(`Unrecognized key: "${key}"`), `${key} alone is refused`);
    }
  });

  test('each dropped key is refused', () => {
    assert.match(fault({ ...MINIMAL, features: { mergeHandoff: true } }), /Unrecognized key: "features"/);
    assert.match(fault({ ...MINIMAL, features: { ticketReviews: true } }), /Unrecognized key: "features"/);
    assert.match(fault({ ...MINIMAL, prompts: { mergeHandoff: 'Old.', mergeHandoffUnread: 'Old.' } }), /Unrecognized key: "prompts"/);
    assert.match(fault({ ...MINIMAL, mergeHandoff: {} }), /Unrecognized key: "mergeHandoff"/);
    assert.match(fault({ ...MINIMAL, ticketReviews: {} }), /Unrecognized key: "ticketReviews"/);
    // The retired hand-off prompts have no key in the section that took
    // their work over, nor beside any section's prompt.
    for (const key of ['mergeHandoff', 'mergeHandoffUnread']) {
      assert.match(fault({ ...MINIMAL, pickup: PICKUP, unblocked: { prompts: { [key]: 'Old.' } } }), new RegExp(`unblocked\\.prompts.*${key}`), key);
      assert.match(fault({ ...MINIMAL, signOff: { [key]: 'Old.' } }), new RegExp(`signOff.*${key}`), key);
    }
    assert.match(fault({ ...MINIMAL, pickup: { ...PICKUP, by: ['OWNER'] } }), /pickup: Unrecognized key: "by"/);
    assert.match(fault({ ...MINIMAL, heartbeat: { issue: 1, marker: '<!-- a -->' } }), /heartbeat: Unrecognized key: "marker"/);
  });

  test('a file turning on unblocked, waits, prReview or issueReviews with no pickup section is refused; a pickup section set off with its labels serves', () => {
    assert.deepEqual([...LABEL_READERS].sort(), ['issueReviews', 'prReview', 'unblocked', 'waits']);
    const sections: Record<string, unknown> = {
      unblocked: {},
      waits: {},
      prReview: { prompt: 'Check it.' },
      issueReviews: { reviews: { triage: { conclusions: { success: ['triage: passed'] } } } },
    };
    for (const [name, section] of Object.entries(sections)) {
      assert.match(fault({ ...MINIMAL, [name]: section }), new RegExp(`pickup: ${name} is on and reads pickup's labels, so the file needs a pickup section with ready and claim`), name);
      assert.match(fault({ ...MINIMAL, [name]: section, pickup: { enabled: false } }), /pickup\.ready: .*pickup's labels, so the pickup section needs ready/, `${name} with labels-less pickup`);
      const served = ok({ ...MINIMAL, [name]: section, pickup: { enabled: false, ...PICKUP } });
      assert.equal(turnsOn(served, name), true, name);
      assert.equal(turnsOn(served, 'pickup'), false, `${name}: pickup stays off`);
      assert.deepEqual(served.labels.ready, ['mode: afk']);
      assert.equal(served.labels.claim, 'claimed');
      // Off, it reads no labels, so it needs no pickup section.
      ok({ ...MINIMAL, [name]: { ...(section as object), enabled: false } });
    }
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
    assert.equal(switchOf({ kind: 'issueReview', issue: 3 }), 'issueReviews');
    assert.equal(switchOf({ kind: 'conflicts', pr: 1, sha: 'a'.repeat(40), base: 'main' }), 'conflicts');
    assert.equal(switchOf({ kind: 'dispatch', prompt: 'p', scheduled: { workflowId: 1, runId: 2, branch: 'main' } }), 'redScheduledRun');
    assert.equal(switchOf({ kind: 'dispatch', prompt: 'p' }), 'summons');
    assert.equal(switchOf({ kind: 'message', session: 'session_1', text: 't' }), 'prMessages');
    assert.equal(switchOf({ kind: 'message', byBranch: true, on: 3, text: 't' }), 'prMessages');
    assert.equal(switchOf({ kind: 'message', session: 'session_1', text: 't', subscribed: true }), 'subscribeMessages');
  });

  // A close starts nothing: it queues a fire per ticket it blocked, which
  // the ticket's own repo's switches govern, by the ticket's state.
  test('a close and an unblocked fire need no one switch: the ticket\'s state picks it', () => {
    assert.equal(switchOf({ kind: 'schedule', freed: 3 }), null);
    assert.equal(switchOf({ kind: 'unblocked', issue: 3, blocker: { repo: 'acme/tools', number: 4, title: 't' } }), null);
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

  test('a repo with only the older .github/dispatch.json is not served, and the warn line names the file to add', async () => {
    const oldLayout = JSON.stringify({ environment: 'env_1', labels: { ready: ['mode: afk'], claim: 'claimed' }, features: { pickup: true } });
    const r = reads({ 't-d-d/old': null, 't-d-d/old:.github/dispatch.json': oldLayout, 't-d-d/none': null });
    const { served, unread } = await servedRepos({ ...r, installations: async () => [{ account: 't-d-d', repos: ['t-d-d/old', 't-d-d/none'] }] });
    assert.deepEqual(served, []);
    assert.deepEqual(unread, []);
    const old = r.logged.find((l) => l.repo === 't-d-d/old');
    assert.equal(old?.event, 'dispatch-not-served');
    assert.equal(old?.level, 'warn');
    assert.match(String(old?.reason), /no \.github\/governor\.json on its default branch, and governor no longer reads \.github\/dispatch\.json: add \.github\/governor\.json/);
    assert.ok(!r.logged.some((l) => l.event === 'dispatch-config-invalid'), 'the old file is never read against the schema');
    assert.deepEqual(r.logged.find((l) => l.repo === 't-d-d/none'), { event: 'dispatch-not-served', level: 'info', repo: 't-d-d/none', reason: `no ${CONFIG_PATH} on its default branch` });
    const one = reads({ 't-d-d/old': null, 't-d-d/old:.github/dispatch.json': oldLayout });
    assert.equal(await repoServed({ ...one, repo: 't-d-d/old' }), null);
    assert.ok(one.logged.some((l) => l.event === 'dispatch-not-served' && l.level === 'warn'));
  });

  test('a repo with both files is served from .github/governor.json alone', async () => {
    const r = reads({ 't-d-d/askme-mcp': ASKME_FILE, 't-d-d/askme-mcp:.github/dispatch.json': '{ not read' });
    const served = await repoServed({ ...r, repo: 't-d-d/askme-mcp' });
    assert.ok(served, JSON.stringify(r.logged));
    assert.ok(!r.asked.includes(`file t-d-d/askme-mcp ${OLD_CONFIG_PATH}`));
  });

  test('an unknown prompt key is an alarmed dispatch-config-invalid naming the repo and the key, never a default', async () => {
    const r = reads({ 't-d-d/typo': askme({ signOff: { promt: 'Sign off.' } }) });
    const { served } = await servedRepos({ ...r, installations: async () => [{ account: 't-d-d', repos: ['t-d-d/typo'] }] });
    assert.deepEqual(served, []);
    const invalid = r.logged.find((l) => l.event === 'dispatch-config-invalid');
    assert.equal(invalid?.repo, 't-d-d/typo');
    assert.equal(invalid?.level, 'error');
    assert.match(String(invalid?.fault), /promt/);
  });

  test('a prompt in a file is read from the default branch beside the config file, and served as if the file held its text', async () => {
    const file = askme({
      deployMessages: { prompts: { green: { file: '.github/green.md' } } },
      prReview: { prompt: { file: 'docs/review.md' } },
    });
    const r = reads({ 't-d-d/askme-mcp': file, 't-d-d/askme-mcp:.github/green.md': 'Check {target} for PR #{pr}.\n', 't-d-d/askme-mcp:docs/review.md': '---\nname: review\n---\n\n# Review\n' });
    const served = await repoServed({ ...r, repo: 't-d-d/askme-mcp' });
    assert.equal(served?.config.prompts.deployGreen, 'Check {target} for PR #{pr}.');
    assert.equal(served?.config.review?.checklist, '# Review', 'a skill file\'s frontmatter is the CLI\'s metadata, not the prompt');
    assert.deepEqual(r.asked.filter((a) => a.startsWith('file')).sort(), ['file t-d-d/askme-mcp .github/green.md', 'file t-d-d/askme-mcp docs/review.md']);
  });

  test('a prompt file that is missing, empty, or names a fact its kind lacks is an alarmed dispatch-config-invalid naming the repo and the path; a failed read leaves the repo unread', async () => {
    const file = askme({ prReview: { prompt: { file: 'docs/review.md' } }, signOff: { prompt: { file: 'docs/sign-off.md' } } });
    for (const [files, named] of [
      [{ 't-d-d/askme-mcp:docs/sign-off.md': 'Sign off.' }, /prReview\.prompt.*docs\/review\.md/],
      [{ 't-d-d/askme-mcp:docs/review.md': ' \n', 't-d-d/askme-mcp:docs/sign-off.md': 'Sign off.' }, /prReview\.prompt.*docs\/review\.md.*empty/],
      [{ 't-d-d/askme-mcp:docs/review.md': 'R', 't-d-d/askme-mcp:docs/sign-off.md': 'Close PR #{pr}.' }, /signOff\.prompt.*\{pr\}/],
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
      assert.doesNotMatch(error.message, /governor\.json/, 'the file was read: the list was not');
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
