#!/usr/bin/env bun
import { createClaudeAdapter } from './adapter/claude.ts';
import { loadConfig, stateFilePath } from './config.ts';
import { messageOf } from './errors.ts';
import { createApp } from './http/app.ts';
import { defaultUiDir } from './http/ui.ts';
import { createSessionService } from './sessions.ts';
import { createStateStore } from './state.ts';

const start = async (): Promise<void> => {
  const config = await loadConfig();
  const service = createSessionService({
    adapter: createClaudeAdapter(),
    config,
    store: createStateStore(stateFilePath(config)),
  });

  const server = Bun.serve({
    fetch: createApp(service, {
      allowedOrigins: config.allowedOrigins,
      uiDir: Bun.env.CCRC_UI_DIR ?? defaultUiDir(),
    }).fetch,
    hostname: config.bind,
    port: config.port,
  });

  const repoNames = config.repos.map((repo) => repo.name).join(', ') || 'none';
  process.stdout.write(
    `ccrcd listening on http://${server.hostname}:${server.port} (config ${config.configPath}; repos: ${repoNames})\n`,
  );
};

try {
  await start();
} catch (error) {
  process.stderr.write(`ccrcd failed to start: ${messageOf(error)}\n`);
  process.exit(1);
}
