import { describe, expect, test } from 'bun:test';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createClaudeAdapter } from '../src/adapter/claude.ts';
import { LaunchError } from '../src/errors.ts';
import {
  failed,
  fakeClock,
  ok,
  recordingRunner,
  rejection,
  tmuxCalls,
  withTempDir,
} from './support.ts';

const ATTACH_URL = 'https://claude.ai/code/session_01JQ4Z8YB0';

describe('launch', () => {
  test('spawns a detached tmux session and returns the attach URL from the pane', async () => {
    const clock = fakeClock();
    const recording = recordingRunner((argv) => {
      if (argv[1] === 'capture-pane') {
        // The URL is printed a moment after startup: first poll misses.
        return ok(
          tmuxCalls(recording, 'capture-pane').length > 1 ? `> ${ATTACH_URL}\n` : 'booting',
        );
      }
      return ok();
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
      "'claude' '--remote-control' 'ccrc-abc' '--permission-mode' 'bypassPermissions' '/review the diff'",
    ]);
    expect(tmuxCalls(recording, 'capture-pane').length).toBe(2);
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

  test('single-quotes prompts so shell metacharacters cannot escape the command', async () => {
    const recording = recordingRunner((argv) => ok(argv[1] === 'capture-pane' ? ATTACH_URL : ''));
    const adapter = createClaudeAdapter({ run: recording.run });

    await adapter.launchSession({
      prompt: "don't; rm -rf /",
      rcName: 'ccrc-abc',
      repoPath: '/repos/example',
      tmuxName: 'ccrc-example-1',
    });

    expect(tmuxCalls(recording, 'new-session')[0]?.at(-1)).toContain(
      String.raw`'don'\''t; rm -rf /'`,
    );
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
    await createClaudeAdapter({ run: recording.run }).stopSession('ccrc-example-1');
    expect(recording.calls).toEqual([['tmux', 'kill-session', '-t', 'ccrc-example-1']]);
  });

  test('liveness follows the exit code of tmux has-session', async () => {
    const alive = recordingRunner(() => ok());
    const gone = recordingRunner(() => failed("can't find session"));

    expect(await createClaudeAdapter({ run: alive.run }).isSessionAlive('ccrc-example-1')).toBe(
      true,
    );
    expect(await createClaudeAdapter({ run: gone.run }).isSessionAlive('ccrc-example-1')).toBe(
      false,
    );
    expect(alive.calls).toEqual([['tmux', 'has-session', '-t', 'ccrc-example-1']]);
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
