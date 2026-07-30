import { join, resolve, sep } from 'node:path';

/**
 * Serves the built console out of `ui/dist`. The daemon is one process: the API and
 * the screen that drives it come from the same origin, so the browser's own
 * same-origin rules are doing real work rather than being waved through by CORS.
 *
 * Nothing here reads the repo registry or the session store — the console talks to
 * the JSON API like any other client.
 */

const INDEX_FILE = 'index.html';
const ASSET_PREFIX = '/assets/';

/** Vite fingerprints everything under `/assets/`, so those may be cached forever. */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** The shell names the hashed assets, so it must never be the stale copy. */
const SHELL_CACHE_CONTROL = 'no-cache';

const MISSING_BUILD_MESSAGE = `The ccrcd web console has not been built.

Run "bun run build" in the ccrcd checkout and restart the daemon. The JSON API is
unaffected and still answers on this port.
`;

export type UiServer = {
  /**
   * The asset a path names, the SPA shell for anything else, or a plain-text
   * explanation when the console was never built.
   */
  readonly serve: (pathname: string) => Promise<Response>;
};

export const defaultUiDir = (): string => join(import.meta.dir, '..', '..', 'ui', 'dist');

/** A path that escapes the build directory, or cannot be decoded, names nothing. */
const withinBuild = (root: string, pathname: string): string | undefined => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) {
    return undefined;
  }
  const candidate = resolve(root, `.${decoded}`);
  return candidate.startsWith(root + sep) ? candidate : undefined;
};

const fileResponse = async (path: string, cacheControl: string): Promise<Response | undefined> => {
  const file = Bun.file(path);
  return (await file.exists())
    ? new Response(file, { headers: { 'cache-control': cacheControl } })
    : undefined;
};

export const createUiServer = (uiDir: string): UiServer => {
  const root = resolve(uiDir);
  const indexPath = join(root, INDEX_FILE);

  /**
   * A missing build is answered, not crashed on: the operator gets the command that
   * fixes it, and `503` says the console is unavailable rather than absent.
   */
  const shell = async (): Promise<Response> =>
    (await fileResponse(indexPath, SHELL_CACHE_CONTROL)) ??
    new Response(MISSING_BUILD_MESSAGE, {
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      status: 503,
    });

  const serve = async (pathname: string): Promise<Response> => {
    const path = withinBuild(root, pathname);
    if (path === undefined) {
      return shell();
    }
    const asset = await fileResponse(path, ASSET_CACHE_CONTROL);
    if (asset !== undefined) {
      return asset;
    }
    /**
     * A fingerprinted asset that is not there is a stale shell asking for a build
     * that no longer exists. Answering with HTML would make that a mystifying MIME
     * error in the console, so it is a plain `404`.
     */
    if (pathname.startsWith(ASSET_PREFIX)) {
      return new Response('not found\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        status: 404,
      });
    }
    // Everything else is a client-side route: the shell resolves it.
    return shell();
  };

  return { serve };
};
