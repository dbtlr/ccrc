import { Hono } from 'hono';

import { DEFAULT_PORT } from '../config.ts';
import {
  BadRequestError,
  CcrcError,
  ForbiddenError,
  NotFoundError,
  UnsupportedMediaTypeError,
  messageOf,
} from '../errors.ts';
import type { HealthService } from '../health.ts';
import { createLogger } from '../log.ts';
import type { Logger } from '../log.ts';
import type { LaunchInput, SessionService } from '../sessions.ts';
import type { WorkspaceService } from '../workspaces.ts';
import { createUiServer } from './ui.ts';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * The API owns these paths outright. The console's history fallback serves the SPA
 * shell for anything else, and must never answer for one of them: a mistyped
 * `/sessions/` request has to stay a JSON error rather than become a page.
 */
const API_PREFIXES = ['/healthz', '/repos', '/sessions', '/workspaces'];

/**
 * Compared case-insensitively and against the decoded path, because the fallback
 * that consults this decodes too. Matching the raw path here while the static
 * server decodes lets a request slip between the two normalisations: `/sessions%2f`
 * is not an API path by a raw-prefix test, so it would be answered with the shell
 * and a JSON client would parse HTML instead of handling a 404. An encoded slash
 * or backslash never belongs in a path this API serves, so it is refused outright
 * rather than decoded and guessed at.
 */
const isApiPath = (pathname: string): boolean => {
  const candidate = pathname.toLowerCase();
  if (/%2f|%5c/i.test(pathname)) {
    return true;
  }
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return true;
  }
  return API_PREFIXES.some((prefix) => decoded === prefix || decoded.startsWith(`${prefix}/`));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readLaunchInput = (body: unknown): LaunchInput => {
  if (!isRecord(body)) {
    throw new BadRequestError('request body must be a JSON object');
  }
  const { prompt, repo } = body;
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new BadRequestError('"repo" is required and must be a registry repo name');
  }
  if (prompt !== undefined && typeof prompt !== 'string') {
    throw new BadRequestError('"prompt" must be a string when present');
  }
  return { prompt, repo };
};

/** Shape only — what makes a name usable is the workspace service's business. */
const readWorkspaceName = (body: unknown): string => {
  if (!isRecord(body)) {
    throw new BadRequestError('request body must be a JSON object');
  }
  const { name } = body;
  if (typeof name !== 'string' || name.length === 0) {
    throw new BadRequestError('"name" is required and must be a string');
  }
  return name;
};

const parseJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new BadRequestError('request body must be valid JSON');
  }
};

/**
 * Every launch runs with `bypassPermissions` and the API has no authentication,
 * so a mutating request has to prove it did not come from a web page the operator
 * happened to visit. Two checks do that:
 *
 * - `application/json` is not a content type a cross-origin form or simple
 *   `fetch` can set, so requiring it costs a browser a preflight this API never
 *   answers;
 * - a browser attaches `Origin` (and often `Sec-Fetch-Site`) to those requests,
 *   so anything the operator has not named is refused outright.
 *
 * A CLI client sends neither header and is unaffected.
 */
const requireJsonContentType = (request: Request): void => {
  const declared = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (declared !== 'application/json') {
    throw new UnsupportedMediaTypeError('content-type must be application/json');
  }
};

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The trusted origins are computed from configuration, never from the request.
 * Deriving them from `request.url` would read them out of the `Host` header, which
 * the caller controls: a page that forges `Host` and `Origin` to the same value
 * would then be trusted, which is what DNS rebinding does — resolve an
 * attacker-owned name to 127.0.0.1 and every browser-attached header describes a
 * same-origin request to a host the operator never named.
 */
const trustedOriginsFor = (port: number, allowedOrigins: readonly string[]): ReadonlySet<string> =>
  new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
    ...allowedOrigins,
  ]);

/**
 * The other half of the rebinding defence: the `Host` a request claims has to be
 * one the operator named. Rebinding turns on the browser believing it is talking
 * to the attacker's hostname, so refusing unknown hostnames breaks it regardless
 * of what `Origin` says — which is why this applies to reads too, not just
 * mutations. A rebound page can otherwise read the whole session list.
 *
 * Matching is on hostname alone. The port a proxy forwards to is a deployment
 * detail, and no attacker gains anything by guessing it; the hostname is the part
 * that has to be legitimate.
 */
const trustedHostnamesFor = (allowedOrigins: readonly string[]): ReadonlySet<string> =>
  new Set([...LOOPBACK_HOSTNAMES, ...allowedOrigins.map((origin) => new URL(origin).hostname)]);

/**
 * Read from the request URL, which the server builds out of the `Host` header, so
 * this sees exactly the host the caller claimed. That the value is
 * caller-controlled is the point: it is compared against a set drawn from
 * configuration, which is what makes rebinding fail. The rejection names the fix
 * without quoting the header — an attacker-supplied `Host` echoed into a log line
 * is a log-injection primitive.
 */
const requireTrustedHost = (request: Request, trustedHostnames: ReadonlySet<string>): void => {
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname.toLowerCase();
  } catch {
    throw new ForbiddenError('requests must carry a usable Host header');
  }
  if (trustedHostnames.has(hostname)) {
    return;
  }
  throw new ForbiddenError(
    'unrecognised Host. Reach ccrcd on a loopback address, or name the proxy host in "allowed_origins".',
  );
};

