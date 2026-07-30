import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { createWorkspaceAdapter } from '../src/adapter/workspaces.ts';
import { loadConfig, stateFilePath } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { LaunchError, LivenessError, StopError } from '../src/errors.ts';
import { createHealthService } from '../src/health.ts';
import { createApp } from '../src/http/app.ts';
import { createSessionService } from '../src/sessions.ts';
import type { SessionService } from '../src/sessions.ts';
import { createStateStore } from '../src/state.ts';
import { createRepoRegistry, createWorkspaceService } from '../src/workspaces.ts';
import {
  capturingLogger,
  fakeAdapter,
  hostSession,
  ok,
  recordingRunner,
  withTempDir,
} from './support.ts';
import type { CapturedLog, FakeAdapter } from './support.ts';

const CONFIG_TOML = `bind = "127.0.0.1"
port = 7433
allowed_origins = ["https://ccrc.example", "http://ccrc.example:8443"]

[[repos]]
name = "example"
path = "/repos/example"

[[repos]]
name = "Side Project"
path = "/repos/side"
`;

type Harness = {
  readonly adapter: FakeAdapter;
  readonly app: ReturnType<typeof createApp>;
  readonly config: Config;
  readonly statePath: string;
  readonly log: CapturedLog;
  readonly service: SessionService;
  /** Moves the service's clock, for the windows reconciliation measures in time. */
  readonly at: (ms: number) => void;
  /** The git commands the workspace creation ran, if any. */
  readonly gitCalls: () => string[][];
};

let sequence = 0;

const harness = async (dir: string, configToml: string = CONFIG_TOML): Promise<Harness> => {
  const configPath = join(dir, 'config.toml');
  await Bun.write(configPath, configToml);
  const config = await loadConfig({ CCRC_CONFIG: configPath }, join(dir, 'home'));
  const adapter = fakeAdapter();
  const statePath = stateFilePath(config);
  const log = capturingLogger();
  let current = 1_764_000_000_000;
  const git = recordingRunner(() => ok());
  const workspaceAdapter = createWorkspaceAdapter({ logger: log.logger, run: git.run });
  const registry = createRepoRegistry({ adapter: workspaceAdapter, config, logger: log.logger });
  const service = createSessionService({
    adapter,
    config,
    generateId: () => {
      sequence += 1;
      return `id${sequence}`;
    },
    host: 'test-host',
    logger: log.logger,
    now: () => current,
    registry,
    store: createStateStore(statePath),
  });
  return {
    adapter,
    app: createApp(service, {
      allowedOrigins: config.allowedOrigins,
      health: createHealthService({ adapter, logger: log.logger, statePath }),
      logger: log.logger,
      port: config.port,
      // Wired only when the config names a root, exactly as `main` does.
      ...(config.workspacesRoot === null
        ? {}
        : {
            workspaces: createWorkspaceService({
              adapter: workspaceAdapter,
              config,
              logger: log.logger,
            }),
          }),
    }),
    at: (ms) => {
      current = ms;
    },
    config,
    gitCalls: () => git.calls,
    log,
    service,
    statePath,
  };
};

const postSession = async (harnessed: Harness, body: unknown): Promise<Response> =>
  harnessed.app.request('/sessions', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

/** A launch request with caller-chosen headers — the CSRF surface. */
const bodyOnly = async (harnessed: Harness, headers: Record<string, string>): Promise<Response> =>
  harnessed.app.request('/sessions', {
    body: JSON.stringify({ repo: 'example' }),
    headers,
    method: 'POST',
  });

beforeEach(() => {
  sequence = 0;
});

describe('healthz', () => {
  test('answers ok once every dependency has answered', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await harnessed.app.request('/healthz');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        checks: { claude: 'ok', state: 'ok', tmux: 'ok' },
        ok: true,
      });
    });
  });

  test('answers 503 naming the dependency that is unwell', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.tmuxHealthFailure = new Error('error connecting to the tmux server');

      const response = await harnessed.app.request('/healthz');

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        checks: { claude: 'ok', state: 'ok', tmux: 'failed' },
        ok: false,
      });
      // Why it failed stays in the log rather than on the wire.
      expect(harnessed.log.errors.join('')).toMatch(/health check "tmux" failed/);
    });
  });

  test('answers for the process alone when no probes are wired', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      const bare = createApp(harnessed.service);

      const response = await bare.request('/healthz');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ checks: {}, ok: true });
    });
  });

  test('stays a plain GET, with no origin or content-type gate', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await harnessed.app.request('/healthz', {
        headers: { origin: 'https://stranger.example' },
      });

      expect(response.status).toBe(200);
    });
  });
});

