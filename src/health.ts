import type { ClaudeAdapter } from './adapter/claude.ts';
import { HealthError, messageOf } from './errors.ts';
import { checkWritable } from './files.ts';
import { createLogger } from './log.ts';
import type { Logger } from './log.ts';

/**
 * What `/healthz` actually asks. The daemon is useless without any one of three
 * things — tmux to run sessions in, the `claude` CLI to run in them, and a writable
 * state file to record them in — so health means all three answer, not that the
 * process is up.
 *
 * Every probe is bounded by a short timeout of its own and they all run together, so
 * an unreachable dependency costs the response that timeout once rather than the
 * 30 seconds a normal command is given. A monitor that has to wait 90 seconds to be
 * told the daemon is unwell is not a monitor.
 */

export type HealthCheckName = 'tmux' | 'claude' | 'state';
export type HealthCheckStatus = 'ok' | 'failed';

export type HealthReport = {
  readonly ok: boolean;
  readonly checks: Record<HealthCheckName, HealthCheckStatus>;
};

export type HealthService = {
  readonly check: () => Promise<HealthReport>;
};

/** Short on purpose: health has to answer while the thing it describes is happening. */
export const HEALTH_TIMEOUT_MS = 2_000;

/**
 * How long one set of answers is reused.
 *
 * `/healthz` is a plain unauthenticated `GET`, and each run of it spawns processes —
 * `claude --version`, `tmux list-sessions`, a probe write. Without a cache, anything
 * that can reach the daemon (including a page the operator happened to open, since a
 * read needs no origin) turns request volume into process volume. Concurrent callers
 * share one run and the answer stands for a few seconds, which bounds the spawn rate
 * no matter how hard the route is hit. A few seconds of staleness is nothing next to
 * a monitor's polling interval.
 */
export const HEALTH_CACHE_TTL_MS = 5_000;

/** Runs `fire` after `ms` and returns its cancel — `setTimeout`, injectable. */
export type OneShotTimer = (ms: number, fire: () => void) => () => void;

const defaultTimer: OneShotTimer = (ms, fire) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

export type HealthOptions = {
  readonly adapter: Pick<ClaudeAdapter, 'checkClaude' | 'checkTmux'>;
  readonly statePath: string;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  readonly timer?: OneShotTimer;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
};

export const createHealthService = (options: HealthOptions): HealthService => {
  const logger = options.logger ?? createLogger();
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const timer = options.timer ?? defaultTimer;
  const cacheTtlMs = options.cacheTtlMs ?? HEALTH_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { readonly at: number; readonly report: HealthReport } | undefined;
  let inFlight: Promise<HealthReport> | undefined;

  /**
   * The reason a probe failed is logged, never served: a probe failure quotes host
   * paths and command output, and `/healthz` is the one route with no origin check
   * in front of it. The client is told which dependency is unwell, and the log says
   * why.
   */
  const bounded = async (
    name: HealthCheckName,
    probe: () => Promise<void>,
  ): Promise<HealthCheckStatus> => {
    const expiry = Promise.withResolvers<never>();
    const cancel = timer(timeoutMs, () => {
      expiry.reject(new HealthError(`${name} did not answer within ${timeoutMs}ms`));
    });
    try {
      await Promise.race([probe(), expiry.promise]);
      return 'ok';
    } catch (cause) {
      logger.error(`ccrcd health check "${name}" failed: ${messageOf(cause)}`);
      return 'failed';
    } finally {
      cancel();
    }
  };

  const probeAll = async (): Promise<HealthReport> => {
    const [claude, state, tmux] = await Promise.all([
      bounded('claude', () => options.adapter.checkClaude()),
      bounded('state', () => checkWritable(options.statePath)),
      bounded('tmux', () => options.adapter.checkTmux()),
    ]);
    return {
      checks: { claude, state, tmux },
      ok: claude === 'ok' && state === 'ok' && tmux === 'ok',
    };
  };

  /** One run at a time; the answer is remembered for `cacheTtlMs`. */
  const refresh = async (): Promise<HealthReport> => {
    try {
      const report = await probeAll();
      cached = { at: now(), report };
      return report;
    } finally {
      inFlight = undefined;
    }
  };

  const check = (): Promise<HealthReport> => {
    if (cached !== undefined && now() - cached.at < cacheTtlMs) {
      return Promise.resolve(cached.report);
    }
    inFlight ??= refresh();
    return inFlight;
  };

  return { check };
};
