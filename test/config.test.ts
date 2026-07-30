import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  DEFAULT_SUPERVISION,
  configPathFrom,
  findRepo,
  loadConfig,
  stateFilePath,
} from '../src/config.ts';
import { ConfigError } from '../src/errors.ts';
import { rejection, withTempDir } from './support.ts';

const SAMPLE = `bind = "127.0.0.1"
port = 7433

[[repos]]
name = "example"
path = "/repos/example"

[[repos]]
name = "notes"
path = "~/notes"
`;

const withBind = async (bind: string, run: (configPath: string) => Promise<void>): Promise<void> =>
  withTempDir(async (dir) => {
    const configPath = join(dir, 'config.toml');
    await Bun.write(configPath, `bind = "${bind}"\n`);
    await run(configPath);
  });

describe('loadConfig', () => {
  test('reads bind, port, and the repo registry from CCRC_CONFIG', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      await Bun.write(configPath, SAMPLE);
      const home = join(dir, 'home');

      const config = await loadConfig({ CCRC_CONFIG: configPath }, home);

      expect(config.bind).toBe('127.0.0.1');
      expect(config.port).toBe(7433);
      expect(config.repos).toEqual([
        { name: 'example', path: '/repos/example' },
        { name: 'notes', path: join(home, 'notes') },
      ]);
      expect(stateFilePath(config)).toBe(join(dir, 'state.json'));
      expect(findRepo(config, 'notes')?.path).toBe(join(home, 'notes'));
      expect(findRepo(config, 'absent')).toBeUndefined();
    });
  });

  test('applies defaults when bind and port are omitted', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      await Bun.write(configPath, '[[repos]]\nname = "example"\npath = "/repos/example"\n');

      const config = await loadConfig({ CCRC_CONFIG: configPath }, '/home/tester');

      expect(config.bind).toBe('127.0.0.1');
      expect(config.port).toBe(7433);
    });
  });

  test('fails with a message naming the missing file', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'absent.toml');

      const failure = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));

      expect(failure).toBeInstanceOf(ConfigError);
      expect(failure.message).toContain(`config not found at ${configPath}`);
    });
  });

  test('rejects malformed entries', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      await Bun.write(configPath, 'port = "not a number"\n');
      const badPort = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));
      expect(badPort.message).toMatch(/"port" must be an integer/);

      await Bun.write(configPath, '[[repos]]\nname = "example"\n');
      const badRepo = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));
      expect(badRepo.message).toMatch(/repos\[0]: "path" must be a non-empty string/);
    });
  });

  test.each(['0.0.0.0', '::', '192.168.1.10', 'ccrc.example.ts.net'])(
    'refuses the network-reachable bind %s',
    async (bind) => {
      await withBind(bind, async (configPath) => {
        const failure = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));
        expect(failure).toBeInstanceOf(ConfigError);
        expect(failure.message).toMatch(/must be a loopback address/);
        expect(failure.message).toMatch(/bypassPermissions/);
      });
    },
  );

  test.each(['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]'])(
    'accepts the loopback bind %s',
    async (bind) => {
      await withBind(bind, async (configPath) => {
        const config = await loadConfig({ CCRC_CONFIG: configPath }, '/home/tester');
        expect(config.bind).toBe(bind);
      });
    },
  );

  test('defaults allowed_origins to nothing at all', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      await Bun.write(configPath, SAMPLE);

      const config = await loadConfig({ CCRC_CONFIG: configPath }, '/home/tester');

      expect(config.allowedOrigins).toEqual([]);
    });
  });

  test.each([
    'https://ccrc.example',
    'http://ccrc.example',
    'https://ccrc.example:8443',
    'http://127.0.0.1:7433',
  ])('accepts the exact origin %s', async (origin) => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      await Bun.write(configPath, `allowed_origins = ["${origin}"]\n`);

      const config = await loadConfig({ CCRC_CONFIG: configPath }, '/home/tester');

      expect(config.allowedOrigins).toEqual([origin]);
    });
  });

  test.each([
    'https://ccrc.example/',
    'https://ccrc.example/console',
    'https://ccrc.example?x=1',
    'https://ccrc.example#top',
    'https://user@ccrc.example',
    'https://CCRC.example',
    'https://ccrc.example:443',
    'ccrc.example',
    '*',
    'https://*.ccrc.example',
    'file:///tmp',
    'null',
    '',
  ])('refuses the unusable origin %p', async (origin) => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      await Bun.write(configPath, `allowed_origins = ["${origin}"]\n`);

      const failure = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));

      expect(failure).toBeInstanceOf(ConfigError);
      expect(failure.message).toContain('allowed_origins[0]');
    });
  });

  test('refuses allowed_origins that is not a list', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      await Bun.write(configPath, 'allowed_origins = "https://ccrc.example"\n');

      const failure = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));

      expect(failure.message).toMatch(/"allowed_origins" must be a list/);
    });
  });

  test('falls back to the XDG-style path when CCRC_CONFIG is unset', () => {
    expect(configPathFrom({}, '/home/tester')).toBe('/home/tester/.config/ccrc/config.toml');
  });
});

