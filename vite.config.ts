import { toolingConfig } from '@dbtlr/tooling';

/**
 * Single-package lint/format/type config (@dbtlr/tooling). The daemon targets
 * Bun, so `node` is the closest shipped lint target — it permits `node:`
 * builtins. Tests run under `bun test`, not vitest, so the vitest target is off.
 *
 * The adapter boundary is structural: only `src/adapter/**` may shell out to
 * `claude`/`tmux` or touch `~/.claude.json`, so everything outside it is barred
 * from importing `node:child_process` and the Bun/Node filesystem modules it
 * needs for that job. The state store is the one other module allowed to write
 * files, and it does so through `Bun.file`/`Bun.write` rather than `node:fs`.
 */
export default toolingConfig({
  lint: {
    ignores: ['dist/**'],
    overrides: [
      {
        excludeFiles: ['src/adapter/**'],
        files: ['src/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              paths: [
                {
                  message:
                    'Process spawning belongs to src/adapter/** — the single module allowed to reach the claude CLI and tmux.',
                  name: 'node:child_process',
                },
                {
                  message:
                    'Direct node:fs use belongs to src/adapter/** (which owns ~/.claude.json); other modules persist state through the state store.',
                  name: 'node:fs',
                },
                {
                  message:
                    'Direct node:fs use belongs to src/adapter/** (which owns ~/.claude.json); other modules persist state through the state store.',
                  name: 'node:fs/promises',
                },
              ],
            },
          ],
        },
      },
    ],
  },
  node: true,
  test: false,
});
