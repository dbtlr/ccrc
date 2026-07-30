import { describe, expect, test } from 'bun:test';
import { mkdir, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createWorkspaceAdapter } from '../src/adapter/workspaces.ts';
import type { WorkspaceAdapter } from '../src/adapter/workspaces.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { BadRequestError, ConflictError, NotFoundError, WorkspaceError } from '../src/errors.ts';
import { createRepoRegistry, createWorkspaceService } from '../src/workspaces.ts';
import { capturingLogger, failed, ok, recordingRunner, rejection, withTempDir } from './support.ts';
import type { CapturedLog } from './support.ts';

const configWithRoot = (root: string): string => `workspaces_root = "${root}"

[[repos]]
name = "example"
path = "/repos/example"
`;

type Harness = {
  readonly config: Config;
  readonly adapter: WorkspaceAdapter;
  readonly log: CapturedLog;
  readonly root: string;
  readonly gitCalls: () => string[][];
};

/**
 * Real directories and a recorded `git` — the filesystem half of this module is the
 * behaviour under test, and the command half is asserted on argv rather than run.
 */
const harness = async (
  dir: string,
  options: { readonly configToml?: string; readonly git?: 'ok' | 'init-fails' } = {},
): Promise<Harness> => {
  const root = join(dir, 'workspaces');
  const configPath = join(dir, 'config.toml');
  await Bun.write(configPath, options.configToml ?? configWithRoot(root));
  const config = await loadConfig({ CCRC_CONFIG: configPath }, join(dir, 'home'));
  const recording = recordingRunner((argv) =>
    options.git === 'init-fails' && argv.includes('init')
      ? failed('fatal: could not create leading directories')
      : ok(),
  );
  return {
    adapter: createWorkspaceAdapter({ run: recording.run }),
    config,
    gitCalls: () => recording.calls,
    log: capturingLogger(),
    root,
  };
};

describe('workspace scan', () => {
  test('lists only the real directories directly under the root', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await mkdir(join(harnessed.root, 'beta', 'nested'), { recursive: true });
      await mkdir(join(harnessed.root, 'alpha'));
      await mkdir(join(harnessed.root, '.hidden'));
      await writeFile(join(harnessed.root, 'notes.txt'), 'not a workspace\n');
      // A link is how a directory outside the root would become launchable.
      await symlink(join(dir, 'elsewhere'), join(harnessed.root, 'linked'));

      const registry = createRepoRegistry({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      expect((await registry.list()).map((entry) => entry.name)).toEqual([
        'example',
        'alpha',
        'beta',
      ]);
    });
  });

  test('is empty, not an error, when the root does not exist yet', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const registry = createRepoRegistry({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      expect((await registry.list()).map((entry) => entry.name)).toEqual(['example']);
      expect(harnessed.log.errors).toEqual([]);
    });
  });

  test('does not scan at all when no root is configured', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, {
        configToml: '[[repos]]\nname = "example"\npath = "/repos/example"\n',
      });

      const registry = createRepoRegistry({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      expect((await registry.list()).map((entry) => entry.name)).toEqual(['example']);
      expect(await registry.find('anything')).toBeUndefined();
    });
  });

  test('keeps the configured repo on a name collision and says so once', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await mkdir(join(harnessed.root, 'example'), { recursive: true });

      const registry = createRepoRegistry({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      expect(await registry.list()).toEqual([{ name: 'example', path: '/repos/example' }]);
      expect((await registry.find('example'))?.path).toBe('/repos/example');
      await registry.list();
      await registry.list();
      expect(harnessed.log.info).toHaveLength(1);
      expect(harnessed.log.info[0]).toMatch(/shadowed by it/);
    });
  });

  test('resolves a scanned workspace to its path under the root', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await mkdir(join(harnessed.root, 'notes'), { recursive: true });

      const registry = createRepoRegistry({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      expect(await registry.find('notes')).toEqual({
        name: 'notes',
        path: join(harnessed.root, 'notes'),
      });
      expect(await registry.find('absent')).toBeUndefined();
    });
  });

  test('serves the configured repos when the root cannot be read', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      // A file where the root should be: readdir answers ENOTDIR, not ENOENT.
      await writeFile(harnessed.root, 'not a directory\n');

      const registry = createRepoRegistry({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      expect((await registry.list()).map((entry) => entry.name)).toEqual(['example']);
      expect(harnessed.log.errors.join('')).toMatch(/could not scan the workspaces root/);
    });
  });
});

