import { ServiceClient } from '@travelduty/common';
import { fakeFetch, type FakeHandler } from '@travelduty/common/testing';
import { describe, expect, it } from 'vitest';
import { buildSynthetics } from '../src/app.js';
import { JOURNEY_WEIGHTS, pickJourney } from '../src/journeys.js';

const trip = (overrides = {}) => ({
  outbound: [{ id: 'FL.OUT', seatsLeft: 9 }],
  inbound: [{ id: 'FL.IN', seatsLeft: 9 }],
  hotels: [{ id: 'HT.1', roomsLeft: 3 }],
  degraded: [],
  ...overrides,
});

/** A fake gateway: happy by default, with per-route overrides keyed "METHOD /path". */
function fakeGateway(overrides: Record<string, FakeHandler> = {}) {
  const calls: string[] = [];
  const routes: Record<string, FakeHandler> = {
    'GET /api/destinations': () => ({ body: { count: 2, items: [{ code: 'LIS' }, { code: 'BCN' }] } }),
    'GET /api/destinations/:code': () => ({ body: { code: 'LIS' } }),
    'GET /api/fx/currencies': () => ({ body: { currencies: ['EUR'] } }),
    'GET /api/trips/search': () => ({ body: trip() }),
    'POST /api/bookings': () => ({ status: 201, body: { ref: 'TD-ABC123', status: 'CONFIRMED' } }),
    'GET /api/bookings/:ref': () => ({ body: { ref: 'TD-ABC123' } }),
    'GET /api/notifications': () => ({ body: { items: [] } }),
    'POST /api/bookings/:ref/cancel': () => ({ body: { status: 'CANCELLED' } }),
    'GET /api/bookings': () => ({ body: { items: [] } }),
    ...overrides,
  };
  const fetchImpl = fakeFetch((req) => {
    const path = req.url.pathname.replace(/\/TD-[A-Z0-9]+/, '/:ref').replace(/\/destinations\/[A-Z]{3}$/, '/destinations/:code');
    const key = `${req.method} ${path}`;
    calls.push(key);
    const handler = routes[key];
    return handler ? handler(req) : { status: 404, body: { error: { code: 'NOT_FOUND', message: key } } };
  });
  const gateway = new ServiceClient({ name: 'gateway', baseUrl: 'http://gateway', retries: 0, fetchImpl });
  return { gateway, calls };
}

const build = (overrides: Record<string, FakeHandler> = {}, adminToken?: string) => {
  const { gateway, calls } = fakeGateway(overrides);
  const s = buildSynthetics({ makeGateway: () => gateway, adminToken, random: () => 0.3, service: { logger: false } });
  return { ...s, calls };
};

describe('journey mix', () => {
  it('picks journeys in proportion to their weights', () => {
    const total = Object.values(JOURNEY_WEIGHTS).reduce((a, b) => a + b, 0);
    const counts: Record<string, number> = {};
    for (let i = 0; i < total * 10; i++) {
      const j = pickJourney(() => (i + 0.5) / (total * 10));
      counts[j] = (counts[j] ?? 0) + 1;
    }
    for (const [j, w] of Object.entries(JOURNEY_WEIGHTS)) expect(counts[j]).toBe(w * 10);
  });
});

describe('journeys', () => {
  it('books, checks and cancels, leaving no inventory held', async () => {
    const { runOnce, calls } = build();
    const r = await runOnce('book');
    expect(r.outcome).toBe('ok');
    expect(calls).toEqual([
      'GET /api/destinations',
      'GET /api/trips/search',
      'POST /api/bookings',
      'GET /api/bookings/:ref',
      'GET /api/notifications',
      'POST /api/bookings/:ref/cancel',
    ]);
  });

  it('names the failing step and the upstream error', async () => {
    const { runOnce } = build({ 'GET /api/destinations': () => ({ status: 503, body: { error: { code: 'CHAOS_INJECTED', message: 'boom' } } }) });
    const r = await runOnce('browse');
    expect(r).toMatchObject({ outcome: 'failed', step: 'GET /api/destinations', detail: 'HTTP 503 CHAOS_INJECTED' });
  });

  it('reports a degraded search with the degraded services', async () => {
    const { runOnce } = build({ 'GET /api/trips/search': () => ({ body: trip({ hotels: null, degraded: [{ service: 'hotel-service' }] }) }) });
    expect(await runOnce('search')).toMatchObject({ outcome: 'degraded', detail: 'hotel-service' });
  });

  it('reports sold out rather than failing when no offer has room', async () => {
    const { runOnce, calls } = build({ 'GET /api/trips/search': () => ({ body: trip({ hotels: [{ id: 'HT.1', roomsLeft: 0 }] }) }) });
    expect((await runOnce('book')).outcome).toBe('sold_out');
    expect(calls).not.toContain('POST /api/bookings');
  });

  it('retries a failed cancellation on the next booking', async () => {
    let cancelOk = false;
    const { runOnce, app, calls } = build({
      'POST /api/bookings/:ref/cancel': () => (cancelOk ? { body: { status: 'CANCELLED' } } : { status: 503, body: { error: { code: 'CHAOS_INJECTED', message: 'x' } } }),
    });
    expect(await runOnce('book')).toMatchObject({ outcome: 'failed', step: 'POST /api/bookings/:ref/cancel' });
    expect((await app.inject({ url: '/status' })).json().pendingCancellations).toEqual(['TD-ABC123']);

    cancelOk = true;
    calls.length = 0;
    expect((await runOnce('book')).outcome).toBe('ok');
    expect(calls[0]).toBe('POST /api/bookings/:ref/cancel');
    expect((await app.inject({ url: '/status' })).json().pendingCancellations).toEqual([]);
  });
});

describe('service', () => {
  it('exports journey metrics labelled by outcome and failing step', async () => {
    const { runOnce, app } = build({ 'GET /api/bookings': () => ({ status: 502, body: { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'x' } } }) });
    await runOnce('browse');
    await runOnce('my-trips');
    const metrics = (await app.inject({ url: '/metrics' })).body;
    expect(metrics).toMatch(/synthetic_journeys_total\{journey="browse",outcome="ok",step="",service="synthetics"\} 1/);
    expect(metrics).toMatch(/synthetic_journeys_total\{journey="my-trips",outcome="failed",step="GET \/api\/bookings",service="synthetics"\} 1/);
    expect(metrics).toMatch(/synthetic_journey_duration_seconds_count\{service="synthetics",journey="browse",outcome="ok"\} 1/);
  });

  it('pauses and resumes behind the admin token', async () => {
    const { app } = build({}, 'tok');
    expect((await app.inject({ method: 'POST', url: '/admin/synthetics/pause' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/synthetics/pause', headers: { 'x-admin-token': 'tok' } })).json()).toEqual({ running: false });
    expect((await app.inject({ url: '/status' })).json().running).toBe(false);
    await app.inject({ method: 'POST', url: '/admin/synthetics/resume', headers: { 'x-admin-token': 'tok' } });
    expect((await app.inject({ url: '/status' })).json().running).toBe(true);
  });
});
