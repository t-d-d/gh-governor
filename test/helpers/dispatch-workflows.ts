/**
 * The workflows a dispatcher turn is fired for, as the tests of a run on
 * main read them (test/dispatch-turn.test.ts, test/dispatch-workflow.test.ts,
 * test/dispatch-coverage.test.ts).
 */

/** The factory's `workflows` section (.github/dispatch.json): its CI, its triage target and its tags. */
export const FACTORY_WORKFLOWS = { ci: '.github/workflows/ci.yml', triage: ['prod'], tags: { dev: 'deploy/dev', prod: 'deploy/prod' } };

/** The commit and run the message fixtures below name. */
export const MESSAGE_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
export const MESSAGE_RUN_URL = 'https://github.com/acme/factory/actions/runs/500';

/** PR `number`, merged at MESSAGE_SHA, as `pullsForCommit` reads it. */
export const mergedPull = (number: number, author = 'someone') => ({
  number, title: `PR ${number}`, html_url: `https://github.com/acme/factory/pull/${number}`, body: '', merged_at: `2026-10-27T1${number}:00:00Z`, merge_commit_sha: MESSAGE_SHA, head: '', author,
});

/**
 * What coverage read of run 500: `shipped` merged, every one picked, each its
 * own session's or subscribed to, and one failed job. Built by hand, so a
 * message's text is read without a reader (test/dispatcher-*-fitness.test.ts).
 */
export const coverageOver = (shipped: ReturnType<typeof mergedPull>[], { label = null as string | null, subscribed = false } = {}) => ({
  reason: null, stale: null, workflow: 'deliver.yml', label, declared: label === null ? null : {}, jobs: [{ name: 'backend', conclusion: 'failure', html_url: `${MESSAGE_RUN_URL}/job/1` }],
  from: null, at: null, baseline: { id: 498, commit: 'b', created: '', conclusion: 'success', url: 'u' },
  range: { baseline: { id: 498, commit: 'b', created: '' }, end: MESSAGE_SHA, merges: shipped.length }, merges: [],
  shipped, picked: shipped, closes: new Map(),
  sessions: async (prs: unknown[]) => ({ sessions: new Map([['S', { session: 'S', own: subscribed ? [] : prs, subscribed: subscribed ? prs : [] }]]), owned: new Set(), unnamed: [] }),
});

/** Each workflow a run is fired for, by name, and its file: what the receiver names in the fire. */
export const WORKFLOW_PATHS: Record<string, string> = {
  CI: '.github/workflows/ci.yml',
  Deliver: '.github/workflows/deliver.yml',
  'Deploy Stage': '.github/workflows/deploy-stage.yml',
  'Dispatch stack': '.github/workflows/deploy.yml',
  'Android release': '.github/workflows/android-release.yml',
  'Apple release': '.github/workflows/apple-release.yml',
};

/**
 * Each workflow file as far as the task reads it: its triggers, the paths
 * its label goes to, and the jobs whose names carry the shipping
 * marker. The marker's `: ` makes a plain scalar a mapping to
 * YAML, so a marked name is quoted. The real files' declarations are
 * test/ticket-label-fitness.test.ts's to hold.
 */
const WORKFLOW_FILES: Record<string, string> = {
  [WORKFLOW_PATHS.CI!]: 'name: CI\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs: {}\n',
  [WORKFLOW_PATHS.Deliver!]: [
    'name: Deliver',
    'on:',
    '  workflow_run:',
    '    workflows: [CI]',
    '    types: [completed]',
    '  workflow_dispatch:',
    'env:',
    '  TICKET_LABEL_PATHS: all',
    'jobs:',
    '  train:',
    '    name: Resolve the train',
    '    runs-on: ubuntu-latest',
    '    steps: []',
    '  dev:',
    '    needs: train',
    '    uses: ./.github/workflows/deploy-stage.yml',
    '    with:',
    '      stage: dev',
    '      head_sha: ${{ needs.train.outputs.commit }}',
    '  gate:',
    '    needs: dev',
    '    runs-on: ubuntu-latest',
    '    steps: []',
    '  e2e:',
    '    needs: gate',
    '    uses: ./.github/workflows/e2e.yml',
    '  prod:',
    '    needs: e2e',
    '    uses: ./.github/workflows/deploy-stage.yml',
    '    with:',
    '      stage: prod',
    '      head_sha: ${{ needs.train.outputs.commit }}',
    '',
  ].join('\n'),
  [WORKFLOW_PATHS['Deploy Stage']!]: [
    'name: Deploy Stage',
    'on:',
    '  workflow_call:',
    '    inputs:',
    '      stage:',
    '        type: string',
    '      head_sha:',
    '        type: string',
    'jobs:',
    '  deploy-stack:',
    '    name: Deploy stack (${{ inputs.stage }})',
    '    runs-on: ubuntu-latest',
    '    steps: []',
    '  publish:',
    '    name: "Publish (${{ inputs.stage }}) at ${{ inputs.head_sha }} · deployed: ${{ inputs.stage }}"',
    '    runs-on: ubuntu-latest',
    '    steps: []',
    '',
  ].join('\n'),
  '.github/workflows/e2e.yml': 'name: E2E\non:\n  workflow_call:\njobs:\n  suite:\n    name: Run the members\n    runs-on: ubuntu-latest\n    steps: []\n',
  [WORKFLOW_PATHS['Dispatch stack']!]: "name: Dispatch stack\non:\n  push:\n    branches: [main]\n    paths:\n      - 'dispatch/**'\n      - 'scripts/lib/github-app.mjs'\n  workflow_dispatch:\nenv:\n  TICKET_LABEL_PATHS: trigger\njobs:\n  deploy:\n    name: \"${{ inputs.probe_only && 'Probe only: ' || '' }}Build the image, apply the stack, probe the task at ${{ github.sha }} · deployed: the dispatcher\"\n    runs-on: ubuntu-latest\n    steps: []\n",
  [WORKFLOW_PATHS['Android release']!]: "name: Android release\non:\n  workflow_dispatch:\nenv:\n  TICKET_LABEL_PATHS: 'clients/android/**'\njobs:\n  play:\n    name: \"Publish to Play testing track at ${{ github.sha }} · deployed: play track\"\n    runs-on: ubuntu-latest\n    steps: []\n",
  [WORKFLOW_PATHS['Apple release']!]: "name: Apple release\non:\n  workflow_dispatch:\nenv:\n  TICKET_LABEL_PATHS: |\n    clients/apple/**\n    clients/shared/**\njobs:\n  release:\n    name: \"Apple release at ${{ needs.resolve.outputs.commit }} · deployed: app store connect\"\n    runs-on: ubuntu-latest\n    steps: []\n",
};

/** A workflow file's text, as the reader's `fileAt` answers; one with no fixture is a 404. */
export const workflowFile = async (path: string) => {
  const text = WORKFLOW_FILES[path];
  if (text === undefined) throw new Error(`GET /contents/${path} failed: 404`);
  return text;
};

/** The label each fixture workflow's final shipping job earns, as a red run of it is read. */
export const FINAL_LABELS: Record<string, string> = {
  Deliver: 'deployed: prod',
  'Dispatch stack': 'deployed: the dispatcher',
  'Android release': 'deployed: play track',
  'Apple release': 'deployed: app store connect',
};

/** A compare whose one commit is the merge at its head: a run that shipped one PR. */
export const headMerge = async (_base: string, head: string) => [{ sha: head, message: 'Merge pull request #1 from acme/branch' }];
