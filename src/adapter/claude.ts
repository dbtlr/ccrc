import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CommandTimeoutError,
  HealthError,
  LaunchError,
  LivenessError,
  StopError,
} from '../errors.ts';
import { writeFileAtomic } from '../files.ts';
import { createMutex } from '../mutex.ts';

/**
 * The only module in ccrcd that touches the `claude` CLI, tmux, or
 * `~/.claude.json`. Every command it issues goes through an injected
 * `CommandRunner`, so the whole CLI surface can be mocked in tests and CLI
 * drift stays a one-file fix.
 */

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type CommandRunner = (argv: readonly string[]) => Promise<CommandResult>;

export type SessionKind = 'interactive' | 'background' | 'unknown';
export type SessionActivity = 'idle' | 'busy' | 'unknown';

/** One entry of `claude agents --json` — every field is optional in the wild. */
export type HostSession = {
  readonly pid: number | null;
  readonly cwd: string | null;
  readonly kind: SessionKind;
  readonly startedAt: number | null;
  readonly sessionId: string | null;
  readonly name: string | null;
  readonly status: SessionActivity;
  readonly state: 'working' | 'done' | null;
  readonly id: string | null;
};

export type LaunchRequest = {
  readonly repoPath: string;
  readonly tmuxName: string;
  readonly rcName: string;
  readonly prompt?: string | undefined;
};

/** Whether a kill landed or found nothing to kill; any other failure throws. */
export type StopOutcome = 'stopped' | 'absent';

/** Enough to find the transcript a running session is appending to. */
export type TranscriptRef = {
  readonly cwd: string;
  readonly sessionId: string;
};

export type ClaudeAdapter = {
  /** Accept the trust dialog for `repoPath` up front; returns the resolved path. */
  readonly trustRepo: (repoPath: string) => Promise<string>;
  /** Spawn a detached session and return the attach URL scraped from its pane. */
  readonly launchSession: (request: LaunchRequest) => Promise<string>;
  /** Every claude session on this host, ccrcd-launched or not. */
  readonly listHostSessions: () => Promise<readonly HostSession[]>;
  readonly stopSession: (tmuxName: string) => Promise<StopOutcome>;
  /**
   * Names of all live tmux sessions — one call instead of N liveness probes.
   * Throws when tmux could not answer, so an unreadable server is never mistaken
   * for an empty one.
   */
  readonly liveSessionNames: () => Promise<readonly string[]>;
  /**
   * When the session last wrote to its transcript, in epoch milliseconds, or
   * `null` when that cannot be established. A session claiming to be busy while
   * its transcript stands still is the second liveness signal ccrcd has, so
   * `null` has to stay indeterminate: it may never be read as "stale".
   */
  readonly transcriptMtime: (ref: TranscriptRef) => Promise<number | null>;
  /** Resolves when tmux answers; throws when it cannot be reached. */
  readonly checkTmux: () => Promise<void>;
  /** Resolves when the claude CLI answers; throws when it cannot be reached. */
  readonly checkClaude: () => Promise<void>;
};

export type AdapterOptions = {
  readonly run?: CommandRunner;
  readonly commandTimeoutMs?: number;
  readonly claudeConfigPath?: string;
  readonly projectsDir?: string;
  readonly resolvePath?: (path: string) => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly attachUrlPollIntervalMs?: number;
  readonly attachUrlTimeoutMs?: number;
};

const ATTACH_URL_PATTERN = /https:\/\/claude\.ai\/code\/session_[\w-]+/g;
const ATTACH_URL_PREFIX_LENGTH = 'https://claude.ai/code/session_'.length;
const MIN_SESSION_ID_LENGTH = 8;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** The URL usually lands within a few hundred ms, so the first poll is quick. */
const FIRST_POLL_INTERVAL_MS = 150;
const DEFAULT_URL_TIMEOUT_MS = 60_000;
/** Long enough for a slow tmux or claude start, short enough to fail a request. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MISSING_SESSION_PATTERN = /can't find session|no such session|no server running/i;

export const defaultClaudeConfigPath = (home: string = homedir()): string =>
  join(home, '.claude.json');

export const defaultProjectsDir = (home: string = homedir()): string =>
  join(home, '.claude', 'projects');

/**
 * claude files a session's transcript under a directory named after the session's
 * cwd with every character outside `[A-Za-z0-9]` replaced by a dash — so
 * `/repos/example` becomes `-repos-example`. Nothing publishes that scheme, which
 * is exactly why it lives in this module with the rest of the CLI's internals.
 */
