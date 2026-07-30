import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ConfigError } from './errors.ts';

export type RepoEntry = {
  readonly name: string;
  readonly path: string;
};

/**
 * How the supervision loop is tuned. The TOML names its intervals in the units an
 * operator thinks in (seconds, minutes, days) and they are normalised to
 * milliseconds here, so nothing downstream has to remember which unit a key used.
 */
export type SupervisionConfig = {
  /** How often the loop reconciles, watches for hangs, and prunes. */
  readonly intervalMs: number;
  /** How long a busy session's transcript may stand still before it is hung. */
  readonly hangThresholdMs: number;
  /** Most automatic restarts allowed in one restart lineage per window. */
  readonly restartCap: number;
  readonly restartCapWindowMs: number;
  /** How long a stopped or failed record is kept before it is pruned. */
  readonly stoppedRetentionMs: number;
};

export type Config = {
  readonly configPath: string;
  /** Directory holding the config file — also where `state.json` lives. */
  readonly stateDir: string;
  readonly bind: string;
  readonly port: number;
  /** Exact origins a browser may drive mutations from, beyond the daemon's own. */
  readonly allowedOrigins: readonly string[];
  readonly repos: readonly RepoEntry[];
  readonly supervision: SupervisionConfig;
};

export const DEFAULT_BIND = '127.0.0.1';
export const DEFAULT_PORT = 7433;
export const STATE_FILE_NAME = 'state.json';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const DEFAULT_SUPERVISION: SupervisionConfig = {
  hangThresholdMs: 10 * MINUTE_MS,
  intervalMs: 30 * SECOND_MS,
  restartCap: 3,
  restartCapWindowMs: 60 * MINUTE_MS,
  stoppedRetentionMs: 7 * DAY_MS,
};

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

export const configPathFrom = (env: ConfigEnvironment, home: string): string =>
  env.CCRC_CONFIG ?? join(home, '.config', 'ccrc', 'config.toml');

const expandHome = (value: string, home: string): string => {
  if (value === '~') {
    return home;
  }
  return value.startsWith('~/') ? join(home, value.slice(2)) : value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (source: Record<string, unknown>, key: string, at: string): string => {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${at}: "${key}" must be a non-empty string`);
  }
  return value;
};

const readRepos = (value: unknown, home: string): readonly RepoEntry[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError('config: "repos" must be a list of [[repos]] tables');
  }
  return value.map((entry, index) => {
    const at = `config: repos[${index}]`;
    if (!isRecord(entry)) {
      throw new ConfigError(`${at} must be a table with "name" and "path"`);
    }
    return {
      name: readString(entry, 'name', at),
      path: expandHome(readString(entry, 'path', at), home),
    };
  });
};

const readPort = (value: unknown): number => {
  if (value === undefined) {
    return DEFAULT_PORT;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ConfigError('config: "port" must be an integer between 1 and 65535');
  }
  return value;
};

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]', '::ffff:127.0.0.1']);
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

const isLoopback = (host: string): boolean => {
  const normalized = host.toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || LOOPBACK_IPV4.test(normalized);
};

/**
 * ccrcd has no authentication and every session it starts runs with
 * `bypassPermissions`, so a reachable-from-the-network bind publishes arbitrary
 * code execution. Until that is fronted by an authenticated transport, a
 * non-loopback bind is a fatal config error rather than a silent exposure.
 */
const readBind = (value: unknown): string => {
  if (value === undefined) {
    return DEFAULT_BIND;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError('config: "bind" must be a non-empty string');
  }
  if (!isLoopback(value)) {
    throw new ConfigError(
      `config: "bind" must be a loopback address (127.0.0.1, ::1, or localhost), not "${value}". ccrcd has no authentication and every session it launches runs with bypassPermissions, so any other bind offers arbitrary code execution to the network.`,
    );
  }
  return value;
};

const ORIGIN_SCHEMES = new Set(['http:', 'https:']);

/**
 * The daemon is loopback-bound and fronted by a reverse proxy, so a browser
 * loading the proxy's host sends that host as `Origin` and would fail the
 * same-origin check on every mutation. This list is how the operator names the
 * proxy — and it stays a list of exact origins.
 *
 * Nothing here matches loosely: an entry has to round-trip through `URL.origin`
 * unchanged, which rejects a trailing slash, a path, a query, a fragment,
 * userinfo, a redundant default port, and any host casing that would otherwise
 * compare unequal against the header a browser actually sends. A default-empty
 * list leaves the guard exactly as strict as it is without one.
 */
const readOrigin = (value: unknown, at: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${at} must be a non-empty string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(
      `${at}: "${value}" is not an origin. Use an exact scheme-and-host origin such as "https://ccrc.example".`,
    );
  }
  if (!ORIGIN_SCHEMES.has(parsed.protocol)) {
    throw new ConfigError(`${at}: "${value}" must use the http or https scheme`);
  }
  // `*` survives URL parsing, so a wildcard has to be refused by name rather than
  // silently accepted as a hostname no browser will ever send.
  if (parsed.hostname.includes('*')) {
    throw new ConfigError(
      `${at}: "${value}" looks like a wildcard. Origins are matched exactly; list each one.`,
    );
  }
  if (parsed.origin !== value) {
    throw new ConfigError(
      `${at}: "${value}" must be an exact origin with no trailing slash, path, query, or fragment — did you mean "${parsed.origin}"?`,
    );
  }
  return parsed.origin;
};

const readAllowedOrigins = (value: unknown): readonly string[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError('config: "allowed_origins" must be a list of origin strings');
  }
  return value.map((entry, index) => readOrigin(entry, `config: allowed_origins[${index}]`));
};

const SUPERVISION_AT = 'config: [supervision]';

/**
 * A zero or negative interval would busy-loop the supervisor, and a zero threshold
 * would call every busy session hung, so every duration has to be positive.
 */
const readDuration = (
  source: Record<string, unknown>,
  key: string,
  unitMs: number,
  fallback: number,
): number => {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${SUPERVISION_AT}: "${key}" must be a positive number`);
  }
  return value * unitMs;
};

