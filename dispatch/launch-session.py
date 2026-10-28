#!/usr/bin/env python3
"""
Dispatch a cloud claude session from a non-interactive environment (e.g. CI).

Usage: launch-session.py <prompt-file>

Creating a cloud session requires a TTY. Without one claude falls back to local
execution — an unattended agent editing the runner's own checkout. This script
allocates a pseudo-TTY via pty.fork(), spawns claude in it, streams output, and
exits as soon as the session is confirmed (line starting with "Resume with:").

## Which flag, and where the prompt goes

The flag that dispatches to the cloud is named differently on either side of a
CLI rename: it was `--remote`, it is now `--cloud`, and `--remote`
survives only as a hidden deprecated alias that a later release will drop. So
the flag is not hard-coded — `claude --help` is read once and whichever of the
two it advertises is used. A CLI advertising neither dispatches nothing, and
says so: spawning claude anyway would run the prompt locally.

The prompt is that flag's VALUE, not a positional argument.
`--cloud [description|session_id|url]` is created FROM its value: the CLI
refuses a bare `--cloud` outright ("Error: --cloud requires a description"),
and claude's positional prompt is read only by a local session. So the prompt
sits immediately behind the flag, with nothing between them — the position
`--remote` took it in, which is why only the flag's NAME needed the probe.

## Why the session is pinned to origin's main

Before it creates anything, `claude --cloud` asks the Claude backend whether
the Claude GitHub App covers the repository the checkout's remote names. On a
"no" it does not fail. It uploads the working tree as a bundle and starts a
session with no GitHub source. That session cannot push or raise a PR, and it
still prints the confirmation line below, so this launcher reported it as
dispatched. That is what an overnight run looked like after the repository
moved to another organisation and the app's installation no longer
matched.

`--ref main` closes that path. With a revision named, the CLI refuses instead
of bundling ("--ref main cannot be honored: the GitHub App is not set up for
this repository, ...") and exits. That is "nothing started" below, with the
reason streamed to stdout for whichever log the caller keeps. (While the
workaround in the next section is in place, a failed preflight starts from
GitHub instead of refusing; the refusal returns with the workaround's
removal.) It is also the
revision every worker should start from: origin's trunk, not whatever branch
the runner's checkout is on. The @claude workflow's prompt names the PR
branch to check out itself.

`claude --help` does not advertise the flag (it is registered hidden), so it
cannot be probed for, and `--help` and `--version` both exit 0 whatever
options precede them. It is newer than `--cloud`: 2.1.42 advertises `--cloud`
and dies on "unknown option '--ref'", 2.1.278 takes it. So a `--cloud` CLI
older than the flag fails every dispatch, loudly, before anything starts, and
the fix is to update the CLI. The `--remote` generation predates the flag and
the bundle path alike, so it gets no `--ref` at all: there the flag would buy
nothing and kill every dispatch.

## Why the session runs in the auto permission mode

Nobody answers a permission prompt in a dispatched session, so it is launched
with `--permission-mode auto`, where the classifier decides. The `auto`
choice is newer than the flag: a CLI that predates it refuses the argv at
parsing, so every dispatch fails loudly before anything starts, as an old
`--cloud` CLI does on `--ref`, and the fix is the same, update the CLI.

## Why feature-flag evaluation is off for the child

The preflight above asks the Claude backend for the App's installation
status on the repository, and since that move
that answer has been `status: null` in every one of the account's Claude
organisations, with the app installed on GitHub and sessions created from
claude.ai attaching the repository fine. That is a backend record, not
anything this machine can fix, and it is with support.

Bundling on a failed preflight is switched on by a server-side feature gate.
With `DISABLE_GROWTHBOOK=1` the CLI evaluates no gates, so bundling reads as
unavailable, and on that combination it starts from GitHub anyway: the
checkout's remote goes up as the git source, the same request a session
created from claude.ai makes, and the backend clones it with the
credentials it already uses for those. Verified against the null answer:
the session came up with the repository at `main` as its source. The CLI
loses nothing the dispatch uses (Remote Control is the one feature that
refuses to run without gates), and the cloud session has its own
environment. Remove this once the preflight answers `app_installed: true`:
the assignment below, this section, and the `feature-flag evaluation off` test in
test/scripts/launch-session.test.ts, which asserts the variable is set.

## Exit status

The exit code is all either caller gets. The child's OWN status cannot serve,
because the success path kills it by closing the pty.

    0  confirmed: the marker arrived and a session is running.
    3  unconfirmed: a clock ran out with claude still running. The marker
       is the only signal there is, so this does NOT mean nothing started.
       The session may exist and the line have been lost.
    anything else  nothing started: claude exited, or the pty closed, before
       confirming; or it stopped at the workspace trust prompt; or the flag
       probe above refused to spawn one at all. A death on an unrecognised
       flag, say.

Unconfirmed is 3 rather than 2 because the status is python's as well as this
script's. Python exits 2 when it cannot open this file, and 1 on an uncaught
exception, both before any claude runs. Those belong with "nothing started",
so unconfirmed has to be a code the interpreter never returns. Sharing one
would send an operator to claude.ai/code after a run that spawned nothing.

None of the three is a dispatch anyone can vouch for, so all are non-zero.
Unconfirmed is separate because a caller that reports it as a failure states
something it cannot know, and each caller decides how loudly to say
it. dispatch/turn.mjs logs a line per outcome and leaves a marker comment on
the ticket for anything but a failure.

Two clocks reach "unconfirmed", because one cannot. The confirmation window is
idle time — how long the child may say nothing — and every readable chunk
restarts it, so a claude that writes without confirming (a spinner, a
repainting TUI frame) outlasts it forever, and neither caller ever gets a code
at all. The caller BLOCKS on this process: the turn awaits it before
the next issue in the batch. So a deadline for the whole dispatch is taken once before
the loop, and each wait is the smaller of the two. Either clock running out is
the same event — the marker never came while claude carried on — so both are
UNCONFIRMED.

DISPATCH_CONFIRM_TIMEOUT overrides the window, DISPATCH_DEADLINE the
deadline and DISPATCH_CONFIRM_GRACE the 5-second hold after the marker, all in
seconds. Neither caller sets them; the tests do, so a path that costs 30
seconds or four minutes in an overnight run costs a few here.
"""

