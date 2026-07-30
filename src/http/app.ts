import { Hono } from 'hono';

import {
  BadRequestError,
  CcrcError,
  ForbiddenError,
  UnsupportedMediaTypeError,
  messageOf,
} from '../errors.ts';
import type { LaunchInput, SessionService } from '../sessions.ts';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

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

/**
 * The daemon's own origin is always trusted; `allowedOrigins` adds the reverse
 * proxy the console is actually loaded from. Membership is exact string equality
 * against a validated set — a near-miss on scheme, port, or path is a stranger.
 *
 * `Sec-Fetch-Site: cross-site` stays a flat refusal. A console served through the
 * proxy is same-origin from the browser's point of view, so that header never
 * describes a request the allow-list is meant to admit.
 */
const requireTrustedOrigin = (request: Request, allowedOrigins: ReadonlySet<string>): void => {
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new ForbiddenError('cross-site requests are refused');
  }
  const origin = request.headers.get('origin');
  if (origin === null || origin === new URL(request.url).origin || allowedOrigins.has(origin)) {
    return;
  }
  throw new ForbiddenError('cross-origin requests are refused');
};

export type AppOptions = {
  /** Exact origins, already validated by config loading. */
  readonly allowedOrigins?: readonly string[];
};

/** Wires the JSON API onto a session service. Nothing here knows about tmux. */
export const createApp = (service: SessionService, options: AppOptions = {}): Hono => {
  const app = new Hono();
  const allowedOrigins = new Set(options.allowedOrigins);

  // Response.json rather than context.json: the numeric status carried by the
  // failure needs no narrowing to Hono's status-code union. Only deliberate
  // failures describe themselves to the client — anything else could carry host
  // paths or a command line, so it is logged here and answered generically.
  app.onError((failure) => {
    if (failure instanceof CcrcError) {
      return Response.json({ error: failure.message }, { status: failure.status });
    }
    process.stderr.write(`ccrcd request failed: ${failure.stack ?? messageOf(failure)}\n`);
    return Response.json({ error: 'internal error' }, { status: 500 });
  });

  app.use('*', async (context, next) => {
    const { method } = context.req;
    if (MUTATING_METHODS.has(method)) {
      requireTrustedOrigin(context.req.raw, allowedOrigins);
      if (BODY_METHODS.has(method)) {
        requireJsonContentType(context.req.raw);
      }
    }
    return next();
  });

  app.get('/healthz', (context) => context.json({ ok: true }));

  app.post('/sessions', async (context) => {
    const input = readLaunchInput(await parseJsonBody(context.req.raw));
    const session = await service.launch(input);
    return context.json(session, 201);
  });

  app.get('/sessions', async (context) => context.json(await service.list()));

  app.get('/sessions/:id', async (context) =>
    context.json(await service.get(context.req.param('id'))),
  );

  app.delete('/sessions/:id', async (context) =>
    context.json(await service.stop(context.req.param('id'))),
  );

  return app;
};
