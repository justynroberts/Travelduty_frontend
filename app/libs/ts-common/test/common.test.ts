import { describe, expect, it } from 'vitest';
import { ServiceClient, TtlCache, UpstreamError, createService } from '../src/index.js';
import { fakeFetch } from '../src/testing.js';

describe('ServiceClient', () => {
  it('retries idempotent requests on 5xx, then succeeds', async () => {
    let n = 0;
    const fetchImpl = fakeFetch(() => (++n < 3 ? { status: 503 } : { body: { ok: true } }));
    const c = new ServiceClient({ name: 'x', baseUrl: 'http://x/', retries: 2, retryBaseDelayMs: 1, fetchImpl });
    expect(await c.get('/thing', { query: { a: 1, skip: undefined } })).toEqual({ ok: true });
    expect(fetchImpl.calls).toHaveLength(3);
    expect(fetchImpl.calls[0]!.url.toString()).toBe('http://x/thing?a=1');
  });

  it('does not retry POSTs without an idempotency key, nor 4xx responses', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 503 }));
    const c = new ServiceClient({ name: 'x', baseUrl: 'http://x', retryBaseDelayMs: 1, fetchImpl });
    await expect(c.post('/p', { body: {} })).rejects.toBeInstanceOf(UpstreamError);
    expect(fetchImpl.calls).toHaveLength(1);

    const notFound = fakeFetch(() => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'nope' } } }));
    const c2 = new ServiceClient({ name: 'x', baseUrl: 'http://x', fetchImpl: notFound });
    const err = (await c2.get('/g').catch((e) => e)) as UpstreamError;
    expect(err.isClientError).toBe(true);
    expect(err.upstreamCode).toBe('NOT_FOUND');
    expect(notFound.calls).toHaveLength(1);
  });

  it('classifies timeouts', async () => {
    const fetchImpl = ((_: unknown, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const c = new ServiceClient({ name: 'slow', baseUrl: 'http://x', timeoutMs: 20, retries: 0, fetchImpl });
    const err = (await c.get('/g').catch((e) => e)) as UpstreamError;
    expect(err.kind).toBe('timeout');
  });
});

describe('TtlCache', () => {
  it('serves stale values when a refresh fails within the stale window', async () => {
    let t = 0;
    const cache = new TtlCache<number>(10, () => t);
    expect((await cache.getOrLoad('k', async () => 1, { ttlMs: 100, staleIfErrorMs: 1_000 })).value).toBe(1);
    t = 500;
    const r = await cache.getOrLoad('k', () => Promise.reject(new Error('down')), { ttlMs: 100, staleIfErrorMs: 1_000 });
    expect(r).toEqual({ value: 1, stale: true });
    t = 5_000;
    await expect(cache.getOrLoad('k', () => Promise.reject(new Error('down')), { ttlMs: 100, staleIfErrorMs: 1_000 })).rejects.toThrow('down');
  });

  it('coalesces concurrent misses', async () => {
    const cache = new TtlCache<number>();
    let loads = 0;
    const loader = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      return 7;
    };
    await Promise.all([1, 2, 3].map(() => cache.getOrLoad('k', loader, { ttlMs: 1_000 })));
    expect(loads).toBe(1);
  });
});

describe('createService', () => {
  const build = (chaos = {}) => {
    const app = createService({ name: 'svc', logger: false, chaos, random: () => 0 });
    app.get('/hello', async () => ({ hi: true }));
    app.get('/api/admin/ping', async () => ({ ok: true }));
    return app;
  };

  it('echoes request ids and serves health', async () => {
    const res = await build().inject({ url: '/hello', headers: { 'x-request-id': 'abc' } });
    expect(res.headers['x-request-id']).toBe('abc');
    expect((await build().inject({ url: '/health' })).json()).toMatchObject({ status: 'ok', service: 'svc' });
  });

  it('injects chaos except on operational endpoints', async () => {
    const app = build({ errorRate: 1 });
    const res = await app.inject({ url: '/hello' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('CHAOS_INJECTED');
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/ping' })).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: '/admin/chaos' });
    expect((await app.inject({ url: '/hello' })).statusCode).toBe(200);
  });

  it('uses the error envelope for unknown routes and validation errors', async () => {
    const app = build();
    expect((await app.inject({ url: '/missing' })).json().error.code).toBe('NOT_FOUND');
    const bad = await app.inject({ method: 'PUT', url: '/admin/chaos', payload: { errorRate: 3 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts an empty body sent with a JSON content-type', async () => {
    const app = build();
    app.post('/act', async (req) => ({ body: req.body ?? null }));
    const res = await app.inject({ method: 'POST', url: '/act', headers: { 'content-type': 'application/json' }, payload: '' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null });
    const bad = await app.inject({ method: 'POST', url: '/act', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('exposes route-templated metrics', async () => {
    const app = build();
    await app.inject({ url: '/hello' });
    expect((await app.inject({ url: '/metrics' })).body).toMatch(/http_requests_total\{method="GET",route="\/hello",status="200",service="svc"\} 1/);
  });
});
