import { describe, expect, test } from 'bun:test';

import type { Session } from '../ui/src/api/client.ts';
import { partitionSessions } from '../ui/src/lib/rack-order.ts';

/** A client-side session, with only the fields a test cares about overridden. */
const session = (overrides: Partial<Session> = {}): Session => ({
  activity: 'unknown',
  attachUrl: null,
  endedAt: null,
  host: 'test-host',
  id: 'id',
  name: 'example',
  pid: null,
  repoName: 'example',
  startedAt: 1_000,
  status: 'running',
  ...overrides,
});

describe('partitionSessions', () => {
  test('stopped and failed both land in closed', () => {
    const stopped = session({ endedAt: 1_000, id: 'stopped', status: 'stopped' });
    const failed = session({ endedAt: 2_000, id: 'failed', status: 'failed' });

    // Input is passed newest-last, the opposite of the expected endedAt-desc output, so
    // this also checks that both states are sorted rather than merely partitioned.
    const { active, closed } = partitionSessions([stopped, failed]);

    expect(active).toEqual([]);
    expect(closed.map((s) => s.id)).toEqual(['failed', 'stopped']);
  });

  test('every active state lands in active', () => {
    const busy = session({ activity: 'busy', id: 'busy', status: 'running' });
    const idle = session({ activity: 'idle', id: 'idle', status: 'running' });
    const running = session({ activity: 'unknown', id: 'running', status: 'running' });
    const starting = session({ id: 'starting', status: 'starting' });

    const { active, closed } = partitionSessions([busy, idle, running, starting]);

    expect(closed).toEqual([]);
    expect(new Set(active.map((s) => s.id))).toEqual(
      new Set(['busy', 'idle', 'running', 'starting']),
    );
  });

  test('active sessions rank busy, then running, then starting, then idle', () => {
    const idle = session({ activity: 'idle', id: 'idle', startedAt: 1_000, status: 'running' });
    const starting = session({ id: 'starting', startedAt: 1_000, status: 'starting' });
    const busy = session({ activity: 'busy', id: 'busy', startedAt: 1_000, status: 'running' });
    const running = session({
      activity: 'unknown',
      id: 'running',
      startedAt: 1_000,
      status: 'running',
    });

    // Shuffled on purpose: this input order is not the expected output order, so the
    // assertion below actually exercises the sort rather than passing on a fluke.
    const { active } = partitionSessions([idle, starting, busy, running]);

    expect(active.map((s) => s.id)).toEqual(['busy', 'running', 'starting', 'idle']);
  });

  test('within a rank, the newest startedAt sorts first', () => {
    const older = session({ activity: 'busy', id: 'older', startedAt: 1_000 });
    const newest = session({ activity: 'busy', id: 'newest', startedAt: 3_000 });
    const middle = session({ activity: 'busy', id: 'middle', startedAt: 2_000 });

    // Input is oldest-first, the opposite of the expected newest-first output.
    const { active } = partitionSessions([older, middle, newest]);

    expect(active.map((s) => s.id)).toEqual(['newest', 'middle', 'older']);
  });

  test('closed sessions sort by endedAt, most recently ended first', () => {
    const first = session({ endedAt: 1_000, id: 'first', startedAt: 500, status: 'stopped' });
    const second = session({ endedAt: 3_000, id: 'second', startedAt: 500, status: 'stopped' });
    const third = session({ endedAt: 2_000, id: 'third', startedAt: 500, status: 'stopped' });

    // Input order matches neither ascending nor descending endedAt.
    const { closed } = partitionSessions([first, second, third]);

    expect(closed.map((s) => s.id)).toEqual(['second', 'third', 'first']);
  });

  test('within equal endedAt, the newest startedAt sorts first', () => {
    const older = session({ endedAt: 9_000, id: 'older', startedAt: 1_000, status: 'stopped' });
    const newest = session({ endedAt: 9_000, id: 'newest', startedAt: 3_000, status: 'stopped' });
    const middle = session({ endedAt: 9_000, id: 'middle', startedAt: 2_000, status: 'stopped' });

    // Input is oldest-first, the opposite of the expected newest-first output.
    const { closed } = partitionSessions([older, middle, newest]);

    expect(closed.map((s) => s.id)).toEqual(['newest', 'middle', 'older']);
  });

  test('a mixed rack sorts each side independently', () => {
    const busy = session({ activity: 'busy', id: 'busy', startedAt: 1_000 });
    const idle = session({ activity: 'idle', id: 'idle', startedAt: 2_000 });
    const early = session({ endedAt: 1_000, id: 'early', status: 'stopped' });
    const late = session({ endedAt: 2_000, id: 'late', status: 'failed' });

    // Closed strips interleave the active ones, and each side arrives in the
    // opposite of its expected order.
    const { active, closed } = partitionSessions([idle, early, busy, late]);

    expect(active.map((s) => s.id)).toEqual(['busy', 'idle']);
    expect(closed.map((s) => s.id)).toEqual(['late', 'early']);
  });

  test('the input array is left untouched', () => {
    // Distinct timestamps throughout, so an in-place sort by either comparator
    // would visibly reorder the input rather than hiding behind equal keys.
    const input = [
      session({ endedAt: 4_000, id: 'stopped', startedAt: 1_000, status: 'stopped' }),
      session({ activity: 'busy', id: 'busy', startedAt: 2_000 }),
      session({ activity: 'idle', id: 'idle', startedAt: 3_000 }),
    ];

    // The rack partitions the polled query data in place on every render; sorting
    // the shared array itself would reorder it under every other reader.
    partitionSessions(input);

    expect(input.map((s) => s.id)).toEqual(['stopped', 'busy', 'idle']);
  });

  test('a closed session with no endedAt falls back to startedAt', () => {
    const ended = session({ endedAt: 2_000, id: 'ended', startedAt: 100, status: 'stopped' });
    const neverEnded = session({
      endedAt: null,
      id: 'never-ended',
      startedAt: 5_000,
      status: 'failed',
    });

    // If the fallback were skipped, `neverEnded` (endedAt null treated as 0) would sort
    // last instead of first.
    const { closed } = partitionSessions([ended, neverEnded]);

    expect(closed.map((s) => s.id)).toEqual(['never-ended', 'ended']);
  });
});
