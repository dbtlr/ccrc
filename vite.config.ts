import { toolingConfig } from '@dbtlr/tooling';

/**
 * Single-package lint/format/type config (@dbtlr/tooling). The daemon targets
 * Bun, so `node` is the closest shipped lint target — it permits `node:`
 * builtins. Tests run under `bun test`, not vitest, so the vitest target is off.
 *
 * The adapter boundary is structural: only `src/adapter/**` may shell out to
 * `claude`/`tmux` or touch `~/.claude.json`, so everything outside it is barred
 * from importing `node:child_process` and the Node filesystem module it needs for
 * that job. `src/files.ts` is the single exception on the filesystem side: it is
 * the path-agnostic atomic-write primitive (tmp file, preserved mode, rename)
 * that both the adapter and the state store go through, and it reaches no CLI.
 */
export default toolingConfig({
  lint: {
    ignores: ['dist/**'],
    overrides: [
      {
        // Tests assert over untyped HTTP JSON and persisted state; they own both
        // ends of those assertions, so the safety bar there is the shipped code.
        files: ['test/**'],
        rules: { 'typescript/no-unsafe-type-assertion': 'off' },
      },
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
              ],
            },
          ],
        },
      },
      {
        excludeFiles: ['src/adapter/**', 'src/files.ts'],
        files: ['src/**'],
        rules: {
          'no-restricted-imports': [
            'error',
            {
              paths: [
                {
                  message:
                    'File writing goes through src/files.ts (atomic, mode-preserving); src/adapter/** owns ~/.claude.json.',
                  name: 'node:fs',
                },
                {
                  message:
                    'File writing goes through src/files.ts (atomic, mode-preserving); src/adapter/** owns ~/.claude.json.',
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
