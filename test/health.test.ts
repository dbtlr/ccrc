import { describe, expect, test } from 'bun:test';
import { chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { HEALTH_TIMEOUT_MS, createHealthService } from '../src/health.ts';
import type { HealthOptions } from '../src/health.ts';
import { capturingLogger, fakeAdapter, withTempDir } from './support.ts';
import type { CapturedLog, FakeAdapter } from './support.ts';

type Harness = {
  readonly adapter: FakeAdapter;
  readonly log: CapturedLog;
  readonly statePath: string;
  readonly service: ReturnType<typeof createHealthService>;
};

const harness = (dir: string, overrides: Partial<HealthOptions> = {}): Harness => {
  const adapter = fakeAdapter();
  const log = capturingLogger();
  const statePath = join(dir, 'state.json');
  return {
    adapter,
    log,
    service: createHealthService({ adapter, logger: log.logger, statePath, ...overrides }),
    statePath,
  };
};

describe('health checks', () => {
  test('reports every dependency it could reach', async () => {
    await withTempDir(async (dir) => {
      const harnessed = harness(dir);

      expect(await harnessed.service.check()).toEqual({
        checks: { claude: 'ok', state: 'ok', tmux: 'ok' },
        ok: true,
      });
      // The writability probe cleans up after itself.
      expect(await readdir(dir)).toEqual([]);
    });
  });

  test('an unreachable tmux fails the report and stays out of the response', async () => {
    await withTempDir(async (dir) => {
      const harnessed = harness(dir);
      harnessed.adapter.tmuxHealthFailure = new Error('error connecting to /tmp/tmux-501/default');

      const report = await harnessed.service.check();

      expect(report).toEqual({
        checks: { claude: 'ok', state: 'ok', tmux: 'failed' },
        ok: false,
      });
      expect(harnessed.log.errors.join('')).toMatch(/health check "tmux" failed/);
      expect(harnessed.log.errors.join('')).toMatch(/tmux-501/);
    });
  });

  test('an unreachable claude CLI fails the report', async () => {
    await withTempDir(async (dir) => {
      const harnessed = harness(dir);
      harnessed.adapter.claudeHealthFailure = new Error('command not found: claude');

      const report = await harnessed.service.check();

      expect(report.ok).toBe(false);
      expect(report.checks).toEqual({ claude: 'failed', state: 'ok', tmux: 'ok' });
    });
  });

  test('a state directory that cannot be written fails the report', async () => {
    await withTempDir(async (dir) => {
      const stateDir = join(dir, 'state');
      const harnessed = harness(stateDir);
      await chmod(dir, 0o500);
      try {
        const report = await harnessed.service.check();

        expect(report.ok).toBe(false);
        expect(report.checks.state).toBe('failed');
        expect(harnessed.log.errors.join('')).toMatch(/health check "state" failed/);
      } finally {
        await chmod(dir, 0o700);
      }
    });
  });

  test('a probe that never answers fails on the short timeout, not the command one', async () => {
    await withTempDir(async (dir) => {
      const deadlines: number[] = [];
      const harnessed = harness(dir, {
        // A tmux that answers nothing at all, the case the deadline exists for.
        adapter: {
          checkClaude: () => Promise.resolve(),
          checkTmux: () => Promise.withResolvers<void>().promise,
        },
        // Fires immediately: the probe would otherwise never settle.
        timer: (ms, fire) => {
          deadlines.push(ms);
          fire();
          return () => undefined;
        },
      });

      const report = await harnessed.service.check();

      expect(report.checks.tmux).toBe('failed');
      expect(deadlines).toEqual([HEALTH_TIMEOUT_MS, HEALTH_TIMEOUT_MS, HEALTH_TIMEOUT_MS]);
      expect(HEALTH_TIMEOUT_MS).toBeLessThan(30_000);
      expect(harnessed.log.errors.join('')).toMatch(/did not answer within 2000ms/);
    });
  });

  test('cancels each deadline once its probe has answered', async () => {
    await withTempDir(async (dir) => {
      let cancels = 0;
      const harnessed = harness(dir, {
        timer: () => () => {
          cancels += 1;
        },
      });

      await harnessed.service.check();

      expect(cancels).toBe(3);
    });
  });
});