import os
import re
import select
import signal
import subprocess
import sys
import time
import pty

CONFIRMED = 0
NOT_STARTED = 1
UNCONFIRMED = 3  # not 2: python exits 2 itself when it cannot open this file.

MARKER = b"Resume with:"

# The workspace-trust prompt `claude` shows in a directory it has not been told
# to trust. It waits there for an answer nothing here gives, so reading it ends
# the dispatch as nothing started instead of an unconfirmed timeout. Matched
# with escape sequences and whitespace removed: the TUI positions each word
# with a cursor move rather than separating them with spaces. The answer line,
# not the question, so output that merely mentions trusting a folder does not
# end a dispatch.
TRUST_PROMPT = b"yes,itrustthisfolder"
ESCAPE = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]")
# Enough raw output to hold the prompt's line with its escapes.
TRUST_TAIL = 4096

# Newest first: a CLI carrying both is a CLI where the older one is deprecated.
CLOUD_FLAGS = ("--cloud", "--remote")
# The revision every session starts from; see the module docstring.
CLOUD_REF = "main"


def cloud_flag(help_text):
    """The flag this CLI takes to dispatch a session to the cloud, or None.

    Matched on a whole flag rather than a prefix, because `--remote-control` is
    a different feature that merely starts with the old name: a prefix match
    reads a current CLI's help as offering `--remote` and composes the argv of
    a generation that is gone.
    """
    for flag in CLOUD_FLAGS:
        if re.search(rf"(?<![\w-]){re.escape(flag)}(?![\w-])", help_text):
            return flag
    return None


