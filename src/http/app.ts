import { Hono } from 'hono';

import { BadRequestError, messageOf, statusOf } from '../errors.ts';
import type { LaunchInput, SessionService } from '../sessions.ts';

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

/** Wires the JSON API onto a session service. Nothing here knows about tmux. */
export const createApp = (service: SessionService): Hono => {
  const app = new Hono();

  // Response.json rather than context.json: the numeric status carried by the
  // failure needs no narrowing to Hono's status-code union.
  app.onError((failure) =>
    Response.json({ error: messageOf(failure) }, { status: statusOf(failure) }),
  );

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
