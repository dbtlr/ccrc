import { hostname } from 'node:os';

import type { ClaudeAdapter, HostSession, SessionActivity } from './adapter/claude.ts';
import { findRepo } from './config.ts';
import type { Config } from './config.ts';
import { BadRequestError, NotFoundError } from './errors.ts';
import type { SessionRecord, StateStore } from './state.ts';

/** A stored record plus the live detail reconciliation adds on read. */
export type SessionView = SessionRecord & { readonly activity: SessionActivity };

export type LaunchInput = {
  readonly repo: string;
  readonly prompt?: string | undefined;
};

export type SessionListing = {
  readonly sessions: readonly SessionView[];
  readonly hostSessions: readonly HostSession[];
};

export type SessionService = {
  readonly launch: (input: LaunchInput) => Promise<SessionView>;
  readonly list: () => Promise<SessionListing>;
  readonly get: (id: string) => Promise<SessionView>;
  readonly stop: (id: string) => Promise<SessionView>;
};

export type SessionServiceOptions = {
  readonly adapter: ClaudeAdapter;
  readonly store: StateStore;
  readonly config: Config;
  readonly host?: string;
  readonly now?: () => number;
  readonly generateId?: () => string;
};

const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';

const randomId = (): string =>
  [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length])
    .join('');

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '') || 'repo';

const ACTIVE_STATUSES = new Set(['starting', 'running']);

/**
 * Names are never reused, including by stopped records: a recycled tmux name
 * would let a new session's liveness leak into an old record's reconciliation.
 */
const allocateNames = (
  repoSlug: string,
  records: readonly SessionRecord[],
  liveNames: readonly string[],
): { readonly tmuxName: string; readonly index: number } => {
  const taken = new Set<string>([...records.map((record) => record.tmuxName), ...liveNames]);
  let index = 1;
  while (taken.has(`ccrc-${repoSlug}-${index}`)) {
    index += 1;
  }
  return { index, tmuxName: `ccrc-${repoSlug}-${index}` };
};

/**
 * `claude agents --json` reports an auto-generated name that does not match the
 * remote-control name given at launch, so correlation goes through pid first and
 * falls back to cwd plus nearest start time.
 */
const correlate = (
  record: SessionRecord,
  hostSessions: readonly HostSession[],
): HostSession | undefined => {
  if (record.pid !== null) {
    const byPid = hostSessions.find((session) => session.pid === record.pid);
    if (byPid !== undefined) {
      return byPid;
    }
  }
  const byPath = hostSessions.filter((session) => session.cwd === record.repoPath);
  if (byPath.length === 0) {
    return undefined;
  }
  return byPath.reduce((closest, candidate) => {
    const distance = (session: HostSession): number =>
      session.startedAt === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(session.startedAt - record.startedAt);
    return distance(candidate) < distance(closest) ? candidate : closest;
  });
};

/** tmux session gone while the record still claims to be active → stopped. */
const stopIfGone = (record: SessionRecord, live: ReadonlySet<string>): SessionRecord =>
  ACTIVE_STATUSES.has(record.status) && !live.has(record.tmuxName)
    ? { ...record, status: 'stopped' }
    : record;

const toView = (record: SessionRecord, hostSessions: readonly HostSession[]): SessionView => ({
  ...record,
  activity: ACTIVE_STATUSES.has(record.status)
    ? (correlate(record, hostSessions)?.status ?? 'unknown')
    : 'unknown',
});

export const createSessionService = (options: SessionServiceOptions): SessionService => {
  const { adapter, config, store } = options;
  const host = options.host ?? hostname();
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? randomId;

  const reconcile = async (records: readonly SessionRecord[]): Promise<SessionListing> => {
    const [liveNames, hostSessions] = await Promise.all([
      adapter.liveSessionNames(),
      adapter.listHostSessions(),
    ]);
    const live = new Set(liveNames);
    const reconciled = records.map((record) => stopIfGone(record, live));
    const changed = reconciled.some((record, index) => record.status !== records[index]?.status);
    if (changed) {
      await store.save(reconciled);
    }
    return {
      hostSessions,
      sessions: reconciled.map((record) => toView(record, hostSessions)),
    };
  };

  const launch = async (input: LaunchInput): Promise<SessionView> => {
    if (typeof input.repo !== 'string' || input.repo.length === 0) {
      throw new BadRequestError('"repo" is required and must be a registry repo name');
    }
    const repo = findRepo(config, input.repo);
    if (repo === undefined) {
      const known = config.repos.map((entry) => entry.name).join(', ') || 'none configured';
      throw new NotFoundError(`unknown repo "${input.repo}" — configured repos: ${known}`);
    }

    const repoPath = await adapter.trustRepo(repo.path);
    const stored = await store.load();
    const { index, tmuxName } = allocateNames(
      slugify(repo.name),
      stored,
      await adapter.liveSessionNames(),
    );
    const id = generateId();
    const pending: SessionRecord = {
      attachUrl: null,
      host,
      id,
      name: `${repo.name}-${index}`,
      pid: null,
      rcName: `ccrc-${id}`,
      repoName: repo.name,
      repoPath,
      startedAt: now(),
      status: 'starting',
      tmuxName,
    };
    await store.save([...stored, pending]);

    const settle = async (record: SessionRecord): Promise<void> => {
      const current = await store.load();
      await store.save(current.map((entry) => (entry.id === record.id ? record : entry)));
    };

    try {
      const attachUrl = await adapter.launchSession({
        prompt: input.prompt,
        rcName: pending.rcName,
        repoPath,
        tmuxName,
      });
      const hostSessions = await adapter.listHostSessions();
      const launched: SessionRecord = {
        ...pending,
        attachUrl,
        pid: correlate(pending, hostSessions)?.pid ?? null,
        status: 'running',
      };
      await settle(launched);
      return toView(launched, hostSessions);
    } catch (cause) {
      await settle({ ...pending, status: 'failed' });
      throw cause;
    }
  };

  const list = async (): Promise<SessionListing> => reconcile(await store.load());

  const get = async (id: string): Promise<SessionView> => {
    const listing = await reconcile(await store.load());
    const found = listing.sessions.find((session) => session.id === id);
    if (found === undefined) {
      throw new NotFoundError(`unknown session "${id}"`);
    }
    return found;
  };

  const stop = async (id: string): Promise<SessionView> => {
    const stored = await store.load();
    const target = stored.find((record) => record.id === id);
    if (target === undefined) {
      throw new NotFoundError(`unknown session "${id}"`);
    }
    await adapter.stopSession(target.tmuxName);
    const stopped: SessionRecord = { ...target, status: 'stopped' };
    await store.save(stored.map((record) => (record.id === id ? stopped : record)));
    return { ...stopped, activity: 'unknown' };
  };

  return { get, launch, list, stop };
};