/** `0` is a legitimate cap: it turns automatic restarts off without turning off detection. */
const readRestartCap = (value: unknown): number => {
  if (value === undefined) {
    return DEFAULT_SUPERVISION.restartCap;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(
      `${SUPERVISION_AT}: "restart_cap" must be an integer of 0 or more (0 disables automatic restarts)`,
    );
  }
  return value;
};

const readSupervision = (value: unknown): SupervisionConfig => {
  if (value === undefined) {
    return DEFAULT_SUPERVISION;
  }
  if (!isRecord(value)) {
    throw new ConfigError('config: "supervision" must be a [supervision] table');
  }
  return {
    hangThresholdMs: readDuration(
      value,
      'hang_threshold_minutes',
      MINUTE_MS,
      DEFAULT_SUPERVISION.hangThresholdMs,
    ),
    intervalMs: readDuration(
      value,
      'reconcile_interval_seconds',
      SECOND_MS,
      DEFAULT_SUPERVISION.intervalMs,
    ),
    restartCap: readRestartCap(value.restart_cap),
    restartCapWindowMs: readDuration(
      value,
      'restart_cap_window_minutes',
      MINUTE_MS,
      DEFAULT_SUPERVISION.restartCapWindowMs,
    ),
    stoppedRetentionMs: readDuration(
      value,
      'stopped_retention_days',
      DAY_MS,
      DEFAULT_SUPERVISION.stoppedRetentionMs,
    ),
  };
};

export const parseConfig = (source: string, configPath: string, home: string): Config => {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (cause) {
    throw new ConfigError(
      `config at ${configPath} is not valid TOML: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(`config at ${configPath} must be a TOML table`);
  }
  return {
    allowedOrigins: readAllowedOrigins(parsed.allowed_origins),
    bind: readBind(parsed.bind),
    configPath,
    port: readPort(parsed.port),
    repos: readRepos(parsed.repos, home),
    stateDir: dirname(configPath),
    supervision: readSupervision(parsed.supervision),
  };
};

/** Reads the TOML config; a missing file is a fatal, explicit startup error. */
export const loadConfig = async (
  env: ConfigEnvironment = Bun.env,
  home: string = homedir(),
): Promise<Config> => {
  const configPath = configPathFrom(env, home);
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw new ConfigError(
      `ccrcd config not found at ${configPath}. Create it (or point CCRC_CONFIG at one) with:\n\nbind = "${DEFAULT_BIND}"\nport = ${DEFAULT_PORT}\n\n[[repos]]\nname = "example"\npath = "~/code/example"`,
    );
  }
  return parseConfig(await file.text(), configPath, home);
};

export const findRepo = (config: Config, name: string): RepoEntry | undefined =>
  config.repos.find((repo) => repo.name === name);

export const stateFilePath = (config: Config): string => join(config.stateDir, STATE_FILE_NAME);
