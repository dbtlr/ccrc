import { dirname, join } from 'node:path';

import type { WorkspaceAdapter } from './adapter/workspaces.ts';
import { findRepo } from './config.ts';
import type { Config, RepoEntry } from './config.ts';
import { BadRequestError, ConflictError, NotFoundError, messageOf } from './errors.ts';
import { createLogger } from './log.ts';
import type { Logger } from './log.ts';

/**
 * What can be launched, and how a new one comes to exist.
 *
 * The launchable set is the config's `[[repos]]` plus whatever directories are
 * sitting under `workspaces_root` right now. Nothing is written down: the scan is
 * the registry, so a workspace created by ccrcd, by `git clone`, or by `mkdir`
 * behaves identically and there is no bookkeeping to drift out of date.
 *
 * The cost of that is worth stating plainly: **everything directly under the root is
 * launchable**, and a launch runs with `bypassPermissions`. The root is a directory
 * the operator hands to the daemon wholesale.
 */

export type WorkspaceSummary = {
  readonly name: string;
  readonly path: string;
};

/** Where `launch` looks a repo name up. Config-only unless a root is configured. */
export type RepoRegistry = {
  readonly list: () => Promise<readonly RepoEntry[]>;
  readonly find: (name: string) => Promise<RepoEntry | undefined>;
};

export type WorkspaceService = {
  readonly create: (name: string) => Promise<WorkspaceSummary>;
};

export type RegistryOptions = {
  readonly config: Config;
  /** Omitted, the registry is the config alone — no scanning, no filesystem. */
  readonly adapter?: WorkspaceAdapter | undefined;
  readonly logger?: Logger;
};

/**
 * A workspace name has to be one ordinary directory name and nothing cleverer. It
 * is joined onto the root and handed to `mkdir`, so anything with a separator, a
 * dot segment, or a NUL in it is refused outright rather than resolved and hoped
 * about; a leading dot is refused too, since the scan skips dotted directories and
 * the workspace would be created invisible to the very list it belongs in.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME_LENGTH = 64;

export const checkWorkspaceName = (name: unknown): string => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new BadRequestError('"name" is required and must be a string');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new BadRequestError(`"name" must be at most ${MAX_NAME_LENGTH} characters`);
  }
  if (!NAME_PATTERN.test(name) || name.includes('..')) {
    throw new BadRequestError(
      '"name" must be one path segment of letters, digits, dots, dashes, or underscores, starting with a letter or digit',
    );
  }
  return name;
};

export const createRepoRegistry = (options: RegistryOptions): RepoRegistry => {
  const { adapter, config } = options;
  const logger = options.logger ?? createLogger();
  const root = config.workspacesRoot;
  // Reported once per name: the scan runs on every read, and an operator does not
  // need the same line every three seconds for as long as the shadowing lasts.
  const reported = new Set<string>();

  /**
   * A root that cannot be read is a registry that is smaller than it should be, not
   * a failed request: the config's own repos still launch, and reporting nothing at
   * all would leave an operator wondering where their workspaces went.
   */
  const scan = async (): Promise<readonly string[]> => {
    if (adapter === undefined || root === null) {
      return [];
    }
    try {
      return await adapter.listDirectories(root);
    } catch (cause) {
      logger.error(
        `ccrcd could not scan the workspaces root, so only configured repos are launchable: ${messageOf(cause)}`,
      );
      return [];
    }
  };

  const list = async (): Promise<readonly RepoEntry[]> => {
    const scanned = await scan();
    const configured = new Set(config.repos.map((repo) => repo.name));
    const workspaces: RepoEntry[] = [];
    for (const name of scanned) {
      if (configured.has(name)) {
        if (!reported.has(name)) {
          reported.add(name);
          logger.info(
            `ccrcd is using the configured repo "${name}"; the directory of that name under the workspaces root is shadowed by it`,
          );
        }
        continue;
      }
      workspaces.push({ name, path: join(root ?? '', name) });
    }
    return [...config.repos, ...workspaces];
  };

  /** The config wins on a name collision, so it is consulted first. */
  const find = async (name: string): Promise<RepoEntry | undefined> => {
    const configured = findRepo(config, name);
    if (configured !== undefined) {
      return configured;
    }
    if (root === null) {
      return undefined;
    }
    const scanned = await scan();
    return scanned.includes(name) ? { name, path: join(root, name) } : undefined;
  };

  return { find, list };
};

export type WorkspaceServiceOptions = {
  readonly config: Config;
  readonly adapter: WorkspaceAdapter;
  readonly logger?: Logger;
};

export const createWorkspaceService = (options: WorkspaceServiceOptions): WorkspaceService => {
  const { adapter, config } = options;
  const logger = options.logger ?? createLogger();

  /**
   * Creating a workspace is: make the directory, make it a git repo, and leave one
   * empty commit behind so a session has a history to work against from its first
   * turn.
   *
   * The containment check is done against the root's *real* path and repeated
   * against the created directory's, so a symlinked root and a symlink racing into
   * place both land inside the directory the operator named rather than somewhere
   * a name was able to point.
   */
  const create = async (rawName: string): Promise<WorkspaceSummary> => {
    const root = config.workspacesRoot;
    if (root === null) {
      throw new NotFoundError(
        'ccrcd has no workspaces root configured, so it cannot create workspaces. Set "workspaces_root" in the config and restart the daemon.',
      );
    }
    const name = checkWorkspaceName(rawName);
    if (findRepo(config, name) !== undefined) {
      throw new ConflictError(`"${name}" is already a configured repo name`);
    }

    const realRoot = await adapter.prepareRoot(root);
    const target = join(realRoot, name);
    if (dirname(target) !== realRoot) {
      throw new BadRequestError(`"${name}" does not name a directory inside the workspaces root`);
    }
    if (await adapter.exists(target)) {
      throw new ConflictError(`workspace "${name}" already exists`);
    }

    const created = await adapter.createDirectory(target);
    if (dirname(created) !== realRoot) {
      await adapter.removeIfPristine(created);
      throw new BadRequestError(`"${name}" does not name a directory inside the workspaces root`);
    }

    try {
      await adapter.initRepo(created);
    } catch (cause) {
      // A directory left behind here would be launchable on the next scan while
      // being no kind of repo, so it goes if it is still nothing but what ccrcd
      // just made.
      const removed = await adapter.removeIfPristine(created);
      logger.error(
        `ccrcd could not initialise workspace "${name}"${removed ? ' and removed the directory it had made' : ', and left the directory in place because it was not empty'}: ${messageOf(cause)}`,
      );
      throw cause;
    }

    logger.info(`ccrcd created workspace "${name}"`);
    return { name, path: created };
  };

  return { create };
};