export const transcriptSlug = (cwd: string): string => cwd.replaceAll(/[^a-zA-Z0-9]/g, '-');

/**
 * The id is CLI output, so it is treated as untrusted input: a value carrying a
 * separator or a dot segment would resolve outside the projects directory, and
 * `stat` on an operator's arbitrary file is not a liveness signal.
 */
const SESSION_ID_PATTERN = /^[\w-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorCode = (cause: unknown): string | undefined =>
  isRecord(cause) && typeof cause.code === 'string' ? cause.code : undefined;

/**
 * SIGKILL the timed-out child and everything it spawned.
 *
 * `child.kill()` signals the direct pid only, so a descendant that inherited the
 * stdout/stderr pipes keeps them open and the stream reads never settle — the very
 * hang the timeout exists to prevent. Children are spawned `detached`, which puts
 * each one in its own process group, so the negative-pid kill reaches the whole
 * tree and can never reach ccrcd itself. (`Subprocess.killTree` does not exist in
 * Bun 1.3.)
 *
 * A kill that finds nothing (ESRCH) is the normal race with a child exiting on its
 * own; anything else falls back to signalling the direct pid. Neither outcome may
 * throw — the caller is already on its way to reporting a timeout.
 */
const killProcessTree = (child: Bun.Subprocess): void => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (cause) {
    if (errorCode(cause) !== 'ESRCH') {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone; the timeout is reported either way.
      }
    }
  }
  // The request is abandoned from here, so nothing may keep the daemon's event
  // loop alive waiting on a child that was just killed.
  child.unref();
};

/**
 * Spawns real processes; the default `CommandRunner` outside tests.
 *
 * Every command is bounded: a wedged tmux server or a `claude` CLI that never
 * exits would otherwise hold the HTTP request that triggered it open forever,
 * with no output to explain why. On expiry the whole process tree is killed and the
 * timeout is reported as such — the command name only, never the argv, which
 * carries the prompt.
 *
 * The timeout is raced against the output collection rather than checked after it,
 * so the rejection lands within `timeoutMs` even if some pipe outlives the kill.
 */
export const createBunCommandRunner =
  (timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS): CommandRunner =>
  async (argv) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      throw new Error('command runner received an empty argv');
    }
    const child = Bun.spawn([command, ...args], {
      detached: true,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const collected = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const expiry = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      killProcessTree(child);
      expiry.reject(
        new CommandTimeoutError(`${command} did not finish within ${timeoutMs}ms and was killed`),
      );
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.race([collected, expiry.promise]);
      return { exitCode, stderr, stdout };
    } finally {
      clearTimeout(timer);
    }
  };

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asKind = (value: unknown): SessionKind =>
  value === 'interactive' || value === 'background' ? value : 'unknown';

/** `status` is absent on some sessions; absence is reported as "unknown". */
const asActivity = (value: unknown): SessionActivity =>
  value === 'idle' || value === 'busy' ? value : 'unknown';

const asState = (value: unknown): 'working' | 'done' | null =>
  value === 'working' || value === 'done' ? value : null;

const toHostSession = (value: unknown): HostSession | null => {
  if (!isRecord(value)) {
    return null;
  }
  return {
    cwd: asString(value.cwd),
    id: asString(value.id),
    kind: asKind(value.kind),
    name: asString(value.name),
    pid: asNumber(value.pid),
    sessionId: asString(value.sessionId),
    startedAt: asNumber(value.startedAt),
    state: asState(value.state),
    status: asActivity(value.status),
  };
};

/** POSIX single-quote quoting — tmux takes the session command as one shell string. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** `--` so a prompt beginning with a dash is text, not a flag for claude. */
const claudeCommandLine = (rcName: string, prompt?: string): string => {
  const argv = ['claude', '--remote-control', rcName, '--permission-mode', 'bypassPermissions'];
  if (prompt !== undefined && prompt.length > 0) {
    argv.push('--', prompt);
  }
  return argv.map(shellQuote).join(' ');
};

/**
 * Only a missing file is benign. A read error or unparseable content means the
 * real file cannot be reproduced, and writing anyway would replace an operator's
 * whole claude config — account state, oauth, every project entry — with the one
 * key ccrcd wanted to add. Refusing the launch is the safe answer.
 */
