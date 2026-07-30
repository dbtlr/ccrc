#!/usr/bin/env bun
import { createClaudeAdapter } from './adapter/claude.ts';
import { createWorkspaceAdapter } from './adapter/workspaces.ts';
import { loadConfig, stateFilePath } from './config.ts';
import { messageOf } from './errors.ts';
import { HEALTH_TIMEOUT_MS, createHealthService } from './health.ts';
import { createApp } from './http/app.ts';
import { defaultUiDir } from './http/ui.ts';
import { createLogger } from './log.ts';
import { createSessionService } from './sessions.ts';
import { createStateStore } from './state.ts';
import { startSupervisor } from './supervise.ts';
import { createRepoRegistry, createWorkspaceService } from './workspaces.ts';

const logger = createLogger();

const start = async (): Promise<void> => {
  const config = await loadConfig();
  const statePath = stateFilePath(config);
  const workspaceAdapter = createWorkspaceAdapter();
  const registry = createRepoRegistry({ adapter: workspaceAdapter, config, logger });
  const service = createSessionService({
    adapter: createClaudeAdapter(),
    config,
    logger,
    registry,
    store: createStateStore(statePath),
  });
  const workspaces = createWorkspaceService({ adapter: workspaceAdapter, config, logger });

  // Health gets its own adapter with the short command timeout: the probe is raced
  // against the same deadline either way, but this is what kills the spawned
  // command at 2s instead of leaving it to the 30s a request's commands are given.
  const health = createHealthService({
    adapter: createClaudeAdapter({ commandTimeoutMs: HEALTH_TIMEOUT_MS }),
    logger,
    statePath,
  });

  const server = Bun.serve({
    fetch: createApp(service, {
      allowedOrigins: config.allowedOrigins,
      health,
      logger,
      port: config.port,
      uiDir: Bun.env.CCRC_UI_DIR ?? defaultUiDir(),
      workspaces,
    }).fetch,
    hostname: config.bind,
    port: config.port,
  });

  // Not awaited: the first tick talks to tmux and the claude CLI, and the API is
  // useful before that answers.
  startSupervisor({ intervalMs: config.supervision.intervalMs, logger, service });

  const repoNames = config.repos.map((repo) => repo.name).join(', ') || 'none';
  const root = config.workspacesRoot ?? 'not configured';
  logger.info(
    `ccrcd listening on http://${server.hostname}:${server.port} (config ${config.configPath}; repos: ${repoNames}; workspaces: ${root}; supervising every ${Math.round(config.supervision.intervalMs / 1_000)}s)`,
  );
};

try {
  await start();
} catch (error) {
  logger.error(`ccrcd failed to start: ${messageOf(error)}`);
  process.exit(1);
}
