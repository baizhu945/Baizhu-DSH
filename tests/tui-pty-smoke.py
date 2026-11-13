#!/usr/bin/env python3
"""Private runtime-smoke helper: real controlling PTY, bounded boot/exit, no prompt."""
import errno
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


def main():
    marker, command, *args = sys.argv[1:]
    pid, fd = pty.fork()
    if pid == 0:
        os.execv(command, [command, *args])
    def interrupted(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 140, 0, 0))
    data = bytearray()
    status = None
    entered = False
    exit_at = None
    escape_sent = False
    exit_sent = False
    second_interrupt_sent = False
    text = ''
    started = time.monotonic()
    ansi = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')
    try:
        while time.monotonic() - started < 65:
            readable, _, _ = select.select([fd], [], [], 0.1)
            if readable:
                try:
                    chunk = os.read(fd, 65536)
                    if chunk:
                        data.extend(chunk)
                        del data[:-200000]
                except OSError as e:
                    if e.errno != errno.EIO:
                        raise
            text = ansi.sub('', data.decode('utf-8', errors='replace'))
            # Require application content, terminal painting, and loader settlement.
            # On a new HOME the onboarding welcome is a valid fully rendered screen.
            if not entered and Path(marker).exists() and b'\x1b[' in data and re.search(
                    r'Welcome to dsh|New session here|欢迎使用|在此新建会话', text, re.I):
                entered = True
                exit_at = time.monotonic()
            if entered:
                elapsed = time.monotonic() - exit_at
                if elapsed > 1 and not escape_sent:
                    os.write(fd, b'\x1b')  # dismiss onboarding after first paint settles
                    escape_sent = True
                if elapsed > 3 and not exit_sent:
                    os.write(fd, b'\x03')
                    exit_sent = True
                if elapsed > 3.4 and not second_interrupt_sent:
                    os.write(fd, b'\x03')
                    second_interrupt_sent = True
                if elapsed > 15:
                    raise RuntimeError('TUI did not exit on Ctrl+C')
            done, status_value = os.waitpid(pid, os.WNOHANG)
            if done:
                status = status_value
                break
        if status is None:
            raise RuntimeError('TUI boot timed out')
        if not entered:
            raise RuntimeError('TUI exited without a rendered screen + settled plugin')
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            raise RuntimeError(f'TUI unclean exit: wait status={status}')
        print('PASS PTY rendered TUI + plugin settled + clean Ctrl+C exit')
    except Exception as e:
        print(f'FAIL PTY: {e}\n{text[-16000:]}', file=sys.stderr)
        return 1
    finally:
        # forkpty child has its own session/process group. Always reap descendants.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig)
            except ProcessLookupError:
                pass
            if sig == signal.SIGTERM:
                time.sleep(0.2)
        if status is None:
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
        os.close(fd)
    return 0


if __name__ == '__main__':
    sys.exit(main())