const readClaudeConfig = async (path: string): Promise<Record<string, unknown>> => {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') {
      return {};
    }
    throw new LaunchError(
      `the claude CLI config could not be read (${errorCode(cause) ?? 'unknown error'}), so the launch was refused rather than overwrite it`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new LaunchError(
      'the claude CLI config is not valid JSON; repair it and retry — ccrcd refuses to overwrite a config it cannot read',
    );
  }
  if (!isRecord(parsed)) {
    throw new LaunchError(
      'the claude CLI config is not a JSON object; ccrcd refuses to overwrite a config it cannot read',
    );
  }
  return parsed;
};

const isTrusted = (config: Record<string, unknown>, resolvedRepoPath: string): boolean => {
  const projects = isRecord(config.projects) ? config.projects : {};
  const entry = projects[resolvedRepoPath];
  return isRecord(entry) && entry.hasTrustDialogAccepted === true;
};

/**
 * One process-wide mutex: concurrent launches read-modify-write the same config,
 * and interleaving them drops one launch's trust entry.
 */
const configMutex = createMutex();

/**
 * Read-modify-write done immediately before launch — running sessions rewrite the
 * config too. Unrelated top-level keys and sibling project entries are preserved,
 * an existing entry for this repo is merged into rather than replaced, and an
 * already-trusted repo is left alone rather than rewriting the whole file.
 */
const writeTrust = (path: string, resolvedRepoPath: string): Promise<void> =>
  configMutex(async () => {
    const current = await readClaudeConfig(path);
    if (isTrusted(current, resolvedRepoPath)) {
      return;
    }
    const projects = isRecord(current.projects) ? current.projects : {};
    const existing = isRecord(projects[resolvedRepoPath]) ? projects[resolvedRepoPath] : {};
    const next = {
      ...current,
      projects: {
        ...projects,
        [resolvedRepoPath]: { ...existing, hasTrustDialogAccepted: true },
      },
    };
    await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  });

/** The longest plausible attach URL in a pane capture, or nothing. */
const findAttachUrl = (paneText: string): string | undefined =>
  [...paneText.matchAll(ATTACH_URL_PATTERN)]
    .map((match) => match[0])
    .filter((url) => url.length - ATTACH_URL_PREFIX_LENGTH >= MIN_SESSION_ID_LENGTH)
    .toSorted((left, right) => right.length - left.length)[0];

const tailOf = (text: string, lines = 3): string =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-lines)
    .join(' / ');

