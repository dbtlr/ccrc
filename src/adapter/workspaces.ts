import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';

import { ConflictError, WorkspaceError } from '../errors.ts';
import { createLogger } from '../log.ts';
import type { Logger } from '../log.ts';
import { createBunCommandRunner } from './claude.ts';
import type { CommandRunner } from './claude.ts';

/**
 * The only module that reads the workspaces root or shells out to `git`.
 *
 * It sits beside the claude adapter rather than inside it: that one owns the
 * `claude` CLI and tmux and nothing else. What the two share is the bounded command
 * runner — every process this spawns is timed out and killed as a group, because a
 * `git` that hangs on a credential prompt would otherwise hold an HTTP request open
 * forever.
 */

export type WorkspaceAdapter = {
  /** Names of the directories directly under `root`; a missing root is empty. */
  readonly listDirectories: (root: string) => Promise<readonly string[]>;
  /** Creates the root if it is not there yet and returns its real path. */
  readonly prepareRoot: (root: string) => Promise<string>;
  /** Whether anything at all exists at that path — file, directory, or link. */
  readonly exists: (path: string) => Promise<boolean>;
  /** Creates one directory, failing if it is already there; returns its real path. */
  readonly createDirectory: (path: string) => Promise<string>;
  /** `git init` plus one empty initial commit. */
  readonly initRepo: (path: string) => Promise<void>;
  /** Moves a finished workspace onto its final name; a taken name is a conflict. */
  readonly publish: (from: string, to: string) => Promise<string>;
  /** Removes a staging directory and everything in it. Never throws. */
  readonly discard: (path: string) => Promise<void>;
};

export type WorkspaceAdapterOptions = {
  readonly run?: CommandRunner;
  readonly commandTimeoutMs?: number;
  readonly logger?: Logger;
};

/**
 * The commit is made with an identity given inline. A daemon started by launchd has
 * no global git config to fall back on, so without this `git commit` fails on a
 * fresh machine with "please tell me who you are"; signing is turned off for the
 * same reason, since there is no terminal to unlock a key from.
 */
const GIT_IDENTITY = [
  '-c',
  'user.name=ccrcd',
  '-c',
  'user.email=ccrcd@localhost',
  '-c',
  'commit.gpgsign=false',
];

const INITIAL_COMMIT_MESSAGE = 'chore: initialize workspace';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorCode = (cause: unknown): string | undefined =>
  isRecord(cause) && typeof cause.code === 'string' ? cause.code : undefined;

/**
 * What went wrong, for the log alone. git quotes host paths, remotes, and its own
 * command line into stderr, and the caller's failure is served to an HTTP client —
 * so the client is told which step failed and the log is told why.
 */
const failureOf = (stderr: string, exitCode: number): string =>
  stderr.trim().split('\n').slice(-3).join(' / ') || `exit code ${exitCode}`;

/**
 * Only real directories count, and only the ones directly under the root.
 *
 * Symlinks are left out on purpose: everything this returns is launchable with
 * `bypassPermissions`, and a link is how a directory outside the root — one the
 * operator never meant to expose — would end up inside it. Dotted names are left
 * out too, so `.git`, `.cache`, and friends are not sessions waiting to happen.
 */
const listDirectories = async (root: string): Promise<readonly string[]> => {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') {
      return [];
    }
    throw new WorkspaceError(
      `the workspaces root could not be read (${errorCode(cause) ?? 'unknown error'})`,
    );
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
};

const prepareRoot = async (root: string): Promise<string> => {
  try {
    await mkdir(root, { recursive: true });
    return await realpath(root);
  } catch (cause) {
    throw new WorkspaceError(
      `the workspaces root could not be prepared (${errorCode(cause) ?? 'unknown error'})`,
    );
  }
};

/**
 * `lstat`, not `stat`: a symlink pointing at nothing follows to "no such file"
 * while the name itself is thoroughly taken — `mkdir` would refuse it every time,
 * and reporting it as free means answering a permanent conflict as a server error.
 */
const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') {
      return false;
    }
    // Anything else means the path cannot be ruled out, and creating over
    // something that might be there is worse than refusing.
    throw new WorkspaceError(
      `the workspace path could not be checked (${errorCode(cause) ?? 'unknown error'})`,
    );
  }
};

/** Not recursive: the parent is the root, which is prepared separately. */
const createDirectory = async (path: string): Promise<string> => {
  try {
    await mkdir(path);
  } catch (cause) {
    // Losing the race to another creation is the same answer as asking for a name
    // that was already taken when the request arrived.
    if (errorCode(cause) === 'EEXIST') {
      throw new ConflictError('that workspace already exists');
    }
    throw new WorkspaceError(
      `the workspace directory could not be created (${errorCode(cause) ?? 'unknown error'})`,
    );
  }
  return realpath(path);
};

/**
 * Puts a finished workspace under the name it was asked for, in one step.
 *
 * `rename` inside one filesystem is atomic, so there is no moment where the final
 * name exists but holds something unfinished — which is the whole reason creation
 * happens somewhere else first. A target that is already a non-empty directory makes
 * this fail, and that failure is a name someone else took, not a broken host.
 */
const publish = async (from: string, to: string): Promise<string> => {
  try {
    await rename(from, to);
  } catch (cause) {
    const code = errorCode(cause);
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR') {
      throw new ConflictError('that workspace already exists');
    }
    throw new WorkspaceError(
      `the workspace could not be put in place (${code ?? 'unknown error'})`,
    );
  }
  return realpath(to);
};

/**
 * Staging is ccrcd's own scratch directory under a name the scan skips, so unlike a
 * real workspace there is never a question of whether it is safe to delete: it was
 * never launchable and nothing else knows it exists.
 */
const discard = async (path: string): Promise<void> => {
  try {
    await rm(path, { force: true, recursive: true });
  } catch {
    // Best effort. The staging name is unique and invisible to the scan, so the
    // worst case is one stray directory rather than a workspace nobody meant.
  }
};

export const createWorkspaceAdapter = (options: WorkspaceAdapterOptions = {}): WorkspaceAdapter => {
  const run = options.run ?? createBunCommandRunner(options.commandTimeoutMs);
  const logger = options.logger ?? createLogger();

  const initRepo = async (path: string): Promise<void> => {
    const initialised = await run(['git', '-C', path, 'init', '-q']);
    if (initialised.exitCode !== 0) {
      logger.error(
        `ccrcd could not git-init ${path}: ${failureOf(initialised.stderr, initialised.exitCode)}`,
      );
      throw new WorkspaceError('git could not initialise the workspace');
    }
    const committed = await run([
      'git',
      '-C',
      path,
      ...GIT_IDENTITY,
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      INITIAL_COMMIT_MESSAGE,
    ]);
    if (committed.exitCode !== 0) {
      logger.error(
        `ccrcd could not make the first commit in ${path}: ${failureOf(committed.stderr, committed.exitCode)}`,
      );
      throw new WorkspaceError('git could not make the first commit in the workspace');
    }
  };

  return { createDirectory, discard, exists, initRepo, listDirectories, prepareRoot, publish };
};
