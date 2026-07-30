import { hostname } from 'node:os';

import type { ClaudeAdapter, HostSession, SessionActivity } from './adapter/claude.ts';
import { findRepo } from './config.ts';
import type { Config, RepoEntry } from './config.ts';
import { BadRequestError, CcrcError, NotFoundError, messageOf } from './errors.ts';
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

/** Big enough for a pasted brief, small enough to stay well inside argv limits. */
const MAX_PROMPT_LENGTH = 32_768;

/**
 * A prompt reaches an exec argv, where a NUL byte is a hard error and an
 * oversized string is E2BIG. Both are rejected here so neither surfaces as an
 * internal failure carrying the command line.
 */
const checkPrompt = (prompt: string | undefined): string | undefined => {
  if (prompt === undefined) {
    return undefined;
  }
  if (prompt.includes('\0')) {
    throw new BadRequestError('"prompt" must not contain NUL bytes');
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new BadRequestError(`"prompt" must be at most ${MAX_PROMPT_LENGTH} characters`);
  }
  return prompt;
};

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

  /**
   * A tmux that will not say which sessions are live makes liveness indeterminate,
   * not negative — `undefined` rather than an empty set. Marking every active
   * record stopped on that answer would retire records whose bypassPermissions
   * sessions are still running, so the listing is served unreconciled instead and
   * the reason is logged for the operator.
   */
  const liveNamesOrUnknown = async (): Promise<ReadonlySet<string> | undefined> => {
    try {
      return new Set(await adapter.liveSessionNames());
    } catch (cause) {
      process.stderr.write(
        `ccrcd could not read live tmux sessions, so records were left as they are: ${messageOf(cause)}\n`,
      );
      return undefined;
    }
  };

  /**
   * The slow adapter reads happen before the store is touched, so reconciliation
   * holds the state mutex only for the read-mutate-write itself and a launch
   * completing alongside a listing cannot be dropped.
   */
  const reconcile = async (): Promise<SessionListing> => {
    const [live, hostSessions] = await Promise.all([
      liveNamesOrUnknown(),
      adapter.listHostSessions(),
    ]);
    const sessions = await store.update((records) => {
      const reconciled =
        live === undefined ? records : records.map((record) => stopIfGone(record, live));
      const changed = reconciled.some((record, index) => record.status !== records[index]?.status);
      return { records: changed ? reconciled : records, result: changed ? reconciled : records };
    });
    return {
      hostSessions,
      sessions: sessions.map((record) => toView(record, hostSessions)),
    };
  };

  /** A configured path that cannot be resolved is a registry problem, not a crash. */
  const trustedPath = async (repo: RepoEntry): Promise<string> => {
    try {
      return await adapter.trustRepo(repo.path);
    } catch (cause) {
      if (cause instanceof CcrcError) {
        throw cause;
      }
      throw new BadRequestError(
        `repo "${repo.name}" cannot be launched: its configured path could not be resolved on this host`,
      );
    }
  };

  const launch = async (input: LaunchInput): Promise<SessionView> => {
    if (typeof input.repo !== 'string' || input.repo.length === 0) {
      throw new BadRequestError('"repo" is required and must be a registry repo name');
    }
    const repo = findRepo(config, input.repo);
    if (repo === undefined) {
      throw new NotFoundError(`unknown repo "${input.repo}"`);
    }
    const prompt = checkPrompt(input.prompt);

    const repoPath = await trustedPath(repo);
    const liveNames = await adapter.liveSessionNames();
    // Allocating the name and recording it are one serialized step: concurrent
    // launches would otherwise all pick the same tmux name.
    const pending = await store.update((records) => {
      const { index, tmuxName } = allocateNames(slugify(repo.name), records, liveNames);
      const id = generateId();
      const record: SessionRecord = {
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
      return { records: [...records, record], result: record };
    });

    const settle = (record: SessionRecord): Promise<void> =>
      store.update((records) => ({
        records: records.map((entry) => (entry.id === record.id ? record : entry)),
        result: undefined,
      }));

    try {
      const attachUrl = await adapter.launchSession({
        prompt,
        rcName: pending.rcName,
        repoPath,
        tmuxName: pending.tmuxName,
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

  const list = (): Promise<SessionListing> => reconcile();

  const get = async (id: string): Promise<SessionView> => {
    const listing = await reconcile();
    const found = listing.sessions.find((session) => session.id === id);
    if (found === undefined) {
      throw new NotFoundError(`unknown session "${id}"`);
    }
    return found;
  };

  /**
   * The record is only marked stopped once tmux confirms the session is gone; a
   * refused kill propagates so the record stays active and reconcilable.
   */
  const stop = async (id: string): Promise<SessionView> => {
    const stored = await store.load();
    const target = stored.find((record) => record.id === id);
    if (target === undefined) {
      throw new NotFoundError(`unknown session "${id}"`);
    }
    await adapter.stopSession(target.tmuxName);
    const stopped: SessionRecord = { ...target, status: 'stopped' };
    await store.update((records) => ({
      records: records.map((record) => (record.id === id ? stopped : record)),
      result: undefined,
    }));
    return { ...stopped, activity: 'unknown' };
  };

  return { get, launch, list, stop };
};
