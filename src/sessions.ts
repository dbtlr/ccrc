import { hostname } from 'node:os';

import { WORST_CASE_LAUNCH_MS } from './adapter/claude.ts';
import type { ClaudeAdapter, HostSession, SessionActivity } from './adapter/claude.ts';
import { findRepo } from './config.ts';
import type { Config, RepoEntry } from './config.ts';
import { BadRequestError, CcrcError, NotFoundError, messageOf } from './errors.ts';
import { createLogger } from './log.ts';
import type { Logger } from './log.ts';
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

/** What the hang watchdog did about one session, for logging and for tests. */
export type HangOutcome = {
  readonly id: string;
  readonly reason: string;
  /**
   * The replacement record's id — including one whose launch failed, since that
   * record exists and is where the session went — or `null` when no replacement was
   * attempted at all.
   */
  readonly restartedAs: string | null;
};

export type SessionService = {
  readonly listRepos: () => readonly RepoSummary[];
  readonly launch: (input: LaunchInput) => Promise<SessionView>;
  readonly list: () => Promise<SessionListing>;
  readonly get: (id: string) => Promise<SessionView>;
  readonly stop: (id: string) => Promise<SessionView>;
  /** Bring records back in line with tmux. Reads do this; so does the supervisor. */
  readonly reconcile: () => Promise<SessionListing>;
  /** Retire sessions that claim to be working but have stopped writing anything. */
  readonly sweepHung: () => Promise<readonly HangOutcome[]>;
  /** Drop terminal records past the retention window; returns how many went. */
  readonly prune: () => Promise<number>;
};

