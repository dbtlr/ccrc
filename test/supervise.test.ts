import { describe, expect, test } from 'bun:test';

import type { HangOutcome, IdleOutcome, SessionListing, SessionService } from '../src/sessions.ts';
import { startSupervisor } from '../src/supervise.ts';
import type { Ticker } from '../src/supervise.ts';
import { capturingLogger } from './support.ts';

const EMPTY_LISTING: SessionListing = { hostSessions: [], sessions: [] };

const unused = (): never => {
  throw new Error('the supervisor must not call this');
};

type Stub = {
  readonly service: SessionService;
  /** Every phase the supervisor ran, in order. */
  readonly phases: string[];
  reconcile: () => Promise<SessionListing>;
  sweep: () => Promise<readonly HangOutcome[]>;
  sweepIdle: () => Promise<readonly IdleOutcome[]>;
  prune: () => Promise<number>;
};

const stubService = (): Stub => {
  const phases: string[] = [];
  const stub: Stub = {
    phases,
    prune: () => Promise.resolve(0),
    reconcile: () => Promise.resolve(EMPTY_LISTING),
    service: {
      get: unused,
      launch: unused,
      list: unused,
      listRepos: unused,
      prune: () => {
        phases.push('prune');
        return stub.prune();
      },
      reconcile: () => {
        phases.push('reconcile');
        return stub.reconcile();
      },
      stop: unused,
      sweepHung: () => {
        phases.push('sweep');
        return stub.sweep();
      },
      sweepIdle: () => {
        phases.push('idle');
        return stub.sweepIdle();
      },
    },
    sweep: () => Promise.resolve([]),
    sweepIdle: () => Promise.resolve([]),
  };
  return stub;
};

type FakeTicker = {
  readonly ticker: Ticker;
  /** The intervals the supervisor asked to be ticked at. */
  readonly intervals: number[];
  readonly fire: () => void;
  readonly cancels: () => number;
};

const fakeTicker = (): FakeTicker => {
  const intervals: number[] = [];
  let handler: (() => void) | undefined;
  let cancels = 0;
  return {
    cancels: () => cancels,
    fire: () => handler?.(),
    intervals,
    ticker: (intervalMs, tick) => {
      intervals.push(intervalMs);
      handler = tick;
      return () => {
        cancels += 1;
      };
    },
  };
};