describe('workspace creation', () => {
  test('creates the directory, initialises git, and leaves one empty commit', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const created = await service.create('new-idea');

      // The path is the resolved one: containment is checked against the root's real
      // path, so that is what the creation can honestly report.
      expect(created).toEqual({
        name: 'new-idea',
        path: join(await realpath(harnessed.root), 'new-idea'),
      });
      expect(await readdir(harnessed.root)).toEqual(['new-idea']);
      const [init, commit] = harnessed.gitCalls();
      expect(init).toEqual(['git', '-C', created.path, 'init', '-q']);
      expect(commit).toEqual([
        'git',
        '-C',
        created.path,
        '-c',
        'user.name=ccrcd',
        '-c',
        'user.email=ccrcd@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-q',
        '-m',
        'chore: initialize workspace',
      ]);
      expect(harnessed.log.info.join('')).toMatch(/created workspace "new-idea"/);
    });
  });

  test('makes the root on first use and lists the new workspace right after', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });
      const registry = createRepoRegistry({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      await service.create('first');

      expect((await registry.list()).map((entry) => entry.name)).toEqual(['example', 'first']);
    });
  });

  test('refuses when no workspaces root is configured', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, {
        configToml: '[[repos]]\nname = "example"\npath = "/repos/example"\n',
      });
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const failure = await rejection(service.create('anything'));

      expect(failure).toBeInstanceOf(NotFoundError);
      expect(failure.message).toMatch(/no workspaces root configured/);
    });
  });

  test.each([
    '',
    '.',
    '..',
    '../escape',
    'nested/name',
    String.raw`nested\name`,
    '.hidden',
    'a..b',
    'has space',
    'trailing/',
    '/absolute',
    'name\0nul',
    'x'.repeat(65),
  ])('refuses the name %p', async (name) => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const failure = await rejection(service.create(name));

      expect(failure).toBeInstanceOf(BadRequestError);
      // Nothing was created, and nothing was even attempted.
      expect(harnessed.gitCalls()).toEqual([]);
      expect(await readdir(dir)).not.toContain('workspaces');
    });
  });

  test.each(['ok', 'with-dash', 'with_underscore', 'with.dot', 'v2'])(
    'accepts the ordinary name %p',
    async (name) => {
      await withTempDir(async (dir) => {
        const harnessed = await harness(dir);
        const service = createWorkspaceService({
          adapter: harnessed.adapter,
          config: harnessed.config,
          logger: harnessed.log.logger,
        });

        expect((await service.create(name)).name).toBe(name);
      });
    },
  );

  test('refuses a name a directory under the root already has', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await mkdir(join(harnessed.root, 'taken'), { recursive: true });
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const failure = await rejection(service.create('taken'));

      expect(failure).toBeInstanceOf(ConflictError);
      expect(failure.message).toMatch(/already exists/);
    });
  });

  test('refuses a name the config registry already has', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const failure = await rejection(service.create('example'));

      expect(failure).toBeInstanceOf(ConflictError);
      expect(failure.message).toMatch(/already a configured repo name/);
      // The config repo lives elsewhere entirely; nothing was made under the root.
      expect(await readdir(harnessed.root).catch(() => [])).toEqual([]);
    });
  });

  test('removes the directory it made when git cannot initialise it', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, { git: 'init-fails' });
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const failure = await rejection(service.create('doomed'));

      expect(failure).toBeInstanceOf(WorkspaceError);
      expect(failure.message).toMatch(/git could not initialise/);
      // A directory left behind would be launchable on the next scan.
      expect(await readdir(harnessed.root)).toEqual([]);
      expect(harnessed.log.errors.join('')).toMatch(/removed the directory it had made/);
    });
  });

  test('keeps a directory that turned out to hold something', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, { git: 'init-fails' });
      // Something of the operator's lands in the new directory before the failure —
      // deleting it to tidy up would be the worse mistake.
      const busy: WorkspaceAdapter = {
        ...harnessed.adapter,
        initRepo: async (path) => {
          await writeFile(join(path, 'notes.md'), 'work in progress\n');
          await harnessed.adapter.initRepo(path);
        },
      };
      const service = createWorkspaceService({
        adapter: busy,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const failure = await rejection(service.create('busy'));

      expect(failure).toBeInstanceOf(WorkspaceError);
      expect(await readdir(join(harnessed.root, 'busy'))).toEqual(['notes.md']);
      expect(harnessed.log.errors.join('')).toMatch(/left the directory in place/);
    });
  });
});