/**
 * A config with a workspaces root. The key goes above the `[[repos]]` tables: in
 * TOML a top-level key written after an array-of-tables header belongs to that
 * table, not to the document.
 */
const withWorkspaces = (root: string): string => `workspaces_root = "${root}"\n${CONFIG_TOML}`;

const postWorkspace = async (harnessed: Harness, body: unknown): Promise<Response> =>
  harnessed.app.request('/workspaces', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

describe('workspace creation', () => {
  test('creates a workspace and answers with its name and path', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'workspaces');
      const harnessed = await harness(dir, withWorkspaces(root));

      const response = await postWorkspace(harnessed, { name: 'new-idea' });

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        name: 'new-idea',
        path: join(await realpath(root), 'new-idea'),
      });
      expect(harnessed.gitCalls().map((argv) => argv[1])).toEqual(['-C', '-C']);
    });
  });

  test('the new workspace is launchable immediately, by name', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'workspaces');
      const harnessed = await harness(dir, withWorkspaces(root));
      await postWorkspace(harnessed, { name: 'new-idea' });

      const listed = (await (await harnessed.app.request('/repos')).json()) as {
        repos: { name: string }[];
      };
      const launched = await postSession(harnessed, { repo: 'new-idea' });

      expect(listed.repos.map((repo) => repo.name)).toEqual([
        'example',
        'Side Project',
        'new-idea',
      ]);
      expect(launched.status).toBe(201);
      // The session runs in the workspace, not somewhere a name happened to resolve.
      expect(harnessed.adapter.launches[0]?.repoPath).toBe(join(root, 'new-idea'));
    });
  });

  test.each(['../etc', 'scanned/../../etc', '.hidden', 'absent'])(
    'refuses to launch the unlisted name %p',
    async (repo) => {
      await withTempDir(async (dir) => {
        const root = join(dir, 'workspaces');
        await mkdir(join(root, 'scanned'), { recursive: true });
        await mkdir(join(root, '.hidden'), { recursive: true });
        const harnessed = await harness(dir, withWorkspaces(root));

        const response = await postSession(harnessed, { repo });

        expect(response.status).toBe(404);
        expect(harnessed.adapter.launches).toEqual([]);
      });
    },
  );

  test('answers 404 when no workspaces root is configured', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await postWorkspace(harnessed, { name: 'new-idea' });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: expect.stringContaining('workspaces_root'),
      });
    });
  });

  test('answers 409 for a name that is already taken', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, withWorkspaces(join(dir, 'workspaces')));
      await postWorkspace(harnessed, { name: 'twice' });

      const again = await postWorkspace(harnessed, { name: 'twice' });
      const configured = await postWorkspace(harnessed, { name: 'example' });

      expect(again.status).toBe(409);
      expect(configured.status).toBe(409);
    });
  });

  test.each([{ name: '../escape' }, { name: 'nested/name' }, { name: '' }, { name: 7 }, {}])(
    'answers 400 for the body %p',
    async (body) => {
      await withTempDir(async (dir) => {
        const harnessed = await harness(dir, withWorkspaces(join(dir, 'workspaces')));

        const response = await postWorkspace(harnessed, body);

        expect(response.status).toBe(400);
        expect(harnessed.gitCalls()).toEqual([]);
      });
    },
  );

  test('is held to the same gates as a launch', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, withWorkspaces(join(dir, 'workspaces')));

      const formLike = await harnessed.app.request('/workspaces', {
        body: JSON.stringify({ name: 'sneaky' }),
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        method: 'POST',
      });
      const crossOrigin = await harnessed.app.request('/workspaces', {
        body: JSON.stringify({ name: 'sneaky' }),
        headers: { 'content-type': 'application/json', origin: 'https://stranger.example' },
        method: 'POST',
      });
      const crossSite = await harnessed.app.request('/workspaces', {
        body: JSON.stringify({ name: 'sneaky' }),
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        method: 'POST',
      });

      expect(formLike.status).toBe(415);
      expect(crossOrigin.status).toBe(403);
      expect(crossSite.status).toBe(403);
      expect(harnessed.gitCalls()).toEqual([]);
    });
  });

  test('an allowed origin may create workspaces, like it may launch', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, withWorkspaces(join(dir, 'workspaces')));

      const response = await harnessed.app.request('/workspaces', {
        body: JSON.stringify({ name: 'from-proxy' }),
        headers: { 'content-type': 'application/json', origin: 'https://ccrc.example' },
        method: 'POST',
      });

      expect(response.status).toBe(201);
    });
  });
});

