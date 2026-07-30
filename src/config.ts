import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ConfigError } from './errors.ts';

export type RepoEntry = {
  readonly name: string;
  readonly path: string;
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
};

export const DEFAULT_BIND = '127.0.0.1';
export const DEFAULT_PORT = 7433;
export const STATE_FILE_NAME = 'state.json';

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
