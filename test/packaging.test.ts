import { describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The LaunchAgent is a template plus an installer, and the whole point of that
 * split is that no committed file names a host. These tests hold that line: they
 * check the two halves agree on the placeholders, and that neither carries an
 * absolute home directory.
 */

const LAUNCHD_DIR = join(import.meta.dir, '..', 'packaging', 'launchd');
const TEMPLATE = join(LAUNCHD_DIR, 'dev.ccrc.ccrcd.plist.template');
const INSTALL = join(LAUNCHD_DIR, 'install.sh');
const UNINSTALL = join(LAUNCHD_DIR, 'uninstall.sh');
const RENDER = join(LAUNCHD_DIR, 'render-plist.sh');

const read = (path: string): Promise<string> => Bun.file(path).text();

const unique = (values: readonly string[]): string[] =>
  [...new Set(values)].toSorted((left, right) => left.localeCompare(right));

const placeholders = (source: string): string[] => unique(source.match(/__[A-Z_]+__/g) ?? []);

/** Renders the plist the way install.sh does, with the values a test chooses. */
const render = async (values: Record<string, string>): Promise<string> => {
  const result = Bun.spawnSync(['bash', RENDER], {
    env: {
      CCRC_AGENT_PATH: '/opt/bin:/usr/bin',
      CCRC_BUN: '/usr/local/bin/bun',
      CCRC_CONFIG_PATH: '/home/tester/.config/ccrc/config.toml',
      CCRC_HOME_DIR: '/home/tester',
      CCRC_LABEL: 'dev.ccrc.ccrcd',
      CCRC_LOG_DIR: '/home/tester/Library/Logs/ccrc',
      CCRC_REPO_DIR: '/home/tester/code/ccrc',
      CCRC_TEMPLATE: TEMPLATE,
      ...values,
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`render-plist.sh failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

describe('plist rendering', () => {
  test('substitutes a path containing characters the shell and XML both care about', async () => {
    // All of these are legal in a macOS path, and a plist is XML.
    const repoDir = '/home/tester/code/r&d|<work>';

    const rendered = await render({ CCRC_REPO_DIR: repoDir });

    expect(rendered).not.toMatch(/__[A-Z_]+__/);
    expect(rendered).toContain('<string>/home/tester/code/r&amp;d|&lt;work&gt;</string>');
    expect(rendered).toContain(
      '<string>/home/tester/code/r&amp;d|&lt;work&gt;/src/main.ts</string>',
    );
  });

  test('renders a plist the system can parse', async () => {
    const rendered = await render({ CCRC_REPO_DIR: '/home/tester/code/r&d' });
    // An `&` that gets rewritten leaves a marker inside a path — still valid XML, so
    // the agent loads and then crash-loops on a program that does not exist.
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
    expect(rendered).toContain('<string>/home/tester/code/r&amp;d</string>');
    const linter = Bun.which('plutil');
    if (linter === null) {
      return;
    }

    const linted = Bun.spawnSync([linter, '-lint', '-'], { stdin: Buffer.from(rendered) });

    expect(linted.stdout.toString().trim()).toMatch(/OK$/);
    expect(linted.exitCode).toBe(0);
  });

  test('leaves no marker unsubstituted for ordinary paths', async () => {
    const rendered = await render({});

    expect(rendered).not.toMatch(/__[A-Z_]+__/);
    expect(rendered).toContain('<string>/usr/local/bin/bun</string>');
    expect(rendered).toContain('<string>/opt/bin:/usr/bin</string>');
    expect(rendered).toContain('<string>/home/tester/Library/Logs/ccrc/ccrcd.err.log</string>');
  });
});

describe('launchd agent', () => {
  test('the renderer substitutes exactly the placeholders the template has', async () => {
    const template = await read(TEMPLATE);
    const renderer = await read(RENDER);

    const substituted = unique(
      [...renderer.matchAll(/\/\/(__[A-Z_]+__)\//g)].map((match) => match[1] ?? ''),
    );

    expect(placeholders(template)).toEqual(substituted);
    expect(substituted.length).toBeGreaterThan(0);
  });

  test('the agent is throttled so a broken start cannot spin', async () => {
    const template = await read(TEMPLATE);

    expect(template).toContain('<key>ThrottleInterval</key>');
  });

  test('the agent runs at login, restarts on exit, and logs where the docs say', async () => {
    const template = await read(TEMPLATE);

    expect(template).toContain('<key>RunAtLoad</key>');
    expect(template).toContain('<key>KeepAlive</key>');
    expect(template).toContain('<string>__LOG_DIR__/ccrcd.out.log</string>');
    expect(template).toContain('<string>__LOG_DIR__/ccrcd.err.log</string>');
    // tmux and the claude CLI have to be findable from a login-less environment.
    expect(template).toContain('<key>PATH</key>');
    expect(await read(INSTALL)).toContain('Library/Logs/ccrc');
  });

  test('the installer refuses to run without the tools every launch needs', async () => {
    const install = await read(INSTALL);

    expect(install).toContain('for tool in tmux claude; do');
    expect(install).toMatch(/command -v bun/);
  });

  test.each([TEMPLATE, INSTALL, UNINSTALL, RENDER])('%s names no host paths', async (path) => {
    const source = await read(path);

    expect(source).not.toMatch(/\/Users\//);
    expect(source).not.toMatch(/\/home\/\w/);
    expect(source).not.toMatch(/\/opt\/homebrew/);
  });

  test.each([INSTALL, UNINSTALL, RENDER])('%s is executable and fails loudly', async (path) => {
    const source = await read(path);

    expect((await stat(path)).mode & 0o111).not.toBe(0);
    expect(source).toContain('#!/usr/bin/env bash');
    expect(source).toContain('set -euo pipefail');
  });
});
