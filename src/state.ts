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

export type StateStore = {
  readonly load: () => Promise<readonly SessionRecord[]>;
  readonly save: (records: readonly SessionRecord[]) => Promise<void>;
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
 * JSON-file session store. A missing or corrupt file reads as an empty list so a
 * bad state file never blocks startup. ccrcd is the only writer, so writes go
 * straight to the file (Bun.write creates the parent directory).
 */
export const createStateStore = (filePath: string): StateStore => ({
  load: async () => {
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
  },
  save: async (records) => {
    await Bun.write(filePath, `${JSON.stringify(records, null, 2)}\n`);
  },
});
