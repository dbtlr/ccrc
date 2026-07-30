import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { configPathFrom, findRepo, loadConfig, stateFilePath } from '../src/config.ts';
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

  test('falls back to the XDG-style path when CCRC_CONFIG is unset', () => {
    expect(configPathFrom({}, '/home/tester')).toBe('/home/tester/.config/ccrc/config.toml');
  });
});
