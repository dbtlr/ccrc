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