const withConfig = async (
  toml: string,
  run: (configPath: string) => Promise<void>,
): Promise<void> =>
  withTempDir(async (dir) => {
    const configPath = join(dir, 'config.toml');
    await Bun.write(configPath, toml);
    await run(configPath);
  });

describe('supervision config', () => {
  test('defaults the whole table when it is absent', async () => {
    await withConfig(SAMPLE, async (configPath) => {
      const config = await loadConfig({ CCRC_CONFIG: configPath }, '/home/tester');

      expect(config.supervision).toEqual(DEFAULT_SUPERVISION);
      expect(config.supervision.intervalMs).toBe(30_000);
      expect(config.supervision.hangThresholdMs).toBe(600_000);
      expect(config.supervision.restartCap).toBe(3);
      expect(config.supervision.restartCapWindowMs).toBe(3_600_000);
      expect(config.supervision.stoppedRetentionMs).toBe(604_800_000);
    });
  });

  test('reads the operator units and normalises them to milliseconds', async () => {
    const toml = `[supervision]
reconcile_interval_seconds = 5
hang_threshold_minutes = 2
restart_cap = 1
restart_cap_window_minutes = 15
stopped_retention_days = 2
`;

    await withConfig(toml, async (configPath) => {
      const config = await loadConfig({ CCRC_CONFIG: configPath }, '/home/tester');

      expect(config.supervision).toEqual({
        hangThresholdMs: 120_000,
        intervalMs: 5_000,
        restartCap: 1,
        restartCapWindowMs: 900_000,
        stoppedRetentionMs: 172_800_000,
      });
    });
  });

  test('keeps the defaults for the keys a partial table leaves out', async () => {
    await withConfig('[supervision]\nhang_threshold_minutes = 20\n', async (configPath) => {
      const config = await loadConfig({ CCRC_CONFIG: configPath }, '/home/tester');

      expect(config.supervision).toEqual({
        ...DEFAULT_SUPERVISION,
        hangThresholdMs: 1_200_000,
      });
    });
  });

  test('accepts a restart cap of zero as "never restart"', async () => {
    await withConfig('[supervision]\nrestart_cap = 0\n', async (configPath) => {
      const config = await loadConfig({ CCRC_CONFIG: configPath }, '/home/tester');

      expect(config.supervision.restartCap).toBe(0);
    });
  });

  test.each([
    'reconcile_interval_seconds = 0',
    'reconcile_interval_seconds = -1',
    'hang_threshold_minutes = 0',
    'restart_cap_window_minutes = -5',
    'stopped_retention_days = 0',
    'stopped_retention_days = "seven"',
    // A fraction of a minute would call every busy session hung on the next tick.
    'hang_threshold_minutes = 0.00001',
    'reconcile_interval_seconds = 0.5',
    'stopped_retention_days = 0.5',
    // Beyond 2^31-1 milliseconds a timer wraps and ticks as fast as it can.
    'reconcile_interval_seconds = 2147484',
    'reconcile_interval_seconds = 4',
    'hang_threshold_minutes = 10000',
    'stopped_retention_days = 4000',
    'restart_cap_window_minutes = 100000',
  ])('refuses the unusable duration %s', async (entry) => {
    await withConfig(`[supervision]\n${entry}\n`, async (configPath) => {
      const failure = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));

      expect(failure).toBeInstanceOf(ConfigError);
      expect(failure.message).toContain('[supervision]');
      expect(failure.message).toMatch(/whole number of|between/);
    });
  });

  test('refuses a restart window shorter than the hang threshold', async () => {
    const toml = `[supervision]
hang_threshold_minutes = 30
restart_cap_window_minutes = 10
`;

    await withConfig(toml, async (configPath) => {
      const failure = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));

      expect(failure).toBeInstanceOf(ConfigError);
      expect(failure.message).toMatch(/"restart_cap_window_minutes" must be at least/);
    });
  });

  test('refuses a retention shorter than the restart window', async () => {
    // Retention that expires inside the window would drop the very history the
    // restart cap is counted from.
    const toml = `[supervision]
restart_cap_window_minutes = 2880
stopped_retention_days = 1
`;

    await withConfig(toml, async (configPath) => {
      const failure = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));

      expect(failure).toBeInstanceOf(ConfigError);
      expect(failure.message).toMatch(/"stopped_retention_days" must cover/);
    });
  });

  test.each(['restart_cap = -1', 'restart_cap = 1.5', 'restart_cap = "many"'])(
    'refuses the unusable %s',
    async (entry) => {
      await withConfig(`[supervision]\n${entry}\n`, async (configPath) => {
        const failure = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));

        expect(failure).toBeInstanceOf(ConfigError);
        expect(failure.message).toMatch(/"restart_cap" must be an integer of 0 or more/);
      });
    },
  );

  test('refuses a supervision value that is not a table', async () => {
    await withConfig('supervision = 30\n', async (configPath) => {
      const failure = await rejection(loadConfig({ CCRC_CONFIG: configPath }, '/home/tester'));

      expect(failure.message).toMatch(/"supervision" must be a \[supervision] table/);
    });
  });
});
