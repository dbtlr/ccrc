#!/usr/bin/env bun
import { createClaudeAdapter } from './adapter/claude.ts';
import { loadConfig, stateFilePath } from './config.ts';
import { messageOf } from './errors.ts';
import { createApp } from './http/app.ts';
import { defaultUiDir } from './http/ui.ts';
import { createLogger } from './log.ts';
import { createSessionService } from './sessions.ts';
import { createStateStore } from './state.ts';
import { startSupervisor } from './supervise.ts';

const logger = createLogger();

const start = async (): Promise<void> => {
  const config = await loadConfig();
  const service = createSessionService({
    adapter: createClaudeAdapter(),
    config,
    logger,
    store: createStateStore(stateFilePath(config)),
  });

  const server = Bun.serve({
    fetch: createApp(service, {
      allowedOrigins: config.allowedOrigins,
      logger,
      port: config.port,
      uiDir: Bun.env.CCRC_UI_DIR ?? defaultUiDir(),
    }).fetch,
    hostname: config.bind,
    port: config.port,
  });

  // Not awaited: the first tick talks to tmux and the claude CLI, and the API is
  // useful before that answers.
  startSupervisor({ intervalMs: config.supervision.intervalMs, logger, service });

  const repoNames = config.repos.map((repo) => repo.name).join(', ') || 'none';
  logger.info(
    `ccrcd listening on http://${server.hostname}:${server.port} (config ${config.configPath}; repos: ${repoNames}; supervising every ${Math.round(config.supervision.intervalMs / 1_000)}s)`,
  );
};

try {
  await start();
} catch (error) {
  logger.error(`ccrcd failed to start: ${messageOf(error)}`);
  process.exit(1);
}
