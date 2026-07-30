import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { WORST_CASE_LAUNCH_MS } from '../src/adapter/claude.ts';
import type { HostSession } from '../src/adapter/claude.ts';
import { findRepo, loadConfig, stateFilePath } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { CommandTimeoutError, StopError } from '../src/errors.ts';
import { LAUNCH_GRACE_MS, createSessionService } from '../src/sessions.ts';
import type { HangOutcome, SessionService, SessionView } from '../src/sessions.ts';
import { createStateStore } from '../src/state.ts';
import type { SessionRecord, StateStore } from '../src/state.ts';
import type { PathState, RepoRegistry } from '../src/workspaces.ts';
import {
  capturingLogger,
  fakeAdapter,
  hostSession,
  rejection,
  sessionRecord,
  withTempDir,
} from './support.ts';
import type { CapturedLog, FakeAdapter } from './support.ts';

const NOW = 1_764_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A restart cap of 2 makes the third restart in a lineage the one that is refused. */
const CONFIG_TOML = `[[repos]]
name = "example"
path = "/repos/example"

[supervision]
hang_threshold_minutes = 10
restart_cap = 2
restart_cap_window_minutes = 60
stopped_retention_days = 7
`;

type Harness = {
  readonly adapter: FakeAdapter;
  readonly service: SessionService;
  readonly store: StateStore;
  readonly log: CapturedLog;
  readonly at: (ms: number) => void;
};

/** A registry that answers about paths however a test needs it to. */
const pathRegistry = (state: PathState): RepoRegistry => ({
  checkPath: () => Promise.resolve(state),
  find: (name) => Promise.resolve(findRepo(harnessConfig, name)),
  list: () => Promise.resolve({ repos: harnessConfig?.repos ?? [], workspacesUnavailable: false }),
});

let harnessConfig: Config;

/** The same table with the idle timeout switched on; the key belongs to it. */
const IDLE_CONFIG_TOML = `${CONFIG_TOML}idle_timeout_minutes = 20\n`;

const harness = async (
  dir: string,
  seeded: readonly SessionRecord[] = [],
  registry?: RepoRegistry,
  configToml: string = CONFIG_TOML,
): Promise<Harness> => {
  const configPath = join(dir, 'config.toml');
  await Bun.write(configPath, configToml);
  const config = await loadConfig({ CCRC_CONFIG: configPath }, join(dir, 'home'));
  harnessConfig = config;
  const adapter = fakeAdapter();
  const store = createStateStore(stateFilePath(config));
  await store.save(seeded);
  let current = NOW;
  let sequence = 0;
  const log = capturingLogger(() => current);
  const service = createSessionService({
    adapter,
    config,
    generateId: () => {
      sequence += 1;
      return `new${sequence}`;
    },
    host: 'test-host',
    logger: log.logger,
    now: () => current,
    ...(registry === undefined ? {} : { registry }),
    store,
  });
  return {
    adapter,
    at: (ms) => {
      current = ms;
    },
    log,
    service,
    store,
  };
};

/** A running record with a correlated, busy host session and a stale transcript. */
const hung = (overrides: Partial<SessionRecord> = {}): SessionRecord =>
  sessionRecord({ pid: 4242, status: 'running', ...overrides });

const busySession = (pid = 4242): HostSession =>
  hostSession({ cwd: '/repos/example', pid, sessionId: 'sid-1', startedAt: NOW, status: 'busy' });

const byId = (records: readonly SessionRecord[], id: string): SessionRecord | undefined =>
  records.find((record) => record.id === id);

