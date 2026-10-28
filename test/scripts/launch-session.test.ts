/**
 * The pty launcher's argv, exercised by running it against a fake `claude`.
 *
 * `dispatch/launch-session.py` is what every dispatch, the schedule's
 * and a mention's, puts on the command line, so it is the one thing they all
 * depend on.
 * It had no test at all; these cover the flags it composes, by putting a
 * recording stub on PATH rather than by reading the source, so a rename or a
 * reordering fails here rather than at 05:17.
 *
 * `--name` is the interesting one. A cloud session otherwise names itself by
 * summarising the prompt, which drops the issue number every time — an
 * identifier reads as boilerplate to a summariser. Naming it outright is the
 * only thing that puts `#705` in the sessions pane, and that only works if
 * the flag actually reaches `claude`.
 *
 * The prompt's POSITION is the other thing the CLI reads. `--cloud
 * [description|session_id|url]` takes the task AS ITS VALUE — that value is
 * what seeds the new cloud session, and the CLI refuses a bare `--cloud`
 * outright: "Error: --cloud requires a description." A positional prompt is
 * read only by a LOCAL session, so an argv that leads with it dispatches
 * nothing. The prompt therefore stays immediately behind the cloud flag, which
 * is also how `--remote` took it. The stub's `--help` is what each test varies
 * to say which CLI generation it is standing in for.
 *
 * The exit status is what the caller reads. `dispatch/turn.mjs` counts a
 * dispatch as failed only on a non-zero exit — so a launcher that exits 0
 * whatever happened reports a session nobody started.
 *
 * It says three things, not two. A window that elapses with `claude`
 * still running is not the same event as a `claude` that died. The
 * confirmation line is the only signal there is, so a missing one leaves a
 * session that may well exist. Both are non-zero, because neither is a
 * dispatch anyone can confirm, but they get their own codes so each caller
 * can word its own report.
 *
 * Saying anything at all is the third thing. That window is idle time, so a
 * `claude` that writes without ever confirming — a spinner, a repainting TUI
 * frame — restarted the clock forever and neither caller got a code.
 *
 * `--ref main` is the fourth. Before creating the session the CLI asks the
 * Claude backend whether the GitHub App covers the checkout's remote. On a
 * "no" it does not fail: it uploads the working tree as a bundle and starts
 * a session with no GitHub source, so the worker can neither push nor raise
 * a PR, and the launcher, which only watches for the confirmation line,
 * reports it dispatched. With a revision named, the CLI refuses instead
 * ("--ref main cannot be honored: ...") and exits, which the launcher reads
 * as nothing started. It is also what the dispatch should have been doing
 * all along: every worker starts from origin's main, not from whatever
 * branch the runner's checkout is on.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DISPATCHER = fileURLToPath(
  new URL('../../dispatch/launch-session.py', import.meta.url),
);

/**
 * A CLI that dispatches with `--cloud`, as 2.1.x does.
 *
 * `--remote-control` is in there deliberately: it is a different flag that
 * merely starts with the old name, so a probe matching on a prefix would read
 * this help as offering `--remote` and compose the argv of a CLI generation
 * that is gone.
 */
const CLOUD_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  --cloud [description|session_id|url]  Create a cloud session with the given',
  '                                        description, or attach to an existing one',
  '  --model <model>                       Model for the current session',
  '  -n, --name <name>                     Set a display name for this session',
  '  --remote-control [name]               Start an interactive session with Remote',
  '                                        Control enabled (optionally named)',
].join('\n');

/** The CLI generation the launcher was written against: `--remote`, no `--cloud`. */
const REMOTE_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  --model <model>                       Model for the current session',
  '  -n, --name <name>                     Set a display name for this session',
  '  --remote                              Dispatch this session to the cloud',
].join('\n');

/**
 * What a `claude` that cannot answer `--help` says before it exits non-zero.
 *
 * A broken install — a half-applied npm update, a node the CLI won't run on —
 * prints its reason and nothing else does. The launcher's own stderr is the
 * whole record of an overnight batch, so the reason has to survive into it.
 */