def hold_open(fd, seconds):
    """Keep the pty open for `seconds`, or until claude closes it.

    Reads and forwards all the while. A pty nobody reads fills after a few KB,
    and claude's next write then blocks until the pty closes, so a hold that
    only slept would stall the very transmission it waits for.
    """
    until = time.monotonic() + seconds
    while True:
        remaining = until - time.monotonic()
        if remaining <= 0:
            return
        try:
            if not select.select([fd], [], [], remaining)[0]:
                return
            chunk = os.read(fd, 4096)
            if not chunk:
                return  # macOS's closed pty; Linux raises EIO below.
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        except OSError:
            return


if len(sys.argv) != 2:
    print(f"Usage: {sys.argv[0]} <prompt-file>", file=sys.stderr)
    sys.exit(NOT_STARTED)

prompt = open(sys.argv[1]).read()
model = os.environ.get("CLAUDE_MODEL", "")
session_name = os.environ.get("CLAUDE_SESSION_NAME", "")
# How long the child may stay SILENT before the dispatch is unconfirmed.
confirm_timeout = float(os.environ.get("DISPATCH_CONFIRM_TIMEOUT") or 30.0)
# The budget for the whole dispatch, silent or not. A real one confirms in
# seconds and the success path holds up to 5 afterwards, so four minutes is
# generous by a wide margin: it is here to end a hang, not to race a
# slow-but-working launch.
deadline_timeout = float(os.environ.get("DISPATCH_DEADLINE") or 240.0)
# How long the pty stays open after the marker; see where it is spent.
confirm_grace = float(os.environ.get("DISPATCH_CONFIRM_GRACE") or 5.0)

# Probe before forking: a failure here must leave nothing running, and the
# child cannot report one back through the pty in any way the caller reads.
try:
    probe = subprocess.run(
        ["claude", "--help"],
        capture_output=True,
        text=True,
        timeout=60,
    )
except FileNotFoundError:
    print("❌ claude is not on PATH — nothing was started", file=sys.stderr)
    sys.exit(NOT_STARTED)
except (OSError, subprocess.SubprocessError) as err:
    print(f"❌ Could not run `claude --help` ({err}) — nothing was started", file=sys.stderr)
    sys.exit(NOT_STARTED)

if probe.returncode != 0:
    # Repeat what claude said. A broken install prints its own reason and
    # nothing else does, and this stderr is the whole record either caller
    # keeps of an overnight batch that dispatched nothing.
    reason = (probe.stderr.strip() or probe.stdout.strip()).splitlines()
    print(
        "\n".join(
            [f"❌ `claude --help` exited {probe.returncode} — nothing was started"]
            + [f"   {line}" for line in reason]
        ),
        file=sys.stderr,
    )
    sys.exit(NOT_STARTED)

flag = cloud_flag(probe.stdout + probe.stderr)
if flag is None:
    print(
        "❌ This claude CLI advertises neither --cloud nor --remote, so there is no way "
        "to dispatch to the cloud — nothing was started. Running it anyway would execute "
        "the prompt locally on this machine.",
        file=sys.stderr,
    )
    sys.exit(NOT_STARTED)