describe('repo registry', () => {
  test('lists the registry names the console can launch', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await harnessed.app.request('/repos');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        repos: [{ name: 'example' }, { name: 'Side Project' }],
        workspacesUnavailable: false,
      });
    });
  });

  test('lists workspaces found under the root alongside the configured repos', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'workspaces');
      await mkdir(join(root, 'scanned'), { recursive: true });
      await mkdir(join(root, '.hidden'), { recursive: true });
      const harnessed = await harness(dir, withWorkspaces(root));

      const response = await harnessed.app.request('/repos');

      expect(await response.json()).toEqual({
        repos: [{ name: 'example' }, { name: 'Side Project' }, { name: 'scanned' }],
        workspacesUnavailable: false,
      });
    });
  });

  test('lists what it still knows, and says so, when the root cannot be read', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'workspaces');
      // A file where the root should be: the scan cannot say what is launchable.
      await Bun.write(root, 'not a directory\n');
      const harnessed = await harness(dir, withWorkspaces(root));

      const listed = await harnessed.app.request('/repos');

      // The configured repos are known and still launch, so they are still offered —
      // with the missing half named rather than passed off as an empty list.
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({
        repos: [{ name: 'example' }, { name: 'Side Project' }],
        workspacesUnavailable: true,
      });
    });
  });

  test('still refuses to launch an unlisted name while the root cannot be read', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'workspaces');
      await Bun.write(root, 'not a directory\n');
      const harnessed = await harness(dir, withWorkspaces(root));

      const launched = await postSession(harnessed, { repo: 'anything' });

      // Not "no such repo": the host would not say, and a launch may not guess.
      expect(launched.status).toBe(502);
      expect(harnessed.adapter.launches).toEqual([]);
    });
  });

  test('still launches a configured repo when the scan is broken', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'workspaces');
      await Bun.write(root, 'not a directory\n');
      const harnessed = await harness(dir, withWorkspaces(root));

      const launched = await postSession(harnessed, { repo: 'example' });

      expect(launched.status).toBe(201);
    });
  });

  test('does not publish where the repos live on the host', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const body = await (await harnessed.app.request('/repos')).text();

      expect(body).not.toContain('/repos/example');
    });
  });

  test('an empty registry is an empty list, not an error', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir, 'bind = "127.0.0.1"\n');

      const response = await harnessed.app.request('/repos');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ repos: [], workspacesUnavailable: false });
    });
  });
});