const PROBE_FAILURE =
  "claude: error: Cannot find module '@anthropic-ai/claude-code/cli.js'";

/** A CLI offering no cloud dispatch at all — the next removal after this one. */
const NEITHER_HELP = [
  'Usage: claude [options] [command] [prompt]',
  '  --model <model>                       Model for the current session',
  '  --remote-control [name]               Start an interactive session with Remote',
].join('\n');

/**
 * A python that reports a closed pty the way macOS does, so the Mac's own
 * failure path is reproducible off a Mac.
 *
 * The two platforms say the same thing differently. Once the child is gone,
 * `os.read` on the pty master raises `EIO` on Linux and returns `b""` on
 * macOS — and there `select` goes on calling the fd readable, so an empty read
 * is not a lull but the end. `sitecustomize` is imported by the interpreter
 * itself before the script runs, which keeps the substitution out of the
 * launcher: nothing in `dispatch/launch-session.py` knows a test is
 * watching. On a real Mac `EIO` never arrives, so this is inert.
 */
const MACOS_PTY_EOF_SHIM = [
  'import errno, os',
  '_real_read = os.read',
  'def _read(fd, n):',
  '    try:',
  '        return _real_read(fd, n)',
  '    except OSError as err:',
  '        if err.errno == errno.EIO:',
  '            return b""',
  '        raise',
  'os.read = _read',
  '',
].join('\n');

/**
 * Run the launcher with a stub `claude` first on PATH, and return what the
 * stub recorded, the launcher's exit status, and how it ended.
 *
 * `body` is the stub's shell body after the argv recording. The default one
 * exits at once without confirming; closing the pty is what ends the
 * launcher's read loop, so the argv tests cost milliseconds rather than the
 * confirmation timeout.
 *
 * `help` is what the stub answers `--help` with, and so which CLI generation
 * the run is against. A `help` of null is the broken install: the stub fails
 * the probe, saying {@link PROBE_FAILURE} on stderr the way a real one would.
 * The probe is not recorded as argv: a launcher that never gets as far as a
 * dispatch leaves no recording at all, which is what the returned `launched`
 * reports.
 *
 * `stderr` is the launcher's own, captured rather than inherited so the
 * diagnostics it prints can be asserted on. Only fd 2 is piped: claude's
 * output goes to fd 1, which stays ignored so a streaming stub cannot fill a
 * buffer nobody reads.
 *
 * `signal` and `ms` exist for the deadline tests. `execFileSync`'s own
 * `timeout` kills the launcher and reports the same shape as a non-zero exit,
 * so a test that only read `status` would pass against the very hang it is
 * meant to catch. A `signal` of null is the launcher deciding for itself.
 *
 * `ptyEofIsEmptyRead` runs the launcher on a python whose `os.read` reports a
 * closed pty the way macOS does. See {@link MACOS_PTY_EOF_SHIM}.
 *
 * The hold after the marker is zero unless `env` sets one: at the production
 * five seconds it was most of this file's run time.
 */