describe('reboot reconciliation', () => {
  test('retires every record whose tmux session is gone, and relaunches nothing', async () => {
    await withTempDir(async (dir) => {
      // Records a reboot left behind: written before the machine went down.
      const harnessed = await harness(dir, [
        sessionRecord({
          id: 'id1',
          startedAt: NOW - 60 * MINUTE,
          status: 'running',
          tmuxName: 'ccrc-example-1',
        }),
        sessionRecord({
          id: 'id2',
          startedAt: NOW - 60 * MINUTE,
          status: 'starting',
          tmuxName: 'ccrc-example-2',
        }),
      ]);
      // An empty tmux server is what a rebooted host looks like.
      harnessed.adapter.liveNames = [];

      const listing = await harnessed.service.reconcile();

      expect(listing.sessions.map((session) => session.status)).toEqual(['stopped', 'stopped']);
      const stored = await harnessed.store.load();
      expect(stored.map((record) => record.status)).toEqual(['stopped', 'stopped']);
      expect(stored.map((record) => record.endedAt)).toEqual([NOW, NOW]);
      expect(stored[0]?.stopReason).toBe('its tmux session was gone');
      expect(harnessed.adapter.launches).toEqual([]);
    });
  });

  /**
   * Reconciliation reads liveness first and the host fleet second, so a launch can
   * land in that gap. The clock moves while it does — freezing it in a test hides the
   * whole question, since `startedAt === takenAt` sits on the boundary of every
   * comparison — so each of these moves it by a real offset.
   */
  const launchDuringSnapshot = async (
    harnessed: Harness,
    offsetMs: number,
  ): Promise<SessionView> => {
    const gate = Promise.withResolvers<void>();
    harnessed.adapter.listDelay = () => gate.promise;
    const reconciling = harnessed.service.reconcile();
    // Lets the liveness snapshot resolve and be timestamped before the clock moves.
    await Bun.sleep(1);
    harnessed.adapter.listDelay = () => Promise.resolve();

    harnessed.at(NOW + offsetMs);
    const launched = await harnessed.service.launch({ repo: 'example' });
    gate.resolve();
    await reconciling;
    return launched;
  };

  test.each([1, 250, 2_000, 30_000])(
    'never retires a session created %sms after the liveness snapshot',
    async (offsetMs) => {
      await withTempDir(async (dir) => {
        const harnessed = await harness(dir);

        const launched = await launchDuringSnapshot(harnessed, offsetMs);

        // The snapshot predates the record: it is the strongest possible reason it
        // cannot speak about it, and this session is running with bypassPermissions.
        expect(launched.status).toBe('running');
        const stored = await harnessed.store.load();
        expect(stored[0]?.status).toBe('running');
        expect(stored[0]?.endedAt).toBeNull();
        expect(stored[0]?.stopReason).toBeNull();
      });
    },
  );

  test('claims the host entry of a session that died on its own', async () => {
    await withTempDir(async (dir) => {
      // A session that crashed, exited, or had its tmux session killed directly: no
      // ccrcd code path ran, so reconciliation is the only place its entry gets claimed.
      const harnessed = await harness(dir, [
        hung({ id: 'id1', pid: null, startedAt: NOW - 3 * MINUTE }),
      ]);
      harnessed.adapter.liveNames = [];
      harnessed.adapter.hostSessions = [
        hostSession({
          cwd: '/repos/example',
          pid: 4242,
          sessionId: 'sid-1',
          // Recent enough to correlate with the dead record and with a relaunch.
          startedAt: NOW - 100_000,
          status: 'busy',
        }),
      ];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 20 * MINUTE };

      await harnessed.service.reconcile();

      const dead = byId(await harnessed.store.load(), 'id1');
      expect(dead?.status).toBe('stopped');
      expect(dead?.pid).toBe(4242);
      expect(dead?.hostSessionId).toBe('sid-1');

      // The operator starts another session in that repo; the dead entry is still
      // listed, busy, with a transcript that stopped moving.
      const replacement = await harnessed.service.launch({ repo: 'example' });

      expect(replacement.pid).toBeNull();
      expect(await harnessed.service.sweepHung()).toEqual([]);
      expect(harnessed.adapter.stopped).toEqual([]);
    });
  });

  test('declines to claim an entry a live session in the same repo could own', async () => {
    await withTempDir(async (dir) => {
      // Two sessions in one repo, launched 30s apart, neither correlated yet — the CLI
      // lagged behind both launches, so both records still have a null pid.
      const started = NOW - 5 * MINUTE;
      const harnessed = await harness(dir, [
        sessionRecord({
          id: 's1',
          pid: null,
          startedAt: started,
          status: 'running',
          tmuxName: 'ccrc-example-1',
        }),
        sessionRecord({
          id: 's2',
          pid: null,
          startedAt: started + 30_000,
          status: 'running',
          tmuxName: 'ccrc-example-2',
        }),
      ]);
      // s1's tmux session is gone. s2 is alive and working fine.
      harnessed.adapter.liveNames = ['ccrc-example-2'];
      // Only s2's entry is in the fleet listing; s1's has already dropped out of it,
      // which is what leaves s2's entry as the one thing s1 can correlate to.
      harnessed.adapter.hostSessions = [
        hostSession({
          cwd: '/repos/example',
          pid: 5_150,
          sessionId: 'sid-s2',
          startedAt: started + 30_000,
          status: 'busy',
        }),
      ];
      harnessed.adapter.transcripts = { 'sid-s2': NOW - 1_000 };

      const listing = await harnessed.service.reconcile();

      const dead = byId(await harnessed.store.load(), 's1');
      expect(dead?.status).toBe('stopped');
      // Claiming a living session's entry suppresses that session's own correlation:
      // no activity and no hang coverage for as long as the dead record is kept.
      expect(dead?.pid).toBeNull();
      expect(dead?.hostSessionId).toBeNull();
      expect(listing.sessions.find((session) => session.id === 's2')?.activity).toBe('busy');
    });
  });

  test('waits out the launch window before retiring a record tmux has never listed', async () => {
    await withTempDir(async (dir) => {
      // Written seconds ago: tmux may simply not have the session yet.
      const harnessed = await harness(dir, [
        sessionRecord({ id: 'id1', startedAt: NOW - 10_000, status: 'starting' }),
      ]);
      harnessed.adapter.liveNames = [];

      await harnessed.service.reconcile();
      expect((await harnessed.store.load())[0]?.status).toBe('starting');

      // Past the window, the same answer is a real one.
      const past = NOW + LAUNCH_GRACE_MS + MINUTE;
      harnessed.at(past);
      await harnessed.service.reconcile();

      const stored = await harnessed.store.load();
      expect(stored[0]?.status).toBe('stopped');
      expect(stored[0]?.endedAt).toBe(past);
    });
  });

  test('grants records longer than a launch can possibly take', () => {
    // The grace exists to cover a launch in progress, so it has to outlast one — the
    // two are derived from the same numbers rather than picked separately.
    expect(LAUNCH_GRACE_MS).toBeGreaterThan(WORST_CASE_LAUNCH_MS);
  });

  test('promotes a starting record whose tmux session outlived the launch', async () => {
    await withTempDir(async (dir) => {
      // What a daemon killed mid-launch leaves behind: no attach URL was ever
      // scraped, but the session it started is alive and running with bypassPermissions.
      const harnessed = await harness(dir, [
        sessionRecord({
          attachUrl: null,
          id: 'id1',
          startedAt: NOW - 5 * MINUTE,
          status: 'starting',
        }),
      ]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];

      const listing = await harnessed.service.reconcile();

      expect(listing.sessions[0]?.status).toBe('running');
      const stored = await harnessed.store.load();
      expect(stored[0]?.status).toBe('running');
      // Truthful about what is known: the URL was never captured and is not invented.
      expect(stored[0]?.attachUrl).toBeNull();
      expect(stored[0]?.endedAt).toBeNull();
    });
  });

  test('leaves a starting record alone while its launch could still be running', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [
        sessionRecord({ attachUrl: null, id: 'id1', startedAt: NOW - 5_000, status: 'starting' }),
      ]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];

      await harnessed.service.reconcile();

      expect((await harnessed.store.load())[0]?.status).toBe('starting');
    });
  });

  test('lets a new session take a pid the OS reused after an old record ended', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [
        // Ended days ago, still kept by retention, still claiming pid 4242.
        sessionRecord({
          endedAt: NOW - 3 * DAY,
          hostSessionId: 'sid-old',
          id: 'id1',
          pid: 4242,
          startedAt: NOW - 4 * DAY,
          status: 'stopped',
          tmuxName: 'ccrc-example-1',
        }),
        sessionRecord({ id: 'id2', pid: null, status: 'running', tmuxName: 'ccrc-example-2' }),
      ]);
      harnessed.adapter.liveNames = ['ccrc-example-2'];
      // The OS handed the same pid to something started long after id1 ended.
      harnessed.adapter.hostSessions = [
        hostSession({
          cwd: '/repos/example',
          pid: 4242,
          sessionId: 'sid-new',
          startedAt: NOW,
          status: 'idle',
        }),
      ];

      const listing = await harnessed.service.reconcile();

      // Without correlation the live session reports no activity and the watchdog can
      // never see it at all — for as long as retention keeps the dead record.
      expect(listing.sessions.find((session) => session.id === 'id2')?.activity).toBe('idle');
    });
  });

  test('retires a record stamped further ahead than any launch could explain', async () => {
    await withTempDir(async (dir) => {
      // A clock corrected backwards leaves records stamped in the future. Being ahead
      // of the snapshot by *more than a whole launch window* cannot be a launch race —
      // those are milliseconds to seconds — and treating it as forever-young makes the
      // record immortal: never retired, never promoted, and never pruned because it is
      // not terminal.
      const ahead = LAUNCH_GRACE_MS + 10 * MINUTE;
      const harnessed = await harness(dir, [
        sessionRecord({ id: 'id1', startedAt: NOW + ahead, status: 'running' }),
        sessionRecord({
          attachUrl: null,
          id: 'id2',
          startedAt: NOW + ahead,
          status: 'starting',
          tmuxName: 'ccrc-example-2',
        }),
      ]);
      harnessed.adapter.liveNames = ['ccrc-example-2'];

      await harnessed.service.reconcile();

      const stored = await harnessed.store.load();
      expect(byId(stored, 'id1')?.status).toBe('stopped');
      expect(byId(stored, 'id1')?.endedAt).toBe(NOW);
      // The same reasoning promotes the one tmux does still have.
      expect(byId(stored, 'id2')?.status).toBe('running');
    });
  });

  test('bounds the claim of a record written before ccrcd tracked end times', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [
        // A record from an older state file: terminal, but with no endedAt to bound
        // its claim. Its own start is the latest moment it could have been holding
        // anything.
        sessionRecord({
          endedAt: null,
          hostSessionId: 'sid-old',
          id: 'id1',
          pid: 4242,
          startedAt: NOW - 4 * DAY,
          status: 'stopped',
          tmuxName: 'ccrc-example-1',
        }),
        sessionRecord({ id: 'id2', pid: null, status: 'running', tmuxName: 'ccrc-example-2' }),
      ]);
      harnessed.adapter.liveNames = ['ccrc-example-2'];
      harnessed.adapter.hostSessions = [
        hostSession({
          cwd: '/repos/example',
          pid: 4242,
          sessionId: 'sid-new',
          startedAt: NOW,
          status: 'idle',
        }),
      ];

      const listing = await harnessed.service.reconcile();

      expect(listing.sessions.find((session) => session.id === 'id2')?.activity).toBe('idle');
    });
  });

  test('leaves records alone when tmux cannot say what is live', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [sessionRecord({ id: 'id1', status: 'running' })]);
      harnessed.adapter.liveFailure = new Error('tmux could not list its sessions');

      await harnessed.service.reconcile();

      expect((await harnessed.store.load())[0]?.status).toBe('running');
      expect(harnessed.log.errors.join('')).toMatch(/could not read live tmux sessions/);
    });
  });
});

