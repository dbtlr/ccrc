import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ClaudeAdapter,
  CommandResult,
  CommandRunner,
  HostSession,
  LaunchRequest,
  StopOutcome,
} from '../src/adapter/claude.ts';
import { createLogger } from '../src/log.ts';
import type { Logger } from '../src/log.ts';
import type { SessionRecord } from '../src/state.ts';

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

/** A stored session record, with only the fields a test cares about overridden. */
export const sessionRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  attachUrl: 'https://claude.ai/code/session_01JQ4Z8YB0',
  endedAt: null,
  host: 'test-host',
  hostSessionId: null,
  id: 'id1',
  name: 'example-1',
  pid: null,
  rcName: 'ccrc-id1',
  repoName: 'example',
  repoPath: '/repos/example',
  restartedAs: null,
  restartedFrom: null,
  restarts: [],
  startedAt: 1_764_000_000_000,
  status: 'running',
  stopReason: null,
  tmuxName: 'ccrc-example-1',
  ...overrides,
});

export type CapturedLog = {
  readonly logger: Logger;
  /** Lines written to stdout, formatted exactly as the daemon writes them. */
  readonly info: string[];
  readonly errors: string[];
};

/** A real logger with both sinks captured, so tests read lines instead of a stream. */
export const capturingLogger = (now: () => number = () => 0): CapturedLog => {
  const info: string[] = [];
  const errors: string[] = [];
  return {
    errors,
    info,
    logger: createLogger({
      err: (line) => void errors.push(line),
      now,
      out: (line) => void info.push(line),
    }),
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
  stopOutcome: StopOutcome | Error;
  trustFailure: Error | null;
  /** Set when tmux cannot be asked which sessions are live. */
  liveFailure: Error | null;
  /** Transcript mtimes by session id; an id with no entry reads as indeterminate. */
  transcripts: Record<string, number>;
  /** Set when the transcript path itself cannot be probed. */
  transcriptFailure: Error | null;
  /** Set when the health probe for that dependency should fail. */
  tmuxHealthFailure: Error | null;
  claudeHealthFailure: Error | null;
  /** Awaited before every `listHostSessions`, to interleave requests on purpose. */
  listDelay: () => Promise<void>;
  /** Awaited before every `stopSession`, to interleave requests on purpose. */
  stopDelay: () => Promise<void>;
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
    checkClaude: () =>
      adapter.claudeHealthFailure === null
        ? Promise.resolve()
        : Promise.reject(adapter.claudeHealthFailure),
    checkTmux: () =>
      adapter.tmuxHealthFailure === null
        ? Promise.resolve()
        : Promise.reject(adapter.tmuxHealthFailure),
    claudeHealthFailure: null,
    hostSessions: [],
    // tmux comes up before the attach URL is polled for, so a launch that fails
    // still leaves a session behind — the case the service has to clean up after.
    launchSession: (request) => {
      launches.push(request);
      adapter.liveNames = [...adapter.liveNames, request.tmuxName];
      return adapter.attachUrl instanceof Error
        ? Promise.reject(adapter.attachUrl)
        : Promise.resolve(adapter.attachUrl);
    },
    launches,
    listDelay: () => Promise.resolve(),
    listHostSessions: async () => {
      await adapter.listDelay();
      return adapter.hostSessions;
    },
    liveFailure: null,
    liveNames: [],
    liveSessionNames: () =>
      adapter.liveFailure === null
        ? Promise.resolve(adapter.liveNames)
        : Promise.reject(adapter.liveFailure),
    stopDelay: () => Promise.resolve(),
    stopOutcome: 'stopped',
    stopSession: async (tmuxName) => {
      await adapter.stopDelay();
      if (adapter.stopOutcome instanceof Error) {
        throw adapter.stopOutcome;
      }
      stopped.push(tmuxName);
      adapter.liveNames = adapter.liveNames.filter((name) => name !== tmuxName);
      return adapter.stopOutcome;
    },
    stopped,
    tmuxHealthFailure: null,
    transcriptFailure: null,
    transcriptMtime: (ref) =>
      adapter.transcriptFailure === null
        ? Promise.resolve(adapter.transcripts[ref.sessionId] ?? null)
        : Promise.reject(adapter.transcriptFailure),
    transcripts: {},
    trustFailure: null,
    trustRepo: (repoPath) =>
      adapter.trustFailure === null
        ? Promise.resolve(repoPath)
        : Promise.reject(adapter.trustFailure),
  };
  return adapter;
};
