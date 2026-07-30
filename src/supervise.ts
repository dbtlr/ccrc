import { messageOf } from './errors.ts';
import { createLogger } from './log.ts';
import type { Logger } from './log.ts';
import type { SessionService } from './sessions.ts';

/**
 * The daemon's own upkeep, on a timer instead of on a request.
 *
 * Everything here used to happen only when a client read the API: records went on
 * claiming to be running long after their tmux sessions died, a wedged session was
 * nobody's problem until someone looked, and terminal records were kept forever.
 * One periodic tick does the three things that have to happen whether or not
 * anyone is watching — reconcile, watch for hangs, prune history.
 *
 * Two rules make the loop safe to leave running unattended:
 *
 * - ticks never overlap. A tick spawns replacement sessions and rewrites state; a
 *   second one starting while the first is mid-restart would reconcile against a
 *   half-written world. A tick that arrives while one is in flight is dropped, not
 *   queued — the next interval is soon enough.
 * - no phase may end the loop. Every phase is caught and logged on its own, so a
 *   tmux that cannot answer neither skips the prune nor stops the ticker nor takes
 *   the daemon down with it.
 */

/** Starts a repeating timer and returns its cancel. Injected so tests drive time. */
export type Ticker = (intervalMs: number, tick: () => void) => () => void;

const defaultTicker: Ticker = (intervalMs, tick) => {
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
};

export type Supervisor = {
  /** Runs one tick now. Does nothing when a tick is already in flight. */
  readonly tick: () => Promise<void>;
  /** The tick run at startup, exposed for callers that want to wait for it. */
  readonly started: Promise<void>;
  readonly stop: () => void;
};

export type SuperviseOptions = {
  readonly service: SessionService;
  readonly intervalMs: number;
  readonly logger?: Logger;
  readonly ticker?: Ticker;
};

export const startSupervisor = (options: SuperviseOptions): Supervisor => {
  const { intervalMs, service } = options;
  const logger = options.logger ?? createLogger();
  const ticker = options.ticker ?? defaultTicker;
  let running = false;

  const phase = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (cause) {
      logger.error(`ccrcd supervision could not ${name}: ${messageOf(cause)}`);
    }
  };

  const tick = async (): Promise<void> => {
    if (running) {
      logger.info('ccrcd skipped a supervision tick because the previous one is still running');
      return;
    }
    running = true;
    try {
      await phase('reconcile records against tmux', () => service.reconcile());
      await phase('check for hung sessions', () => service.sweepHung());
      await phase('prune old records', async () => {
        const pruned = await service.prune();
        if (pruned > 0) {
          logger.info(`ccrcd pruned ${pruned} session record(s) past the retention window`);
        }
      });
    } finally {
      running = false;
    }
  };

  const cancel = ticker(intervalMs, () => void tick());
  // One tick immediately: after a host reboot the records left in the state file
  // all claim to be running, and nothing should have to call the API to find out
  // otherwise. Reconciliation only ever retires them — it never relaunches.
  return { started: tick(), stop: cancel, tick };
};