describe('hang watchdog', () => {
  test('kills a busy session with a stale transcript and restarts it in the same repo', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 15 * MINUTE };

      const outcomes = await harnessed.service.sweepHung();

      expect(outcomes).toEqual([
        {
          id: 'id1',
          reason: 'hung (busy 15 min with a transcript that stopped moving); restarted as new1',
          restartedAs: 'new1',
        },
      ]);
      expect(harnessed.adapter.stopped).toEqual(['ccrc-example-1']);
      // A fresh name, never the dead session's: liveness must not leak between them.
      expect(harnessed.adapter.launches.map((launch) => launch.tmuxName)).toEqual([
        'ccrc-example-2',
      ]);
      expect(harnessed.adapter.launches[0]?.repoPath).toBe('/repos/example');

      const stored = await harnessed.store.load();
      const old = byId(stored, 'id1');
      const replacement = byId(stored, 'new1');
      expect(old?.status).toBe('stopped');
      expect(old?.endedAt).toBe(NOW);
      expect(old?.restartedAs).toBe('new1');
      expect(replacement?.status).toBe('running');
      expect(replacement?.restartedFrom).toBe('id1');
      expect(replacement?.repoName).toBe('example');
      expect(harnessed.log.info.join('')).toMatch(/restarted session id1 in repo example as new1/);
    });
  });

  test('records when the session ended, not when the restart finished', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 15 * MINUTE };
      // A launch can take the better part of a minute. The clock moves on once the
      // kill has happened, while the replacement is coming up.
      let listings = 0;
      harnessed.adapter.listDelay = () => {
        listings += 1;
        if (listings > 1) {
          harnessed.at(NOW + 55_000);
        }
        return Promise.resolve();
      };

      await harnessed.service.sweepHung();

      // Retention is measured from this, and the record's own reason is rewritten
      // twice on the way through — the kill is when the session ended.
      expect(byId(await harnessed.store.load(), 'id1')?.endedAt).toBe(NOW);
    });
  });

  test('starts the replacement without inheriting the dead session’s prompt', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 30 * MINUTE };

      await harnessed.service.sweepHung();

      expect(harnessed.adapter.launches[0]?.prompt).toBeUndefined();
    });
  });

  test('never lets a replacement adopt the host entry of the session it replaced', async () => {
    await withTempDir(async (dir) => {
      // pid null: this record was never correlated by pid, so nothing claims its
      // host entry by pid the way a settled launch would.
      const harnessed = await harness(dir, [hung({ id: 'id1', pid: null })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 15 * MINUTE };

      await harnessed.service.sweepHung();

      // The killed session lingers in the CLI's fleet listing, still busy and still
      // stale. Adopting it would make the watchdog kill the healthy replacement.
      const second = await harnessed.service.sweepHung();

      expect(second).toEqual([]);
      expect(harnessed.adapter.stopped).toEqual(['ccrc-example-1']);
      expect(harnessed.adapter.launches).toHaveLength(1);
      const replacement = byId(await harnessed.store.load(), 'new1');
      expect(replacement?.status).toBe('running');
      expect(replacement?.pid).toBeNull();
    });
  });

  test('never lets a session launched after a DELETE adopt the stopped session’s entry', async () => {
    await withTempDir(async (dir) => {
      // The ordinary operator workflow for a session that has gone quiet: stop it,
      // start another one in the same repo. The stopped session's entry is still in
      // the CLI's fleet listing, still busy, with a transcript that stopped moving.
      const harnessed = await harness(dir, [hung({ id: 'id1', pid: null })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 15 * MINUTE };

      await harnessed.service.stop('id1');
      const replacement = await harnessed.service.launch({ repo: 'example' });

      expect(replacement.pid).toBeNull();
      expect(replacement.hostSessionId).toBeNull();
      // Adopting the dead entry would have the watchdog kill this healthy session,
      // and would leave it reporting a stranger's activity until then.
      expect(await harnessed.service.sweepHung()).toEqual([]);
      expect(harnessed.adapter.stopped).toEqual(['ccrc-example-1']);
      expect(harnessed.adapter.launches).toHaveLength(1);
      const stored = await harnessed.store.load();
      expect(byId(stored, 'id1')?.pid).toBe(4242);
      expect(byId(stored, 'id1')?.hostSessionId).toBe('sid-1');
    });
  });

  test('stops a session even when the claude CLI will not answer', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1', pid: null })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      // A wedged or missing CLI: the fleet listing is where the host claim comes from,
      // but stopping a session is the one thing that has to work when things are broken.
      harnessed.adapter.listFailure = new CommandTimeoutError(
        'claude did not finish within 30000ms and was killed',
      );

      const stopped = await harnessed.service.stop('id1');

      expect(stopped.status).toBe('stopped');
      expect(harnessed.adapter.stopped).toEqual(['ccrc-example-1']);
      const stored = await harnessed.store.load();
      expect(stored[0]?.status).toBe('stopped');
      expect(stored[0]?.endedAt).toBe(NOW);
      // No claim to stamp, and none invented.
      expect(stored[0]?.pid).toBeNull();
      expect(stored[0]?.hostSessionId).toBeNull();
    });
  });

  test('leaves the record active when tmux refuses the kill', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 15 * MINUTE };
      harnessed.adapter.stopOutcome = new StopError('operation not permitted');

      expect(await harnessed.service.sweepHung()).toEqual([]);

      expect((await harnessed.store.load())[0]?.status).toBe('running');
      expect(harnessed.adapter.launches).toEqual([]);
      expect(harnessed.log.errors.join('')).toMatch(/tmux refused to kill it/);
    });
  });

  test('stops a session whose repo directory is gone rather than restarting it', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(
        dir,
        [hung({ id: 'id1', repoName: 'retired', repoPath: '/repos/retired' })],
        pathRegistry('missing'),
      );
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 15 * MINUTE };

      const outcomes = await harnessed.service.sweepHung();

      expect(outcomes[0]?.restartedAs).toBeNull();
      expect(outcomes[0]?.reason).toMatch(/no longer there/);
      expect((await harnessed.store.load())[0]?.status).toBe('stopped');
      expect(harnessed.adapter.launches).toEqual([]);
    });
  });

  test('leaves a hung session alone when the host will not say if its repo is there', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1' })], pathRegistry('unknown'));
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 15 * MINUTE };

      expect(await harnessed.service.sweepHung()).toEqual([]);

      // Killing on an answer the host would not give is how a working session gets
      // retired with nothing to replace it. The next tick asks again.
      expect(harnessed.adapter.stopped).toEqual([]);
      expect(harnessed.adapter.launches).toEqual([]);
      expect((await harnessed.store.load())[0]?.status).toBe('running');
      expect(harnessed.log.errors.join('')).toMatch(/could not tell whether the repo/);
    });
  });

  test('restarts into the path the record was launched from, not a name lookup', async () => {
    await withTempDir(async (dir) => {
      // The name now points somewhere else entirely — a directory of the same name
      // made under the workspaces root after the session started.
      const repointed: RepoRegistry = {
        checkPath: () => Promise.resolve('present'),
        find: () => Promise.resolve({ name: 'example', path: '/repos/impostor' }),
        list: () =>
          Promise.resolve({
            repos: [{ name: 'example', path: '/repos/impostor' }],
            workspacesUnavailable: false,
          }),
      };
      const harnessed = await harness(dir, [hung({ id: 'id1' })], repointed);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 15 * MINUTE };

      const outcomes = await harnessed.service.sweepHung();

      expect(outcomes[0]?.restartedAs).toBe('new1');
      // The replacement continues the work that hung, in the same directory.
      expect(harnessed.adapter.launches[0]?.repoPath).toBe('/repos/example');
    });
  });

  test('retires the record when the replacement cannot be started', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 15 * MINUTE };
      harnessed.adapter.attachUrl = new Error('no attach URL appeared');

      const outcomes = await harnessed.service.sweepHung();

      // The replacement exists as a failed record, so the pair still cross-links
      // both ways: a record pointing at nothing hides where the session went.
      expect(outcomes[0]?.restartedAs).toBe('new1');
      expect(outcomes[0]?.reason).toMatch(/replacement new1 failed to start/);
      const stored = await harnessed.store.load();
      expect(byId(stored, 'id1')?.status).toBe('stopped');
      expect(byId(stored, 'id1')?.restartedAs).toBe('new1');
      expect(byId(stored, 'new1')?.status).toBe('failed');
      expect(byId(stored, 'new1')?.restartedFrom).toBe('id1');
      expect(harnessed.log.errors.join('')).toMatch(/could not start its replacement/);
    });
  });
});

