/**
 * The daemon's whole logging surface: one line per event, prefixed with an
 * ISO-8601 timestamp.
 *
 * A daemon supervised by launchd writes into a log file nobody watches live, so a
 * line without a timestamp cannot be placed against a session that misbehaved.
 * `info` goes to stdout and `error` to stderr, which is what keeps the two apart
 * once launchd redirects them into separate files.
 *
 * The clock and both sinks are injected so tests read lines instead of a stream.
 */

export type Logger = {
  readonly info: (message: string) => void;
  readonly error: (message: string) => void;
};

export type LoggerOptions = {
  readonly now?: () => number;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
};

export const createLogger = (options: LoggerOptions = {}): Logger => {
  const now = options.now ?? Date.now;
  const out = options.out ?? ((line: string) => void process.stdout.write(line));
  const err = options.err ?? ((line: string) => void process.stderr.write(line));
  // A newline inside a message would break the one-line-per-event contract every
  // log reader assumes, so it is folded rather than passed through.
  const line = (message: string): string =>
    `${new Date(now()).toISOString()} ${message.replaceAll('\n', ' ')}\n`;
  return {
    error: (message) => err(line(message)),
    info: (message) => out(line(message)),
  };
};
