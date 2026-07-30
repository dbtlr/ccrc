import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandResult, CommandRunner } from '../src/adapter/claude.ts';
import { createWorkspaceAdapter } from '../src/adapter/workspaces.ts';
import type { WorkspaceAdapter } from '../src/adapter/workspaces.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { BadRequestError, ConflictError, NotFoundError, WorkspaceError } from '../src/errors.ts';
import { createRepoRegistry, createWorkspaceService } from '../src/workspaces.ts';
import { capturingLogger, failed, ok, rejection, withTempDir } from './support.ts';
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
  options: {
    readonly configToml?: string;
    readonly git?: 'ok' | 'init-fails';
    readonly run?: CommandRunner;
  } = {},
): Promise<Harness> => {
  const root = join(dir, 'workspaces');
  const configPath = join(dir, 'config.toml');
  await Bun.write(configPath, options.configToml ?? configWithRoot(root));
  const config = await loadConfig({ CCRC_CONFIG: configPath }, join(dir, 'home'));
  const calls: string[][] = [];
  /** Stands in for git closely enough to matter: `init` leaves a `.git` behind. */
  const run: CommandRunner = async (argv) => {
    calls.push([...argv]);
    if (argv.includes('init')) {
      if (options.git === 'init-fails') {
        return failed('fatal: could not create leading directories');
      }
      await mkdir(join(argv[2] ?? '', '.git'), { recursive: true });
    }
    return ok();
  };
  const log = capturingLogger();
  return {
    adapter: createWorkspaceAdapter({ logger: log.logger, run: options.run ?? run }),
    config,
    gitCalls: () => calls,
    log,
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
      // A link to a real directory outside the root — the case that matters, since a
      // link to nothing is excluded whether or not symlinks are followed. Launching
      // this would run bypassPermissions somewhere the operator never exposed.
      await mkdir(join(dir, 'elsewhere'));
      await symlink(join(dir, 'elsewhere'), join(harnessed.root, 'linked'));

      const registry = createRepoRegistry({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      expect((await registry.list()).repos.map((entry) => entry.name)).toEqual([
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

      expect((await registry.list()).repos.map((entry) => entry.name)).toEqual(['example']);
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

      expect((await registry.list()).repos.map((entry) => entry.name)).toEqual(['example']);
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

      expect((await registry.list()).repos).toEqual([{ name: 'example', path: '/repos/example' }]);
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

  test('reports a root it cannot read rather than answering with a short list', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      // A file where the root should be: readdir answers ENOTDIR, not ENOENT.
      await writeFile(harnessed.root, 'not a directory\n');
      const registry = createRepoRegistry({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      // The configured repos are known whatever the filesystem is doing, so they are
      // still offered — with the half that could not be read named rather than
      // quietly missing.
      expect(await registry.list()).toEqual({
        repos: [{ name: 'example', path: '/repos/example' }],
        workspacesUnavailable: true,
      });
      expect(harnessed.log.errors.join('')).toMatch(/could not scan the workspaces root/);

      // A configured repo still resolves: nothing about it depends on the scan.
      expect((await registry.find('example'))?.path).toBe('/repos/example');
      // Any other name is indeterminate, not absent.
      const lookup = await rejection(registry.find('maybe'));
      expect(lookup).toBeInstanceOf(WorkspaceError);
    });
  });
});

describe('staging hygiene', () => {
  test('checks that a discarded staging directory actually went, and retries', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'workspaces');
      const staging = join(root, '.doomed.creating-abcd1234');
      await mkdir(join(staging, '.git'), { recursive: true });
      // A removal that does not remove: under load `rm` has been seen to resolve with
      // the directory still on disk, and a read-only parent reproduces the shape of
      // that — the call fails to take effect, and nothing notices.
      await chmod(root, 0o500);
      const log = capturingLogger();
      const adapter = createWorkspaceAdapter({
        logger: log.logger,
        run: () => Promise.resolve(ok()),
        // The wait between attempts is where the obstruction clears.
        sleep: async () => {
          await chmod(root, 0o700);
        },
      });

      await adapter.discard(staging);

      expect(await readdir(root)).toEqual([]);
    });
  });

  test('reports a staging directory it could not remove at all', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'workspaces');
      const staging = join(root, '.stuck.creating-abcd1234');
      await mkdir(staging, { recursive: true });
      await chmod(root, 0o500);
      const log = capturingLogger();
      const adapter = createWorkspaceAdapter({
        logger: log.logger,
        run: () => Promise.resolve(ok()),
        sleep: () => Promise.resolve(),
      });

      try {
        await adapter.discard(staging);

        expect(log.errors.join('')).toMatch(/could not remove the staging directory/);
      } finally {
        await chmod(root, 0o700);
      }
    });
  });

  test('sweeps stale staging directories at startup and leaves everything else', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      // What a crash mid-creation leaves behind, beside things that must not be touched.
      await mkdir(join(harnessed.root, '.old.creating-abcd1234', '.git'), { recursive: true });
      await mkdir(join(harnessed.root, '.newer.creating-00ff99aa'), { recursive: true });
      await mkdir(join(harnessed.root, 'keeper'), { recursive: true });
      await mkdir(join(harnessed.root, '.config'), { recursive: true });
      await writeFile(join(harnessed.root, '.env'), 'SECRET=1\n');
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      expect(await service.sweepStaging()).toBe(2);

      expect((await readdir(harnessed.root)).toSorted()).toEqual(['.config', '.env', 'keeper']);
      expect(harnessed.log.info.join('')).toMatch(/2 unfinished workspace/);
    });
  });

  test('sweeps nothing, and says nothing, when there is no root or nothing stale', async () => {
    await withTempDir(async (dir) => {
      const withoutRoot = await harness(dir, {
        configToml: '[[repos]]\nname = "example"\npath = "/repos/example"\n',
      });
      const harnessed = await harness(dir);
      await mkdir(join(harnessed.root, 'keeper'), { recursive: true });

      const unconfigured = createWorkspaceService({
        adapter: withoutRoot.adapter,
        config: withoutRoot.config,
        logger: withoutRoot.log.logger,
      });
      const configured = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      expect(await unconfigured.sweepStaging()).toBe(0);
      expect(await configured.sweepStaging()).toBe(0);
      expect(harnessed.log.info).toEqual([]);
      expect(await readdir(harnessed.root)).toEqual(['keeper']);
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
      // git ran somewhere else entirely: the final name only ever holds a finished
      // workspace, so the scan cannot offer a half-made one.
      const [init, commit] = harnessed.gitCalls();
      const staged = init?.[2] ?? '';
      expect(staged).toMatch(/\/\.new-idea\.creating-[\da-f]{8}$/);
      expect(init).toEqual(['git', '-C', staged, 'init', '-q']);
      expect(commit).toEqual([
        'git',
        '-C',
        staged,
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

      expect((await registry.list()).repos.map((entry) => entry.name)).toEqual([
        'example',
        'first',
      ]);
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

  test('answers one winner and conflicts for the rest when creates race', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const outcomes = await Promise.allSettled(
        Array.from({ length: 4 }, () => service.create('contested')),
      );

      const created = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(created).toHaveLength(1);
      expect(refused).toHaveLength(3);
      // Losing a race is the same answer as asking for a name that is already taken.
      for (const outcome of refused) {
        expect(outcome.reason).toBeInstanceOf(ConflictError);
      }
      expect(await readdir(harnessed.root)).toEqual(['contested']);
    });
  });

  test('treats a dangling symlink at the name as taken', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await mkdir(harnessed.root, { recursive: true });
      // A link to nothing: following it says "no such file", but the name is in use
      // and `mkdir` will refuse it every time.
      await symlink(join(dir, 'gone'), join(harnessed.root, 'ghost'));
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const failure = await rejection(service.create('ghost'));

      expect(failure).toBeInstanceOf(ConflictError);
      expect(harnessed.gitCalls()).toEqual([]);
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

  test('creates inside a symlinked root, resolving through the link', async () => {
    await withTempDir(async (dir) => {
      // The root the operator configured is a link; everything real lives elsewhere.
      const real = join(dir, 'real-workspaces');
      await mkdir(real);
      await symlink(real, join(dir, 'linked-root'));
      const harnessed = await harness(dir, {
        configToml: `workspaces_root = "${join(dir, 'linked-root')}"\n`,
      });
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const created = await service.create('through-link');

      // Containment is judged against the root's real path, so the link is followed
      // once and the workspace lands in the directory it actually names.
      expect(created.path).toBe(join(await realpath(real), 'through-link'));
      expect(await readdir(real)).toEqual(['through-link']);
    });
  });

  test('does not offer a half-made workspace to the scan', async () => {
    await withTempDir(async (dir) => {
      // `git init` hangs: the window in which a directory exists but is not yet a
      // workspace. Anything the scan lists in that window is launchable, and a
      // failure would then delete the working directory of a live session.
      const initialising = Promise.withResolvers<CommandResult>();
      const harnessed = await harness(dir, {
        run: (argv) => (argv.includes('init') ? initialising.promise : Promise.resolve(ok())),
      });
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

      const creating = service.create('slow');
      await Bun.sleep(1);

      expect((await registry.list()).repos.map((entry) => entry.name)).toEqual(['example']);
      // It is staged under a name the scan skips, not under the name it will have.
      const staged = await readdir(harnessed.root);
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatch(/^\.slow\.creating-/);

      initialising.resolve(ok());
      await creating;

      expect((await registry.list()).repos.map((entry) => entry.name)).toEqual(['example', 'slow']);
      expect(await readdir(harnessed.root)).toEqual(['slow']);
    });
  });

  test('leaves nothing under the root when git fails', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, { git: 'init-fails' });
      const service = createWorkspaceService({
        adapter: harnessed.adapter,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      const failure = await rejection(service.create('doomed'));

      expect(failure).toBeInstanceOf(WorkspaceError);
      // No staging left, and above all nothing at the name a launch would accept.
      expect(await readdir(harnessed.root)).toEqual([]);
    });
  });

  test('discards the staging directory whatever landed in it', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, { git: 'init-fails' });
      // Staging was never launchable, so unlike a real workspace there is nothing to
      // be careful about: it goes, contents and all.
      const messy: WorkspaceAdapter = {
        ...harnessed.adapter,
        initRepo: async (path) => {
          await writeFile(join(path, 'half-written.md'), 'partial\n');
          await harnessed.adapter.initRepo(path);
        },
      };
      const service = createWorkspaceService({
        adapter: messy,
        config: harnessed.config,
        logger: harnessed.log.logger,
      });

      await rejection(service.create('messy'));

      expect(await readdir(harnessed.root)).toEqual([]);
    });
  });
});