/** A signal the watchdog must read as unknown, and so must never act on. */
type RestraintCase = {
  readonly name: string;
  readonly session: HostSession;
  readonly transcripts?: Record<string, number>;
  readonly record?: Partial<SessionRecord>;
};

describe('hang watchdog restraint', () => {
  const cases: RestraintCase[] = [
    { name: 'an idle session', session: { ...busySession(), status: 'idle' } },
    {
      name: 'a session that reports no status at all',
      session: { ...busySession(), status: 'unknown' },
    },
    { name: 'a busy session with no session id', session: { ...busySession(), sessionId: null } },
    { name: 'a transcript that cannot be found', session: busySession(), transcripts: {} },
    {
      name: 'a transcript that moved inside the threshold',
      session: busySession(),
      transcripts: { 'sid-1': NOW - 9 * MINUTE },
    },
    {
      name: 'a session that correlates to nothing',
      record: { pid: 111 },
      session: { ...busySession(9_999), cwd: '/repos/elsewhere' },
    },
    {
      name: 'a record that is not running yet',
      record: { status: 'starting' },
      session: busySession(),
    },
  ];

  test.each(cases)('never trips on $name', async ({ record, session, transcripts }) => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1', ...record })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [session];
      harnessed.adapter.transcripts = transcripts ?? { 'sid-1': NOW - 60 * MINUTE };

      expect(await harnessed.service.sweepHung()).toEqual([]);

      expect(harnessed.adapter.stopped).toEqual([]);
      expect(harnessed.adapter.launches).toEqual([]);
      expect((await harnessed.store.load())[0]?.stopReason).toBeNull();
    });
  });

  test('never trips when the transcript cannot be probed at all', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcriptFailure = new Error('EIO');

      expect(await harnessed.service.sweepHung()).toEqual([]);

      expect(harnessed.adapter.stopped).toEqual([]);
      expect(harnessed.log.errors.join('')).toMatch(/could not read the transcript of session id1/);
    });
  });
});