const runLauncher = (
  env: Record<string, string>,
  body = 'exit 0\n',
  help: string | null = CLOUD_HELP,
  harnessTimeoutMs = 60_000,
  ptyEofIsEmptyRead = false,
) => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-remote-test-'));
  try {
    if (ptyEofIsEmptyRead) writeFileSync(join(dir, 'sitecustomize.py'), MACOS_PTY_EOF_SHIM);
    const recorded = join(dir, 'argv');
    const recordedEnv = join(dir, 'env');
    const helpFile = join(dir, 'help.txt');
    writeFileSync(helpFile, `${help ?? PROBE_FAILURE}\n`);
    const stub = join(dir, 'claude');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        // The probe must not overwrite the dispatch's own recording.
        help === null
          ? `if [ "$1" = "--help" ]; then cat ${helpFile} >&2; exit 1; fi`
          : `if [ "$1" = "--help" ]; then cat ${helpFile}; exit 0; fi`,
        `printf '%s\\n' "$@" > ${recorded}`,
        // The one variable the launcher is expected to set for the child, so a
        // test can tell "set by the launcher" from "inherited from the runner".
        // `-` rather than `:-`, so an inherited empty value reads as empty,
        // not as `unset`.
        `printf '%s\\n' "\${DISABLE_GROWTHBOOK-unset}" > ${recordedEnv}`,
        body,
      ].join('\n'),
    );
    chmodSync(stub, 0o755);

    const promptFile = join(dir, 'prompt.txt');
    // No trailing newline: the stub records one argument per line, so a prompt
    // ending in one could not be told from the separator.
    writeFileSync(promptFile, 'do the thing');

    let status: number | null = 0;
    let signal: string | null = null;
    let stderr = '';
    const started = Date.now();
    try {
      execFileSync('python3', [DISPATCHER, promptFile], {
        env: {
          ...process.env,
          DISPATCH_CONFIRM_GRACE: '0',
          ...env,
          PATH: `${dir}:${process.env.PATH}`,
          // Empty unless asked for, so a PYTHONPATH the runner happens to
          // carry cannot pull a stray sitecustomize into the other runs.
          PYTHONPATH: ptyEofIsEmptyRead ? dir : '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: harnessTimeoutMs,
      });
    } catch (err) {
      // The argv tests care only about the command line, and their stub never
      // confirms — so a non-zero status is read back rather than thrown.
      const failure = err as {
        status?: number | null;
        signal?: string | null;
        stderr?: Buffer | string | null;
      };
      status = failure.status ?? null;
      signal = failure.signal ?? null;
      stderr = failure.stderr?.toString() ?? '';
    }
    const launched = existsSync(recorded);
    return {
      argv: launched ? readFileSync(recorded, 'utf8').split('\n').filter(Boolean) : null,
      /** The child's `DISABLE_GROWTHBOOK` as the stub saw it; `unset` when absent. */
      childGrowthBook: launched ? readFileSync(recordedEnv, 'utf8').trim() : null,
      launched,
      status,
      signal,
      stderr,
      ms: Date.now() - started,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * The argv one dispatch put on the command line.
 *
 * A run that never reached a dispatch has no argv, and must not read as an
 * empty one: `[]` satisfies every "does not contain" assertion below, so a
 * launcher that refused to start anything would pass them silently. The
 * refusal paths are asserted where they belong, in § CLI compatibility.
 */
const argvFrom = (env: Record<string, string>, help = CLOUD_HELP) => {
  const { argv } = runLauncher(env, undefined, help);
  assert.ok(argv, 'the launcher dispatched nothing, so there is no argv to assert on');
  return argv;
};

const NO_ENV = { CLAUDE_MODEL: '', CLAUDE_SESSION_NAME: '' };
/** The launcher's "unconfirmed" status, asserted below to be one the
 *  interpreter cannot produce on its own. */
const UNCONFIRMED = 3;

describe('launch-session.py argv', () => {
  test('ends with the cloud flag carrying the prompt', () => {
    assert.deepEqual(argvFrom(NO_ENV), ['--permission-mode', 'auto', '--ref', 'main', '--cloud', 'do the thing']);
  });

  // An unattended session answers no permission prompt, so it runs in the
  // auto mode, where the classifier decides. Only the --cloud generation:
  // the --remote one predates the `auto` choice and would refuse the argv,
  // as it does --ref.
  test('runs a --cloud session in the auto permission mode, and sends no mode to a --remote CLI', () => {
    const cloud = argvFrom(NO_ENV, CLOUD_HELP);
    assert.equal(cloud[cloud.indexOf('--permission-mode') + 1], 'auto', cloud.join(' '));
    assert.ok(!argvFrom(NO_ENV, REMOTE_HELP).includes('--permission-mode'));
  });

  /**
   * The revision is what turns a failed GitHub preflight into a refusal. The
   * CLI checks with the Claude backend whether the GitHub App covers the
   * checkout's remote before it creates anything. Without a named revision a
   * "no" makes it upload the working tree as a bundle and start a session
   * with no GitHub source, one that cannot push or raise a PR, and one the
   * launcher still confirms, because the "Resume with:" line arrives all the
   * same. With one named, the same "no" is "--ref main cannot be honored:.
   * .." and a non-zero exit, which both callers report as a failure.
   *
   * `main` rather than the checkout's branch: the worker starts from origin's
   * trunk whatever the runner's checkout is on, and the `@claude` workflow's
   * prompt names the PR branch to check out itself.
   *
   * Only on the `--cloud` generation. The `--remote` one predates the flag
   * (2.1.42 dies on "unknown option '--ref'") and the bundle path it guards
   * against, so there the flag buys nothing and kills every dispatch.
   */
  test('pins every session to origin main on a --cloud CLI', () => {
    const argv = argvFrom(NO_ENV, CLOUD_HELP);
    assert.deepEqual(argv.slice(-4), ['--ref', 'main', '--cloud', 'do the thing']);
  });

  test('passes no --ref to a --remote CLI, which has no such option', () => {
    // Nor the gate workaround below: that generation has no bundle path for
    // it to steer, so its feature flags stay as the CLI evaluates them. The
    // inherited value is pinned empty so a runner carrying the variable can
    // neither fail nor pass this on its own.
    const { argv, childGrowthBook } = runLauncher(
      { ...NO_ENV, DISABLE_GROWTHBOOK: '' },
      undefined,
      REMOTE_HELP,
    );
    assert.ok(argv, 'the launcher dispatched nothing, so there is no argv to assert on');
    assert.ok(!argv.includes('--ref'), `--ref would kill this generation: ${argv.join(' ')}`);
    assert.equal(childGrowthBook, '');
  });

  /**
   * The workaround for a backend that has lost the App installation record.
   * With feature-flag evaluation off, the CLI treats bundling as unavailable
   * and, on a failed preflight, starts from GitHub anyway: it sends the
   * checkout's remote as the git source, as a session created from claude.ai
   * does, and the backend clones it with the credentials it already uses for
   * those. Verified on the Mac against the null answer: the session came up
   * with `acme/factory` at `main` as its source. `--ref main` above stays:
   * it pins the revision, and it is the refusal should bundling ever become
   * available under this variable.
   *
   * Asserted against an inherited empty value, so a runner that happens to
   * carry the variable cannot make a launcher that forgot it pass.
   */
  test('launches claude with feature-flag evaluation off, so a failed preflight starts from GitHub', () => {
    const { childGrowthBook, launched } = runLauncher({ ...NO_ENV, DISABLE_GROWTHBOOK: '' });
    assert.ok(launched);
    assert.equal(childGrowthBook, '1');
  });

  test('always hands the prompt to the cloud flag as its value', () => {
    // A bare `--cloud` is refused outright ("Error: --cloud requires a
    // description"), and a prompt left as a positional is read only by a local
    // session. The prompt must sit immediately behind the flag, whichever other
    // flags are set.
    for (const env of [
      NO_ENV,
      { CLAUDE_MODEL: 'claude-opus-5', CLAUDE_SESSION_NAME: '' },
      { CLAUDE_MODEL: '', CLAUDE_SESSION_NAME: '#7 t' },
      { CLAUDE_MODEL: 'claude-opus-5', CLAUDE_SESSION_NAME: '#7 t' },
    ]) {
      const argv = argvFrom(env);
      assert.deepEqual(
        argv.slice(-2),
        ['--cloud', 'do the thing'],
        `the prompt must be the cloud flag's value: ${argv.join(' ')}`,
      );
      // Nothing may sit between them, `--ref main` included: the CLI refuses
      // a bare `--cloud`, and the prompt left behind it would be a positional
      // nobody dispatches.
      assert.equal(argv.indexOf('--ref'), argv.length - 4, `--ref must precede the cloud flag: ${argv.join(' ')}`);
    }
  });

  test('dispatches with --remote on a CLI that still offers it', () => {
    assert.deepEqual(argvFrom(NO_ENV, REMOTE_HELP), ['--remote', 'do the thing']);
  });

  test('names the session when CLAUDE_SESSION_NAME is set', () => {
    const argv = argvFrom({ CLAUDE_MODEL: '', CLAUDE_SESSION_NAME: '#705 A revocation parked' });
    assert.deepEqual(argv, [
      '--name',
      '#705 A revocation parked',
      '--permission-mode',
      'auto',
      '--ref',
      'main',
      '--cloud',
      'do the thing',
    ]);
  });

  test('passes no --name at all when the variable is empty', () => {
    // An empty --name would title every overnight session the empty string,
    // which is worse than the summary it replaces.
    assert.ok(!argvFrom(NO_ENV).includes('--name'));
  });

  test('keeps passing --model', () => {
    const argv = argvFrom({ CLAUDE_MODEL: 'claude-opus-5', CLAUDE_SESSION_NAME: '' });
    assert.deepEqual(argv.slice(0, 2), ['--model', 'claude-opus-5']);
  });

  test('composes model and name together', () => {
    const argv = argvFrom({ CLAUDE_MODEL: 'claude-opus-5', CLAUDE_SESSION_NAME: '#7 t' });
    assert.deepEqual(argv, [
      '--model',
      'claude-opus-5',
      '--name',
      '#7 t',
      '--permission-mode',
      'auto',
      '--ref',
      'main',
      '--cloud',
      'do the thing',
    ]);
  });
});

describe('launch-session.py CLI compatibility', () => {
  test('starts nothing when the CLI offers no cloud dispatch', () => {
    // The next removal after `--remote`'s. Spawning `claude` anyway runs the prompt
    // LOCALLY on the runner — an unattended agent editing the Mac's checkout —
    // so the launcher must refuse rather than guess at a flag.
    //
    // This is also where a prefix match shows up: `NEITHER_HELP` advertises
    // `--remote-control`, a different feature that merely starts with the old
    // name, so a probe matching on a prefix would read it as `--remote` and
    // dispatch here instead of refusing.
    const { status, launched } = runLauncher(NO_ENV, undefined, NEITHER_HELP);
    assert.equal(launched, false, 'no dispatch may be attempted against a CLI with no cloud flag');
    // Nothing started, not unconfirmed: no `claude` ran, so there is no session
    // anywhere for an operator to go looking for at claude.ai/code.
    assert.equal(status, 1);
  });

  test('starts nothing when the CLI cannot be probed at all', () => {
    const { status, launched } = runLauncher(NO_ENV, undefined, null);
    assert.equal(launched, false);
    assert.equal(status, 1);
  });

  /**
   * A refused probe fails the whole batch, and the launcher's stderr is the
   * only record the caller keeps: the dispatcher task's log stream in
   * `/governor` is all that
   * survives an overnight failure. An exit code with no cause leaves whoever
   * reads it at 09:00 reproducing the probe by hand.
   */
  test('says why the probe failed, not just that it did', () => {
    const { stderr } = runLauncher(NO_ENV, undefined, null);
    assert.match(
      stderr,
      /Cannot find module/,
      `the probe's own diagnostic must reach the log: ${stderr}`,
    );
  });
});

describe('launch-session.py exit status', () => {
  /** A half-second confirmation window, so the timeout path costs half a
   *  second rather than the 30 an overnight run gives it. Only for a child
   *  that never confirms: a slow start cannot change how that run ends. */
  const QUICK_TIMEOUT = { ...NO_ENV, DISPATCH_CONFIRM_TIMEOUT: '0.5' };

  /**
   * The status is the whole signal, and `python3` writes one too. It exits 2
   * when it cannot open the script at all, which covers a moved, renamed or
   * unreadable launcher, and 1 on an uncaught exception. Nothing started in
   * either case, so the unconfirmed status has to be a number the interpreter
   * never returns. Sharing one would send an operator to claude.ai/code to
   * look for a session no `claude` was ever spawned for.
   */
  test('the interpreter cannot fake an unconfirmed dispatch by failing to run the launcher', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-remote-missing-'));
    try {
      let status = 0;
      try {
        execFileSync('python3', [join(dir, 'gone.py')], { stdio: 'ignore' });
      } catch (err) {
        status = (err as { status?: number }).status ?? 1;
      }
      assert.notEqual(status, 0, 'python3 must fail on a script it cannot open');
      assert.notEqual(
        status,
        UNCONFIRMED,
        `python3 exits ${status} when the launcher is not there, so a status that ` +
          'also means "unconfirmed" would report a session for a run that spawned none',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The only evidence the caller gets. `dispatch/turn.mjs` reads a
   * non-zero exit as a failed dispatch and otherwise logs it as dispatched,
   * marker comment and all. A `claude` that dies on an unrecognised flag,
   * or one that never reaches the cloud inside the window, must therefore
   * not look like a dispatch. An overnight run reporting sessions nobody
   * started is worse than one reporting nothing at all.
   */
  test('reports nothing started when claude exits without dispatching', () => {
    for (const body of [
      'echo "error: unknown option --name" >&2\nexit 1\n',
      // The death `--ref main` buys. A `claude` whose GitHub preflight fails
      // refuses the named revision and exits, rather than bundling the working
      // tree into a session that has no GitHub source. No session exists, the
      // ticket stays selectable, and the reason is on the launcher's stdout,
      // which the dispatcher task inherits into its log. (The gate workaround in the argv suite
      // sidesteps this refusal while it is in place; the launcher's reading of
      // the exit is the same either way.)
      'echo "Error: --ref main cannot be honored: the GitHub App is not set up for this ' +
        'repository, so the session would be seeded from your local working tree instead."\n' +
        'exit 1\n',
    ]) {
      const { status } = runLauncher(NO_ENV, body);
      assert.equal(
        status,
        1,
        `a claude that exited without dispatching must not read as success: ${body}`,
      );
    }
  });

  /**
   * The same death, on macOS, where the scheduled dispatch once ran
   * and where an operator still runs the launcher by hand: a closed
   * pty there is an empty read rather than an `EIO` — and `select`
   * keeps calling the fd readable, so a loop that ends only on a raise reads
   * nothing over and over at full CPU until the deadline, and then reports a
   * `claude` that dispatched nothing as one that might have. That is the
   * distinction above, inverted on every Mac failure.
   *
   * The deadline here is short because it is what the bug spends: a pass
   * returns at once, and only a launcher that spins can reach it.
   */
  test('reports nothing started when the pty closes by reporting EOF', () => {
    const { status, signal, ms } = runLauncher(
      { ...NO_ENV, DISPATCH_CONFIRM_TIMEOUT: '30', DISPATCH_DEADLINE: '5' },
      undefined,
      CLOUD_HELP,
      30_000,
      true,
    );
    assert.equal(signal, null, 'the launcher must end itself, not be killed by the test harness');
    assert.equal(
      status,
      1,
      'an empty read is the pty closing, so the run must read as nothing started rather than unconfirmed',
    );
    assert.ok(ms < 4_000, `spun for ${ms}ms — an empty read must end the loop, not restart it`);
  });

  /**
   * `claude` in a directory it has never been told to trust asks first, and
   * waits. Nothing answers in a task or on a runner, so the launcher used to
   * sit out the whole window and report the dispatch unconfirmed — "may or may
   * not be running" — about a session that cannot exist, run after run.
   *
   * The stub paints the prompt the way the real TUI does, with a cursor move
   * between words rather than a space, since that is the output the launcher
   * has to recognise. The window is long so only a launcher that reads the
   * prompt, rather than one that waits it out, can pass.
   */
  test('reports nothing started, and says why, when claude stops at the trust prompt', () => {
    const { status, signal, ms, stderr } = runLauncher(
      { ...NO_ENV, DISPATCH_CONFIRM_TIMEOUT: '30', DISPATCH_DEADLINE: '60' },
      "printf '\\033[2GQuick\\033[8Gsafety\\033[15Gcheck:\\n" +
        "\\033[4GNo,\\033[8Gexit\\n" +
        "\\033[4GYes,\\033[9GI\\033[11Gtrust\\033[17Gthis\\033[22Gfolder\\n'\nsleep 45\n",
      CLOUD_HELP,
      40_000,
    );
    assert.equal(signal, null, 'the launcher must end itself, not be killed by the test harness');
    assert.equal(status, 1, 'a claude waiting on the trust prompt has started nothing');
    assert.ok(ms < 20_000, `waited ${ms}ms — the prompt must end the run, not the window`);
    assert.match(stderr, /trust/i);
  });

  /**
   * Only the prompt's answer line ends the run. Output that merely mentions
   * trusting a folder, as a ticket title in the session's name could, is not
   * the prompt, and a dispatch that goes on to confirm is a dispatch.
   */
  test('a mention of trusting a folder is not the trust prompt', () => {
    const { status } = runLauncher(
      NO_ENV,
      'echo "Do you trust this folder?"\necho "Resume with: claude --resume abc123"\nsleep 30\n',
    );
    assert.equal(status, 0);
  });

  /**
   * The ambiguous one, and the reason the codes differ. `claude` is still
   * running when the window closes, so the session may have been created and
   * the line lost. A caller that read this as "nothing started" would state
   * something it cannot know. Non-zero all the same, since nothing confirmed
   * the dispatch.
   */
  test('reports unconfirmed when the window elapses with claude still running', () => {
    const { status } = runLauncher(QUICK_TIMEOUT, 'sleep 30\n');
    assert.equal(status, UNCONFIRMED);
  });

  test('succeeds once the session confirms', () => {
    // The launcher's own marker, and the success path the above must not break:
    // it kills claude by closing the pty, so the child's own status says
    // nothing — the marker is what makes the run a dispatch.
    const { status } = runLauncher(NO_ENV, 'echo "Resume with: claude --resume abc123"\nsleep 30\n');
    assert.equal(status, 0);
  });

  /**
   * "Resume with:" can arrive before claude has finished sending the prompt,
   * and closing the pty kills claude, so the launcher holds it open for a
   * grace after the marker. Five seconds in production; every other test here
   * sets it to zero, so this is the one that holds the launcher to it.
   *
   * The stub stands in for the rest of the prompt with a write an eighth of the
   * grace after the marker. A launcher that closed the pty on the marker
   * would kill it first. Before that write the stub paints 64 KiB, more than a
   * pty holds: a launcher that stopped reading at the marker would leave
   * claude blocked on that paint for the whole grace. The upper bound is what
   * `DISPATCH_CONFIRM_GRACE` buys: the production grace alone would exceed it.
   */
  test('holds the pty open after confirming, so claude can finish sending the prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-remote-grace-'));
    try {
      const delivered = join(dir, 'delivered');
      const { status, ms } = runLauncher(
        { ...NO_ENV, DISPATCH_CONFIRM_GRACE: '1', DELIVERED: delivered },
        'echo "Resume with: claude --resume abc123"\n' +
          "head -c 65536 /dev/zero | tr '\\0' .\n" +
          'sleep 0.125\n: > "$DELIVERED"\nsleep 30\n',
      );
      assert.equal(status, 0);
      assert.ok(
        existsSync(delivered),
        'claude was killed, or blocked on a full pty, before it finished sending the prompt',
      );
      assert.ok(ms < 4_000, `took ${ms}ms — DISPATCH_CONFIRM_GRACE must replace the production grace`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The production grace, unset as both callers leave it. It is five seconds,
   * but a claude that exits inside it has nothing left to send, so the hold
   * ends with it. That keeps this test cheap, and a default of zero would
   * still kill the stub before its write.
   */
  test('holds the pty open by default, and stops holding it when claude exits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-remote-grace-'));
    try {
      const delivered = join(dir, 'delivered');
      const { status, ms } = runLauncher(
        { ...NO_ENV, DISPATCH_CONFIRM_GRACE: '', DELIVERED: delivered },
        'echo "Resume with: claude --resume abc123"\nsleep 0.125\n: > "$DELIVERED"\nexit 0\n',
      );
      assert.equal(status, 0);
      assert.ok(existsSync(delivered), 'the default grace must hold the pty open after the marker');
      assert.ok(ms < 4_000, `took ${ms}ms — a claude that has exited leaves nothing to wait for`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The marker is matched against reads, not lines, and a pty hands over
   * whatever has arrived. So a `claude` that writes the line in two goes —
   * which is what a repainting TUI does — must still confirm. Nothing else
   * holds the launcher to that: it keeps only enough of the last read to span
   * one boundary, because a buffer that grew for the whole four-minute budget
   * would be rescanned entire on every chunk.
   */
  test('confirms a marker split across two reads', () => {
    const { status } = runLauncher(
      NO_ENV,
      "printf 'Resume with'\nsleep 0.3\nprintf ': claude --resume abc123\\n'\nsleep 30\n",
    );
    assert.equal(status, 0);
  });

  /**
   * The window is idle time waiting for output, not a budget for the whole
   * dispatch: a child that keeps talking must not be cut off for having talked
   * longer than one window. So the marker lands about 3s in, against a 2s
   * window, and every gap before it is a fraction of one.
   *
   * Both halves of that are the point. A child that only slept for less than
   * the window confirmed inside a single `select`, so it asserted nothing about
   * idle-versus-budget — and it left the pass resting on the stub shell writing
   * inside the ~0.45s left over, which is what `--test-concurrency=4` took away
   * on a loaded host. The window opens at the first `select`, after the
   * interpreter has started and probed, so only the child's startup was ever in
   * it. Streaming from the first read puts a whole window behind that.
   */
  test('confirms a dispatch that keeps talking for longer than one idle window', () => {
    const { status } = runLauncher(
      { ...NO_ENV, DISPATCH_CONFIRM_TIMEOUT: '2' },
      'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf .; sleep 0.25; done\n' +
        'echo "Resume with: claude --resume abc123"\nsleep 30\n',
    );
    assert.equal(status, 0);
  });
});

describe('launch-session.py deadline', () => {
  /**
   * A dispatch is a bounded thing — the confirmation arrives in seconds — so
   * the launcher must return whatever the child is doing. The confirmation
   * wait alone cannot promise that: it measures silence, and a `claude` that
   * repaints a spinner is never silent. The caller blocks on this process
   * (`dispatch/turn.mjs` awaits it before the next issue in the plan), so a
   * launcher that never returns costs the whole fire, not one dispatch.
   */
  test('gives up on a claude that streams without ever confirming', () => {
    const { status, signal, ms } = runLauncher(
      { ...NO_ENV, DISPATCH_CONFIRM_TIMEOUT: '30', DISPATCH_DEADLINE: '1' },
      'while :; do printf .; sleep 0.1; done\n',
      CLOUD_HELP,
      30_000,
    );
    assert.equal(signal, null, 'the launcher must end itself, not be killed by the test harness');
    // Unconfirmed rather than nothing-started: claude was alive and writing
    // when the budget ran out, which is the ambiguity that code exists for.
    assert.equal(status, UNCONFIRMED);
    assert.ok(ms < 20_000, `gave up after ${ms}ms — the deadline, not the idle window, must bound it`);
  });

  /**
   * The deadline is a ceiling, not a replacement: a child that says nothing at
   * all still fails at the idle window, well before the overall budget runs
   * out. Taking the larger of the two, or dropping the idle wait, would hold
   * every dead dispatch open for the full deadline.
   */
  test('still gives up at the idle window when the child goes quiet', () => {
    const { status, signal, ms } = runLauncher(
      { ...NO_ENV, DISPATCH_CONFIRM_TIMEOUT: '0.5', DISPATCH_DEADLINE: '60' },
      'sleep 45\n',
      CLOUD_HELP,
      30_000,
    );
    assert.equal(signal, null);
    assert.equal(status, UNCONFIRMED);
    assert.ok(ms < 20_000, `waited ${ms}ms — the idle window must still cut a silent child short`);
  });

  /**
   * A confirmation inside the budget is still a dispatch. The deadline runs
   * from the launch, so a child that streams for a while before printing the
   * marker must not be counted against it once the marker lands.
   */
  test('confirms a session that streams first and confirms inside the budget', () => {
    const { status, signal } = runLauncher(
      { ...NO_ENV, DISPATCH_CONFIRM_TIMEOUT: '30', DISPATCH_DEADLINE: '60' },
      'for i in 1 2 3 4 5 6 7 8 9 10; do printf .; sleep 0.05; done\n' +
        'echo "Resume with: claude --resume abc123"\nsleep 30\n',
      CLOUD_HELP,
      40_000,
    );
    assert.equal(signal, null);
    assert.equal(status, 0);
  });
});