pid, fd = pty.fork()
if pid == 0:
    # Close every fd the runner gave us (> stderr). If we don't do this,
    # claude and its Node.js children inherit the step's stdout/stderr
    # pipes and the GitHub Actions step hangs until every last grandchild
    # exits — even after we kill the main claude process.
    os.closerange(3, 1024)
    cmd = ["claude"]
    if model:
        cmd += ["--model", model]
    # Naming the session outright is the only way an issue number survives into
    # the sessions pane: the namer summarises the prompt rather than copying it,
    # and an identifier reads as boilerplate to a summariser. Optional, so the
    # workflow that sets no name keeps the behaviour it has.
    if session_name:
        cmd += ["--name", session_name]
    # Pinned to origin's trunk, ahead of the cloud flag so the prompt stays
    # that flag's value. Naming a revision is what makes a failed GitHub
    # preflight a refusal rather than a bundle. Only the `--cloud` generation
    # has the flag or the bundle path; see the module docstring.
    if flag == "--cloud":
        # Unattended: nobody answers a permission prompt, so the session runs
        # in the auto mode, where the classifier decides. This generation
        # only: the `--remote` one predates the `auto` choice and would refuse
        # the argv, as it does `--ref`.
        cmd += ["--permission-mode", "auto"]
        cmd += ["--ref", CLOUD_REF]
        # Temporary; see the module docstring § Why feature-flag evaluation is
        # off for the child. Same generation as `--ref`: only this one has the
        # bundle path the variable steers.
        os.environ["DISABLE_GROWTHBOOK"] = "1"
    # The prompt is the cloud flag's VALUE, never a positional. See the module
    # docstring: that value is what the new cloud session is created from, and
    # a positional prompt is read only by a local session.
    cmd += [flag, prompt]
    os.execvp("claude", cmd)
else:
    buf = b""
    tail = b""
    untrusted = False
    status = NOT_STARTED
    deadline = time.monotonic() + deadline_timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            # The budget is spent however loudly claude has been writing.
            status = UNCONFIRMED
            break
        try:
            r, _, _ = select.select([fd], [], [], min(confirm_timeout, remaining))
            if not r:
                # claude is still running; we simply never saw the marker.
                status = UNCONFIRMED
                break
            chunk = os.read(fd, 4096)
            if not chunk:
                # The other way a platform says the pty closed. Linux raises
                # EIO below; macOS returns b"" and select goes on calling the
                # fd readable, so an empty read there is the end, not a lull —
                # and a loop that carried on would spin at full CPU until the
                # deadline and then call a dead claude UNCONFIRMED.
                break
            # Keep only what a marker split across two reads needs. The
            # streaming child the deadline exists for now runs the whole
            # budget, and a buffer that only grew would be rescanned entire on
            # every chunk: ~100 MB held and a core pegged for four minutes.
            buf = buf[-(len(MARKER) - 1) :] + chunk
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            tail = (tail + chunk)[-TRUST_TAIL:]
            if TRUST_PROMPT in re.sub(rb"\s+", b"", ESCAPE.sub(b"", tail)).lower():
                untrusted = True
                break  # claude waits on the prompt; nothing will start.
            if MARKER in buf:
                # Give claude time to finish transmitting the prompt to the
                # remote session.  "Resume with:" can appear before the task
                # payload is fully delivered; killing too early drops it.
                hold_open(fd, confirm_grace)
                status = CONFIRMED
                break  # Session dispatched
        except OSError:
            break  # pty closed: claude is gone and never confirmed.
    if status == UNCONFIRMED:
        print(
            "⚠️  Timed out waiting for dispatch confirmation. A session may or "
            "may not be running; check claude.ai/code",
            file=sys.stderr,
        )
    elif untrusted:
        print(
            f"❌ claude stopped at the workspace trust prompt for {os.getcwd()} — nothing "
            "was started. Run `claude` there once and accept the prompt, or run the "
            "dispatch from a directory under one that is already trusted.",
            file=sys.stderr,
        )
    elif status == NOT_STARTED:
        print("⚠️  No dispatch confirmation — nothing was started", file=sys.stderr)
    # Closing the PTY master sends SIGHUP to claude's foreground process
    # group — the normal "terminal closed" signal — which is usually enough
    # for a clean exit. SIGKILL is the guaranteed fallback.
    try:
        os.close(fd)
    except OSError:
        pass

    # Wait up to 2 s for SIGHUP to take effect. Look before each nap: a claude
    # that closed the pty by exiting is already waiting to be reaped.
    for _ in range(200):
        try:
            if os.waitpid(pid, os.WNOHANG)[0]:
                sys.exit(status)
        except ChildProcessError:
            sys.exit(status)
        time.sleep(0.01)

    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.exit(status)