describe('restart cap', () => {
  /**
   * id1 → id2 → id3, where id3 is live and carries the history of the two restarts
   * that produced it, both landing `ago` before now.
   */
  const lineage = (ago: number): readonly SessionRecord[] => [
    sessionRecord({ id: 'id1', status: 'stopped', tmuxName: 'ccrc-example-1' }),
    sessionRecord({
      id: 'id2',
      restartedFrom: 'id1',
      restarts: [NOW - ago - MINUTE],
      startedAt: NOW - ago - MINUTE,
      status: 'stopped',
      tmuxName: 'ccrc-example-2',
    }),
    hung({
      id: 'id3',
      restartedFrom: 'id2',
      restarts: [NOW - ago - MINUTE, NOW - ago],
      startedAt: NOW - ago,
      tmuxName: 'ccrc-example-3',
    }),
  ];

  const sweepLineage = async (dir: string, ago: number): Promise<Harness> => {
    const harnessed = await harness(dir, lineage(ago));
    harnessed.adapter.liveNames = ['ccrc-example-3'];
    harnessed.adapter.hostSessions = [busySession()];
    harnessed.adapter.transcripts = { 'sid-1': NOW - 20 * MINUTE };
    return harnessed;
  };

  test('counts restarts from the live record, so pruned history cannot lift the cap', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1' })]);

      /**
       * One watchdog round with the retired record dropped afterwards, exactly as
       * the retention prune would drop it. The cap has to survive that: it is the
       * live record that carries the restart history, not a chain of dead records.
       */
      const round = async (index: number): Promise<readonly HangOutcome[]> => {
        const live = (await harnessed.store.load()).filter((record) => record.status === 'running');
        await harnessed.store.save(live);
        harnessed.adapter.liveNames = live.map((record) => record.tmuxName);
        harnessed.adapter.hostSessions = [
          hostSession({
            cwd: '/repos/example',
            pid: 5_000 + index,
            sessionId: `sid-${index}`,
            startedAt: NOW,
            status: 'busy',
          }),
        ];
        harnessed.adapter.transcripts = { [`sid-${index}`]: NOW - 20 * MINUTE };
        return harnessed.service.sweepHung();
      };

      await round(1);
      await round(2);
      const third = await round(3);

      // Two restarts allowed, and the third refused — even with every ancestor gone.
      expect(harnessed.adapter.launches).toHaveLength(2);
      expect(third[0]?.restartedAs).toBeNull();
      expect(third[0]?.reason).toMatch(/automatic restart cap of 2/);
    });
  });

  test('hands the replacement the history it will be judged by, trimmed to the window', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [
        // One restart three hours ago, one ten minutes ago: only the recent one counts.
        hung({ id: 'id1', restarts: [NOW - 3 * 60 * MINUTE, NOW - 10 * MINUTE] }),
      ]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 20 * MINUTE };

      await harnessed.service.sweepHung();

      expect(byId(await harnessed.store.load(), 'new1')?.restarts).toEqual([
        NOW - 10 * MINUTE,
        NOW,
      ]);
    });
  });

  test('refuses the restart that would exceed the cap for a lineage', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await sweepLineage(dir, 5 * MINUTE);

      const outcomes = await harnessed.service.sweepHung();

      expect(outcomes[0]?.restartedAs).toBeNull();
      expect(outcomes[0]?.reason).toMatch(/automatic restart cap of 2 per 60 min was reached/);
      // The wedged session is still killed — only the replacement is withheld.
      expect(harnessed.adapter.stopped).toEqual(['ccrc-example-3']);
      expect(harnessed.adapter.launches).toEqual([]);
      const stored = await harnessed.store.load();
      expect(byId(stored, 'id3')?.status).toBe('stopped');
      expect(byId(stored, 'id3')?.restartedAs).toBeNull();
      expect(harnessed.log.errors.join('')).toMatch(/will not restart it/);
    });
  });

  test('restarts again once the earlier restarts fall outside the window', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await sweepLineage(dir, 3 * 60 * MINUTE);

      const outcomes = await harnessed.service.sweepHung();

      expect(outcomes[0]?.restartedAs).toBe('new1');
      expect(harnessed.adapter.launches.map((launch) => launch.tmuxName)).toEqual([
        'ccrc-example-4',
      ]);
    });
  });
});

