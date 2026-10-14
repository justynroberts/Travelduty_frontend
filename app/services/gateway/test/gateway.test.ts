import { ServiceClient } from '@travelduty/common';
import { fakeFetch, type FakeHandler } from '@travelduty/common/testing';
import { describe, expect, it } from 'vitest';
import { buildGateway, type Clients, type ServiceName } from '../src/app.js';

const offers = (prefix: string) => ({ items: [{ id: `${prefix}.0`, totalEur: 100 }, { id: `${prefix}.1`, totalEur: 150 }] });

/** Default happy-path upstreams; tests override per service. */
const upstreams: Record<ServiceName, FakeHandler> = {
  destination: ({ url }) => ({ body: { code: url.pathname.split('/')[2], city: 'Lisbon', weather: { days: [] } } }),
  flight: ({ url }) => ({ body: offers(`FL.${url.searchParams.get('from')}`) }),
  hotel: () => ({ body: { nights: 4, items: [{ id: 'HT.LIS.1', totalEur: 400 }] } }),
  pricing: () => ({ body: { base: 'EUR', date: '2026-10-13', rates: { GBP: 0.85, USD: 1.1 }, stale: false } }),
  booking: ({ method, body }) => (method === 'POST' ? { status: 201, body: { ref: 'TD-AAAAAA', echo: body } } : { body: { items: [] } }),
  payment: () => ({ body: {} }),
  notification: () => ({ body: { items: [] } }),
};

function gateway(overrides: Partial<Record<ServiceName, FakeHandler>> = {}, adminToken?: string) {
  const seen: Record<string, string[]> = {};
  const clients = Object.fromEntries(
    (Object.keys(upstreams) as ServiceName[]).map((name) => {
      const handler = overrides[name] ?? upstreams[name];
      const fetchImpl = fakeFetch((req) => {
        (seen[name] ??= []).push(`${req.method} ${req.url.pathname}${req.url.search} rid=${req.headers.get('x-request-id')}`);
        return handler(req);
      });
      return [name, new ServiceClient({ name: `${name}-service`, baseUrl: `http://${name}`, retries: 0, fetchImpl })];
    }),
  ) as Clients;
  return { app: buildGateway({ makeClients: () => clients, adminToken, service: { logger: false } }), seen };
}

const trip = '/api/trips/search?from=lhr&to=LIS&depart=2026-11-02&return=2026-11-06&adults=2&currency=GBP';

describe('trip search', () => {
  it('fans out, converts prices and propagates the request id', async () => {
    const { app, seen } = gateway();
    const res = await app.inject({ url: trip, headers: { 'x-request-id': 'trace-1' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currency).toBe('GBP');
    expect(body.outbound[0]).toMatchObject({ id: 'FL.LHR.0', price: { amount: 85, currency: 'GBP' } });
    expect(body.inbound[0].id).toBe('FL.LIS.0');
    expect(body.hotels[0].price).toEqual({ amount: 340, currency: 'GBP' });
    expect(body.nights).toBe(4);
    expect(body.destination.city).toBe('Lisbon');
    expect(body.degraded).toEqual([]);
    expect(seen.flight).toEqual([
      'GET /flights/search?from=LHR&to=LIS&date=2026-11-02&adults=2 rid=trace-1',
      'GET /flights/search?from=LIS&to=LHR&date=2026-11-06&adults=2 rid=trace-1',
    ]);
    expect(seen.hotel?.[0]).toContain('city=LIS&checkIn=2026-11-02&checkOut=2026-11-06&guests=2');
  });

  it('degrades when hotels, destination info and FX are unavailable', async () => {
    const down: FakeHandler = () => ({ status: 503, body: { error: { code: 'CHAOS_INJECTED', message: 'boom' } } });
    const { app } = gateway({ hotel: down, destination: down, pricing: down });
    const res = await app.inject({ url: trip });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hotels).toBeNull();
    expect(body.destination).toBeNull();
    expect(body.currency).toBe('EUR'); // falls back to EUR prices
    expect(body.outbound[0].price).toEqual({ amount: 100, currency: 'EUR' });
    expect(body.degraded.map((d: { service: string }) => d.service).sort()).toEqual(['destination-service', 'hotel-service', 'pricing-service']);
  });

  it('fails with 502 when flights are unavailable', async () => {
    const { app } = gateway({ flight: () => ({ status: 500 }) });
    const res = await app.inject({ url: trip });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', service: 'flight-service' });
  });

  it('validates the query', async () => {
    const { app } = gateway();
    for (const url of ['/api/trips/search?from=LHR&depart=2026-11-02', '/api/trips/search?from=LHR&to=LIS&depart=2026-11-06&return=2026-11-02']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('pass-through routes', () => {
  it('mirrors upstream status codes and bodies', async () => {
    const { app } = gateway({
      booking: ({ url }) =>
        url.pathname === '/bookings/TD-MISSING'
          ? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Booking TD-MISSING not found' } } }
          : { status: 201, body: { ref: 'TD-AAAAAA' } },
    });
    const created = await app.inject({ method: 'POST', url: '/api/bookings', payload: { outboundOfferId: 'x' } });
    expect(created.statusCode).toBe(201);
    const missing = await app.inject({ url: '/api/bookings/TD-MISSING' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe('Booking TD-MISSING not found');
  });

  it('forwards card declines as 402', async () => {
    const { app } = gateway({
      booking: () => ({ status: 402, body: { error: { code: 'CARD_DECLINED', message: 'Your card was declined' } } }),
    });
    const res = await app.inject({ method: 'POST', url: '/api/bookings', payload: {} });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('CARD_DECLINED');
  });
});

describe('ops endpoints', () => {
  it('reports per-service status', async () => {
    const { app } = gateway({ payment: () => ({ status: 503 }) });
    const body = (await app.inject({ url: '/api/status' })).json();
    expect(body.status).toBe('degraded');
    expect(body.services).toHaveLength(7);
    expect(body.services.find((s: { service: string }) => s.service === 'payment-service').status).toBe('down');
  });

  it('proxies chaos control and enforces the admin token', async () => {
    const { app, seen } = gateway({ payment: ({ body }) => ({ body: { errorRate: (body as { errorRate: number }).errorRate } }) }, 'tok');
    expect((await app.inject({ method: 'PUT', url: '/api/admin/chaos/payment-service', payload: { errorRate: 0.5 } })).statusCode).toBe(401);
    const res = await app.inject({ method: 'PUT', url: '/api/admin/chaos/payment-service', payload: { errorRate: 0.5 }, headers: { 'x-admin-token': 'tok' } });
    expect(res.json()).toEqual({ errorRate: 0.5 });
    expect(seen.payment?.[0]).toMatch(/^PUT \/admin\/chaos/);
    const unknown = await app.inject({ url: '/api/admin/chaos/nope', headers: { 'x-admin-token': 'tok' } });
    expect(unknown.statusCode).toBe(404);
  });
});