describe('session lifecycle', () => {
  test('launches, lists, fetches, and stops a session', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.hostSessions = [
        hostSession({
          cwd: '/repos/example',
          pid: 4242,
          startedAt: 1_764_000_000_000,
          status: 'busy',
        }),
        hostSession({ cwd: '/repos/elsewhere', pid: 9999 }),
      ];

      const created = await postSession(harnessed, { prompt: '/plan', repo: 'example' });
      expect(created.status).toBe(201);
      const session = (await created.json()) as Record<string, unknown>;
      expect(session).toMatchObject({
        activity: 'busy',
        attachUrl: 'https://claude.ai/code/session_abc123',
        host: 'test-host',
        id: 'id1',
        name: 'example-1',
        pid: 4242,
        rcName: 'ccrc-id1',
        repoName: 'example',
        status: 'running',
        tmuxName: 'ccrc-example-1',
      });
      // The configured path stays on the host, same as the registry it came from.
      expect(session.repoPath).toBeUndefined();
      expect(harnessed.adapter.launches[0]).toEqual({
        prompt: '/plan',
        rcName: 'ccrc-id1',
        repoPath: '/repos/example',
        tmuxName: 'ccrc-example-1',
      });

      const listed = await harnessed.app.request('/sessions');
      const listing = (await listed.json()) as {
        hostSessions: unknown[];
        sessions: Record<string, unknown>[];
      };
      expect(listing.sessions.length).toBe(1);
      expect(listing.sessions[0]).toMatchObject({ id: 'id1', status: 'running' });
      expect(listing.sessions[0]?.repoPath).toBeUndefined();
      // The whole host fleet rides along, ccrcd-launched or not.
      expect(listing.hostSessions.length).toBe(2);

      const fetched = await harnessed.app.request('/sessions/id1');
      expect(fetched.status).toBe(200);
      expect((await fetched.json()) as Record<string, unknown>).toMatchObject({ id: 'id1' });

      const deleted = await harnessed.app.request('/sessions/id1', { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      const stoppedBody = (await deleted.json()) as Record<string, unknown>;
      expect(stoppedBody).toMatchObject({ status: 'stopped' });
      expect(stoppedBody.repoPath).toBeUndefined();
      expect(harnessed.adapter.stopped).toEqual(['ccrc-example-1']);

      const afterStop = await harnessed.app.request('/sessions/id1');
      expect((await afterStop.json()) as Record<string, unknown>).toMatchObject({
        activity: 'unknown',
        status: 'stopped',
      });
    });
  });

  test('persists records to the state file next to the config', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await postSession(harnessed, { repo: 'example' });

      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted.length).toBe(1);
      expect(persisted[0]).toMatchObject({ id: 'id1', status: 'running' });
    });
  });

  test('numbers tmux names per repo and never reuses a retired one', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      await postSession(harnessed, { repo: 'example' });
      await harnessed.app.request('/sessions/id1', { method: 'DELETE' });
      await postSession(harnessed, { repo: 'example' });
      const sideResponse = await postSession(harnessed, { repo: 'Side Project' });

      expect(harnessed.adapter.launches.map((launch) => launch.tmuxName)).toEqual([
        'ccrc-example-1',
        'ccrc-example-2',
        'ccrc-side-project-1',
      ]);
      expect((await sideResponse.json()) as Record<string, unknown>).toMatchObject({
        name: 'Side Project-1',
      });
    });
  });

  test('adopts no pid when the repo already has an unrelated session', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      // Two claude sessions in the same repo: neither can be told apart by cwd, and
      // the older one belongs to somebody else entirely.
      harnessed.adapter.hostSessions = [
        hostSession({
          cwd: '/repos/example',
          pid: 111,
          startedAt: 1_764_000_000_000,
          status: 'busy',
        }),
        hostSession({
          cwd: '/repos/example',
          pid: 222,
          startedAt: 1_764_000_000_500,
          status: 'idle',
        }),
      ];

      const created = await postSession(harnessed, { repo: 'example' });

      expect((await created.json()) as Record<string, unknown>).toMatchObject({
        activity: 'unknown',
        pid: null,
        status: 'running',
      });
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ pid: null });
    });
  });

  test('adopts no pid from a session that started long before the record', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.hostSessions = [
        hostSession({ cwd: '/repos/example', pid: 111, startedAt: 1_763_000_000_000 }),
      ];

      const created = await postSession(harnessed, { repo: 'example' });

      expect((await created.json()) as Record<string, unknown>).toMatchObject({ pid: null });
    });
  });

  test('leaves a session another record already claims alone', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.hostSessions = [
        hostSession({ cwd: '/repos/example', pid: 4242, startedAt: 1_764_000_000_000 }),
      ];

      const first = await postSession(harnessed, { repo: 'example' });
      const second = await postSession(harnessed, { repo: 'example' });

      expect((await first.json()) as Record<string, unknown>).toMatchObject({ pid: 4242 });
      expect((await second.json()) as Record<string, unknown>).toMatchObject({ pid: null });
    });
  });

  test('marks a session stopped once its tmux session is gone', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await postSession(harnessed, { repo: 'example' });

      // Something outside ccrcd killed the tmux session, and the launch window the
      // record is granted has long since passed.
      harnessed.adapter.liveNames = [];
      harnessed.at(1_764_000_600_000);

      const listing = (await (await harnessed.app.request('/sessions')).json()) as {
        sessions: Record<string, unknown>[];
      };
      expect(listing.sessions[0]).toMatchObject({ status: 'stopped' });
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ status: 'stopped' });
    });
  });

  test('leaves records alone when tmux will not say which sessions are live', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await postSession(harnessed, { repo: 'example' });

      // tmux is reachable enough to have launched the session but refuses to list.
      harnessed.adapter.liveFailure = new LivenessError('tmux could not list its sessions');

      const listed = await harnessed.app.request('/sessions');
      expect(listed.status).toBe(200);
      const listing = (await listed.json()) as { sessions: Record<string, unknown>[] };
      expect(listing.sessions[0]).toMatchObject({ id: 'id1', status: 'running' });
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ status: 'running' });
    });
  });

  test('records a failed launch and surfaces the reason as a 502', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.attachUrl = new LaunchError('no attach URL appeared');

      const response = await postSession(harnessed, { repo: 'example' });

      expect(response.status).toBe(502);
      expect((await response.json()) as Record<string, unknown>).toEqual({
        error: 'no attach URL appeared',
      });
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ attachUrl: null, status: 'failed' });
    });
  });

  test('kills the tmux session a failed launch left behind', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      // tmux came up; the attach URL never did. The record goes to `failed`, which
      // reconciliation never revisits, so the launch has to clean up after itself.
      harnessed.adapter.attachUrl = new LaunchError('no attach URL appeared');

      const response = await postSession(harnessed, { repo: 'example' });

      expect(response.status).toBe(502);
      expect(harnessed.adapter.stopped).toEqual(['ccrc-example-1']);
      expect(harnessed.adapter.liveNames).toEqual([]);
    });
  });

  test('a teardown that also fails does not mask the launch failure', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.attachUrl = new LaunchError('no attach URL appeared');
      harnessed.adapter.stopOutcome = new StopError('tmux could not kill session ccrc-example-1');

      const response = await postSession(harnessed, { repo: 'example' });

      expect(response.status).toBe(502);
      expect((await response.json()) as Record<string, unknown>).toEqual({
        error: 'no attach URL appeared',
      });
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ status: 'failed' });
    });
  });

  test('an unexpected failure is a generic 500 that leaks nothing', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.attachUrl = new TypeError(
        'Invalid argument: claude --permission-mode bypassPermissions /Users/someone/secret',
      );

      const response = await postSession(harnessed, { repo: 'example' });

      expect(response.status).toBe(500);
      expect((await response.json()) as Record<string, unknown>).toEqual({
        error: 'internal error',
      });
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ status: 'failed' });
    });
  });

  test('a kill tmux refused leaves the record active and answers 502', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await postSession(harnessed, { repo: 'example' });
      harnessed.adapter.stopOutcome = new StopError('tmux could not kill session ccrc-example-1');

      const response = await harnessed.app.request('/sessions/id1', { method: 'DELETE' });

      expect(response.status).toBe(502);
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ status: 'running' });
    });
  });

  test('a session tmux has already lost still stops cleanly', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await postSession(harnessed, { repo: 'example' });
      harnessed.adapter.stopOutcome = 'absent';

      const response = await harnessed.app.request('/sessions/id1', { method: 'DELETE' });

      expect(response.status).toBe(200);
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ status: 'stopped' });
    });
  });
});

