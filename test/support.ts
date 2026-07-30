import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ClaudeAdapter,
  CommandResult,
  CommandRunner,
  HostSession,
  LaunchRequest,
} from '../src/adapter/claude.ts';

export const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stderr: '', stdout });

export const failed = (stderr = '', exitCode = 1): CommandResult => ({
  exitCode,
  stderr,
  stdout: '',
});

export type Recording = {
  readonly calls: string[][];
  readonly run: CommandRunner;
};

/** A `CommandRunner` that records argv and answers from a caller-supplied table. */
export const recordingRunner = (
  respond: (argv: readonly string[], callIndex: number) => CommandResult,
): Recording => {
  const calls: string[][] = [];
  const run: CommandRunner = (argv) => {
    calls.push([...argv]);
    return Promise.resolve(respond(argv, calls.length - 1));
  };
  return { calls, run };
};

export const tmuxCalls = (recording: Recording, subcommand: string): string[][] =>
  recording.calls.filter((argv) => argv[0] === 'tmux' && argv[1] === subcommand);

/** Advancing clock: every simulated sleep moves `now` forward by that amount. */
export const fakeClock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let current = 0;
  return {
    now: () => current,
    sleep: (ms) => {
      current += ms;
      return Promise.resolve();
    },
  };
};

/**
 * Returns the error a promise rejected with. Used instead of `expect().rejects`,
 * whose Bun typings are not thenable and so cannot be awaited type-safely.
 */
export const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  throw new Error('expected the promise to reject, but it resolved');
};

export const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'ccrcd-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

export type FakeAdapter = ClaudeAdapter & {
  readonly launches: LaunchRequest[];
  readonly stopped: string[];
  liveNames: string[];
  hostSessions: HostSession[];
  attachUrl: string | Error;
};

export const hostSession = (overrides: Partial<HostSession> = {}): HostSession => ({
  cwd: null,
  id: null,
  kind: 'interactive',
  name: null,
  pid: null,
  sessionId: null,
  startedAt: null,
  state: null,
  status: 'unknown',
  ...overrides,
});

/** Stand-in adapter for HTTP tests — no tmux, no claude CLI, no home directory. */
export const fakeAdapter = (): FakeAdapter => {
  const launches: LaunchRequest[] = [];
  const stopped: string[] = [];
  const adapter: FakeAdapter = {
    attachUrl: 'https://claude.ai/code/session_abc123',
    hostSessions: [],
    isSessionAlive: (tmuxName) => Promise.resolve(adapter.liveNames.includes(tmuxName)),
    launchSession: (request) => {
      launches.push(request);
      if (adapter.attachUrl instanceof Error) {
        return Promise.reject(adapter.attachUrl);
      }
      adapter.liveNames = [...adapter.liveNames, request.tmuxName];
      return Promise.resolve(adapter.attachUrl);
    },
    launches,
    listHostSessions: () => Promise.resolve(adapter.hostSessions),
    liveNames: [],
    liveSessionNames: () => Promise.resolve(adapter.liveNames),
    stopSession: (tmuxName) => {
      stopped.push(tmuxName);
      adapter.liveNames = adapter.liveNames.filter((name) => name !== tmuxName);
      return Promise.resolve();
    },
    stopped,
    trustRepo: (repoPath) => Promise.resolve(repoPath),
  };
  return adapter;
};
