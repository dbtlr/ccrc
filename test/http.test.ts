import { beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { loadConfig, stateFilePath } from '../src/config.ts';
import type { Config } from '../src/config.ts';
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

  test('records a failed launch and surfaces the reason', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);
      harnessed.adapter.attachUrl = new Error('no attach URL appeared');

      const response = await postSession(harnessed, { repo: 'example' });

      expect(response.status).toBe(500);
      expect((await response.json()) as Record<string, unknown>).toEqual({
        error: 'no attach URL appeared',
      });
      const persisted = (await Bun.file(harnessed.statePath).json()) as Record<string, unknown>[];
      expect(persisted[0]).toMatchObject({ attachUrl: null, status: 'failed' });
    });
  });
});

describe('request errors', () => {
  test('unknown repo is a 404 that names the registry', async () => {
    await withTempDir(async (dir) => {
      const harnessed = await harness(dir);

      const response = await postSession(harnessed, { repo: 'nope' });

      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: string }).error).toContain(
        'configured repos: example, Side Project',
      );
      expect(harnessed.adapter.launches).toEqual([]);
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
