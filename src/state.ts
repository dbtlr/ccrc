import { writeFileAtomic } from './files.ts';
import { createMutex } from './mutex.ts';

export type SessionStatus = 'starting' | 'running' | 'stopped' | 'failed';

/** A session ccrcd launched. Owned by ccrcd, persisted across restarts. */
export type SessionRecord = {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly repoName: string;
  readonly repoPath: string;
  readonly tmuxName: string;
  readonly rcName: string;
  readonly attachUrl: string | null;
  readonly pid: number | null;
  readonly startedAt: number;
  readonly status: SessionStatus;
};

/** The next records to persist plus whatever the caller wants back out. */
export type Update<T> = {
  readonly records: readonly SessionRecord[];
  readonly result: T;
};

export type StateStore = {
  readonly load: () => Promise<readonly SessionRecord[]>;
  readonly save: (records: readonly SessionRecord[]) => Promise<void>;
  /**
   * Serialized read-modify-write — the only safe way to change stored records.
   * Returning the records it was given skips the write.
   */
  readonly update: <T>(mutate: (records: readonly SessionRecord[]) => Update<T>) => Promise<T>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const STATUSES: readonly SessionStatus[] = ['starting', 'running', 'stopped', 'failed'];

const asStatus = (value: unknown): SessionStatus =>
  STATUSES.find((status) => status === value) ?? 'stopped';

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const toSessionRecord = (value: unknown): SessionRecord | null => {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value.id);
  if (id.length === 0) {
    return null;
  }
  return {
    attachUrl: typeof value.attachUrl === 'string' ? value.attachUrl : null,
    host: asString(value.host),
    id,
    name: asString(value.name, id),
    pid: typeof value.pid === 'number' ? value.pid : null,
    rcName: asString(value.rcName),
    repoName: asString(value.repoName),
    repoPath: asString(value.repoPath),
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
    status: asStatus(value.status),
    tmuxName: asString(value.tmuxName),
  };
};

/**
 * One process-wide mutex shared by every store: the state file is read, mutated
 * and written back on nearly every request, and a launch that landed between
 * another request's read and write would otherwise be lost — leaving a live
 * session with no record to stop it by.
 */
const stateMutex = createMutex();

/**
 * JSON-file session store. A missing or corrupt file reads as an empty list so a
 * bad state file never blocks startup. Writes are atomic and 0600: records carry
 * attach URLs, which are capabilities.
 */
export const createStateStore = (filePath: string): StateStore => {
  const read = async (): Promise<readonly SessionRecord[]> => {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(toSessionRecord).filter((record): record is SessionRecord => record !== null);
  };

  const write = (records: readonly SessionRecord[]): Promise<void> =>
    writeFileAtomic(filePath, `${JSON.stringify(records, null, 2)}\n`);

  return {
    load: () => stateMutex(read),
    save: (records) => stateMutex(() => write(records)),
    update: (mutate) =>
      stateMutex(async () => {
        const records = await read();
        const next = mutate(records);
        if (next.records !== records) {
          await write(next.records);
        }
        return next.result;
      }),
  };
};
