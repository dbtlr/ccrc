import { describe, expect, test } from 'bun:test';
import { chmod, lstat, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createStateStore } from '../src/state.ts';
import type { StateStore } from '../src/state.ts';
import { sessionRecord as record, withTempDir } from './support.ts';

const append = (store: StateStore, id: string): Promise<number> =>
  store.update((records) => ({
    records: [...records, record({ id, tmuxName: `ccrc-example-${id}` })],
    result: records.length,
  }));

describe('state store', () => {
  test('round-trips records and drops unusable entries', async () => {
    await withTempDir(async (dir) => {
      const store = createStateStore(join(dir, 'state.json'));

      await store.save([record()]);

      expect(await store.load()).toEqual([record()]);
      await writeFile(join(dir, 'state.json'), '[{"id":""},{"id":"id2"},"junk"]', 'utf8');
      expect((await store.load()).map((entry) => entry.id)).toEqual(['id2']);
    });
  });

  test('a corrupt or missing file reads as an empty list', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'state.json');
      const store = createStateStore(filePath);

      expect(await store.load()).toEqual([]);
      await writeFile(filePath, '[{"id":"id1"', 'utf8');
      expect(await store.load()).toEqual([]);
    });
  });

  test('records are written owner-only and leave no staging file behind', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'state.json');

      await createStateStore(filePath).save([record()]);

      // Attach URLs are capabilities: nobody else on the host gets to read them.
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await readdir(dir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    });
  });

  test('an existing file keeps its mode and its symlink', async () => {
    await withTempDir(async (dir) => {
      const realPath = join(dir, 'real-state.json');
      const linkPath = join(dir, 'state.json');
      await writeFile(realPath, '[]', 'utf8');
      await chmod(realPath, 0o640);
      await symlink(realPath, linkPath);

      await createStateStore(linkPath).save([record()]);

      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect((await stat(realPath)).mode & 0o777).toBe(0o640);
      expect(JSON.parse(await readFile(realPath, 'utf8'))).toEqual([record()]);
    });
  });

  test('update serializes read-modify-write across concurrent callers', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'state.json');
      // Two stores over one file: the mutex is process-wide, not per instance.
      const first = createStateStore(filePath);
      const second = createStateStore(filePath);

      const seen = await Promise.all([
        append(first, 'id1'),
        append(second, 'id2'),
        append(first, 'id3'),
        append(second, 'id4'),
      ]);

      // Every writer saw the one before it.
      expect(seen).toEqual([0, 1, 2, 3]);
      expect((await first.load()).map((entry) => entry.id)).toEqual(['id1', 'id2', 'id3', 'id4']);
    });
  });

  test('update skips the write when the records are unchanged', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'state.json');
      const store = createStateStore(filePath);
      await store.save([record()]);
      const before = await stat(filePath);

      const seen = await store.update((records) => ({ records, result: records.length }));

      expect(seen).toBe(1);
      expect((await stat(filePath)).mtimeMs).toBe(before.mtimeMs);
    });
  });
});
