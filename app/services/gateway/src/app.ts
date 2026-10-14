import { HttpError, createService, round2, type ServiceClient, type ServiceOptions } from '@travelduty/common';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type ServiceName = 'destination' | 'flight' | 'hotel' | 'pricing' | 'booking' | 'payment' | 'notification';
export type Clients = Record<ServiceName, ServiceClient>;

export interface GatewayDeps {
  makeClients: (app: FastifyInstance) => Clients;
  /** Token forwarded to services' /admin endpoints. */
  adminToken?: string;
  service?: Partial<ServiceOptions>;
}

type Query = Record<string, string | undefined>;

interface Priced {
  totalEur: number;
}

interface Rates {
  base: string;
  date: string;
  rates: Record<string, number>;
  stale: boolean;
}

const SERVICES: ServiceName[] = ['destination', 'flight', 'hotel', 'pricing', 'booking', 'payment', 'notification'];

/**
 * The public edge of the platform (the web app's backend-for-frontend). Most routes are thin
 * pass-throughs; `/api/trips/search` fans out to five services and degrades gracefully.
 */
export function buildGateway(deps: GatewayDeps) {
  const app = createService({ name: 'gateway', ...deps.service });
  const c = deps.makeClients(app);

  /** Forward a request and mirror the upstream status code (errors go through the shared handler). */
  const pass =
    (svc: ServiceName, method: string, path: (req: FastifyRequest) => string) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const res = await c[svc].exchange(method, path(req), {
        requestId: req.id,
        query: req.query as Query,
        body: method === 'GET' ? undefined : (req.body ?? undefined),
        idempotencyKey: req.headers['idempotency-key'] as string | undefined,
      });
      return reply.code(res.status).send(res.body);
    };

  const param = (req: FastifyRequest, name: string) => encodeURIComponent((req.params as Record<string, string>)[name] ?? '');

  app.get('/api/destinations', pass('destination', 'GET', () => '/destinations'));
  app.get('/api/destinations/:code', pass('destination', 'GET', (r) => `/destinations/${param(r, 'code')}`));
  app.get('/api/geocode', pass('destination', 'GET', () => '/geocode'));
  app.get('/api/flights/search', pass('flight', 'GET', () => '/flights/search'));
  app.get('/api/hotels/search', pass('hotel', 'GET', () => '/hotels/search'));
  app.get('/api/fx/rates', pass('pricing', 'GET', () => '/fx/rates'));
  app.get('/api/fx/currencies', pass('pricing', 'GET', () => '/fx/currencies'));
  app.post('/api/bookings', pass('booking', 'POST', () => '/bookings'));
  app.get('/api/bookings', pass('booking', 'GET', () => '/bookings'));
  app.get('/api/bookings/:ref', pass('booking', 'GET', (r) => `/bookings/${param(r, 'ref')}`));
  app.post('/api/bookings/:ref/cancel', pass('booking', 'POST', (r) => `/bookings/${param(r, 'ref')}/cancel`));
  app.get('/api/notifications', pass('notification', 'GET', () => '/notifications'));

  app.get<{
    Querystring: { from: string; to: string; depart: string; return?: string; adults: number; cabin?: string; currency: string };
  }>(
    '/api/trips/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['from', 'to', 'depart'],
          properties: {
            from: { type: 'string', pattern: '^[A-Za-z]{3}$' },
            to: { type: 'string', pattern: '^[A-Za-z]{3}$' },
            depart: { type: 'string', format: 'date' },
            return: { type: 'string', format: 'date' },
            adults: { type: 'integer', minimum: 1, maximum: 6, default: 1 },
            cabin: { type: 'string', enum: ['economy', 'premium', 'business'] },
            currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'EUR' },
          },
        },
      },
    },
    async (req) => {
      const q = req.query;
      const from = q.from.toUpperCase();
      const to = q.to.toUpperCase();
      if (q.return && q.return <= q.depart) throw new HttpError(400, 'VALIDATION_ERROR', 'return must be after depart');
      const opts = { requestId: req.id };

      const [outbound, inbound, hotels, destination, rates] = await Promise.allSettled([
        c.flight.get<{ items: Priced[] }>('/flights/search', { ...opts, query: { from, to, date: q.depart, adults: q.adults, cabin: q.cabin } }),
        q.return
          ? c.flight.get<{ items: Priced[] }>('/flights/search', { ...opts, query: { from: to, to: from, date: q.return, adults: q.adults, cabin: q.cabin } })
          : Promise.resolve(undefined),
        q.return
          ? c.hotel.get<{ items: Priced[]; nights: number }>('/hotels/search', { ...opts, query: { city: to, checkIn: q.depart, checkOut: q.return, guests: q.adults } })
          : Promise.resolve(undefined),
        c.destination.get<Record<string, unknown>>(`/destinations/${to}`, {
          ...opts,
          query: { include: 'weather,holidays', from: q.depart, to: q.return ?? q.depart },
        }),
        q.currency === 'EUR' ? Promise.resolve(undefined) : c.pricing.get<Rates>('/fx/rates', { ...opts, query: { base: 'EUR' } }),
      ]);

      // Flights are the core of the product: without them there is nothing to sell.
      if (outbound.status === 'rejected') throw outbound.reason;
      if (inbound.status === 'rejected') throw inbound.reason;

      const degraded: { service: string; reason: string }[] = [];
      const soft = <T>(r: PromiseSettledResult<T>, service: string): T | null => {
        if (r.status === 'fulfilled') return r.value;
        degraded.push({ service, reason: (r.reason as Error).message });
        req.log.warn({ err: r.reason, service }, 'trip search degraded');
        return null;
      };

      const rateResult = soft(rates, 'pricing-service');
      let currency = q.currency;
      let rate = 1;
      if (q.currency !== 'EUR') {
        const r = rateResult?.rates[q.currency];
        if (r) rate = r;
        else {
          currency = 'EUR';
          if (rateResult) degraded.push({ service: 'pricing-service', reason: `No rate for ${q.currency}` });
        }
      }
      const price = <T extends Priced>(items: T[] | undefined) =>
        items?.map((o) => ({ ...o, price: { amount: round2(o.totalEur * rate), currency } }));

      const hotelResult = soft(hotels, 'hotel-service');
      return {
        query: { from, to, depart: q.depart, return: q.return ?? null, adults: q.adults, cabin: q.cabin ?? 'economy', currency: q.currency },
        currency,
        rate: { value: rate, date: rateResult?.date ?? null, stale: rateResult?.stale ?? false },
        destination: soft(destination, 'destination-service'),
        outbound: price(outbound.value.items),
        inbound: price(inbound.value?.items) ?? null,
        hotels: q.return ? (price(hotelResult?.items) ?? null) : null,
        nights: hotelResult?.nights ?? null,
        degraded,
      };
    },
  );

  /** Platform status: health + latency of every service, for the ops panel. */
  app.get('/api/status', async (req) => {
    const results = await Promise.all(
      SERVICES.map(async (name) => {
        const started = performance.now();
        try {
          const h = await c[name].get<{ version?: string; uptimeSeconds?: number }>('/health', { requestId: req.id, timeoutMs: 2_000 });
          return { service: `${name}-service`, status: 'up', latencyMs: Math.round(performance.now() - started), version: h.version, uptimeSeconds: h.uptimeSeconds };
        } catch (err) {
          return { service: `${name}-service`, status: 'down', latencyMs: Math.round(performance.now() - started), error: (err as Error).message };
        }
      }),
    );
    return { status: results.every((r) => r.status === 'up') ? 'ok' : 'degraded', services: results };
  });

  // Chaos control for every service through one door — handy for incident-response demos.
  const adminHeaders = deps.adminToken ? { 'x-admin-token': deps.adminToken } : undefined;
  const chaosTarget = (req: FastifyRequest) => {
    const name = (req.params as { service: string }).service.replace(/-service$/, '');
    if (name === 'gateway') return undefined;
    if (!SERVICES.includes(name as ServiceName)) throw new HttpError(404, 'NOT_FOUND', `Unknown service ${name}`);
    return c[name as ServiceName];
  };
  const requireAdmin = async (req: FastifyRequest) => {
    if (deps.adminToken && req.headers['x-admin-token'] !== deps.adminToken) {
      throw new HttpError(401, 'UNAUTHORIZED', 'A valid x-admin-token header is required');
    }
  };

  app.get('/api/admin/chaos', { preHandler: requireAdmin }, async (req) => {
    const entries = await Promise.all(
      SERVICES.map(async (name) => {
        try {
          return [`${name}-service`, await c[name].get('/admin/chaos', { requestId: req.id, headers: adminHeaders, timeoutMs: 2_000 })] as const;
        } catch {
          return [`${name}-service`, null] as const;
        }
      }),
    );
    return { gateway: app.chaos, ...Object.fromEntries(entries) };
  });

  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    app.route({
      method,
      url: '/api/admin/chaos/:service',
      preHandler: requireAdmin,
      handler: async (req) => {
        const target = chaosTarget(req);
        if (!target) {
          // The gateway's own chaos state lives in-process.
          if (method === 'PUT') Object.assign(app.chaos, req.body);
          if (method === 'DELETE') Object.assign(app.chaos, { latencyMs: 0, jitterMs: 0, errorRate: 0, errorStatus: 503 });
          return app.chaos;
        }
        return target.request(method, '/admin/chaos', { requestId: req.id, headers: adminHeaders, body: method === 'PUT' ? req.body : undefined });
      },
    });
  }

  return app;
}