describe('concurrency', () => {
  test('a launch that lands during a listing is not lost', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await postSession(harnessed, { repo: 'example' });

      // GET /sessions shells out to the claude CLI; hold it there while a launch
      // completes, the window that used to drop the new record entirely.
      const gate = Promise.withResolvers<void>();
      harnessed.adapter.listDelay = () => gate.promise;
      const listing = harnessed.app.request('/sessions');
      await Bun.sleep(1);
      harnessed.adapter.listDelay = () => Promise.resolve();

      const created = await postSession(harnessed, { repo: 'example' });
      expect(created.status).toBe(201);
      gate.resolve();
      const listed = (await (await listing).json()) as { sessions: Record<string, unknown>[] };

      expect(listed.sessions.map((session) => session.id)).toEqual(['id1', 'id2']);
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted.map((record) => record.id)).toEqual(['id1', 'id2']);
      // The symptom of the lost record: the returned id 404s and the session orphans.
      expect((await harnessed.app.request('/sessions/id2', { method: 'DELETE' })).status).toBe(200);
    });
  });

  test("a stop that overlaps a settling launch keeps the launch's attach URL and pid", async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.hostSessions = [
        hostSession({ cwd: '/repos/example', pid: 4242, startedAt: 1_764_000_000_000 }),
      ];

      // Hold the launch just before it settles, so DELETE reads the record while it
      // is still `starting` with no attach URL and no pid.
      const settling = Promise.withResolvers<void>();
      harnessed.adapter.listDelay = () => settling.promise;
      const launch = postSession(harnessed, { repo: 'example' });
      await Bun.sleep(1);
      harnessed.adapter.listDelay = () => Promise.resolve();

      // Hold the kill too, then let the launch settle while the kill is in flight.
      const killing = Promise.withResolvers<void>();
      harnessed.adapter.stopDelay = () => killing.promise;
      const deleted = harnessed.app.request('/sessions/id1', { method: 'DELETE' });
      await Bun.sleep(1);
      settling.resolve();
      expect((await launch).status).toBe(201);
      killing.resolve();

      expect((await deleted).status).toBe(200);
      // The kill's own pre-await snapshot would have reverted both of these to null.
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({
        attachUrl: 'https://claude.ai/code/session_abc123',
        pid: 4242,
        status: 'stopped',
      });
    });
  });

  test('a stop that completes before a launch settles is never undone by it', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.hostSessions = [
        hostSession({ cwd: '/repos/example', pid: 4242, startedAt: 1_764_000_000_000 }),
      ];

      // Hold the launch just before it settles.
      const settling = Promise.withResolvers<void>();
      harnessed.adapter.listDelay = () => settling.promise;
      const launch = postSession(harnessed, { repo: 'example' });
      await Bun.sleep(1);
      harnessed.adapter.listDelay = () => Promise.resolve();

      // The stop runs to completion first: tmux is killed and the record is stopped.
      expect((await harnessed.app.request('/sessions/id1', { method: 'DELETE' })).status).toBe(200);
      settling.resolve();
      await launch;

      // The settle may not resurrect the record: the tmux session is already dead,
      // so a `running` record here is a phantom nothing can stop.
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ endedAt: 1_764_000_000_000, status: 'stopped' });
      const listed = (await (await harnessed.app.request('/sessions/id1')).json()) as Record<
        string,
        unknown
      >;
      expect(listed.status).toBe('stopped');
    });
  });

  test('a launch that fails after a stop leaves the stop standing', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.attachUrl = new LaunchError('no attach URL appeared');

      const settling = Promise.withResolvers<void>();
      harnessed.adapter.stopDelay = () => settling.promise;
      const launch = postSession(harnessed, { repo: 'example' });
      await Bun.sleep(1);
      const deleted = harnessed.app.request('/sessions/id1', { method: 'DELETE' });
      await Bun.sleep(1);
      settling.resolve();
      await Promise.all([launch, deleted]);

      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ endedAt: 1_764_000_000_000, status: 'stopped' });
    });
  });

  test('concurrent launches each get their own tmux name and record', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const responses = await Promise.all([
        postSession(harnessed, { repo: 'example' }),
        postSession(harnessed, { repo: 'example' }),
        postSession(harnessed, { repo: 'example' }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
      expect(harnessed.adapter.launches.map((launch) => launch.tmuxName).toSorted()).toEqual([
        'ccrc-example-1',
        'ccrc-example-2',
        'ccrc-example-3',
      ]);
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted.length).toBe(3);
      expect(new Set(persisted.map((record) => record.tmuxName)).size).toBe(3);
      expect(persisted.every((record) => record.status === 'running')).toBe(true);
    });
  });
});

