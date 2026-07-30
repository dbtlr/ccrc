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

const read = (path: string): Promise<string> => Bun.file(path).text();

const unique = (values: readonly string[]): string[] =>
  [...new Set(values)].toSorted((left, right) => left.localeCompare(right));

const placeholders = (source: string): string[] => unique(source.match(/__[A-Z_]+__/g) ?? []);

describe('launchd agent', () => {
  test('the installer substitutes exactly the placeholders the template has', async () => {
    const template = await read(TEMPLATE);
    const install = await read(INSTALL);

    const substituted = unique(
      [...install.matchAll(/s\|(__[A-Z_]+__)\|/g)].map((match) => match[1] ?? ''),
    );

    expect(placeholders(template)).toEqual(substituted);
    expect(substituted.length).toBeGreaterThan(0);
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

  test.each([TEMPLATE, INSTALL, UNINSTALL])('%s names no host paths', async (path) => {
    const source = await read(path);

    expect(source).not.toMatch(/\/Users\//);
    expect(source).not.toMatch(/\/home\/\w/);
    expect(source).not.toMatch(/\/opt\/homebrew/);
  });

  test.each([INSTALL, UNINSTALL])('%s is executable and fails loudly', async (path) => {
    const source = await read(path);

    expect((await stat(path)).mode & 0o111).not.toBe(0);
    expect(source).toContain('#!/usr/bin/env bash');
    expect(source).toContain('set -euo pipefail');
  });
});
