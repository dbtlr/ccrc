/**
 * The console's only contact with the daemon. Responses are untyped JSON off the
 * wire, so every field is narrowed here rather than asserted — the same discipline
 * the daemon applies to the CLI output it reads.
 */

export type SessionStatus = 'starting' | 'running' | 'stopped' | 'failed' | 'unknown';
export type SessionActivity = 'idle' | 'busy' | 'unknown';

export type Session = {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly repoName: string;
  readonly attachUrl: string | null;
  readonly pid: number | null;
  readonly startedAt: number;
  readonly status: SessionStatus;
  readonly activity: SessionActivity;
};

export type Repo = {
  readonly name: string;
};

export type LaunchRequest = {
  readonly repo: string;
  readonly prompt?: string | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asStatus = (value: unknown): SessionStatus =>
  value === 'starting' || value === 'running' || value === 'stopped' || value === 'failed'
    ? value
    : 'unknown';

const asActivity = (value: unknown): SessionActivity =>
  value === 'idle' || value === 'busy' ? value : 'unknown';

const toSession = (value: unknown): Session | null => {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  return {
    activity: asActivity(value.activity),
    attachUrl: typeof value.attachUrl === 'string' ? value.attachUrl : null,
    host: asString(value.host, 'this host'),
    id: value.id,
    name: asString(value.name, value.id),
    pid: asNumber(value.pid),
    repoName: asString(value.repoName, 'unknown repo'),
    startedAt: asNumber(value.startedAt) ?? 0,
    status: asStatus(value.status),
  };
};

const toRepo = (value: unknown): Repo | null =>
  isRecord(value) && typeof value.name === 'string' && value.name.length > 0
    ? { name: value.name }
    : null;

const collect = <T>(value: unknown, key: string, parse: (entry: unknown) => T | null): T[] => {
  const list = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map(parse).filter((entry): entry is T => entry !== null);
};

/**
 * The daemon answers every deliberate failure with `{ "error": "..." }`. That
 * message is the only thing worth telling the operator, so it is carried through
 * verbatim; a response with no message at all falls back to naming the status.
 */
const failureMessage = (body: unknown, status: number): string => {
  const reported = isRecord(body) ? body.error : undefined;
  if (typeof reported === 'string' && reported.length > 0) {
    return reported;
  }
  return `ccrcd answered ${status} with no explanation`;
};

const request = async (path: string, init?: RequestInit): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error('ccrcd is not answering. Check that the daemon is still running.');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(failureMessage(body, response.status));
  }
  return body;
};

const JSON_HEADERS = { 'content-type': 'application/json' };

export const fetchSessions = async (): Promise<Session[]> =>
  collect(await request('/sessions'), 'sessions', toSession);

export const fetchRepos = async (): Promise<Repo[]> =>
  collect(await request('/repos'), 'repos', toRepo);

export const launchSession = async (input: LaunchRequest): Promise<Session | null> =>
  toSession(
    await request('/sessions', {
      body: JSON.stringify(input),
      headers: JSON_HEADERS,
      method: 'POST',
    }),
  );

export const stopSession = async (id: string): Promise<void> => {
  await request(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
};
