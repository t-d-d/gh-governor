/**
 * The factory's CI, deploy and conflicts messages, read from its file's
 * `workflows` section. Each is built through the code that sends it, from
 * the factory's own file, and held to the text in
 * test/fixtures/factory-messages.json.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONFIG_PATH, readConfig, resolveFiles } from '../dispatch/repo-config.mjs';
import { planWorkflow } from '../dispatch/workflow.mjs';
import { conflictMessage } from '../dispatch/conflicts.mjs';
import { DEPENDABOT } from '../dispatch/webhook/fire.mjs';
import { MESSAGE_RUN_URL as RUN_URL, MESSAGE_SHA as SHA, coverageOver as coverage, mergedPull as pull } from './helpers/dispatch-workflows.ts';
import { factoryFile } from './helpers/factory.ts';

const GOLDEN: Record<string, string> = JSON.parse(readFileSync('test/fixtures/factory-messages.json', 'utf8'));
const parsed = readConfig(factoryFile(CONFIG_PATH));
assert.ok(parsed.ok, JSON.stringify(parsed));
// As a turn serves it: the prompt files read off the checkout, as off the default branch.
const read = await resolveFiles(parsed.config, async (path) => factoryFile(path));
assert.ok(read.ok, JSON.stringify(read));
const { prompts, workflows } = read.config;

const red = (name: string, path: string) => ({ kind: 'workflow', name, path, branch: 'main', event: 'push', runId: 500, url: RUN_URL, conclusion: 'failure', headSha: SHA });
const job = (label: string) => ({ kind: 'job', name: `Publish · ${label}`, workflow: 'Deliver', branch: 'main', runId: 500, jobId: 1, url: `${RUN_URL}/job/1`, headSha: SHA, label, commit: SHA });
const CI = red('CI', '.github/workflows/ci.yml');
const DELIVER = red('Deliver', '.github/workflows/deliver.yml');
const plan = (invocation: unknown, covered: unknown) => planWorkflow({ invocation: invocation as never, coverage: covered as never, prompts, workflows });

/** Each message, by its name in the fixture. */
const BUILT: Record<string, () => Promise<string>> = {
  ciBreaker: async () => (await plan(CI, coverage([pull(1)]))).notes[0]!.text,
  ciBreakerFallback: async () => String((await plan(CI, coverage([pull(1)]))).notes[0]!.fallback?.prompt),
  ciSubscriber: async () => (await plan(CI, coverage([pull(1)], { subscribed: true }))).notes[0]!.text,
  ciTriage: async () => String((await plan(CI, coverage([pull(1), pull(2)]))).triage?.prompt),
  ciBumpTriage: async () => String((await plan(CI, coverage([pull(1, DEPENDABOT)]))).triage?.prompt),
  prodTriage: async () => String((await plan(DELIVER, coverage([pull(1)], { label: 'deployed: prod' }))).triage?.prompt),
  deployGreenDev: async () => (await plan(job('deployed: dev'), coverage([pull(1)], { label: 'deployed: dev' }))).notes[0]!.text,
  deployGreenProd: async () => (await plan(job('deployed: prod'), coverage([pull(1), pull(2)], { label: 'deployed: prod' }))).notes[0]!.text,
  deployGreenDispatcher: async () => (await plan(job('deployed: dispatcher'), coverage([pull(1)], { label: 'deployed: dispatcher' }))).notes[0]!.text,
  deployRedDev: async () => (await plan(DELIVER, coverage([pull(1)], { label: 'deployed: dev' }))).notes[0]!.text,
  deployRedDispatcher: async () => (await plan(DELIVER, coverage([pull(1), pull(2)], { label: 'deployed: dispatcher' }))).notes[0]!.text,
  deploySubscriber: async () => (await plan(job('deployed: dev'), coverage([pull(1)], { label: 'deployed: dev', subscribed: true }))).notes[0]!.text,
  conflicts: async () => conflictMessage({ pr: { number: 1, title: 'PR 1', html_url: 'u1' }, base: 'main', head: 'c'.repeat(40), merged: { pr: 2, sha: SHA } }, prompts).text,
  conflictsFallback: async () => conflictMessage({ pr: { number: 1, title: 'PR 1', html_url: 'u1' }, base: 'main', head: 'c'.repeat(40), merged: { pr: 2, sha: SHA } }, prompts).fallback.prompt,
};

describe('fitness: the factory\'s CI, deploy and conflicts messages read from its workflows section (dispatcher-workflows.md)', () => {
  test('every pinned message is built here', () => {
    assert.deepEqual(Object.keys(BUILT).sort(), Object.keys(GOLDEN).sort());
  });
  test('the factory\'s file names its CI, its triage target and its tags', () => {
    assert.deepEqual(workflows, { ci: '.github/workflows/ci.yml', triage: ['prod'], tags: { dev: 'deploy/dev', prod: 'deploy/prod' } });
  });
  for (const [name, build] of Object.entries(BUILT)) {
    test(name, async () => assert.equal(await build(), GOLDEN[name]));
  }
});
