import type { FastifyInstance } from 'fastify';

export type FakeHandler = (req: { method: string; url: URL; body: unknown; headers: Headers }) =>
  | { status?: number; body?: unknown }
  | Promise<{ status?: number; body?: unknown }>;

/** A `fetch` replacement that answers from a handler function — for stubbing external APIs. */
export function fakeFetch(handler: FakeHandler): typeof fetch & { calls: { method: string; url: URL }[] } {
  const calls: { method: string; url: URL }[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const res = await handler({ method, url, body, headers: new Headers(init?.headers) });
    const status = res.status ?? 200;
    const payload = res.body === undefined || status === 204 ? null : JSON.stringify(res.body);
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
  };
  return Object.assign(fn, { calls }) as typeof fetch & { calls: { method: string; url: URL }[] };
}

/**
 * A `fetch` that routes requests to in-process Fastify apps by hostname, e.g.
 * `{ flight: flightApp }` serves `http://flight/...`. Lets tests exercise real
 * service-to-service contracts without opening sockets. Unknown hosts fail like a network error.
 */
export function fetchFromApps(apps: Record<string, FastifyInstance>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const app = apps[url.host];
    if (!app) throw new TypeError(`fetch failed: no app registered for ${url.host}`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v !== undefined && k !== 'content-length' && k !== 'transfer-encoding') outHeaders.set(k, String(v));
    }
    const body = res.statusCode === 204 || res.body === '' ? null : res.body;
    return new Response(body, { status: res.statusCode, headers: outHeaders });
  }) as typeof fetch;
}