describe('retention prune', () => {
  test('drops terminal records past the retention window and keeps the rest', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [
        sessionRecord({ endedAt: NOW - 8 * DAY, id: 'old-stop', status: 'stopped' }),
        sessionRecord({ endedAt: NOW - 8 * DAY, id: 'old-fail', status: 'failed' }),
        sessionRecord({ endedAt: NOW - 6 * DAY, id: 'recent-stop', status: 'stopped' }),
        // Started long ago but stopped a minute ago: retention counts from the end.
        sessionRecord({
          endedAt: NOW - MINUTE,
          id: 'long-runner',
          startedAt: NOW - 30 * DAY,
          status: 'stopped',
        }),
        sessionRecord({ id: 'running', startedAt: NOW - 30 * DAY, status: 'running' }),
        // A record written before ccrcd tracked end times falls back to its start.
        sessionRecord({ endedAt: null, id: 'legacy', startedAt: NOW - 9 * DAY, status: 'stopped' }),
      ]);

      expect(await harnessed.service.prune()).toBe(3);

      expect((await harnessed.store.load()).map((record) => record.id)).toEqual([
        'recent-stop',
        'long-runner',
        'running',
      ]);
    });
  });

  test('removes nothing when every terminal record is still recent', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [
        sessionRecord({ endedAt: NOW - DAY, id: 'id1', status: 'stopped' }),
      ]);

      expect(await harnessed.service.prune()).toBe(0);
      expect((await harnessed.store.load()).map((record) => record.id)).toEqual(['id1']);
    });
  });

  test('prunes against the clock it is given, not the wall clock', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [
        sessionRecord({ endedAt: NOW - DAY, id: 'id1', status: 'stopped' }),
      ]);
      harnessed.at(NOW + 10 * DAY);

      expect(await harnessed.service.prune()).toBe(1);
      expect(await harnessed.store.load()).toEqual([]);
    });
  });
});