/**
 * `allowedOrigins` adds the reverse proxy the console is actually loaded from.
 * Membership is exact string equality against a validated set — a near-miss on
 * scheme, port, or path is a stranger.
 *
 * `Sec-Fetch-Site: cross-site` stays a flat refusal. A console served through the
 * proxy is same-origin from the browser's point of view, so that header never
 * describes a request the allow-list is meant to admit.
 */
const requireTrustedOrigin = (request: Request, trustedOrigins: ReadonlySet<string>): void => {
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new ForbiddenError('cross-site requests are refused');
  }
  const origin = request.headers.get('origin');
  if (origin === null || trustedOrigins.has(origin)) {
    return;
  }
  throw new ForbiddenError('cross-origin requests are refused');
};

export type AppOptions = {
  /** Exact origins, already validated by config loading. */
  readonly allowedOrigins?: readonly string[];
  /** The configured listen port, which fixes the daemon's own trusted origins. */
  readonly port?: number;
  /** Where the built console lives. Omitted, the app is the JSON API alone. */
  readonly uiDir?: string | undefined;
  readonly logger?: Logger;
  /**
   * The dependency probes `/healthz` reports on. Omitted, the endpoint answers for
   * the process alone — which is all an app wired without one can honestly claim.
   */
  readonly health?: HealthService;
  /** Workspace creation. Omitted, `POST /workspaces` answers as unconfigured. */
  readonly workspaces?: WorkspaceService;
};

/** Wires the JSON API onto a session service. Nothing here knows about tmux. */
export const createApp = (service: SessionService, options: AppOptions = {}): Hono => {
  const app = new Hono();
  const allowedOrigins = options.allowedOrigins ?? [];
  const trustedOrigins = trustedOriginsFor(options.port ?? DEFAULT_PORT, allowedOrigins);
  const trustedHostnames = trustedHostnamesFor(allowedOrigins);
  const ui = options.uiDir === undefined ? undefined : createUiServer(options.uiDir);
  const logger = options.logger ?? createLogger();

  // Response.json rather than context.json: the numeric status carried by the
  // failure needs no narrowing to Hono's status-code union. Only deliberate
  // failures describe themselves to the client — anything else could carry host
  // paths or a command line, so it is logged here and answered generically.
  app.onError((failure) => {
    if (failure instanceof CcrcError) {
      return Response.json({ error: failure.message }, { status: failure.status });
    }
    logger.error(`ccrcd request failed: ${failure.stack ?? messageOf(failure)}`);
    return Response.json({ error: 'internal error' }, { status: 500 });
  });

  app.use('*', async (context, next) => {
    const { method } = context.req;
    requireTrustedHost(context.req.raw, trustedHostnames);
    if (MUTATING_METHODS.has(method)) {
      requireTrustedOrigin(context.req.raw, trustedOrigins);
      if (BODY_METHODS.has(method)) {
        requireJsonContentType(context.req.raw);
      }
    }
    return next();
  });

  /**
   * A read, so it stays outside the origin and content-type gates the mutations are
   * held to — a monitor is a plain `GET` client with no headers to offer.
   */
  app.get('/healthz', async (context) => {
    const { health } = options;
    if (health === undefined) {
      return context.json({ checks: {}, ok: true });
    }
    const report = await health.check();
    return report.ok ? context.json(report) : context.json(report, 503);
  });

  // The console cannot read the TOML, so the registry it picks from comes from here.
  app.get('/repos', async (context) => context.json(await service.listRepos()));

  app.post('/sessions', async (context) => {
    const input = readLaunchInput(await parseJsonBody(context.req.raw));
    const session = await service.launch(input);
    return context.json(session, 201);
  });

  /**
   * Held to exactly the same gates as a launch: creating a workspace is how a
   * directory becomes launchable, so it is as much a privileged mutation as the
   * launch that follows it.
   */
  app.post('/workspaces', async (context) => {
    const { workspaces } = options;
    if (workspaces === undefined) {
      throw new NotFoundError(
        'ccrcd has no workspaces root configured, so it cannot create workspaces. Set "workspaces_root" in the config and restart the daemon.',
      );
    }
    const created = await workspaces.create(
      readWorkspaceName(await parseJsonBody(context.req.raw)),
    );
    return context.json(created, 201);
  });

  app.get('/sessions', async (context) => context.json(await service.list()));

  app.get('/sessions/:id', async (context) =>
    context.json(await service.get(context.req.param('id'))),
  );

  app.delete('/sessions/:id', async (context) =>
    context.json(await service.stop(context.req.param('id'))),
  );

  /**
   * The console is a single-page app, so its routes only exist in the browser. Every
   * unmatched read that is not an API path gets the shell and lets the router sort it
   * out; everything else stays a JSON failure in the shape clients already parse.
   */
  app.notFound((context) => {
    const { method, path } = context.req;
    if (ui === undefined || isApiPath(path) || !READ_METHODS.has(method)) {
      return context.json({ error: 'not found' }, 404);
    }
    return ui.serve(path);
  });

  return app;
};