describe('cross-origin defence', () => {
  test('a body not declared as JSON is a 415', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      // The content types a cross-origin page can set without a preflight.
      expect((await bodyOnly(harnessed, { 'content-type': 'text/plain' })).status).toBe(415);
      expect(
        (await bodyOnly(harnessed, { 'content-type': 'application/x-www-form-urlencoded' })).status,
      ).toBe(415);
      expect((await bodyOnly(harnessed, { 'content-type': 'multipart/form-data' })).status).toBe(
        415,
      );
      expect((await bodyOnly(harnessed, {})).status).toBe(415);
      expect(harnessed.adapter.launches).toEqual([]);
    });
  });

  test('a charset parameter on application/json is still accepted', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await bodyOnly(harnessed, {
        'content-type': 'Application/JSON; charset=utf-8',
      });

      expect(response.status).toBe(201);
    });
  });

  test('a cross-origin or cross-site mutation is a 403', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const foreignOrigin = await bodyOnly(harnessed, {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      });
      expect(foreignOrigin.status).toBe(403);

      const crossSite = await bodyOnly(harnessed, {
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
      });
      expect(crossSite.status).toBe(403);

      const foreignDelete = await harnessed.app.request('/sessions/id1', {
        headers: { origin: 'https://evil.example' },
        method: 'DELETE',
      });
      expect(foreignDelete.status).toBe(403);

      expect(harnessed.adapter.launches).toEqual([]);
      expect(harnessed.adapter.stopped).toEqual([]);
    });
  });

  test('a configured origin may drive a mutation', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const launched = await bodyOnly(harnessed, {
        'content-type': 'application/json',
        origin: 'https://ccrc.example',
        'sec-fetch-site': 'same-origin',
      });
      expect(launched.status).toBe(201);

      const deleted = await harnessed.app.request('/sessions/id1', {
        headers: { origin: 'http://ccrc.example:8443' },
        method: 'DELETE',
      });
      expect(deleted.status).toBe(200);
    });
  });

  // The allow-list is exact strings, so every way of nearly being one is a stranger.
  test.each([
    'http://ccrc.example',
    'https://ccrc.example:8443',
    'https://ccrc.example.evil',
    'https://evil.ccrc.example',
    'https://ccrc.exampl',
    'https://ccrc.example/',
    'https://ccrc.example/sessions',
    'HTTPS://CCRC.EXAMPLE',
    'null',
  ])('the near-miss origin %s is still a 403', async (origin) => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await bodyOnly(harnessed, {
        'content-type': 'application/json',
        origin,
      });

      expect(response.status).toBe(403);
      expect(harnessed.adapter.launches).toEqual([]);
    });
  });

  test('an empty allow-list refuses a foreign origin outright', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(
        dir,
        'bind = "127.0.0.1"\n\n[[repos]]\nname = "example"\npath = "/repos/example"\n',
      );
      expect(harnessed.config.allowedOrigins).toEqual([]);

      const response = await bodyOnly(harnessed, {
        'content-type': 'application/json',
        origin: 'https://ccrc.example',
      });

      expect(response.status).toBe(403);
      expect(harnessed.adapter.launches).toEqual([]);
    });
  });

  test('a configured origin does not excuse a cross-site request', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await bodyOnly(harnessed, {
        'content-type': 'application/json',
        origin: 'https://ccrc.example',
        'sec-fetch-site': 'cross-site',
      });

      expect(response.status).toBe(403);
      expect(harnessed.adapter.launches).toEqual([]);
    });
  });

  test('a configured origin still has to declare a JSON body', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await bodyOnly(harnessed, {
        'content-type': 'text/plain',
        origin: 'https://ccrc.example',
      });

      expect(response.status).toBe(415);
    });
  });

  test('a same-origin request and a header-less CLI request are allowed', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      // The daemon's own origin carries the configured port. `http://localhost`
      // without one is a different origin, and is only trusted if something is
      // reading trust out of the request rather than out of the config.
      const sameOrigin = await bodyOnly(harnessed, {
        'content-type': 'application/json',
        origin: `http://localhost:${harnessed.config.port}`,
        'sec-fetch-site': 'same-origin',
      });
      expect(sameOrigin.status).toBe(201);

      const deleted = await harnessed.app.request('/sessions/id1', { method: 'DELETE' });
      expect(deleted.status).toBe(200);
    });
  });

  test('a forged Host that matches a forged Origin is still refused', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      // DNS rebinding: the attacker's own hostname resolves to 127.0.0.1, so the
      // browser sends Host and Origin that agree with each other and describe a
      // same-origin request. Trust read out of the request would accept this.
      const rebound = await harnessed.app.request('http://evil.example/sessions', {
        body: JSON.stringify({ repo: 'example' }),
        headers: {
          'content-type': 'application/json',
          origin: 'http://evil.example',
          'sec-fetch-site': 'same-origin',
        },
        method: 'POST',
      });

      expect(rebound.status).toBe(403);
      expect(harnessed.adapter.launches).toHaveLength(0);
    });
  });

  test('a loopback Host on the wrong port cannot vouch for its own Origin', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      // The host check passes here — the hostname is loopback — so this isolates
      // the origin half: trust taken from the request would compare Origin against
      // this same forged authority and match it. Only the configured port is ours.
      const wrongPort = await harnessed.app.request('http://127.0.0.1:9999/sessions', {
        body: JSON.stringify({ repo: 'example' }),
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:9999',
          'sec-fetch-site': 'same-origin',
        },
        method: 'POST',
      });

      expect(wrongPort.status).toBe(403);
      expect(harnessed.adapter.launches).toHaveLength(0);
    });
  });

  test('an unrecognised Host is refused on reads as well', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      // A rebound page can read as easily as it can write, so the host check
      // cannot be limited to mutations.
      const listed = await harnessed.app.request('http://evil.example/sessions');
      expect(listed.status).toBe(403);

      const repos = await harnessed.app.request('http://evil.example/repos');
      expect(repos.status).toBe(403);
    });
  });

  test('the configured proxy host is reachable as a Host and as an Origin', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const proxied = await harnessed.app.request('https://ccrc.example/sessions', {
        body: JSON.stringify({ repo: 'example' }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://ccrc.example',
          'sec-fetch-site': 'same-origin',
        },
        method: 'POST',
      });

      expect(proxied.status).toBe(201);
    });
  });

  test('reads are unaffected', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await harnessed.app.request('/sessions', {
        headers: { origin: 'https://evil.example' },
      });

      expect(response.status).toBe(200);
    });
  });
});

