import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import type { HostSession } from '../src/adapter/claude.ts';
import { loadConfig, stateFilePath } from '../src/config.ts';
import { StopError } from '../src/errors.ts';
import { createSessionService } from '../src/sessions.ts';
import type { HangOutcome, SessionService } from '../src/sessions.ts';
import { createStateStore } from '../src/state.ts';
import type { SessionRecord, StateStore } from '../src/state.ts';
import {
  capturingLogger,
  fakeAdapter,
  hostSession,
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

const harness = async (dir: string, seeded: readonly SessionRecord[] = []): Promise<Harness> => {
  const configPath = join(dir, 'config.toml');
  await Bun.write(configPath, CONFIG_TOML);
  const config = await loadConfig({ CCRC_CONFIG: configPath }, join(dir, 'home'));
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

  test('never retires a session that launched while the liveness snapshot was in flight', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      // Reconciliation reads liveness first and the host fleet second. Hold it in
      // that gap — the tmux snapshot it is carrying cannot know about a launch that
      // has not happened yet.
      const gate = Promise.withResolvers<void>();
      harnessed.adapter.listDelay = () => gate.promise;
      const reconciling = harnessed.service.reconcile();
      await Bun.sleep(1);
      harnessed.adapter.listDelay = () => Promise.resolve();

      const launched = await harnessed.service.launch({ repo: 'example' });
      gate.resolve();
      await reconciling;

      expect(launched.status).toBe('running');
      const stored = await harnessed.store.load();
      expect(stored[0]?.status).toBe('running');
      expect(stored[0]?.endedAt).toBeNull();
      expect(stored[0]?.stopReason).toBeNull();
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
      harnessed.at(NOW + 2 * MINUTE);
      await harnessed.service.reconcile();

      const stored = await harnessed.store.load();
      expect(stored[0]?.status).toBe('stopped');
      expect(stored[0]?.endedAt).toBe(NOW + 2 * MINUTE);
    });
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

  test('stops a session whose repo left the registry rather than restarting it', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, [
        hung({ id: 'id1', repoName: 'retired', repoPath: '/repos/retired' }),
      ]);
      harnessed.adapter.liveNames = ['ccrc-example-1'];
      harnessed.adapter.hostSessions = [busySession()];
      harnessed.adapter.transcripts = { 'sid-1': NOW - 15 * MINUTE };

      const outcomes = await harnessed.service.sweepHung();

      expect(outcomes[0]?.restartedAs).toBeNull();
      expect(outcomes[0]?.reason).toMatch(/no longer in the registry/);
      expect((await harnessed.store.load())[0]?.status).toBe('stopped');
      expect(harnessed.adapter.launches).toEqual([]);
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