export const createClaudeAdapter = (options: AdapterOptions = {}): ClaudeAdapter => {
  const run = options.run ?? createBunCommandRunner(options.commandTimeoutMs);
  const claudeConfigPath = options.claudeConfigPath ?? defaultClaudeConfigPath();
  const projectsDir = options.projectsDir ?? defaultProjectsDir();
  const resolvePath = options.resolvePath ?? ((path: string) => realpath(path));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const pollIntervalMs = options.attachUrlPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const urlTimeoutMs = options.attachUrlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS;

  const killSession = (tmuxName: string): Promise<CommandResult> =>
    run(['tmux', 'kill-session', '-t', tmuxName]);

  /**
   * A kill tmux refused is reported, never swallowed: a session that is still
   * running must not be recorded as stopped, or nothing will ever revisit it.
   */
  const stopSession = async (tmuxName: string): Promise<StopOutcome> => {
    const result = await killSession(tmuxName);
    if (result.exitCode === 0) {
      return 'stopped';
    }
    if (MISSING_SESSION_PATTERN.test(result.stderr)) {
      return 'absent';
    }
    throw new StopError(
      `tmux could not kill session ${tmuxName}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
    );
  };

  /**
   * "No server running" is a real answer — nothing is live. Any other failure is
   * tmux declining to answer at all, and reporting that as an empty list would
   * tell reconciliation every session is dead while they all keep running.
   */
  const liveSessionNames = async (): Promise<readonly string[]> => {
    const result = await run(['tmux', 'list-sessions', '-F', '#{session_name}']);
    if (result.exitCode !== 0) {
      if (!MISSING_SESSION_PATTERN.test(result.stderr)) {
        throw new LivenessError(
          `tmux could not list its sessions: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
        );
      }
      return [];
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };

  /**
   * The attach URL is printed only into the session's terminal, so the pane is
   * polled until it appears.
   *
   * `-J` joins wrapped lines: without it a URL wrapped at the pane boundary
   * matches as a truncated prefix and a broken URL gets persisted. The second
   * capture reads the saved normal screen and its history (`-a -S -`), where the
   * URL ends up when claude prints it before entering the alternate screen.
   *
   * A capture tmux refuses means the pane is gone — the command exited — which is
   * an immediate failure rather than 60s of polling a dead session. A timeout is
   * a failed launch too: the tmux session is killed so no orphan is left behind.
   * Recursion rather than a loop keeps the inherently sequential polling free of
   * an await-in-loop suppression.
   */
  const captureAttachUrl = async (tmuxName: string): Promise<string> => {
    const deadline = now() + urlTimeoutMs;
    const poll = async (attempts: number, lastOutput: string): Promise<string> => {
      const pane = await run(['tmux', 'capture-pane', '-p', '-J', '-t', tmuxName]);
      if (pane.exitCode !== 0) {
        await killSession(tmuxName);
        throw new LaunchError(
          `the session ${tmuxName} exited before printing an attach URL: ${pane.stderr.trim() || lastOutput || 'no output'}`,
        );
      }
      const visible = findAttachUrl(pane.stdout);
      if (visible !== undefined) {
        return visible;
      }
      const history = await run([
        'tmux',
        'capture-pane',
        '-p',
        '-J',
        '-q',
        '-a',
        '-S',
        '-',
        '-t',
        tmuxName,
      ]);
      const buried = findAttachUrl(history.stdout);
      if (buried !== undefined) {
        return buried;
      }
      const output = tailOf(pane.stdout) || lastOutput;
      if (now() >= deadline) {
        await killSession(tmuxName);
        throw new LaunchError(
          `no attach URL appeared in tmux session ${tmuxName} within ${urlTimeoutMs}ms (${attempts} polls); the tmux session was killed. Last pane output: ${output || 'none'}`,
        );
      }
      await sleep(
        attempts === 1 ? Math.min(FIRST_POLL_INTERVAL_MS, pollIntervalMs) : pollIntervalMs,
      );
      return poll(attempts + 1, output);
    };
    return poll(1, '');
  };

  const launchSession = async (request: LaunchRequest): Promise<string> => {
    const spawned = await run([
      'tmux',
      'new-session',
      '-d',
      '-s',
      request.tmuxName,
      '-c',
      request.repoPath,
      claudeCommandLine(request.rcName, request.prompt),
    ]);
    if (spawned.exitCode !== 0) {
      throw new LaunchError(
        `tmux could not start session ${request.tmuxName}: ${spawned.stderr.trim() || `exit code ${spawned.exitCode}`}`,
      );
    }
    return captureAttachUrl(request.tmuxName);
  };

  const listHostSessions = async (): Promise<readonly HostSession[]> => {
    const result = await run(['claude', 'agents', '--json']);
    if (result.exitCode !== 0) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(toHostSession).filter((session): session is HostSession => session !== null);
  };

  /**
   * A transcript that cannot be found or read is reported as `null` rather than as
   * an ancient mtime: the only caller kills sessions on the strength of staleness,
   * and a renamed CLI directory layout must not make it kill every session on the
   * host.
   */
  const transcriptMtime = async (ref: TranscriptRef): Promise<number | null> => {
    if (!SESSION_ID_PATTERN.test(ref.sessionId)) {
      return null;
    }
    try {
      const stats = await stat(
        join(projectsDir, transcriptSlug(ref.cwd), `${ref.sessionId}.jsonl`),
      );
      return stats.mtimeMs;
    } catch {
      return null;
    }
  };

  /** Liveness for the health endpoint: tmux with no server running still answers. */
  const checkTmux = async (): Promise<void> => {
    await liveSessionNames();
  };

  const checkClaude = async (): Promise<void> => {
    const result = await run(['claude', '--version']);
    if (result.exitCode !== 0) {
      throw new HealthError(
        `the claude CLI did not answer: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
      );
    }
  };

  const trustRepo = async (repoPath: string): Promise<string> => {
    const resolved = await resolvePath(repoPath);
    await writeTrust(claudeConfigPath, resolved);
    return resolved;
  };

  return {
    checkClaude,
    checkTmux,
    launchSession,
    listHostSessions,
    liveSessionNames,
    stopSession,
    transcriptMtime,
    trustRepo,
  };
};
