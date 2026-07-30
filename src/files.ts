import { chmod, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Atomic whole-file replacement, the only file-writing primitive in ccrcd. A
 * truncate-and-write leaves invalid JSON behind when it is interrupted, so the
 * next content is staged beside the target and renamed over it:
 *
 * - the staging name is unique, so concurrent writers cannot clobber each other;
 * - the target's realpath is written, so a config symlinked into a dotfiles repo
 *   keeps its link instead of being replaced by a regular file;
 * - the target's mode is preserved, and a file created here starts at 0600 —
 *   both files ccrcd writes hold capabilities (attach URLs, account state).
 */

export const DEFAULT_FILE_MODE = 0o600;

const modeOf = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
};

const resolveTarget = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/**
 * Confirms a file at `path` could be replaced, by staging beside it exactly as an
 * atomic write does and removing the staged file instead of renaming it.
 *
 * A state directory that has gone read-only is otherwise discovered at the moment a
 * launch has to be recorded — with a `bypassPermissions` session already running and
 * no record to stop it by. The health endpoint asks this instead.
 */
export const checkWritable = async (path: string): Promise<void> => {
  const target = await resolveTarget(path);
  await mkdir(dirname(target), { recursive: true });
  const probe = `${target}.ccrcd-health-${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(probe, '', { mode: DEFAULT_FILE_MODE });
    await rm(probe, { force: true });
  } catch (cause) {
    await rm(probe, { force: true });
    throw cause;
  }
};

export const writeFileAtomic = async (
  path: string,
  contents: string,
  fallbackMode: number = DEFAULT_FILE_MODE,
): Promise<void> => {
  const target = await resolveTarget(path);
  const mode = (await modeOf(target)) ?? fallbackMode;
  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.ccrcd-${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(staging, contents, { mode });
    await chmod(staging, mode);
    await rename(staging, target);
  } catch (cause) {
    await rm(staging, { force: true });
    throw cause;
  }
};
