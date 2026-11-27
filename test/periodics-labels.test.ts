/**
 * `labels` on `issuesOpened` and `issuesClosed`: a limit that counts only
 * the issues carrying every label it lists, in any case, by the labels
 * each carries when the check runs. The issues list the window already
 * reads carries each issue's labels, so the filter makes no read of its
 * own. An issue is still counted only where `trust.auto` lets its author
 * in.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../dispatch/repo-config.mjs';
import { duePeriodics, filteredMeasures, narrowOf, periodicPrompt, windowOf } from '../dispatch/periodics.mjs';
import { wokenBy } from '../dispatch/webhook/measures.mjs';

const REPO = 'acme/factory';
const NOW = Date.parse('2026-10-27T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const hoursAgo = (n: number) => new Date(NOW - n * HOUR).toISOString();
const finished = async () => false;
const log = () => {};

type Record_ = { at: string; session: string | null; baseline: boolean };
const store = (initial: Record<string, Record_>) => ({
  periodic: async (_repo: string, name: string) => initial[name] ?? null,
  recordPeriodic: async () => true,
});
const fired = (hours: number): Record_ => ({ at: hoursAgo(hours), session: 'https://claude.ai/code/session_01RUN', baseline: false });

type Issue = { number: number; labels: string[]; association?: string; at?: string };

/**
 * A repo whose issues were opened, and closed, in the order given, the
 * first longest ago, each carrying the labels given as the check reads
 * them. The reader judges `by` as the real one does.
 */
const repoOf = (issues: Issue[]) => {
  const reads: string[] = [];
  const fileReads: number[] = [];
  const rows = (since: string, by?: readonly string[]) => issues
    .map((issue, i) => ({ number: issue.number, title: `Issue ${issue.number}`, at: issue.at ?? hoursAgo(issues.length - i), labels: issue.labels, association: issue.association ?? 'OWNER' }))
    .filter((row) => Date.parse(row.at) > Date.parse(since))
    .filter((row) => by === undefined || by.includes(row.association))
    .map(({ association: _association, ...row }) => row);
  const reader = {
    defaultBranch: async () => 'main',
    mergedSince: async () => [],
    issuesOpenedSince: async (since: string, by?: readonly string[]) => { reads.push(`opened ${since}`); return rows(since, by); },
    issuesClosedSince: async (since: string, by?: readonly string[]) => { reads.push(`closed ${since}`); return rows(since, by); },
    pullFiles: async (n: number) => { fileReads.push(n); return []; },
  };
  return { reader, reads, fileReads };
};

const check = async (repo: ReturnType<typeof repoOf>, periodics: unknown[], records: Record<string, Record_>, event: string | undefined = 'issuesOpened') => duePeriodics({
  repo: REPO,
  periodics: periodics as never,
  state: store(records),
  now: NOW,
  log,
  window: windowOf(repo.reader as never, 'main'),
  narrow: narrowOf(repo.reader as never),
  busy: finished,
  ...(event === undefined ? {} : { event: event as never }),
});

const bugs = { name: 'Bug review', prompt: 'Review the bugs.', counts: { issuesOpened: 2 }, filters: { issuesOpened: { labels: ['type: bug'] } } };