/** A running record with a correlated host session that reports itself idle. */
const idleSession = (pid = 4242): HostSession =>
  hostSession({ cwd: '/repos/example', pid, sessionId: 'sid-1', startedAt: NOW, status: 'idle' });

const idleHarness = (dir: string, seeded: readonly SessionRecord[]): Promise<Harness> =>
  harness(dir, seeded, undefined, IDLE_CONFIG_TOML);

describe('idle timeout', () => {
  test('stops a session that has been idle past the window', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await idleHarness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [idleSession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 35 * MINUTE };

      const outcomes = await harnessed.service.sweepIdle();

      expect(outcomes).toEqual([
        { id: 'id1', reason: 'idle for 35 minutes; stopped by the idle timeout' },
      ]);
      expect(harnessed.adapter.stopped).toEqual(['ccrc-example-1']);
      const stored = (await harnessed.store.load())[0];
      // Stopped exactly as an operator's DELETE stops one — the kill, the claim on
      // the host entry, the end time — with the reason ccrcd had for doing it.
      expect(stored?.status).toBe('stopped');
      expect(stored?.endedAt).toBe(NOW);
      expect(stored?.stopReason).toBe('idle for 35 minutes; stopped by the idle timeout');
      expect(stored?.pid).toBe(4242);
      expect(stored?.hostSessionId).toBe('sid-1');
      // An idle stop is the end of it: nothing is restarted and no cap is touched.
      expect(stored?.restartedAs).toBeNull();
      expect(stored?.restarts).toEqual([]);
      expect(harnessed.adapter.launches).toEqual([]);
      expect(harnessed.log.info.join('')).toMatch(/stopped session id1 in repo example/);
    });
  });

  test('records the end once, even when the sweep runs again later', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await idleHarness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [idleSession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 35 * MINUTE };

      await harnessed.service.sweepIdle();
      harnessed.at(NOW + 10 * MINUTE);
      expect(await harnessed.service.sweepIdle()).toEqual([]);

      expect((await harnessed.store.load())[0]?.endedAt).toBe(NOW);
    });
  });

  test('does nothing at all when the timeout is not configured', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [idleSession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 10 * DAY };
      let fleetReads = 0;
      harnessed.adapter.listDelay = () => {
        fleetReads += 1;
        return Promise.resolve();
      };

      expect(await harnessed.service.sweepIdle()).toEqual([]);

      // Off means off: no fleet listing, no transcript reads, no work at all.
      expect(fleetReads).toBe(0);
      expect(harnessed.adapter.stopped).toEqual([]);
      expect((await harnessed.store.load())[0]?.status).toBe('running');
    });
  });

  test('leaves the record running when tmux refuses the kill', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await idleHarness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [idleSession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 35 * MINUTE };
      harnessed.adapter.stopOutcome = new StopError('operation not permitted');

      expect(await harnessed.service.sweepIdle()).toEqual([]);

      expect((await harnessed.store.load())[0]?.status).toBe('running');
      expect(harnessed.log.errors.join('')).toMatch(/tmux refused to kill it/);
    });
  });

  test('skips the sweep when the host fleet cannot be listed', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await idleHarness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.listFailure = new CommandTimeoutError(
        'claude did not finish within 30000ms and was killed',
      );

      // Not "nothing is idle", and certainly not "everything is": the tick gives up.
      const failure = await rejection(harnessed.service.sweepIdle());

      expect(failure).toBeInstanceOf(CommandTimeoutError);
      expect(harnessed.adapter.stopped).toEqual([]);
      expect((await harnessed.store.load())[0]?.status).toBe('running');
    });
  });
});

