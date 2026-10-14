import { UpstreamError } from './errors.js';

type QueryValue = string | number | boolean | undefined | null;

export interface CallResult {
  target: string;
  method: string;
  outcome: 'success' | 'error';
  status?: number;
  durationMs: number;
}

export interface ClientOptions {
  /** Logical name used in errors and metrics, e.g. "flight-service" or "open-meteo". */
  name: string;
  baseUrl: string;
  timeoutMs?: number;
  /** Extra attempts for idempotent requests (GET, or any request with an idempotency key). */
  retries?: number;
  retryBaseDelayMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  onResult?: (result: CallResult) => void;
}

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Propagated as `x-request-id` so a single request can be traced across services. */
  requestId?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface Exchange<T> {
  status: number;
  body: T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal JSON HTTP client with timeouts, bounded retries with exponential backoff,
 * request-id propagation and per-call metrics. Non-2xx responses throw `UpstreamError`.
 */
export class ServiceClient {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly onResult?: (result: CallResult) => void;

  constructor(opts: ClientOptions) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.retries = opts.retries ?? 2;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 100;
    this.headers = opts.headers ?? {};
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onResult = opts.onResult;
  }

  get<T>(path: string, opts?: RequestOptions) {
    return this.request<T>('GET', path, opts);
  }
  post<T>(path: string, opts?: RequestOptions) {
    return this.request<T>('POST', path, opts);
  }
  put<T>(path: string, opts?: RequestOptions) {
    return this.request<T>('PUT', path, opts);
  }
  delete<T>(path: string, opts?: RequestOptions) {
    return this.request<T>('DELETE', path, opts);
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.exchange<T>(method, path, opts)).body;
  }

  /** Like `request` but also returns the upstream status code (useful when proxying). */
  async exchange<T>(method: string, path: string, opts: RequestOptions = {}): Promise<Exchange<T>> {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = { accept: 'application/json', ...this.headers, ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.requestId) headers['x-request-id'] = opts.requestId;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    const retryable = method === 'GET' || Boolean(opts.idempotencyKey);
    const attempts = retryable ? this.retries + 1 : 1;
    let lastError: UpstreamError | undefined;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      const started = performance.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
        });
      } catch (err) {
        const e = err as Error;
        const kind = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network';
        this.report(method, 'error', undefined, started);
        lastError = new UpstreamError(this.name, kind, `${this.name} ${kind === 'timeout' ? 'timed out' : 'unreachable'}: ${e.message}`);
        continue;
      }

      const body = await parseBody(res);
      if (res.ok) {
        this.report(method, 'success', res.status, started);
        return { status: res.status, body: body as T };
      }

      this.report(method, 'error', res.status, started);
      lastError = new UpstreamError(this.name, 'http', `${this.name} responded ${res.status} to ${method} ${url.pathname}`, res.status, body);
      // Client errors are deterministic; retrying will not help.
      if (res.status < 500) throw lastError;
    }
    throw lastError!;
  }

  private report(method: string, outcome: CallResult['outcome'], status: number | undefined, started: number) {
    this.onResult?.({ target: this.name, method, outcome, status, durationMs: performance.now() - started });
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
