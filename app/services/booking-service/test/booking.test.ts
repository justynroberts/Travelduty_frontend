import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBookingApp } from '../src/app.js';
import { MemoryBookingRepository } from '../src/repository.js';
import { FakeWorld, validBooking } from './fakes.js';

let world: FakeWorld;
let repo: MemoryBookingRepository;

const build = () => buildBookingApp({ repo, makeClients: () => world.clients(), service: { logger: false } });

beforeEach(() => {
  world = new FakeWorld();
  repo = new MemoryBookingRepository();
});

describe('booking saga', () => {
  it('holds, quotes, charges, confirms and notifies', async () => {
    const app = build();
    const res = await app.inject({ method: 'POST', url: '/bookings', payload: validBooking(), headers: { 'x-request-id': 'trace-42' } });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b.ref).toMatch(/^TD-[A-Z2-9]{6}$/);
    expect(b.status).toBe('CONFIRMED');
    expect(b.flights.map((f: { direction: string }) => f.direction)).toEqual(['outbound', 'return']);
    expect(b.flights[0].tickets).toHaveLength(2);
    expect(b.hotel.confirmationCode).toBe('HTL-ABC234');
    // 2 pax × €100 × 2 flights + €400 hotel + €4.99 fee
    expect(b.quote.total).toBeCloseTo(804.99);
    expect(b.payment).toMatchObject({ status: 'captured', last4: '4242', brand: 'visa' });
    expect(JSON.stringify(b)).not.toContain('4242424242424242');
    expect(world.holdStatuses('flight')).toEqual(['confirmed', 'confirmed']);
    expect(world.notifications).toEqual([{ template: 'booking_confirmed', to: 'ada@example.com' }]);
    expect(world.calls).toEqual([
      'POST flight-service/holds',
      'POST flight-service/holds',
      'POST hotel-service/holds',
      'POST pricing-service/quotes',
      'POST payment-service/payments',
      'POST flight-service/holds/{id}/confirm',
      'POST flight-service/holds/{id}/confirm',
      'POST hotel-service/holds/{id}/confirm',
      'POST notification-service/notifications',
    ]);
    expect((await repo.get(b.ref))?.status).toBe('CONFIRMED');
  });

  it('releases every hold when the card is declined, and returns 402', async () => {
    world.on('POST payment-service/payments', () => ({
      status: 402,
      body: { error: { code: 'CARD_DECLINED', message: 'Your card was declined', details: { declineCode: 'generic_decline' } } },
    }));
    const res = await build().inject({ method: 'POST', url: '/bookings', payload: validBooking() });
    expect(res.statusCode).toBe(402);
    const err = res.json().error;
    expect(err.code).toBe('CARD_DECLINED');
    expect(err.details).toMatchObject({ step: 'charge_payment', service: 'payment-service' });

    expect(world.holdStatuses('flight')).toEqual(['cancelled', 'cancelled']);
    expect(world.holdStatuses('hotel')).toEqual(['cancelled']);
    const stored = await repo.get(err.details.bookingRef);
    expect(stored?.status).toBe('FAILED');
    expect(stored?.failure).toMatchObject({ step: 'charge_payment', code: 'CARD_DECLINED' });
    expect(world.notifications.map((n) => n.template)).toEqual(['booking_failed']);
  });

  it('releases the flight when the hotel is sold out', async () => {
    world.on('POST hotel-service/holds', () => ({ status: 409, body: { error: { code: 'SOLD_OUT', message: 'Only 0 rooms left' } } }));
    const res = await build().inject({ method: 'POST', url: '/bookings', payload: validBooking() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SOLD_OUT');
    expect(world.holdStatuses('flight')).toEqual(['cancelled', 'cancelled']);
    expect(world.calls).not.toContain('POST payment-service/payments');
  });

  it('refunds the charge when inventory confirmation fails after payment', async () => {
    world.on('POST hotel-service/holds/{id}/confirm', () => ({ status: 409, body: { error: { code: 'HOLD_EXPIRED', message: 'expired' } } }));
    const res = await build().inject({ method: 'POST', url: '/bookings', payload: validBooking() });
    expect(res.statusCode).toBe(409);
    const stored = await repo.get(res.json().error.details.bookingRef);
    expect(stored?.payment).toMatchObject({ status: 'refunded' });
    expect([...world.payments.values()][0]!.refunded).toBeGreaterThan(0);
    expect(stored?.timeline.map((t) => t.event)).toContain('refund_payment.compensated');
  });

  it('maps a payment processor outage to 502 and compensates', async () => {
    world.on('POST payment-service/payments', () => ({ status: 503, body: { error: { code: 'CHAOS_INJECTED', message: 'Injected failure in payment-service' } } }));
    const res = await build().inject({ method: 'POST', url: '/bookings', payload: validBooking() });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', details: { service: 'payment-service' } });
    expect(world.holdStatuses('flight')).toEqual(['cancelled', 'cancelled']);
  });

  it('still confirms when the notification service is down', async () => {
    world.on('POST notification-service/notifications', () => ({ status: 500 }));
    const res = await build().inject({ method: 'POST', url: '/bookings', payload: validBooking({ returnOfferId: undefined, hotelOfferId: undefined }) });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b.status).toBe('CONFIRMED');
    expect(b.timeline.map((t: { event: string }) => t.event)).toContain('notification.booking_confirmed.failed');
  });

  it('rejects invalid input before touching any service', async () => {
    const res = await build().inject({
      method: 'POST',
      url: '/bookings',
      payload: validBooking({ passengers: [], contact: { email: 'nope' } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(world.calls).toEqual([]);
  });
});

describe('booking queries and cancellation', () => {
  it('lists by email, fetches by ref and cancels with a refund', async () => {
    const app = build();
    const { ref } = (await app.inject({ method: 'POST', url: '/bookings', payload: validBooking() })).json();

    const list = (await app.inject({ url: '/bookings?email=ADA@example.com' })).json();
    expect(list.items.map((b: { ref: string }) => b.ref)).toEqual([ref]);
    expect((await app.inject({ url: `/bookings/${ref.toLowerCase()}` })).statusCode).toBe(200);
    expect((await app.inject({ url: '/bookings/TD-NOPE00' })).statusCode).toBe(404);

    const cancelled = await app.inject({ method: 'POST', url: `/bookings/${ref}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED', payment: { status: 'refunded' } });
    expect(world.holdStatuses('flight')).toEqual(['cancelled', 'cancelled']);
    expect(world.notifications.map((n) => n.template)).toEqual(['booking_confirmed', 'booking_cancelled']);

    const again = await app.inject({ method: 'POST', url: `/bookings/${ref}/cancel` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('NOT_CANCELLABLE');
  });

  it('records booking outcomes in metrics and reports readiness', async () => {
    const app = build();
    await app.inject({ method: 'POST', url: '/bookings', payload: validBooking() });
    const metrics = (await app.inject({ url: '/metrics' })).body;
    expect(metrics).toMatch(/bookings_total\{status="CONFIRMED",service="booking-service"\} 1/);
    expect(metrics).toContain('upstream_calls_total');
    expect((await app.inject({ url: '/ready' })).json()).toEqual({ status: 'ready', checks: { database: true } });
  });
});

describe('synthetic clear-down', () => {
  const book = async (app: ReturnType<typeof build>, email: string, cancel: boolean) => {
    const b = (await app.inject({ method: 'POST', url: '/bookings', payload: validBooking({ contact: { email } }) })).json();
    if (cancel) await app.inject({ method: 'POST', url: `/bookings/${b.ref}/cancel` });
    return b.ref as string;
  };

  it('deletes only finished synthetic bookings older than the retention window', async () => {
    const app = build();
    const oldSynthetic = await book(app, 'synthetic.user1@travelduty.test', true);
    const confirmedSynthetic = await book(app, 'synthetic.user2@travelduty.test', false);
    const realCancelled = await book(app, 'ada@example.com', true);

    expect(await repo.purgeFinished('travelduty.test', new Date(Date.now() - 60_000))).toBe(0);
    expect(await repo.purgeFinished('travelduty.test', new Date(Date.now() + 1_000))).toBe(1);
    expect(await repo.get(oldSynthetic)).toBeUndefined();
    expect(await repo.get(confirmedSynthetic)).toBeDefined();
    expect(await repo.get(realCancelled)).toBeDefined();
  });

  it('runs on its own once the service is up and counts what it cleared', async () => {
    const seed = build();
    const ref = await book(seed, 'synthetic.user1@travelduty.test', true);
    const app = buildBookingApp({
      repo,
      makeClients: () => world.clients(),
      service: { logger: false },
      purge: { domain: 'travelduty.test', retentionMs: 0, intervalMs: 60_000, now: () => Date.now() + 1_000 },
    });
    await app.ready();
    await vi.waitFor(async () => expect(await repo.get(ref)).toBeUndefined());
    expect((await app.inject({ url: '/metrics' })).body).toMatch(/cleardown_records_total\{store="bookings",service="booking-service"\} 1/);
    await app.close();
  });
});