export type SessionServiceOptions = {
  readonly adapter: ClaudeAdapter;
  readonly store: StateStore;
  readonly config: Config;
  readonly host?: string;
  readonly now?: () => number;
  readonly generateId?: () => string;
  readonly logger?: Logger;
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
const TERMINAL_STATUSES = new Set(['stopped', 'failed']);

const MINUTE_MS = 60_000;

/** Durations in a reason an operator reads are minutes, not milliseconds. */
const minutesOf = (ms: number): number => Math.round(ms / MINUTE_MS);

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
/**
 * Whether another record already owns this host entry.
 *
 * A killed session lingers in `claude agents --json`, and its record keeps the pid
 * and session id it was killed with precisely so the next session in that repo
 * cannot adopt them: inheriting a dead session's busy report and stopped-moving
 * transcript is a hang as far as the watchdog can tell, so a healthy replacement
 * would be killed next tick, and its replacement after that.
 *
 * A dead record's claim expires with the session, though. The OS reuses pids, and a
 * record kept for the retention window would otherwise make a legitimate new session
 * uncorrelatable for days — no activity of its own, and no hang coverage. So a record
 * that has ended only claims entries that existed before it did: an entry that
 * started afterwards cannot be the session it was holding. An entry that will not say
 * when it started stays claimed, because the alternative guesses in the dangerous
 * direction.
 */
const isClaimed = (session: HostSession, others: readonly SessionRecord[]): boolean =>
  others.some((other) => {
    const mine =
      (other.pid !== null && other.pid === session.pid) ||
      (other.hostSessionId !== null && other.hostSessionId === session.sessionId);
    if (!mine) {
      return false;
    }
    return other.endedAt === null || session.startedAt === null
      ? true
      : session.startedAt <= other.endedAt;
  });

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
  const others = records.filter((other) => other.id !== record.id);
  const candidates = hostSessions.filter(
    (session) =>
      session.cwd === record.repoPath &&
      !isClaimed(session, others) &&
      startedTogether(session, record),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
};

/** What tmux was live at a known moment. The moment is the point. */
export type LivenessSnapshot = {
  readonly names: ReadonlySet<string>;
  readonly takenAt: number;
};

/**
 * How long a record is exempt from retirement after it is created.
 *
 * A record is written before tmux is asked for the session, and the attach URL then
 * has its own deadline to appear, so a liveness snapshot taken anywhere in that window
 * legitimately does not list the session yet. Retiring a record on that answer stops a
 * session that is coming up perfectly well — and marks it `stopped` while it keeps
 * running with `bypassPermissions`, which is the worst of both. The next tick retires
 * it truthfully if it really is gone.
 *
 * Derived from the launch's own timeouts plus a margin rather than picked: the two have
 * to move together, and the adapter owns those numbers.
 */
export const LAUNCH_GRACE_MS = WORST_CASE_LAUNCH_MS + 30_000;

/**
 * Whether a snapshot is entitled to speak about this record.
 *
 * It is not while the record is inside its launch window. It is once that window has
 * passed — and also when the record claims to have started *after* the snapshot was
 * taken, which happens when the clock steps backwards: a grace period measured from a
 * future timestamp would never expire, leaving a record that is never retired, never
 * promoted, and never pruned because it is not terminal.
 */
const launchWindowPassed = (record: SessionRecord, live: LivenessSnapshot): boolean =>
  record.startedAt > live.takenAt || record.startedAt + LAUNCH_GRACE_MS <= live.takenAt;

/**
 * tmux session gone while the record still claims to be active → stopped. This is
 * also the whole of ccrcd's reboot story: a rebooted host has an empty tmux server,
 * so the first reconciliation retires every record it left behind. Nothing is ever
 * relaunched from that — a machine coming back up must not start running
 * `bypassPermissions` sessions on its own.
 *
 * The snapshot is compared against the record's age, not against the clock: a
 * snapshot only speaks for the moment it was taken, and reconciliation's own host
 * listing can hold it for as long as the `claude` CLI takes to answer.
 */
const stopIfGone = (record: SessionRecord, live: LivenessSnapshot, at: number): SessionRecord =>
  ACTIVE_STATUSES.has(record.status) &&
  !live.names.has(record.tmuxName) &&
  launchWindowPassed(record, live)
    ? {
        ...record,
        endedAt: at,
        status: 'stopped',
        stopReason: record.stopReason ?? 'its tmux session was gone',
      }
    : record;

/**
 * A `starting` record with a live tmux session, long past any launch that could
 * still be in progress → running.
 *
 * A daemon killed mid-launch leaves exactly that: the launch that would have settled
 * the record is gone, so nothing will ever move it off `starting` — while the session
 * it started keeps running with `bypassPermissions`. The record is corrected to what
 * tmux says rather than left immortal. The attach URL stays null: it is printed once
 * into the pane and was never captured, and a record saying "running, URL unknown" is
 * the truth. (A record whose tmux session is gone is retired by `stopIfGone` first.)
 */
const promoteIfStranded = (record: SessionRecord, live: LivenessSnapshot): SessionRecord =>
  record.status === 'starting' &&
  live.names.has(record.tmuxName) &&
  launchWindowPassed(record, live)
    ? { ...record, status: 'running' }
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
  const logger = options.logger ?? createLogger();

  /**
   * A tmux that will not say which sessions are live makes liveness indeterminate,
   * not negative — `undefined` rather than an empty set. Marking every active
   * record stopped on that answer would retire records whose bypassPermissions
   * sessions are still running, so the listing is served unreconciled instead and
   * the reason is logged for the operator.
   */
  const liveNamesOrUnknown = async (): Promise<LivenessSnapshot | undefined> => {
    try {
      const names = new Set(await adapter.liveSessionNames());
      // Timed on return, not on use: what follows may hold this answer for as long
      // as the claude CLI takes, and a launch can land in that gap.
      return { names, takenAt: now() };
    } catch (cause) {
      logger.error(
        `ccrcd could not read live tmux sessions, so records were left as they are: ${messageOf(cause)}`,
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
    const at = now();
    const sessions = await store.update((records) => {
      const reconciled =
        live === undefined
          ? records
          : records.map((record) => promoteIfStranded(stopIfGone(record, live, at), live));
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

  /**
   * Starts a session and settles its record — the whole of a launch after the
   * request has been validated. The watchdog's relaunch comes through here too, so
   * a restarted session is allocated, named, and correlated exactly like an
   * operator's launch; `restartedFrom` is the only difference.
   */
  const startSession = async (start: {
    readonly repo: RepoEntry;
    readonly prompt?: string | undefined;
    readonly restartedFrom?: string | null;
    readonly restarts?: readonly number[];
    /** Called once the record exists, so a caller can name it even if the launch fails. */
    readonly onPending?: (record: SessionRecord) => void;
  }): Promise<{
    readonly record: SessionRecord;
    readonly records: readonly SessionRecord[];
    readonly hostSessions: readonly HostSession[];
  }> => {
    const { prompt, repo } = start;
    const repoPath = await trustedPath(repo);
    const liveNames = await adapter.liveSessionNames();
    // Allocating the name and recording it are one serialized step: concurrent
    // launches would otherwise all pick the same tmux name.
    const pending = await store.update((records) => {
      const { index, tmuxName } = allocateNames(slugify(repo.name), records, liveNames);
      const id = generateId();
      const record: SessionRecord = {
        attachUrl: null,
        endedAt: null,
        host,
        hostSessionId: null,
        id,
        name: `${repo.name}-${index}`,
        pid: null,
        rcName: `ccrc-${id}`,
        repoName: repo.name,
        repoPath,
        restartedAs: null,
        restartedFrom: start.restartedFrom ?? null,
        restarts: start.restarts ?? [],
        startedAt: now(),
        status: 'starting',
        stopReason: null,
        tmuxName,
      };
      return { records: [...records, record], result: record };
    });
    start.onPending?.(pending);

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
      const { record, records } = await settle((current) => {
        // Built onto the record as it stands, never onto the pre-launch snapshot: a
        // `DELETE` that landed while this launch was settling has already written to
        // it, and spreading the snapshot would revert that stop — leaving a record
        // that claims to be running with no tmux session behind it.
        const stored = current.find((entry) => entry.id === pending.id) ?? pending;
        const matched = correlate(pending, hostSessions, current);
        const learned = {
          attachUrl,
          // Both identifiers are kept: they are how this record claims its host
          // entry against every other record's correlation.
          hostSessionId: matched?.sessionId ?? null,
          pid: matched?.pid ?? null,
        };
        // A record that went terminal mid-launch stays terminal. Its tmux session is
        // already dead — or reconciliation will find it so — and nothing may promote
        // it back to running.
        return TERMINAL_STATUSES.has(stored.status)
          ? { ...stored, ...learned }
          : { ...stored, ...learned, status: 'running' };
      });
      return { hostSessions, record, records };
    } catch (cause) {
      await tearDown(pending.tmuxName);
      await settle((current) => {
        const stored = current.find((entry) => entry.id === pending.id) ?? pending;
        // An operator's stop that got there first is the truthful account of how this
        // record ended; a failed launch must not overwrite it.
        return TERMINAL_STATUSES.has(stored.status)
          ? stored
          : {
              ...stored,
              endedAt: now(),
              status: 'failed',
              // Only a deliberate failure describes itself: anything else may carry a
              // command line or a host path, and the reason is served to clients.
              stopReason: cause instanceof CcrcError ? cause.message : 'the launch failed',
            };
      });
      throw cause;
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
    const started = await startSession({ prompt, repo });
    return toView(started.record, started.hostSessions, started.records);
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
   * What the record keeps of the session that was just killed.
   *
   * Every path that kills a session goes through this, because the claim is what
   * stops the next session in the same repo from adopting the dead one's entry:
   * `claude agents --json` still lists a killed session for a while, and a record
   * that adopted it would report a stranger's activity and be killed by the watchdog
   * on a stranger's stale transcript. An operator's `DELETE` needs it exactly as much
   * as the watchdog's kill does — stop, then relaunch, is the ordinary workflow.
   */
  const claimOf = (
    record: SessionRecord,
    killed: HostSession | undefined,
  ): Pick<SessionRecord, 'endedAt' | 'hostSessionId' | 'pid'> => ({
    // Stamped once. A restart rewrites this record's reason twice more before it is
    // done — once its replacement is known — and the end time must not walk forward
    // with those writes: retention is measured from it, and it is the only account of
    // when the session actually stopped.
    endedAt: record.endedAt ?? now(),
    hostSessionId: killed?.sessionId ?? record.hostSessionId,
    pid: killed?.pid ?? record.pid,
  });

  /** The host entry a record is running as, as far as the fleet listing can say. */
  const hostEntryOf = async (
    record: SessionRecord,
    records: readonly SessionRecord[],
  ): Promise<HostSession | undefined> =>
    correlate(record, await adapter.listHostSessions(), records);

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
    // Read before the kill: afterwards the entry starts disappearing from the fleet
    // listing, and an unclaimed entry is one the next launch can adopt.
    const killed = await hostEntryOf(target, stored);
    await adapter.stopSession(target.tmuxName);
    const stopped = await store.update((records) => {
      const current = records.find((record) => record.id === id);
      if (current === undefined) {
        throw new NotFoundError(`unknown session "${id}"`);
      }
      // No reason: an operator's own `DELETE` needs no explanation, and a reason
      // left over from an earlier ccrcd decision would be the wrong one.
      const next: SessionRecord = {
        ...current,
        ...claimOf(current, killed),
        status: 'stopped',
        stopReason: null,
      };
      return {
        records: records.map((record) => (record.id === id ? next : record)),
        result: next,
      };
    });
    return { ...withoutRepoPath(stopped), activity: 'unknown' };
  };

  /** Retires a record ccrcd decided to end, with the reason it decided that. */
  const retire = (
    id: string,
    reason: string,
    restartedAs: string | null,
    killed?: HostSession,
  ): Promise<void> =>
    store.update((records) => {
      const current = records.find((record) => record.id === id);
      if (current === undefined) {
        return { records, result: undefined };
      }
      const next: SessionRecord = {
        ...current,
        ...claimOf(current, killed),
        restartedAs,
        status: 'stopped',
        stopReason: reason,
      };
      return {
        records: records.map((record) => (record.id === id ? next : record)),
        result: undefined,
      };
    });

  /**
   * How stale a busy session's transcript is, or `null` when it is not hung.
   *
   * Two signals have to agree before a session is killed: the session says it is
   * `busy`, and the transcript it would be appending to has not moved for the
   * threshold. Everything else — an idle session, a session with no status of its
   * own, one that could not be correlated, one with no session id, a transcript
   * that cannot be read — is unknown, and unknown never trips the watchdog. Killing
   * a working session because ccrcd could not see its transcript would destroy work
   * nobody asked it to touch.
   */
  const staleFor = async (record: SessionRecord, session: HostSession): Promise<number | null> => {
    if (session.status !== 'busy' || session.sessionId === null) {
      return null;
    }
    let mtime: number | null;
    try {
      mtime = await adapter.transcriptMtime({
        cwd: session.cwd ?? record.repoPath,
        sessionId: session.sessionId,
      });
    } catch (cause) {
      logger.error(
        `ccrcd could not read the transcript of session ${record.id}, so it was left running: ${messageOf(cause)}`,
      );
      return null;
    }
    if (mtime === null) {
      return null;
    }
    const idleFor = now() - mtime;
    return idleFor >= config.supervision.hangThresholdMs ? idleFor : null;
  };

  /**
   * The automatic restarts behind this record that still fall inside the window.
   *
   * The history is carried by the record itself and handed to each replacement, so
   * the count survives everything that happens to the dead records: retention
   * pruning them, an operator deleting them, a state file rewritten by hand. Walking
   * `restartedFrom` instead would reset the count the moment one link went missing —
   * which is the state prune leaves behind by design.
   */
  const recentRestarts = (record: SessionRecord): readonly number[] => {
    const since = now() - config.supervision.restartCapWindowMs;
    return record.restarts.filter((at) => at >= since);
  };

  /**
   * Kills the hung session, then starts a fresh one in the same repo. The tmux name
   * is never reused, so the replacement is a new record and the two are cross-linked
   * both ways.
   *
   * A kill tmux refuses leaves the record active and untouched: a session that is
   * still running must not be recorded as stopped, and the next tick will try again.
   */
  const restartHung = async (
    record: SessionRecord,
    session: HostSession,
    idleFor: number,
  ): Promise<HangOutcome | null> => {
    const symptom = `hung (busy ${minutesOf(idleFor)} min with a transcript that stopped moving)`;
    try {
      await adapter.stopSession(record.tmuxName);
    } catch (cause) {
      logger.error(
        `ccrcd found session ${record.id} ${symptom} but tmux refused to kill it, so the record was left active: ${messageOf(cause)}`,
      );
      return null;
    }
    const { restartCap, restartCapWindowMs } = config.supervision;
    const already = recentRestarts(record);
    if (already.length >= restartCap) {
      const reason = `${symptom}; the automatic restart cap of ${restartCap} per ${minutesOf(restartCapWindowMs)} min was reached, so it was not restarted`;
      await retire(record.id, reason, null, session);
      logger.error(
        `ccrcd stopped session ${record.id} in repo ${record.repoName} and will not restart it: ${reason}. Sessions in that repo keep wedging — it needs an operator.`,
      );
      return { id: record.id, reason, restartedAs: null };
    }
    const repo = findRepo(config, record.repoName);
    if (repo === undefined) {
      const reason = `${symptom}; repo "${record.repoName}" is no longer in the registry, so it was not restarted`;
      await retire(record.id, reason, null, session);
      logger.error(`ccrcd stopped session ${record.id}: ${reason}`);
      return { id: record.id, reason, restartedAs: null };
    }
    /**
     * The record is retired — and so claims the killed session's host entry — before
     * the replacement is started. The other order lets the replacement's own
     * correlation adopt the dead entry it was launched to replace, and the watchdog
     * then reads that entry's stale transcript as the replacement hanging.
     */
    await retire(record.id, `${symptom}; a replacement is being started`, null, session);
    // The replacement's id is captured as soon as its record exists, so a launch
    // that fails still leaves the two records pointing at each other — a dead end on
    // one side hides where the session went.
    const attempt: { id: string | null; started: boolean } = { id: null, started: false };
    try {
      // The replacement inherits this record's restart history plus this restart, so
      // the cap is enforced against the live record alone.
      await startSession({
        onPending: (pending) => {
          attempt.id = pending.id;
        },
        repo,
        restartedFrom: record.id,
        restarts: [...already, now()],
      });
      attempt.started = true;
    } catch (cause) {
      logger.error(
        `ccrcd stopped hung session ${record.id} but could not start its replacement: ${messageOf(cause)}`,
      );
    }
    const replacement = attempt.id;
    if (!attempt.started) {
      const reason =
        replacement === null
          ? `${symptom}; a replacement session could not be created`
          : `${symptom}; its replacement ${replacement} failed to start`;
      await retire(record.id, reason, replacement, session);
      return { id: record.id, reason, restartedAs: replacement };
    }
    const reason = `${symptom}; restarted as ${replacement}`;
    await retire(record.id, reason, replacement, session);
    logger.info(
      `ccrcd restarted session ${record.id} in repo ${record.repoName} as ${replacement}: ${symptom}`,
    );
    return { id: record.id, reason, restartedAs: replacement };
  };

  const sweepHung = async (): Promise<readonly HangOutcome[]> => {
    const records = await store.load();
    const running = records.filter((record) => record.status === 'running');
    if (running.length === 0) {
      return [];
    }
    const hostSessions = await adapter.listHostSessions();
    const checked = await Promise.all(
      running.map(async (record) => {
        const session = correlate(record, hostSessions, records);
        if (session === undefined) {
          return null;
        }
        const idleFor = await staleFor(record, session);
        return idleFor === null ? null : { idleFor, record, session };
      }),
    );
    // Restarts run together: each one allocates its tmux name inside the store's
    // critical section, so two replacements can never claim the same name.
    const outcomes = await Promise.all(
      checked
        .filter((entry) => entry !== null)
        .map((entry) => restartHung(entry.record, entry.session, entry.idleFor)),
    );
    return outcomes.filter((outcome) => outcome !== null);
  };

  /**
   * Terminal records are history, and history is not kept forever: the state file is
   * read and rewritten on nearly every request, so an unbounded one is a growing
   * cost on every launch. Retention is measured from when the record ended, not from
   * when it started, so a long session that stopped a minute ago is still recent.
   */
  const prune = (): Promise<number> =>
    store.update((records) => {
      const cutoff = now() - config.supervision.stoppedRetentionMs;
      const kept = records.filter(
        (record) =>
          !TERMINAL_STATUSES.has(record.status) || (record.endedAt ?? record.startedAt) > cutoff,
      );
      return kept.length === records.length
        ? { records, result: 0 }
        : { records: kept, result: records.length - kept.length };
    });

  return { get, launch, list, listRepos, prune, reconcile, stop, sweepHung };
};