describe('supervision loop', () => {
  test('runs one tick at startup, in reconcile-watchdog-prune order', async () => {
    const stub = stubService();
    const ticker = fakeTicker();

    const supervisor = startSupervisor({
      intervalMs: 30_000,
      service: stub.service,
      ticker: ticker.ticker,
    });
    await supervisor.started;

    expect(stub.phases).toEqual(['reconcile', 'sweep', 'idle', 'prune']);
    expect(ticker.intervals).toEqual([30_000]);
    supervisor.stop();
    expect(ticker.cancels()).toBe(1);
  });

  test('ticks again on every interval', async () => {
    const stub = stubService();
    const ticker = fakeTicker();
    const supervisor = startSupervisor({
      intervalMs: 5_000,
      service: stub.service,
      ticker: ticker.ticker,
    });
    await supervisor.started;
    // The timer's tick is fired and forgotten, so the test waits on the last phase
    // of that tick rather than on a promise it cannot see.
    const pruned = Promise.withResolvers<void>();
    stub.prune = () => {
      pruned.resolve();
      return Promise.resolve(0);
    };

    ticker.fire();
    await pruned.promise;

    expect(stub.phases.filter((phase) => phase === 'reconcile')).toHaveLength(2);
    supervisor.stop();
  });

  test('drops a tick that arrives while the previous one is still running', async () => {
    const stub = stubService();
    const ticker = fakeTicker();
    const blocked = Promise.withResolvers<SessionListing>();
    stub.reconcile = () => blocked.promise;
    const log = capturingLogger();

    const supervisor = startSupervisor({
      intervalMs: 30_000,
      logger: log.logger,
      service: stub.service,
      ticker: ticker.ticker,
    });
    // The startup tick is parked inside reconcile; the interval fires anyway.
    ticker.fire();
    await supervisor.tick();

    expect(stub.phases).toEqual(['reconcile']);
    expect(log.info.join('')).toMatch(/skipped a supervision tick/);

    blocked.resolve(EMPTY_LISTING);
    await supervisor.started;
    expect(stub.phases).toEqual(['reconcile', 'sweep', 'idle', 'prune']);
    supervisor.stop();
  });

  test('escalates once ticks keep being skipped, and calms down when one lands', async () => {
    const stub = stubService();
    const ticker = fakeTicker();
    const blocked = Promise.withResolvers<SessionListing>();
    stub.reconcile = () => blocked.promise;
    const log = capturingLogger();

    const supervisor = startSupervisor({
      intervalMs: 30_000,
      logger: log.logger,
      service: stub.service,
      ticker: ticker.ticker,
    });
    // The startup tick is wedged inside reconcile, so every interval is a skip. A
    // few are ordinary; a run of them means supervision has silently stopped.
    ticker.fire();
    ticker.fire();
    ticker.fire();
    expect(log.errors).toEqual([]);
    ticker.fire();
    await supervisor.tick();

    expect(log.errors.join('')).toMatch(/skipped 4 supervision ticks in a row/);
    expect(log.errors.join('')).toMatch(/skipped 5 supervision ticks in a row/);

    blocked.resolve(EMPTY_LISTING);
    await supervisor.started;
    log.errors.length = 0;
    log.info.length = 0;

    // The wedge cleared: the count starts over rather than staying escalated.
    const pruned = Promise.withResolvers<void>();
    stub.reconcile = () => Promise.resolve(EMPTY_LISTING);
    stub.prune = () => {
      pruned.resolve();
      return Promise.resolve(0);
    };
    ticker.fire();
    await pruned.promise;
    expect(log.errors).toEqual([]);
    supervisor.stop();
  });

  test('a failing phase neither skips the others nor stops the loop', async () => {
    const stub = stubService();
    const ticker = fakeTicker();
    stub.reconcile = () => Promise.reject(new Error('tmux is wedged'));
    stub.sweep = () => Promise.reject(new Error('the CLI is gone'));
    stub.sweepIdle = () => Promise.reject(new Error('the fleet would not list'));
    const log = capturingLogger();

    const supervisor = startSupervisor({
      intervalMs: 30_000,
      logger: log.logger,
      service: stub.service,
      ticker: ticker.ticker,
    });
    await supervisor.started;

    expect(stub.phases).toEqual(['reconcile', 'sweep', 'idle', 'prune']);
    expect(log.errors.join('')).toMatch(/could not reconcile records against tmux: tmux is wedged/);
    expect(log.errors.join('')).toMatch(/could not check for hung sessions: the CLI is gone/);
    expect(log.errors.join('')).toMatch(/could not stop idle sessions: the fleet would not list/);

    // The loop is still live: the next tick runs every phase again.
    await supervisor.tick();
    expect(stub.phases).toHaveLength(8);
    supervisor.stop();
  });

  test('survives a phase that throws before it returns a promise', async () => {
    const stub = stubService();
    const ticker = fakeTicker();
    stub.prune = () => {
      throw new Error('the state file is unwritable');
    };
    const log = capturingLogger();

    const supervisor = startSupervisor({
      intervalMs: 30_000,
      logger: log.logger,
      service: stub.service,
      ticker: ticker.ticker,
    });

    await supervisor.started;

    expect(log.errors.join('')).toMatch(
      /could not prune old records: the state file is unwritable/,
    );
    // The tick completed, so the next one is not treated as an overlap.
    await supervisor.tick();
    expect(stub.phases).toHaveLength(8);
    supervisor.stop();
  });

  test('reports how many records a prune removed, and stays quiet when none went', async () => {
    const stub = stubService();
    const ticker = fakeTicker();
    stub.prune = () => Promise.resolve(4);
    const log = capturingLogger();

    const supervisor = startSupervisor({
      intervalMs: 30_000,
      logger: log.logger,
      service: stub.service,
      ticker: ticker.ticker,
    });
    await supervisor.started;

    expect(log.info.join('')).toMatch(/pruned 4 session record\(s\)/);

    stub.prune = () => Promise.resolve(0);
    log.info.length = 0;
    await supervisor.tick();
    expect(log.info).toEqual([]);
    supervisor.stop();
  });
});
