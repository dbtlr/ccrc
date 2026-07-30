import { beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { loadConfig, stateFilePath } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { LaunchError, StopError } from '../src/errors.ts';
import { createApp } from '../src/http/app.ts';
import { createSessionService } from '../src/sessions.ts';
import { createStateStore } from '../src/state.ts';
import { fakeAdapter, hostSession, withTempDir } from './support.ts';
import type { FakeAdapter } from './support.ts';

const CONFIG_TOML = `bind = "127.0.0.1"
port = 7433

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
};

let sequence = 0;

const harness = async (dir: string): Promise<Harness> => {
  const configPath = join(dir, 'config.toml');
  await Bun.write(configPath, CONFIG_TOML);
  const config = await loadConfig({ CCRC_CONFIG: configPath }, join(dir, 'home'));
  const adapter = fakeAdapter();
  const statePath = stateFilePath(config);
  const service = createSessionService({
    adapter,
    config,
    generateId: () => {
      sequence += 1;
      return `id${sequence}`;
    },
    host: 'test-host',
    now: () => 1_764_000_000_000,
    store: createStateStore(statePath),
  });
  return { adapter, app: createApp(service), config, statePath };
};

const postSession = async (harnessed: Harness, body: unknown): Promise<Response> =>
  harnessed.app.request('/sessions', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

beforeEach(() => {
  sequence = 0;
});

describe('healthz', () => {
  test('answers ok', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      const response = await harnessed.app.request('/healthz');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
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
        repoPath: '/repos/example',
        status: 'running',
        tmuxName: 'ccrc-example-1',
      });
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
      // The whole host fleet rides along, ccrcd-launched or not.
      expect(listing.hostSessions.length).toBe(2);

      const fetched = await harnessed.app.request('/sessions/id1');
      expect(fetched.status).toBe(200);
      expect((await fetched.json()) as Record<string, unknown>).toMatchObject({ id: 'id1' });

      const deleted = await harnessed.app.request('/sessions/id1', { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      expect((await deleted.json()) as Record<string, unknown>).toMatchObject({
        status: 'stopped',
      });
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

  test('marks a session stopped once its tmux session is gone', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      await postSession(harnessed, { repo: 'example' });

      // Something outside ccrcd killed the tmux session.
      harnessed.adapter.liveNames = [];

      const listing = (await (await harnessed.app.request('/sessions')).json()) as {
        sessions: Record<string, unknown>[];
      };
      expect(listing.sessions[0]).toMatchObject({ status: 'stopped' });
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ status: 'stopped' });
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