/** Everything the idle sweep has to read as unknown, and so never act on. */
type IdleRestraintCase = {
  readonly name: string;
  readonly session: HostSession;
  readonly transcripts?: Record<string, number>;
  readonly record?: Partial<SessionRecord>;
};

describe('idle timeout restraint', () => {
  const cases: IdleRestraintCase[] = [
    {
      name: 'a session that reports itself busy (the watchdog owns that)',
      session: { ...idleSession(), status: 'busy' },
    },
    {
      name: 'a session that reports no status at all',
      session: { ...idleSession(), status: 'unknown' },
    },
    { name: 'an idle session with no session id', session: { ...idleSession(), sessionId: null } },
    { name: 'a transcript that cannot be found', session: idleSession(), transcripts: {} },
    {
      name: 'a transcript that moved inside the window',
      session: idleSession(),
      transcripts: { 'sid-1': NOW - 19 * MINUTE },
    },
    {
      name: 'a session that correlates to nothing',
      record: { pid: 111 },
      session: { ...idleSession(9_999), cwd: '/repos/elsewhere' },
    },
    {
      name: 'a record that is not running yet',
      record: { status: 'starting' },
      session: idleSession(),
    },
  ];

  test.each(cases)('never trips on $name', async ({ record, session, transcripts }) => {
    await withTempDir(async (dir) => {
      const harnessed = await idleHarness(dir, [hung({ id: 'id1', ...record })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [session];
      harnessed.adapter.transcripts = transcripts ?? { 'sid-1': NOW - 60 * MINUTE };

      expect(await harnessed.service.sweepIdle()).toEqual([]);

      expect(harnessed.adapter.stopped).toEqual([]);
      const stored = (await harnessed.store.load())[0];
      expect(stored?.stopReason).toBeNull();
      expect(stored?.endedAt).toBeNull();
    });
  });

  test('never trips when the transcript cannot be probed at all', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await idleHarness(dir, [hung({ id: 'id1' })]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [idleSession()];
      harnessed.adapter.transcriptFailure = new Error('EIO');

      expect(await harnessed.service.sweepIdle()).toEqual([]);

      expect(harnessed.adapter.stopped).toEqual([]);
      expect(harnessed.log.errors.join('')).toMatch(/could not read the transcript of session id1/);
    });
  });
});
