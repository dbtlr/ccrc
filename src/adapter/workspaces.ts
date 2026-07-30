import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';

import { WorkspaceError } from '../errors.ts';
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
  /** Removes a directory that holds nothing but `.git`; reports whether it did. */
  readonly removeIfPristine: (path: string) => Promise<boolean>;
};

export type WorkspaceAdapterOptions = {
  readonly run?: CommandRunner;
  readonly commandTimeoutMs?: number;
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

/** The tail of whatever the command said, or its exit code — never its argv. */
const failureOf = (stderr: string, exitCode: number): string =>
  stderr.trim().split('\n').slice(-2).join(' / ') || `exit code ${exitCode}`;

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

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
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
    if (errorCode(cause) === 'EEXIST') {
      throw new WorkspaceError('that workspace already exists');
    }
    throw new WorkspaceError(
      `the workspace directory could not be created (${errorCode(cause) ?? 'unknown error'})`,
    );
  }
  return realpath(path);
};

/**
 * Cleanup after a failed creation, and deliberately timid about it: a directory
 * holding anything beyond `.git` is not one ccrcd made a moment ago, and deleting
 * an operator's files to tidy up after itself is the worse mistake.
 */
const removeIfPristine = async (path: string): Promise<boolean> => {
  try {
    const entries = await readdir(path);
    if (entries.some((entry) => entry !== '.git')) {
      return false;
    }
    await rm(path, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
};

export const createWorkspaceAdapter = (options: WorkspaceAdapterOptions = {}): WorkspaceAdapter => {
  const run = options.run ?? createBunCommandRunner(options.commandTimeoutMs);

  const initRepo = async (path: string): Promise<void> => {
    const initialised = await run(['git', '-C', path, 'init', '-q']);
    if (initialised.exitCode !== 0) {
      throw new WorkspaceError(
        `git could not initialise the workspace: ${failureOf(initialised.stderr, initialised.exitCode)}`,
      );
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
      throw new WorkspaceError(
        `git could not make the first commit: ${failureOf(committed.stderr, committed.exitCode)}`,
      );
    }
  };

  return { createDirectory, exists, initRepo, listDirectories, prepareRoot, removeIfPristine };
};
