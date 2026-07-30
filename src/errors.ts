/** Errors that carry the HTTP status the transport should answer with. */
export class CcrcError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CcrcError';
    this.status = status;
  }
}

/** Malformed request payload — missing or wrong-typed fields. */
export class BadRequestError extends CcrcError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'BadRequestError';
  }
}

/** A mutating request that did not prove it came from a same-origin caller. */
export class ForbiddenError extends CcrcError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

/** A mutating request whose body was not declared as JSON. */
export class UnsupportedMediaTypeError extends CcrcError {
  constructor(message: string) {
    super(message, 415);
    this.name = 'UnsupportedMediaTypeError';
  }
}

/** Unknown repo name or unknown session id. */
export class NotFoundError extends CcrcError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

/** A launch that could not be completed (tmux failure, attach URL never appeared). */
export class LaunchError extends CcrcError {
  constructor(message: string) {
    super(message, 502);
    this.name = 'LaunchError';
  }
}

/** A kill that tmux refused for a reason other than "no such session". */
export class StopError extends CcrcError {
  constructor(message: string) {
    super(message, 502);
    this.name = 'StopError';
  }
}

/** Config file missing or unusable — fatal at startup, never served. */
export class ConfigError extends CcrcError {
  constructor(message: string) {
    super(message, 500);
    this.name = 'ConfigError';
  }
}

export const statusOf = (error: unknown): number =>
  error instanceof CcrcError ? error.status : 500;

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
