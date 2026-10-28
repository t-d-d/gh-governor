import { test } from 'node:test';
import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import rule from '../../eslint-rules/require-cli-env.mjs';

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
});

test('require-cli-env', () => {
  ruleTester.run('require-cli-env', rule as never, {
    valid: [
      {
        name: 'a message send under cliEnv',
        code: `spawn('claude', ['-p', '--cloud', session], { cwd, env: cliEnv(env, home, account), stdio: 'pipe' });`,
      },
      {
        name: 'the launcher under cliEnv, with its own variables folded in',
        code: `spawn('python3', [launcherPath(), promptFile], { cwd, env: cliEnv({ ...env, CLAUDE_MODEL: model }, home, account) });`,
      },
      {
        name: 'a spawnSync of the CLI under cliEnv',
        code: `spawnSync('claude', ['--version'], { encoding: 'utf8', env: cliEnv(env, home, account) });`,
      },
      {
        // The argument list is optional: the options then come second.
        name: 'the CLI under cliEnv with no argument list',
        code: `execFileSync('claude', { encoding: 'utf8', env: cliEnv(env, home, account) });`,
      },
      {
        // Only the CLI resolves an org; git and a bare python probe do not.
        name: 'a program that is not the CLI',
        code: `spawnSync('git', ['init'], { cwd, stdio: 'ignore' });
          spawnSync('python3', ['-c', PROBE], { encoding: 'utf8' });`,
      },
    ],
    invalid: [
      {
        name: 'the CLI with a hand-built environment',
        code: `spawn('claude', ['-p'], { cwd, env: { ...env, HOME: home } });`,
        errors: [{ messageId: 'noCliEnv' }],
      },
      {
        name: 'the CLI inheriting the task environment',
        code: `spawnSync('claude', ['--version'], { encoding: 'utf8' });`,
        errors: [{ messageId: 'noCliEnv' }],
      },
      {
        name: 'the CLI with no options at all',
        code: `spawn('claude', ['-p']);`,
        errors: [{ messageId: 'noCliEnv' }],
      },
      {
        // Every child_process call that takes (file, args, options) runs the CLI as spawn does.
        name: 'the CLI through execFile, execFileSync, or a namespaced spawn',
        code: `execFile('claude', ['-p'], { cwd });
          execFileSync('claude', ['--version'], { encoding: 'utf8' });
          childProcess.spawn('claude', ['-p'], { cwd, env: { ...env, HOME: home } });`,
        errors: [{ messageId: 'noCliEnv' }, { messageId: 'noCliEnv' }, { messageId: 'noCliEnv' }],
      },
      {
        name: 'the launcher, which runs the CLI, with a hand-built environment',
        code: `spawn('python3', [launcherPath(), promptFile], { cwd, env: { ...env, HOME: home } });`,
        errors: [{ messageId: 'noCliEnv' }],
      },
    ],
  });
});
