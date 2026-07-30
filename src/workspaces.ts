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

/** Whether a repo path is still there. `unknown` when the host would not say. */
export type PathState = 'present' | 'missing' | 'unknown';

/** Everything launchable right now, and whether that answer is the whole of it. */
export type RegistryListing = {
  readonly repos: readonly RepoEntry[];
  /** True when the workspaces root could not be read, so the list is short. */
  readonly workspacesUnavailable: boolean;
};

/** Where `launch` looks a repo name up. Config-only unless a root is configured. */
export type RepoRegistry = {
  readonly list: () => Promise<RegistryListing>;
  readonly find: (name: string) => Promise<RepoEntry | undefined>;
  /**
   * Whether a path a record was launched from is still usable. The watchdog asks
   * before it kills anything, because "gone" and "cannot tell" call for opposite
   * behaviour and only one of them is a reason to retire a session.
   */
  readonly checkPath: (path: string) => Promise<PathState>;
};

export type WorkspaceService = {
  readonly create: (name: string) => Promise<WorkspaceSummary>;
  /** Clears staging directories an earlier run left behind. Never throws. */
  readonly sweepStaging: () => Promise<number>;
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
   * A root that cannot be read leaves the registry *unknown*, and unknown is not
   * empty. Swallowing the failure would answer `/repos` with a list that quietly
   * omits every workspace, and answer a launch into one of them with "no such repo" —
   * both of which read as "your work is gone" when the truth is "this host would not
   * say". The same lesson tmux liveness taught: indeterminate has to stay
   * indeterminate.
   *
   * A root that simply does not exist yet is a different answer, and an honest one:
   * there is nothing there.
   */
  let scanFailureLogged = false;
  const scan = async (): Promise<readonly string[]> => {
    if (adapter === undefined || root === null) {
      return [];
    }
    try {
      const listed = await adapter.listDirectories(root);
      scanFailureLogged = false;
      return listed;
    } catch (cause) {
      // Logged once per outage, not once per poll — the console asks every few
      // seconds, and a dropped mount would otherwise fill the log with one line.
      if (!scanFailureLogged) {
        scanFailureLogged = true;
        logger.error(`ccrcd could not scan the workspaces root: ${messageOf(cause)}`);
      }
      throw cause;
    }
  };

  /**
   * A listing is not all-or-nothing. The configured repos are known whatever the
   * filesystem is doing and they still launch, so they are still offered; what is
   * missing is named instead of being passed off as an empty root. Refusing the whole
   * list would leave the console with an empty picker and no way to launch the repos
   * that are demonstrably fine.
   */
  const list = async (): Promise<RegistryListing> => {
    let scanned: readonly string[];
    try {
      scanned = await scan();
    } catch {
      // Already logged where it happened.
      return { repos: config.repos, workspacesUnavailable: true };
    }
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
    return { repos: [...config.repos, ...workspaces], workspacesUnavailable: false };
  };

  /**
   * The config wins on a name collision, so it is consulted first — which also means
   * a configured repo still launches while the scan is failing.
   */
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

  /**
   * Without an adapter there is nothing to ask, so the answer is the behaviour ccrcd
   * had before any of this existed: try the launch and let it fail if the path is
   * bad. A configured registry has a filesystem to consult and gives a real answer.
   */
  const checkPath = async (path: string): Promise<PathState> => {
    if (adapter === undefined) {
      return 'present';
    }
    try {
      return (await adapter.exists(path)) ? 'present' : 'missing';
    } catch (cause) {
      logger.error(`ccrcd could not check the repo path ${path}: ${messageOf(cause)}`);
      return 'unknown';
    }
  };

  return { checkPath, find, list };
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
   * Creating a workspace is: make the directory, make it a git repo, leave one empty
   * commit behind so a session has a history to work against from its first turn —
   * and only then let it have the name it was asked for.
   *
   * That last part is the point of the staging directory. The scan is the registry,
   * so a directory sitting at the final name is launchable the instant it exists,
   * including while `git init` is still running and including when that fails; a
   * session launched into it would then have its working directory deleted by the
   * cleanup. Staging is dotted, which the scan skips, so the name appears only when
   * there is a finished workspace behind it, and cleanup only ever removes a
   * directory nothing could have launched into.
   *
   * The containment check is done against the root's *real* path and repeated on the
   * published path, so a symlinked root and a symlink racing into place both land
   * inside the directory the operator named rather than somewhere a name was able to
   * point.
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

    const staging = join(realRoot, `.${name}.creating-${crypto.randomUUID().slice(0, 8)}`);
    const created = await adapter.createDirectory(staging);
    // Where the workspace currently sits on disk: staging until the publish rename
    // lands, the published path after — so a failure past the rename cleans up the
    // live directory rather than no-op'ing on the staging path that no longer exists.
    let current = created;
    try {
      if (dirname(created) !== realRoot) {
        throw new BadRequestError(`"${name}" does not name a directory inside the workspaces root`);
      }
      await adapter.initRepo(created);
      // Checked again on the way out: the gap between the first check and here is
      // exactly long enough for a `git clone` to have taken the name.
      if (await adapter.exists(target)) {
        throw new ConflictError(`workspace "${name}" already exists`);
      }
      const published = await adapter.publish(created, target);
      current = published;
      if (dirname(published) !== realRoot) {
        throw new BadRequestError(`"${name}" does not name a directory inside the workspaces root`);
      }
      logger.info(`ccrcd created workspace "${name}"`);
      return { name, path: published };
    } catch (cause) {
      await adapter.discard(current);
      logger.error(`ccrcd could not create workspace "${name}": ${messageOf(cause)}`);
      throw cause;
    }
  };

  /**
   * Run once at startup. A daemon killed between `mkdir` and `rename` leaves a
   * staging directory behind, and so does a removal that silently did not take;
   * neither is launchable, so both are simply cleared before the daemon gets going.
   */
  const sweepStaging = async (): Promise<number> => {
    const root = config.workspacesRoot;
    if (root === null) {
      return 0;
    }
    try {
      const swept = await adapter.sweepStaging(root);
      if (swept > 0) {
        logger.info(`ccrcd swept ${swept} unfinished workspace directories from an earlier run`);
      }
      return swept;
    } catch (cause) {
      // Housekeeping never holds up a start, and never becomes an unhandled
      // rejection in the caller that fired it and walked away.
      logger.error(`ccrcd could not sweep unfinished workspace directories: ${messageOf(cause)}`);
      return 0;
    }
  };

  return { create, sweepStaging };
};
