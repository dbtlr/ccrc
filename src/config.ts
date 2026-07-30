import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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
  /**
   * How long an idle session may sit with nothing happening before ccrcd stops it,
   * or `null` when the operator has not asked for that at all. Unset is off: a
   * session nobody is watching is not a problem until someone says it is.
   */
  readonly idleTimeoutMs: number | null;
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
  /**
   * Directory whose immediate subdirectories are launchable, and where new
   * workspaces are created. `null` when the operator has not configured one, which
   * turns both the scan and workspace creation off.
   */
  readonly workspacesRoot: string | null;
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
  idleTimeoutMs: null,
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

/**
 * Everything directly under this root becomes launchable, so it is held to the same
 * shape as a repo path: `~` is expanded and the result has to be an absolute path.
 * A relative root would resolve against whatever working directory the daemon
 * happened to be started in — under launchd, not one the operator chose.
 *
 * The directory itself need not exist yet; the first workspace creation makes it.
 */
const readWorkspacesRoot = (value: unknown, home: string): string | null => {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new ConfigError('config: "workspaces_root" must be a non-empty path string');
  }
  const expanded = expandHome(value, home);
  if (!isAbsolute(expanded)) {
    throw new ConfigError(
      `config: "workspaces_root" must be an absolute path or start with "~", not "${value}"`,
    );
  }
  // `resolve` on an already-absolute path normalises it and drops any trailing
  // separator without consulting the working directory, which keeps every later
  // join and containment check comparing like with like.
  return resolve(expanded);
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
 * Every supervision duration is a whole number of its own unit inside a range that
 * keeps the loop sane. Both ends matter:
 *
 * - a fraction is not a rounding nuisance but a behaviour change — a hang threshold
 *   of `0.00001` minutes calls every busy session hung on the next tick;
 * - past 2^31-1 milliseconds a timer interval wraps and fires continuously, so an
 *   interval an operator meant as "basically never" becomes a tick storm.
 */
const readDuration = (
  source: Record<string, unknown>,
  key: string,
  unitMs: number,
  fallback: number,
  range: { readonly min: number; readonly max: number },
): number => {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConfigError(`${SUPERVISION_AT}: "${key}" must be a whole number of its own unit`);
  }
  if (value < range.min || value > range.max) {
    throw new ConfigError(
      `${SUPERVISION_AT}: "${key}" must be between ${range.min} and ${range.max}`,
    );
  }
  return value * unitMs;
};

/**
 * A key with no default at all: absent means the feature is off, which is a
 * different answer from any number. Everything else about it — whole numbers, a
 * bounded range — is what the rest of the table is held to.
 */
const readOptionalDuration = (
  source: Record<string, unknown>,
  key: string,
  unitMs: number,
  range: { readonly min: number; readonly max: number },
): number | null =>
  source[key] === undefined ? null : readDuration(source, key, unitMs, 0, range);

/** Frequent enough to be useful, never so frequent that ticks overlap by design. */
const INTERVAL_SECONDS = { max: 3_600, min: 5 };
const THRESHOLD_MINUTES = { max: 1_440, min: 1 };
const WINDOW_MINUTES = { max: 10_080, min: 1 };
const RETENTION_DAYS = { max: 365, min: 1 };
/** Long enough that a pause for coffee is not a stop; short of a working week. */
const IDLE_MINUTES = { max: 10_080, min: 5 };

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
  const supervision: SupervisionConfig = {
    hangThresholdMs: readDuration(
      value,
      'hang_threshold_minutes',
      MINUTE_MS,
      DEFAULT_SUPERVISION.hangThresholdMs,
      THRESHOLD_MINUTES,
    ),
    idleTimeoutMs: readOptionalDuration(value, 'idle_timeout_minutes', MINUTE_MS, IDLE_MINUTES),
    intervalMs: readDuration(
      value,
      'reconcile_interval_seconds',
      SECOND_MS,
      DEFAULT_SUPERVISION.intervalMs,
      INTERVAL_SECONDS,
    ),
    restartCap: readRestartCap(value.restart_cap),
    restartCapWindowMs: readDuration(
      value,
      'restart_cap_window_minutes',
      MINUTE_MS,
      DEFAULT_SUPERVISION.restartCapWindowMs,
      WINDOW_MINUTES,
    ),
    stoppedRetentionMs: readDuration(
      value,
      'stopped_retention_days',
      DAY_MS,
      DEFAULT_SUPERVISION.stoppedRetentionMs,
      RETENTION_DAYS,
    ),
  };
  // A window shorter than the threshold could never hold two restarts of the same
  // session, which reads as a cap the operator did not ask for.
  if (supervision.restartCapWindowMs < supervision.hangThresholdMs) {
    throw new ConfigError(
      `${SUPERVISION_AT}: "restart_cap_window_minutes" must be at least "hang_threshold_minutes"`,
    );
  }
  // Restart history lives on records, and pruned records take their history with
  // them: retention that expires inside the window would reset the restart count
  // and let a repo that wedges every session be restarted forever.
  if (supervision.stoppedRetentionMs < supervision.restartCapWindowMs) {
    throw new ConfigError(
      `${SUPERVISION_AT}: "stopped_retention_days" must cover "restart_cap_window_minutes", or pruning would drop the history the restart cap is counted from`,
    );
  }
  return supervision;
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
    workspacesRoot: readWorkspacesRoot(parsed.workspaces_root, home),
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
