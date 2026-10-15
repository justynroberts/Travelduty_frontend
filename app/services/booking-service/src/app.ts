import { createService, notFound, type ServiceOptions } from '@travelduty/common';
import type { FastifyInstance } from 'fastify';
import { Counter } from 'prom-client';
import type { BookingRepository } from './repository.js';
import { cancelBooking, createBooking, type Clients, type SagaContext } from './saga.js';
import type { CreateBookingInput } from './types.js';

export interface BookingDeps {
  repo: BookingRepository;
  /** Receives the app so clients can record upstream metrics on it. */
  makeClients: (app: FastifyInstance) => Clients;
  /** Clear-down of synthetic traffic's bookings; omit to keep everything. */
  purge?: PurgeOptions;
  service?: Partial<ServiceOptions>;
}

export interface PurgeOptions {
  /** Bookings whose contact email is on this domain are synthetic. */
  domain: string;
  /** Finished synthetic bookings older than this are deleted. */
  retentionMs: number;
  intervalMs: number;
  now?: () => number;
}

const card = {
  type: 'object',
  required: ['number', 'expMonth', 'expYear', 'cvc', 'holderName'],
  properties: {
    number: { type: 'string', pattern: '^[0-9 ]{12,23}$' },
    expMonth: { type: 'integer', minimum: 1, maximum: 12 },
    expYear: { type: 'integer', minimum: 2000, maximum: 2100 },
    cvc: { type: 'string', pattern: '^[0-9]{3,4}$' },
    holderName: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

const createBookingSchema = {
  type: 'object',
  required: ['outboundOfferId', 'passengers', 'contact', 'payment'],
  properties: {
    outboundOfferId: { type: 'string', minLength: 1 },
    returnOfferId: { type: 'string', minLength: 1 },
    hotelOfferId: { type: 'string', minLength: 1 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'EUR' },
    passengers: {
      type: 'array',
      minItems: 1,
      maxItems: 9,
      items: {
        type: 'object',
        required: ['firstName', 'lastName'],
        properties: { firstName: { type: 'string', minLength: 1, maxLength: 60 }, lastName: { type: 'string', minLength: 1, maxLength: 60 } },
      },
    },
    contact: {
      type: 'object',
      required: ['email'],
      properties: { email: { type: 'string', format: 'email' }, phone: { type: 'string', maxLength: 30 } },
    },
    payment: { type: 'object', required: ['card'], properties: { card } },
  },
} as const;

export function buildBookingApp(deps: BookingDeps) {
  const app = createService({
    name: 'booking-service',
    readiness: { database: () => deps.repo.ping() },
    ...deps.service,
  });
  const clients = deps.makeClients(app);
  const bookings = new Counter({
    name: 'bookings_total',
    help: 'Booking outcomes',
    labelNames: ['status'],
    registers: [app.metrics.registry],
  });

  const ctx = (req: { id: string; log: SagaContext['log'] }): SagaContext => ({
    clients,
    repo: deps.repo,
    log: req.log,
    requestId: req.id,
    onOutcome: (status) => bookings.inc({ status }),
  });

  app.post<{ Body: CreateBookingInput }>('/bookings', { schema: { body: createBookingSchema } }, async (req, reply) => {
    const booking = await createBooking(ctx(req), req.body);
    return reply.code(201).send(booking);
  });

  app.get<{ Querystring: { email?: string; limit?: number } }>(
    '/bookings',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { email: { type: 'string', format: 'email' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        },
      },
    },
    async (req) => ({ items: await deps.repo.list({ email: req.query.email, limit: req.query.limit ?? 20 }) }),
  );

  app.get<{ Params: { ref: string } }>('/bookings/:ref', async (req) => {
    const booking = await deps.repo.get(req.params.ref.toUpperCase());
    if (!booking) throw notFound(`Booking ${req.params.ref} not found`);
    return booking;
  });

  app.post<{ Params: { ref: string } }>('/bookings/:ref/cancel', async (req) => {
    const booking = await deps.repo.get(req.params.ref.toUpperCase());
    if (!booking) throw notFound(`Booking ${req.params.ref} not found`);
    return cancelBooking(ctx(req), booking);
  });

  if (deps.purge) startPurge(app, deps.repo, deps.purge);

  return app;
}

/**
 * Hands-off clear-down: synthetic users book and cancel around the clock, so their finished
 * bookings are deleted once they are older than the retention window. Real bookings are never
 * touched, and neither is a synthetic booking still confirmed or in progress.
 */
function startPurge(app: FastifyInstance, repo: BookingRepository, opts: PurgeOptions) {
  const now = opts.now ?? Date.now;
  const purged = new Counter({
    name: 'cleardown_records_total',
    help: 'Finished records deleted by the automatic clear-down',
    labelNames: ['store'],
    registers: [app.metrics.registry],
  });
  const run = async () => {
    try {
      const n = await repo.purgeFinished(opts.domain, new Date(now() - opts.retentionMs));
      purged.inc({ store: 'bookings' }, n);
      if (n) app.log.info({ purged: n, domain: opts.domain }, 'synthetic bookings cleared down');
    } catch (err) {
      app.log.warn({ err }, 'synthetic clear-down failed; retrying next interval');
    }
  };
  let timer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    timer = setInterval(run, opts.intervalMs);
    timer.unref();
    void run();
  });
  app.addHook('onClose', async () => clearInterval(timer));
}