describe('request errors', () => {
  test('unknown repo is a 404 that does not enumerate the registry', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await postSession(harnessed, { repo: 'nope' });

      expect(response.status).toBe(404);
      const { error } = (await response.json()) as { error: string };
      expect(error).toBe('unknown repo "nope"');
      expect(error).not.toContain('Side Project');
      expect(harnessed.adapter.launches).toEqual([]);
    });
  });

  test('an unusable prompt is a 400, not an exec failure', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const withNul = await postSession(harnessed, { prompt: 'ok\0bad', repo: 'example' });
      expect(withNul.status).toBe(400);
      expect(((await withNul.json()) as { error: string }).error).toMatch(/NUL/);

      const oversized = await postSession(harnessed, {
        prompt: 'x'.repeat(32_769),
        repo: 'example',
      });
      expect(oversized.status).toBe(400);
      expect(((await oversized.json()) as { error: string }).error).toMatch(/at most 32768/);

      expect(harnessed.adapter.launches).toEqual([]);
    });
  });

  test('a repo path that cannot be resolved is a 4xx naming the repo, not the path', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.trustFailure = Object.assign(
        new Error("ENOENT: no such file or directory, realpath '/repos/example'"),
        { code: 'ENOENT' },
      );

      const response = await postSession(harnessed, { repo: 'example' });

      expect(response.status).toBe(400);
      const { error } = (await response.json()) as { error: string };
      expect(error).toContain('repo "example"');
      expect(error).not.toContain('/repos/example');
      const persisted = await Bun.file(harnessed.statePath).exists();
      expect(persisted).toBe(false);
    });
  });

  test('a missing or wrong-typed repo field is a 400', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      expect((await postSession(harnessed, {})).status).toBe(400);
      expect((await postSession(harnessed, { repo: 7 })).status).toBe(400);
      expect((await postSession(harnessed, { prompt: 7, repo: 'example' })).status).toBe(400);
      expect(
        (
          await harnessed.app.request('/sessions', {
            body: 'not json',
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          })
        ).status,
      ).toBe(400);
      expect(harnessed.adapter.launches).toEqual([]);
    });
  });

  test('unknown session ids are 404 on both read and delete', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      expect((await harnessed.app.request('/sessions/absent')).status).toBe(404);
      expect((await harnessed.app.request('/sessions/absent', { method: 'DELETE' })).status).toBe(
        404,
      );
    });
  });
});