describe('an issues limit with labels', () => {
  test('is not due after two issues opened without the label, and is due after two that carry it', async () => {
    const quiet = repoOf([{ number: 1, labels: [] }, { number: 2, labels: ['type: enhancement'] }]);
    assert.deepEqual((await check(quiet, [bugs], { 'Bug review': fired(10) })).due, []);
    const busy = repoOf([{ number: 1, labels: ['type: bug'] }, { number: 2, labels: [] }, { number: 3, labels: ['mode: afk', 'type: bug'] }]);
    const { due } = await check(busy, [bugs], { 'Bug review': fired(10) });
    assert.deepEqual(due.map((d) => d.windows?.issuesOpened?.map((i) => i.number)), [[1, 3]]);
    assert.deepEqual(due[0]!.by, { count: 'issuesOpened', number: 2 });
    assert.deepEqual(busy.fileReads, [], 'the filter makes no read of its own');
  });

  test('an issue must carry every label listed to count, and a label matches in any case', async () => {
    const both = { ...bugs, counts: { issuesOpened: 1 }, filters: { issuesOpened: { labels: ['Type: Bug', 'SEV: 1'] } } };
    const one = repoOf([{ number: 1, labels: ['type: bug'] }, { number: 2, labels: ['sev: 1'] }]);
    assert.deepEqual((await check(one, [both], { 'Bug review': fired(10) })).due, [], 'one label of two is not enough');
    const all = repoOf([{ number: 1, labels: ['type: bug'] }, { number: 2, labels: ['sev: 1', 'TYPE: BUG'] }]);
    assert.deepEqual((await check(all, [both], { 'Bug review': fired(10) })).due.map((d) => d.windows?.issuesOpened?.map((i) => i.number)), [[2]]);
  });

  test('an issue opened without the label and labelled a minute later is counted by the check its label change queues, where the count is 1', async () => {
    const every = { ...bugs, counts: { issuesOpened: 1 } };
    const labelled = { action: 'labeled', label: { name: 'type: bug' }, issue: { number: 1, state: 'open', labels: [{ name: 'type: bug' }] } };
    const woken = wokenBy('issues', labelled, 'main').filter((w) => w.by === 'labels').map((w) => w.name);
    assert.ok(woken.includes('issuesOpened'), JSON.stringify(woken));
    // The check reads the labels the issue carries now, not the ones it opened with.
    const repo = repoOf([{ number: 1, labels: ['type: bug'], at: hoursAgo(1) }]);
    const { due } = await check(repo, [every], { 'Bug review': fired(10) }, 'issuesOpened');
    assert.deepEqual(due.map((d) => d.windows?.issuesOpened?.map((i) => i.number)), [[1]]);
  });

  test('a label added or removed on an issue wakes its measures only where a limit of them has labels; on a closed issue it wakes issuesClosed too', () => {
    const change = (action: string, state: string) => ({ action, label: { name: 'type: bug' }, issue: { number: 1, state, labels: [] } });
    const by = (payload: unknown) => wokenBy('issues', payload, 'main').map((w) => [w.name, w.by]);
    for (const action of ['labeled', 'unlabeled']) {
      assert.deepEqual(by(change(action, 'open')), [['issuesOpened', 'labels']], action);
      assert.deepEqual(by(change(action, 'closed')), [['issuesOpened', 'labels'], ['issuesClosed', 'labels']], action);
    }
    assert.deepEqual(wokenBy('pull_request', { action: 'labeled', label: { name: 'x' }, pull_request: { number: 2 } }, 'main'), [], 'a pull request\'s label wakes nothing');
    assert.deepEqual(wokenBy('issues', { action: 'opened', issue: { number: 1 } }, 'main').map((w) => w.by), [undefined], 'an issue opened wakes its measure by the event, not by a filter');
  });

  test('issuesClosed with labels counts a closed issue by the labels it carries at the check', async () => {
    const incidents = { name: 'Incident review', prompt: 'p', counts: { issuesClosed: 1 }, filters: { issuesClosed: { labels: ['incident'] } } };
    const before = repoOf([{ number: 1, labels: [] }]);
    assert.deepEqual((await check(before, [incidents], { 'Incident review': fired(10) }, 'issuesClosed')).due, []);
    const after = repoOf([{ number: 1, labels: ['Incident'] }]);
    assert.deepEqual((await check(after, [incidents], { 'Incident review': fired(10) }, 'issuesClosed')).due.map((d) => d.windows?.issuesClosed?.map((i) => i.number)), [[1]]);
  });

  test('an issue whose author trust.auto does not let in is not counted, whatever its labels', async () => {
    const every = { ...bugs, counts: { issuesOpened: 1 } };
    const repo = repoOf([{ number: 1, labels: ['type: bug'], association: 'NONE' }]);
    assert.deepEqual((await check(repo, [every], { 'Bug review': fired(10) })).due, []);
  });

  test('the prompt lists only the issues counted and names the labels', async () => {
    const both = { ...bugs, counts: { issuesOpened: 1 }, filters: { issuesOpened: { labels: ['type: bug', 'sev: 1'] } } };
    const repo = repoOf([{ number: 1, labels: ['type: bug'] }, { number: 2, labels: ['type: bug', 'sev: 1'] }]);
    const read = fired(10);
    const { due } = await check(repo, [both], { 'Bug review': read });
    const prompt = periodicPrompt(both.prompt, read, due[0]!.windows, both.filters);
    assert.match(prompt, new RegExp(`Issues opened carrying the labels \`type: bug\` and \`sev: 1\` since ${read.at}: 1\\n- #2 Issue 2$`));
    assert.doesNotMatch(prompt, /#1 /);
  });

  test('a limit with labels and one without share the one issues list', async () => {
    const all = { name: 'Every issue', prompt: 'p', counts: { issuesOpened: 9 } };
    const repo = repoOf([{ number: 1, labels: ['type: bug'] }, { number: 2, labels: [] }, { number: 3, labels: ['type: bug'] }]);
    const { due } = await check(repo, [bugs, all], { 'Bug review': fired(10), 'Every issue': fired(10) });
    assert.deepEqual(repo.reads, [`opened ${hoursAgo(10)}`]);
    assert.deepEqual(due.map((d) => d.periodic.name), ['Bug review']);
  });
});

describe('the config file\'s labels', () => {
  const file = (when: unknown, enabled = true) => JSON.stringify({ environment: 'env_01ASK', periodics: { ...(enabled ? {} : { enabled: false }), sessions: { 'Bug review': { prompt: 'p', when } } } });

  test('the object form of issuesOpened and of issuesClosed takes labels, read into the periodic\'s filters', () => {
    for (const kind of ['issuesOpened', 'issuesClosed']) {
      const read = readConfig(file({ [kind]: { count: 10, labels: ['type: bug'] } }));
      assert.ok(read.ok, read.ok ? '' : read.fault);
      assert.deepEqual(read.config.periodics, [{ name: 'Bug review', prompt: 'p', counts: { [kind]: 10 }, filters: { [kind]: { labels: ['type: bug'] } } }]);
    }
  });

  test('a labels that is empty, or that sits on merges, makes the file invalid', () => {
    for (const when of [
      { issuesOpened: { count: 1, labels: [] } },
      { issuesClosed: { count: 1, labels: [''] } },
      { issuesOpened: { count: 1, labels: 'type: bug' } },
      { merges: { count: 1, labels: ['type: bug'] } },
      { days: { count: 1, labels: ['type: bug'] } },
    ]) {
      const read = readConfig(file(when));
      assert.ok(!read.ok, JSON.stringify(when));
    }
  });

  test('the measures with a limit that has labels, in the table\'s order, listed under labels, and none with periodics off', () => {
    const config = (when: Record<string, unknown>, enabled = true) => {
      const read = readConfig(JSON.stringify({ environment: 'env_01ASK', periodics: { ...(enabled ? {} : { enabled: false }), sessions: { A: { prompt: 'p', when }, B: { prompt: 'p', when: { issuesOpened: 3 } } } } }));
      assert.ok(read.ok, read.ok ? '' : read.fault);
      return read.config as never;
    };
    assert.deepEqual(filteredMeasures(config({ issuesClosed: { count: 1, labels: ['incident'] }, issuesOpened: { count: 2, labels: ['bug'] } })), { labels: ['issuesOpened', 'issuesClosed'] });
    assert.deepEqual(filteredMeasures(config({ issuesClosed: 1, merges: { count: 1, paths: ['infra/**'] } })), { labels: [] }, 'paths wakes nothing: a merge wakes merges by its own event');
    assert.deepEqual(filteredMeasures(config({ issuesClosed: { count: 1, labels: ['incident'] } }, false)), { labels: [] });
  });
});
