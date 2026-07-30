import { hostname } from 'node:os';

import type { ClaudeAdapter, HostSession, SessionActivity } from './adapter/claude.ts';
import { findRepo } from './config.ts';
import type { Config, RepoEntry } from './config.ts';
import { BadRequestError, CcrcError, NotFoundError, messageOf } from './errors.ts';
import type { SessionRecord, StateStore } from './state.ts';

/**
 * A stored record plus the live detail reconciliation adds on read — everything a
 * client is told about a session. `repoPath` stays out: the console never uses it,
 * and it is the same host path the registry summary already keeps off the wire.
 */
export type SessionView = Omit<SessionRecord, 'repoPath'> & { readonly activity: SessionActivity };

export type LaunchInput = {
  readonly repo: string;
  readonly prompt?: string | undefined;
};

export type SessionListing = {
  readonly sessions: readonly SessionView[];
  readonly hostSessions: readonly HostSession[];
};

/**
 * What a client is told about a registry entry. The name is all a launch needs,
 * and the configured path stays on the host rather than being enumerable by
 * anything that can reach the API.
 */
export type RepoSummary = {
  readonly name: string;
};

export type SessionService = {
  readonly listRepos: () => readonly RepoSummary[];
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
 * How far a host session's own start may sit from the record's before the two are
 * taken to be different sessions. The record is written before `claude` starts and
 * the attach URL has 60s to appear, so a session's own start legitimately trails
 * its record's by that much; the window is twice that, to absorb a slow start and
 * whatever skew there is in the time claude reports.
 */
const CORRELATION_WINDOW_MS = 120_000;

const startedTogether = (session: HostSession, record: SessionRecord): boolean =>
  session.startedAt !== null &&
  Math.abs(session.startedAt - record.startedAt) <= CORRELATION_WINDOW_MS;

/**
 * `claude agents --json` reports an auto-generated name that does not match the
 * remote-control name given at launch, so correlation goes through pid first and
 * falls back to cwd.
 *
 * The fallback has to be conservative: a repo commonly has several sessions, and
 * adopting the wrong one writes a stranger's pid into the record, which then drives
 * its reported activity and every later pid correlation. So a candidate is only
 * accepted when no other record already claims it, it started around the same time
 * as the record, and it is the only one left — anything ambiguous correlates to
 * nothing at all.
 */
const correlate = (
  record: SessionRecord,
  hostSessions: readonly HostSession[],
  records: readonly SessionRecord[],
): HostSession | undefined => {
  if (record.pid !== null) {
    const byPid = hostSessions.find((session) => session.pid === record.pid);
    if (byPid !== undefined) {
      return byPid;
    }
  }
  const claimed = new Set(
    records
      .filter((other) => other.id !== record.id && other.pid !== null)
      .map((other) => other.pid),
  );
  const candidates = hostSessions.filter(
    (session) =>
      session.cwd === record.repoPath &&
      !claimed.has(session.pid) &&
      startedTogether(session, record),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
};

/** tmux session gone while the record still claims to be active → stopped. */
const stopIfGone = (record: SessionRecord, live: ReadonlySet<string>): SessionRecord =>
  ACTIVE_STATUSES.has(record.status) && !live.has(record.tmuxName)
    ? { ...record, status: 'stopped' }
    : record;

const withoutRepoPath = (record: SessionRecord): Omit<SessionRecord, 'repoPath'> => {
  const { repoPath: _repoPath, ...view } = record;
  return view;
};

const toView = (
  record: SessionRecord,
  hostSessions: readonly HostSession[],
  records: readonly SessionRecord[],
): SessionView => ({
  ...withoutRepoPath(record),
  activity: ACTIVE_STATUSES.has(record.status)
    ? (correlate(record, hostSessions, records)?.status ?? 'unknown')
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
      sessions: sessions.map((record) => toView(record, hostSessions, sessions)),
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

    /**
     * The settled record is built inside the store's critical section, so the pid
     * it correlates to is chosen against the records it lands beside, and the view
     * it returns describes the same snapshot.
     */
    const settle = (
      build: (records: readonly SessionRecord[]) => SessionRecord,
    ): Promise<{ readonly record: SessionRecord; readonly records: readonly SessionRecord[] }> =>
      store.update((records) => {
        const record = build(records);
        const next = records.map((entry) => (entry.id === record.id ? record : entry));
        return { records: next, result: { record, records: next } };
      });

    /**
     * A launch that failed after tmux came up leaves a bypassPermissions session
     * running with nothing to revisit it: `failed` is not an active status, so
     * reconciliation skips the record and `DELETE` cannot help either. The kill is
     * best-effort — the adapter already kills the session on its own failure paths,
     * so finding nothing is the normal case, and a teardown failure must not replace
     * the launch failure that caused it.
     */
    const tearDown = async (tmuxName: string): Promise<void> => {
      try {
        await adapter.stopSession(tmuxName);
      } catch {
        // The launch failure is the one worth reporting, not this safety net's.
      }
    };

    try {
      const attachUrl = await adapter.launchSession({
        prompt,
        rcName: pending.rcName,
        repoPath,
        tmuxName: pending.tmuxName,
      });
      const hostSessions = await adapter.listHostSessions();
      const { record, records } = await settle((current) => ({
        ...pending,
        attachUrl,
        pid: correlate(pending, hostSessions, current)?.pid ?? null,
        status: 'running',
      }));
      return toView(record, hostSessions, records);
    } catch (cause) {
      await tearDown(pending.tmuxName);
      await settle((current) => ({
        ...(current.find((entry) => entry.id === pending.id) ?? pending),
        status: 'failed',
      }));
      throw cause;
    }
  };

  const listRepos = (): readonly RepoSummary[] => config.repos.map((repo) => ({ name: repo.name }));

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
   *
   * The kill itself is slow and must not hold the state mutex, so only the tmux name
   * is read before it and the status is flipped on whatever the record looks like
   * afterwards. Persisting the pre-kill snapshot instead would silently revert an
   * attach URL or pid that a launch settling alongside the kill had just written.
   */
  const stop = async (id: string): Promise<SessionView> => {
    const stored = await store.load();
    const target = stored.find((record) => record.id === id);
    if (target === undefined) {
      throw new NotFoundError(`unknown session "${id}"`);
    }
    await adapter.stopSession(target.tmuxName);
    const stopped = await store.update((records) => {
      const current = records.find((record) => record.id === id);
      if (current === undefined) {
        throw new NotFoundError(`unknown session "${id}"`);
      }
      const next: SessionRecord = { ...current, status: 'stopped' };
      return {
        records: records.map((record) => (record.id === id ? next : record)),
        result: next,
      };
    });
    return { ...withoutRepoPath(stopped), activity: 'unknown' };
  };

  return { get, launch, list, listRepos, stop };
};
