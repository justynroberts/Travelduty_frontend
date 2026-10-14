/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export type UpstreamFailureKind = 'http' | 'timeout' | 'network';

/** A call to another service (internal or external) failed. */
export class UpstreamError extends Error {
  constructor(
    public readonly service: string,
    public readonly kind: UpstreamFailureKind,
    message: string,
    public readonly statusCode?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }

  /** The error code the upstream returned in its `{ error: { code } }` envelope, if any. */
  get upstreamCode(): string | undefined {
    const err = (this.body as { error?: { code?: unknown } } | undefined)?.error;
    return typeof err?.code === 'string' ? err.code : undefined;
  }

  get isClientError(): boolean {
    return this.kind === 'http' && this.statusCode !== undefined && this.statusCode < 500;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'BAD_REQUEST', message, details);
export const notFound = (message: string) => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);
