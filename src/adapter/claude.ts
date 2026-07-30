import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { LaunchError } from '../errors.ts';

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

export type ClaudeAdapter = {
  /** Accept the trust dialog for `repoPath` up front; returns the resolved path. */
  readonly trustRepo: (repoPath: string) => Promise<string>;
  /** Spawn a detached session and return the attach URL scraped from its pane. */
  readonly launchSession: (request: LaunchRequest) => Promise<string>;
  /** Every claude session on this host, ccrcd-launched or not. */
  readonly listHostSessions: () => Promise<readonly HostSession[]>;
  readonly stopSession: (tmuxName: string) => Promise<void>;
  readonly isSessionAlive: (tmuxName: string) => Promise<boolean>;
  /** Names of all live tmux sessions — one call instead of N liveness probes. */
  readonly liveSessionNames: () => Promise<readonly string[]>;
};

export type AdapterOptions = {
  readonly run?: CommandRunner;
  readonly claudeConfigPath?: string;
  readonly resolvePath?: (path: string) => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly attachUrlPollIntervalMs?: number;
  readonly attachUrlTimeoutMs?: number;
};

const ATTACH_URL_PATTERN = /https:\/\/claude\.ai\/code\/session_[\w-]+/;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_URL_TIMEOUT_MS = 60_000;

export const defaultClaudeConfigPath = (home: string = homedir()): string =>
  join(home, '.claude.json');

/** Spawns real processes; the default `CommandRunner` outside tests. */
export const bunCommandRunner: CommandRunner = async (argv) => {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new Error('command runner received an empty argv');
  }
  const child = Bun.spawn([command, ...args], { stderr: 'pipe', stdout: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const claudeCommandLine = (rcName: string, prompt?: string): string => {
  const argv = ['claude', '--remote-control', rcName, '--permission-mode', 'bypassPermissions'];
  if (prompt !== undefined && prompt.length > 0) {
    argv.push(prompt);
  }
  return argv.map(shellQuote).join(' ');
};

const readJsonObject = async (path: string): Promise<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * Running sessions rewrite `~/.claude.json` concurrently, so this is a
 * read-modify-write done immediately before launch: unrelated top-level keys and
 * sibling project entries are preserved, and an existing entry for this repo is
 * merged into rather than replaced.
 */
const writeTrust = async (path: string, resolvedRepoPath: string): Promise<void> => {
  const current = await readJsonObject(path);
  const projects = isRecord(current.projects) ? current.projects : {};
  const existing = isRecord(projects[resolvedRepoPath]) ? projects[resolvedRepoPath] : {};
  const next = {
    ...current,
    projects: {
      ...projects,
      [resolvedRepoPath]: { ...existing, hasTrustDialogAccepted: true },
    },
  };
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.ccrcd.tmp`;
  await writeFile(staging, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(staging, path);
};

export const createClaudeAdapter = (options: AdapterOptions = {}): ClaudeAdapter => {
  const run = options.run ?? bunCommandRunner;
  const claudeConfigPath = options.claudeConfigPath ?? defaultClaudeConfigPath();
  const resolvePath = options.resolvePath ?? ((path: string) => realpath(path));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const pollIntervalMs = options.attachUrlPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const urlTimeoutMs = options.attachUrlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS;

  const stopSession = async (tmuxName: string): Promise<void> => {
    await run(['tmux', 'kill-session', '-t', tmuxName]);
  };

  const isSessionAlive = async (tmuxName: string): Promise<boolean> => {
    const result = await run(['tmux', 'has-session', '-t', tmuxName]);
    return result.exitCode === 0;
  };

  const liveSessionNames = async (): Promise<readonly string[]> => {
    const result = await run(['tmux', 'list-sessions', '-F', '#{session_name}']);
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };

  /**
   * The attach URL is printed only into the session's terminal, so the pane is
   * polled until it appears. A timeout is a failed launch: the tmux session is
   * killed so no orphan is left behind. Recursion rather than a loop keeps the
   * inherently sequential polling free of an await-in-loop suppression.
   */
  const captureAttachUrl = async (tmuxName: string): Promise<string> => {
    const deadline = now() + urlTimeoutMs;
    const poll = async (attempts: number): Promise<string> => {
      const pane = await run(['tmux', 'capture-pane', '-t', tmuxName, '-p']);
      const found = ATTACH_URL_PATTERN.exec(pane.stdout);
      if (found !== null) {
        return found[0];
      }
      if (now() >= deadline) {
        await stopSession(tmuxName);
        throw new LaunchError(
          `no attach URL appeared in tmux session ${tmuxName} within ${urlTimeoutMs}ms (${attempts} polls); the tmux session was killed`,
        );
      }
      await sleep(pollIntervalMs);
      return poll(attempts + 1);
    };
    return poll(1);
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

  const trustRepo = async (repoPath: string): Promise<string> => {
    const resolved = await resolvePath(repoPath);
    await writeTrust(claudeConfigPath, resolved);
    return resolved;
  };

  return {
    isSessionAlive,
    launchSession,
    listHostSessions,
    liveSessionNames,
    stopSession,
    trustRepo,
  };
};
