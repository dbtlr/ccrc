import { describe, expect, test } from 'bun:test';
import {
  chmod,
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { bunCommandRunner, createClaudeAdapter } from '../src/adapter/claude.ts';
import { LaunchError, StopError } from '../src/errors.ts';
import {
  failed,
  fakeClock,
  ok,
  recordingRunner,
  rejection,
  tmuxCalls,
  withTempDir,
} from './support.ts';
import type { Recording } from './support.ts';

const ATTACH_URL = 'https://claude.ai/code/session_01JQ4Z8YB0';

/** The pane capture polled for the URL, as opposed to the scrollback capture. */
const isVisibleCapture = (argv: readonly string[]): boolean =>
  argv[1] === 'capture-pane' && !argv.includes('-a');

const visibleCaptures = (recording: Recording): string[][] =>
  recording.calls.filter((argv) => isVisibleCapture(argv));

describe('launch', () => {
  test('spawns a detached tmux session and returns the attach URL from the pane', async () => {
    const clock = fakeClock();
    const recording = recordingRunner((argv) => {
      if (argv[1] !== 'capture-pane') {
        return ok();
      }
      // The URL is printed a moment after startup: the first poll misses.
      return isVisibleCapture(argv) && visibleCaptures(recording).length > 1
        ? ok(`> ${ATTACH_URL}\n`)
        : ok('booting');
    });
    const adapter = createClaudeAdapter({
      attachUrlPollIntervalMs: 10,
      attachUrlTimeoutMs: 1_000,
      now: clock.now,
      run: recording.run,
      sleep: clock.sleep,
    });

    const attachUrl = await adapter.launchSession({
      prompt: '/review the diff',
      rcName: 'ccrc-abc',
      repoPath: '/repos/example',
      tmuxName: 'ccrc-example-1',
    });

    expect(attachUrl).toBe(ATTACH_URL);
    const [spawn] = tmuxCalls(recording, 'new-session');
    expect(spawn).toEqual([
      'tmux',
      'new-session',
      '-d',
      '-s',
      'ccrc-example-1',
      '-c',
      '/repos/example',
      "'claude' '--remote-control' 'ccrc-abc' '--permission-mode' 'bypassPermissions' '--' '/review the diff'",
    ]);
    // -J joins wrapped lines, so a URL at the pane boundary is never truncated.
    expect(visibleCaptures(recording)[0]).toEqual([
      'tmux',
      'capture-pane',
      '-p',
      '-J',
      '-t',
      'ccrc-example-1',
    ]);
    expect(visibleCaptures(recording).length).toBe(2);
    expect(tmuxCalls(recording, 'kill-session')).toEqual([]);
  });

  test('omits the positional prompt when none is given', async () => {
    const recording = recordingRunner((argv) => ok(argv[1] === 'capture-pane' ? ATTACH_URL : ''));
    const adapter = createClaudeAdapter({ run: recording.run });

    await adapter.launchSession({
      rcName: 'ccrc-abc',
      repoPath: '/repos/example',
      tmuxName: 'ccrc-example-1',
    });

    expect(tmuxCalls(recording, 'new-session')[0]?.at(-1)).toBe(
      "'claude' '--remote-control' 'ccrc-abc' '--permission-mode' 'bypassPermissions'",
    );
  });

  test('finds a URL that was printed before the TUI took over the screen', async () => {
    const clock = fakeClock();
    const recording = recordingRunner((argv) => {
      if (argv[1] !== 'capture-pane') {
        return ok();
      }
      // The alternate screen shows the TUI; the URL is only in the saved screen.
      return isVisibleCapture(argv) ? ok('claude TUI') : ok(`welcome\n${ATTACH_URL}\n`);
    });
    const adapter = createClaudeAdapter({
      attachUrlPollIntervalMs: 10,
      attachUrlTimeoutMs: 1_000,
      now: clock.now,
      run: recording.run,
      sleep: clock.sleep,
    });

    expect(
      await adapter.launchSession({
        rcName: 'ccrc-abc',
        repoPath: '/repos/example',
        tmuxName: 'ccrc-example-1',
      }),
    ).toBe(ATTACH_URL);
    expect(tmuxCalls(recording, 'capture-pane').at(-1)).toEqual([
      'tmux',
      'capture-pane',
      '-p',
      '-J',
      '-q',
      '-a',
      '-S',
      '-',
      '-t',
      'ccrc-example-1',
    ]);
  });

  test('never returns a truncated URL left by a wrapped pane line', async () => {
    const clock = fakeClock();
    const truncated = 'https://claude.ai/code/session_01J';
    const recording = recordingRunner((argv) => {
      if (argv[1] !== 'capture-pane') {
        return ok();
      }
      if (!isVisibleCapture(argv)) {
        return ok('');
      }
      return visibleCaptures(recording).length > 1 ? ok(ATTACH_URL) : ok(`> ${truncated}\n`);
    });
    const adapter = createClaudeAdapter({
      attachUrlPollIntervalMs: 10,
      attachUrlTimeoutMs: 1_000,
      now: clock.now,
      run: recording.run,
      sleep: clock.sleep,
    });

    expect(
      await adapter.launchSession({
        rcName: 'ccrc-abc',
        repoPath: '/repos/example',
        tmuxName: 'ccrc-example-1',
      }),
    ).toBe(ATTACH_URL);
  });

  test('fails immediately when the pane is gone, quoting its last output', async () => {
    const clock = fakeClock();
    const recording = recordingRunner((argv) => {
      if (!isVisibleCapture(argv)) {
        return ok('');
      }
      return visibleCaptures(recording).length > 1
        ? failed("can't find pane: ccrc-example-1")
        : ok('claude: command not found\n');
    });
    const adapter = createClaudeAdapter({
      attachUrlPollIntervalMs: 10,
      attachUrlTimeoutMs: 60_000,
      now: clock.now,
      run: recording.run,
      sleep: clock.sleep,
    });

    const failure = await rejection(
      adapter.launchSession({
        rcName: 'ccrc-abc',
        repoPath: '/repos/example',
        tmuxName: 'ccrc-example-1',
      }),
    );

    expect(failure).toBeInstanceOf(LaunchError);
    expect(failure.message).toMatch(/exited before printing an attach URL/);
    expect(failure.message).toMatch(/can't find pane/);
    // The launch gave up on the second poll instead of burning the whole timeout.
    expect(visibleCaptures(recording).length).toBe(2);
    expect(clock.now()).toBeLessThan(60_000);
  });

  test('fails loudly and kills the tmux session when no attach URL appears', async () => {
    const clock = fakeClock();
    const recording = recordingRunner(() => ok('claude is thinking about it'));
    const adapter = createClaudeAdapter({
      attachUrlPollIntervalMs: 1_000,
      attachUrlTimeoutMs: 5_000,
      now: clock.now,
      run: recording.run,
      sleep: clock.sleep,
    });

    const failure = await rejection(
      adapter.launchSession({
        rcName: 'ccrc-abc',
        repoPath: '/repos/example',
        tmuxName: 'ccrc-example-1',
      }),
    );

    expect(failure).toBeInstanceOf(LaunchError);
    expect(failure.message).toMatch(/no attach URL appeared in tmux session ccrc-example-1/);
    expect(failure.message).toMatch(/claude is thinking about it/);
    expect(tmuxCalls(recording, 'kill-session')).toContainEqual([
      'tmux',
      'kill-session',
      '-t',
      'ccrc-example-1',
    ]);
  });

  test('reports the tmux failure when the session cannot be created', async () => {
    const recording = recordingRunner(() => failed('duplicate session: ccrc-example-1'));
    const adapter = createClaudeAdapter({ run: recording.run });

    const failure = await rejection(
      adapter.launchSession({
        rcName: 'ccrc-abc',
        repoPath: '/repos/example',
        tmuxName: 'ccrc-example-1',
      }),
    );

    expect(failure.message).toMatch(/duplicate session: ccrc-example-1/);
    expect(tmuxCalls(recording, 'capture-pane')).toEqual([]);
  });
});

/**
 * The generated command line is handed to tmux as one shell string, so quoting is
 * verified by letting a real `sh` split it back into argv (`set --` plus `printf`,
 * both builtins — nothing is executed). Round-tripping through the shell is the
 * only assertion that proves nothing escapes the prompt argument.
 */
describe('prompt quoting round-trip', () => {
  const shellArgv = async (prompt: string): Promise<string[]> => {
    const recording = recordingRunner((argv) => ok(argv[1] === 'capture-pane' ? ATTACH_URL : ''));
    await createClaudeAdapter({ run: recording.run }).launchSession({
      prompt,
      rcName: 'ccrc-abc',
      repoPath: '/repos/example',
      tmuxName: 'ccrc-example-1',
    });
    const commandLine = tmuxCalls(recording, 'new-session')[0]?.at(-1) ?? '';
    const split = await bunCommandRunner([
      'sh',
      '-c',
      `set -- ${commandLine}; printf '%s\\0' "$@"`,
    ]);
    expect(split.exitCode).toBe(0);
    return split.stdout.split('\0').slice(0, -1);
  };

  const prompts: readonly [string, string][] = [
    ['backticks', 'run `id` now'],
    ['command substitution', 'run $(id) now'],
    ['a newline', 'first line\nsecond line'],
    ['a lone single quote', "don't"],
    ['a lone backslash', String.raw`a\b`],
    ['double quotes and a variable', 'say "$HOME" please'],
    ['shell terminators', '; rm -rf / & echo pwned | cat > /tmp/x'],
    ['a claude flag', '--help'],
    ['a claude flag with a value', '--settings /etc/passwd'],
  ];

  test.each(prompts)('passes %s through as one literal argument', async (_label, prompt) => {
    expect(await shellArgv(prompt)).toEqual([
      'claude',
      '--remote-control',
      'ccrc-abc',
      '--permission-mode',
      'bypassPermissions',
      '--',
      prompt,
    ]);
  });
});

describe('bunCommandRunner', () => {
  test('reports stdout, stderr, and the exit code of a real process', async () => {
    const result = await bunCommandRunner(['sh', '-c', 'printf out; printf err >&2; exit 3']);

    expect(result).toEqual({ exitCode: 3, stderr: 'err', stdout: 'out' });
  });

  test('refuses an empty argv', async () => {
    const failure = await rejection(bunCommandRunner([]));
    expect(failure.message).toMatch(/empty argv/);
  });
});

describe('pre-trust', () => {
  const trustFixture = {
    numStartups: 12,
    projects: {
      '/repos/other': { allowedTools: ['Bash'], hasTrustDialogAccepted: true },
      '/repos/target': { exampleFilesGenerated: true, history: [{ display: 'hello' }] },
    },
    userID: 'fixture-user',
  };

  test('merges hasTrustDialogAccepted without disturbing the rest of the file', async () => {
    await withTempDir(async (dir) => {
      const claudeConfigPath = join(dir, '.claude.json');
      await writeFile(claudeConfigPath, JSON.stringify(trustFixture, null, 2), 'utf8');
      const repoPath = join(dir, 'target');
      await Bun.write(join(repoPath, '.keep'), '');
      const adapter = createClaudeAdapter({
        claudeConfigPath,
        run: recordingRunner(() => ok()).run,
      });

      const resolved = await adapter.trustRepo(repoPath);

      // Resolution matters: the trust entry must be keyed by the real path.
      expect(resolved).toBe(await realpath(repoPath));
      const written: unknown = JSON.parse(await readFile(claudeConfigPath, 'utf8'));
      expect(written).toEqual({
        ...trustFixture,
        projects: {
          ...trustFixture.projects,
          [resolved]: { hasTrustDialogAccepted: true },
        },
      });
      // No staging file survives a successful write.
      expect((await readdir(dir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    });
  });

  test('keeps existing keys of an entry that already exists for the repo', async () => {
    await withTempDir(async (dir) => {
      const claudeConfigPath = join(dir, '.claude.json');
      const repoPath = await realpath(dir);
      await writeFile(
        claudeConfigPath,
        JSON.stringify({ projects: { [repoPath]: { mcpServers: { local: {} } } } }),
        'utf8',
      );
      const adapter = createClaudeAdapter({
        claudeConfigPath,
        run: recordingRunner(() => ok()).run,
      });

      await adapter.trustRepo(dir);

      const written: unknown = JSON.parse(await readFile(claudeConfigPath, 'utf8'));
      expect(written).toEqual({
        projects: { [repoPath]: { hasTrustDialogAccepted: true, mcpServers: { local: {} } } },
      });
    });
  });

  test('creates the file and the projects entry when nothing exists yet', async () => {
    await withTempDir(async (dir) => {
      const claudeConfigPath = join(dir, 'nested', '.claude.json');
      const adapter = createClaudeAdapter({
        claudeConfigPath,
        resolvePath: (path) => Promise.resolve(path),
        run: recordingRunner(() => ok()).run,
      });

      await adapter.trustRepo('/repos/fresh');

      const written: unknown = JSON.parse(await readFile(claudeConfigPath, 'utf8'));
      expect(written).toEqual({ projects: { '/repos/fresh': { hasTrustDialogAccepted: true } } });
      // A file ccrcd creates holds account state: owner-only.
      expect((await stat(claudeConfigPath)).mode & 0o777).toBe(0o600);
    });
  });

  test('leaves an already-trusted repo alone instead of rewriting the file', async () => {
    await withTempDir(async (dir) => {
      const claudeConfigPath = join(dir, '.claude.json');
      const repoPath = await realpath(dir);
      const source = JSON.stringify({
        projects: { [repoPath]: { hasTrustDialogAccepted: true } },
      });
      await writeFile(claudeConfigPath, source, 'utf8');
      const before = await stat(claudeConfigPath);
      const adapter = createClaudeAdapter({
        claudeConfigPath,
        run: recordingRunner(() => ok()).run,
      });

      await adapter.trustRepo(dir);

      expect(await readFile(claudeConfigPath, 'utf8')).toBe(source);
      expect((await stat(claudeConfigPath)).mtimeMs).toBe(before.mtimeMs);
    });
  });

  test('refuses the launch instead of replacing an unparseable config', async () => {
    await withTempDir(async (dir) => {
      const claudeConfigPath = join(dir, '.claude.json');
      // A torn or truncated write of a large config.
      const truncated = '{"projects":{"/repos/other":{"hasTrustDialogAcce';
      await writeFile(claudeConfigPath, truncated, 'utf8');
      const adapter = createClaudeAdapter({
        claudeConfigPath,
        resolvePath: (path) => Promise.resolve(path),
        run: recordingRunner(() => ok()).run,
      });

      const failure = await rejection(adapter.trustRepo('/repos/target'));

      expect(failure).toBeInstanceOf(LaunchError);
      expect(failure.message).toMatch(/not valid JSON/);
      expect(await readFile(claudeConfigPath, 'utf8')).toBe(truncated);
    });
  });

  test('refuses the launch when the config is not a JSON object', async () => {
    await withTempDir(async (dir) => {
      const claudeConfigPath = join(dir, '.claude.json');
      await writeFile(claudeConfigPath, '["nope"]', 'utf8');
      const adapter = createClaudeAdapter({
        claudeConfigPath,
        resolvePath: (path) => Promise.resolve(path),
        run: recordingRunner(() => ok()).run,
      });

      const failure = await rejection(adapter.trustRepo('/repos/target'));

      expect(failure).toBeInstanceOf(LaunchError);
      expect(await readFile(claudeConfigPath, 'utf8')).toBe('["nope"]');
    });
  });

  test('preserves the mode of an existing config', async () => {
    await withTempDir(async (dir) => {
      const claudeConfigPath = join(dir, '.claude.json');
      await writeFile(claudeConfigPath, '{}', 'utf8');
      await chmod(claudeConfigPath, 0o600);
      const adapter = createClaudeAdapter({
        claudeConfigPath,
        resolvePath: (path) => Promise.resolve(path),
        run: recordingRunner(() => ok()).run,
      });

      await adapter.trustRepo('/repos/target');

      expect((await stat(claudeConfigPath)).mode & 0o777).toBe(0o600);
    });
  });

  test('follows a symlinked config instead of replacing the link', async () => {
    await withTempDir(async (dir) => {
      const realConfig = join(dir, 'dotfiles', 'claude.json');
      await writeFile(join(dir, 'placeholder'), '', 'utf8');
      await Bun.write(realConfig, '{"userID":"fixture-user"}');
      const claudeConfigPath = join(dir, '.claude.json');
      await symlink(realConfig, claudeConfigPath);
      const adapter = createClaudeAdapter({
        claudeConfigPath,
        resolvePath: (path) => Promise.resolve(path),
        run: recordingRunner(() => ok()).run,
      });

      await adapter.trustRepo('/repos/target');

      expect((await lstat(claudeConfigPath)).isSymbolicLink()).toBe(true);
      const written: unknown = JSON.parse(await readFile(realConfig, 'utf8'));
      expect(written).toEqual({
        projects: { '/repos/target': { hasTrustDialogAccepted: true } },
        userID: 'fixture-user',
      });
    });
  });

  test('serializes concurrent trust writes so no entry is lost', async () => {
    await withTempDir(async (dir) => {
      const claudeConfigPath = join(dir, '.claude.json');
      await writeFile(claudeConfigPath, JSON.stringify({ userID: 'fixture-user' }), 'utf8');
      const adapter = createClaudeAdapter({
        claudeConfigPath,
        resolvePath: (path) => Promise.resolve(path),
        run: recordingRunner(() => ok()).run,
      });

      await Promise.all([
        adapter.trustRepo('/repos/one'),
        adapter.trustRepo('/repos/two'),
        adapter.trustRepo('/repos/three'),
      ]);

      const written: unknown = JSON.parse(await readFile(claudeConfigPath, 'utf8'));
      expect(written).toEqual({
        projects: {
          '/repos/one': { hasTrustDialogAccepted: true },
          '/repos/three': { hasTrustDialogAccepted: true },
          '/repos/two': { hasTrustDialogAccepted: true },
        },
        userID: 'fixture-user',
      });
      expect((await readdir(dir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    });
  });
});

describe('list', () => {
  test('parses agents --json, defaulting an absent status to unknown', async () => {
    const payload = JSON.stringify([
      {
        cwd: '/repos/example',
        kind: 'interactive',
        name: 'auto-generated-name',
        pid: 4242,
        sessionId: '6f1f0f2e-0000-4000-8000-000000000000',
        startedAt: 1_764_000_000_000,
        status: 'busy',
      },
      { cwd: '/repos/other', kind: 'interactive', pid: 4243, startedAt: 1_764_000_001_000 },
      {
        cwd: '/repos/other',
        id: 'bg1',
        kind: 'background',
        pid: 4244,
        state: 'working',
        status: 'idle',
      },
      'not an object',
    ]);
    const adapter = createClaudeAdapter({
      run: recordingRunner(() => ok(payload)).run,
    });

    const sessions = await adapter.listHostSessions();

    expect(sessions.length).toBe(3);
    expect(sessions[0]).toEqual({
      cwd: '/repos/example',
      id: null,
      kind: 'interactive',
      name: 'auto-generated-name',
      pid: 4242,
      sessionId: '6f1f0f2e-0000-4000-8000-000000000000',
      startedAt: 1_764_000_000_000,
      state: null,
      status: 'busy',
    });
    expect(sessions[1]?.status).toBe('unknown');
    expect(sessions[1]?.name).toBeNull();
    expect(sessions[2]).toMatchObject({ id: 'bg1', kind: 'background', state: 'working' });
  });

  test('invokes claude agents --json', async () => {
    const recording = recordingRunner(() => ok('[]'));
    await createClaudeAdapter({ run: recording.run }).listHostSessions();
    expect(recording.calls).toEqual([['claude', 'agents', '--json']]);
  });

  test('returns nothing when the CLI fails or prints non-JSON', async () => {
    const broken = createClaudeAdapter({ run: recordingRunner(() => failed('boom')).run });
    const noisy = createClaudeAdapter({ run: recordingRunner(() => ok('not json')).run });

    expect(await broken.listHostSessions()).toEqual([]);
    expect(await noisy.listHostSessions()).toEqual([]);
  });
});

describe('stop and liveness', () => {
  test('stop kills the tmux session by name', async () => {
    const recording = recordingRunner(() => ok());
    expect(await createClaudeAdapter({ run: recording.run }).stopSession('ccrc-example-1')).toBe(
      'stopped',
    );
    expect(recording.calls).toEqual([['tmux', 'kill-session', '-t', 'ccrc-example-1']]);
  });

  test('a session tmux cannot find is already gone', async () => {
    const adapter = createClaudeAdapter({
      run: recordingRunner(() => failed("can't find session: ccrc-example-1")).run,
    });
    expect(await adapter.stopSession('ccrc-example-1')).toBe('absent');
  });

  test('any other kill failure is reported rather than swallowed', async () => {
    const adapter = createClaudeAdapter({
      run: recordingRunner(() => failed('operation not permitted')).run,
    });

    const failure = await rejection(adapter.stopSession('ccrc-example-1'));

    expect(failure).toBeInstanceOf(StopError);
    expect(failure.message).toMatch(/operation not permitted/);
  });

  test('live session names come from list-sessions and tolerate a dead tmux server', async () => {
    const listed = createClaudeAdapter({
      run: recordingRunner(() => ok('ccrc-example-1\nccrc-other-3\n')).run,
    });
    const noServer = createClaudeAdapter({
      run: recordingRunner(() => failed('no server running')).run,
    });

    expect(await listed.liveSessionNames()).toEqual(['ccrc-example-1', 'ccrc-other-3']);
    expect(await noServer.liveSessionNames()).toEqual([]);
  });
});
