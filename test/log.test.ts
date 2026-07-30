import { describe, expect, test } from 'bun:test';

import { createLogger } from '../src/log.ts';

const sinks = (): {
  readonly out: string[];
  readonly err: string[];
  readonly logger: ReturnType<typeof createLogger>;
} => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    logger: createLogger({
      err: (line) => void err.push(line),
      now: () => 1_764_000_000_000,
      out: (line) => void out.push(line),
    }),
    out,
  };
};

describe('createLogger', () => {
  test('prefixes an ISO-8601 timestamp and ends the line', () => {
    const { logger, out } = sinks();

    logger.info('ccrcd listening on http://127.0.0.1:7433');

    expect(out).toEqual(['2025-11-24T16:00:00.000Z ccrcd listening on http://127.0.0.1:7433\n']);
  });

  test('sends failures to stderr and leaves stdout alone', () => {
    const { err, logger, out } = sinks();

    logger.error('ccrcd request failed: boom');

    expect(out).toEqual([]);
    expect(err).toEqual(['2025-11-24T16:00:00.000Z ccrcd request failed: boom\n']);
  });

  test('folds embedded newlines so one event stays one line', () => {
    const { err, logger } = sinks();

    logger.error('failed: Error: boom\n    at somewhere\n    at elsewhere');

    expect(err).toHaveLength(1);
    expect(err[0]).toBe(
      '2025-11-24T16:00:00.000Z failed: Error: boom     at somewhere     at elsewhere\n',
    );
  });
});
