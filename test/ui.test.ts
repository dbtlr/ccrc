import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { loadConfig, stateFilePath } from '../src/config.ts';
import { createApp } from '../src/http/app.ts';
import { createUiServer } from '../src/http/ui.ts';
import { createSessionService } from '../src/sessions.ts';
import { createStateStore } from '../src/state.ts';
import { fakeAdapter, withTempDir } from './support.ts';

const SHELL = '<!doctype html><html><body><div id="board"></div></body></html>';

type Served = {
  readonly app: ReturnType<typeof createApp>;
  readonly uiDir: string;
};

/** A stand-in for `ui/dist`: a shell, one hashed asset, and nothing else. */
const withBuiltUi = async (dir: string, build: 'present' | 'absent'): Promise<Served> => {
  const configPath = join(dir, 'config.toml');
  await Bun.write(
    configPath,
    'bind = "127.0.0.1"\n\n[[repos]]\nname = "example"\npath = "/repos"\n',
  );
  const config = await loadConfig({ CCRC_CONFIG: configPath }, join(dir, 'home'));
  const uiDir = join(dir, 'dist');
  if (build === 'present') {
    await Bun.write(join(uiDir, 'index.html'), SHELL);
    await Bun.write(join(uiDir, 'assets', 'index-abc123.js'), 'export const board = 1;\n');
    await Bun.write(join(uiDir, 'assets', 'index-abc123.css'), ':root { color: red }\n');
  }
  await Bun.write(join(dir, 'secret.txt'), 'not part of the build\n');
  const service = createSessionService({
    adapter: fakeAdapter(),
    config,
    host: 'test-host',
    store: createStateStore(stateFilePath(config)),
  });
  return { app: createApp(service, { uiDir }), uiDir };
};

describe('serving the console', () => {
  test('answers the root path with the SPA shell', async () => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'present');

      const response = await app.request('/');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('id="board"');
    });
  });

  test('serves hashed assets immutably and with their own content type', async () => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'present');

      const script = await app.request('/assets/index-abc123.js');
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toContain('javascript');
      expect(script.headers.get('cache-control')).toContain('immutable');

      const styles = await app.request('/assets/index-abc123.css');
      expect(styles.headers.get('content-type')).toContain('text/css');
    });
  });

  // Once a proxy makes the console browser-reachable, an unframed shell is the only
  // thing standing between a stray iframe and a one-tap launch of a bypassPermissions
  // session, since same-origin checks cannot tell a legitimate tab from a frame.
  test('the shell refuses to be framed and is served with a sniff-proof content type', async () => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'present');

      const response = await app.request('/');

      expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });

  test('assets are served with a sniff-proof content type', async () => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'present');

      const script = await app.request('/assets/index-abc123.js');

      expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });

  test('the shell is never cached, so it cannot name assets that are gone', async () => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'present');

      const response = await app.request('/');

      expect(response.headers.get('cache-control')).toBe('no-cache');
    });
  });

  // A bookmarked shell must not inherit the year-long cache meant for `/assets/*`:
  // that would leave a rebuild permanently blank until the cache is purged by hand.
  test('a bookmarked /index.html is served no-cache, not the asset cache lifetime', async () => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'present');

      const response = await app.request('/index.html');

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-cache');
    });
  });

  test('GET /assets and /assets/ fail the same way', async () => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'present');

      const withoutSlash = await app.request('/assets');
      const withSlash = await app.request('/assets/');

      expect(withoutSlash.status).toBe(404);
      expect(withSlash.status).toBe(404);
      expect(withoutSlash.headers.get('content-type')).toBe(withSlash.headers.get('content-type'));
    });
  });

  // A deep link typed into Safari has to reach the router, not a 404.
  test.each(['/board', '/sessions-view/deep/link', '/repos-picker'])(
    'falls back to the shell for the client-side route %s',
    async (path) => {
      await withTempDir(async (dir) => {
        const { app } = await withBuiltUi(dir, 'present');

        const response = await app.request(path);

        expect(response.status).toBe(200);
        expect(await response.text()).toContain('id="board"');
      });
    },
  );

  test.each([
    '/healthz',
    '/repos',
    '/sessions',
    '/sessions/absent',
    '/sessions/absent/anything',
    '/healthz/extra',
  ])('the fallback does not shadow the API path %s', async (path) => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'present');

      const response = await app.request(path);
      const body = await response.text();

      expect(body).not.toContain('id="board"');
      expect(response.headers.get('content-type')).toContain('application/json');
    });
  });

  test('an unmatched mutation stays a JSON failure', async () => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'present');

      const response = await app.request('/board', {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not found' });
    });
  });

  test('a fingerprinted asset that is gone is a 404, not the shell', async () => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'present');

      const response = await app.request('/assets/index-stale.js');

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).not.toContain('text/html');
    });
  });

  /**
   * These go through `createUiServer` directly rather than `app.request`. The
   * fetch/URL layer underneath `app.request` collapses literal `..` and decodes
   * `%2e` before Hono ever sees the path, and `isApiPath` in `app.ts` (a separate,
   * already-covered guard) claims every path carrying a raw `%2f`/`%5c` as an API
   * path before the not-found handler would reach `ui.serve` — so no payload routed
   * through the full app can ever exercise `withinBuild`'s own containment check.
   * Calling the UI server directly is the only way to test that check at all.
   */
  test.each(['/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/assets%2f..%2fsecret.txt'])(
    'withinBuild refuses to serve %s from outside the build',
    async (path) => {
      await withTempDir(async (dir) => {
        const { uiDir } = await withBuiltUi(dir, 'present');
        const ui = createUiServer(uiDir);

        const response = await ui.serve(path);

        // A refusal falls back to the SPA shell, not to serving (or 404ing on) the
        // secret file, so both the status and the content-type have to match the
        // shell exactly — a guardless server that simply missed the file by path
        // arithmetic would still satisfy a body-only assertion.
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(await response.text()).toContain('id="board"');
      });
    },
  );

  test('explains an unbuilt console instead of crashing on it', async () => {
    await withTempDir(async (dir) => {
      const { app } = await withBuiltUi(dir, 'absent');

      const response = await app.request('/');

      expect(response.status).toBe(503);
      expect(await response.text()).toContain('bun run build');
      // The API is unaffected by a missing build.
      expect((await app.request('/healthz')).status).toBe(200);
    });
  });

  test.each(['/sessions%2f', '/sessions%2Fabc', '/healthz%2fx', '/SESSIONS', '/Sessions/abc'])(
    'the API path %s stays a JSON failure rather than becoming a page',
    async (path) => {
      await withTempDir(async (dir) => {
        const { app } = await withBuiltUi(dir, 'present');

        const response = await app.request(path);

        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).toContain('application/json');
      });
    },
  );

  test('the API alone is served when no build directory is configured', async () => {
    await withTempDir(async (dir) => {
      const configPath = join(dir, 'config.toml');
      await Bun.write(configPath, 'bind = "127.0.0.1"\n');
      const config = await loadConfig({ CCRC_CONFIG: configPath }, join(dir, 'home'));
      const app = createApp(
        createSessionService({
          adapter: fakeAdapter(),
          config,
          store: createStateStore(stateFilePath(config)),
        }),
      );

      const response = await app.request('/');

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not found' });
    });
  });
});
