import { HttpError, UpstreamError, randomCode, type ServiceClient } from '@travelduty/common';
import type { FastifyBaseLogger } from 'fastify';
import type { BookingRepository } from './repository.js';
import type {
  Booking,
  BookedFlight,
  CreateBookingInput,
  FlightOffer,
  Hold,
  HotelOffer,
  Payment,
  Quote,
} from './types.js';

export interface Clients {
  flight: ServiceClient;
  hotel: ServiceClient;
  pricing: ServiceClient;
  payment: ServiceClient;
  notification: ServiceClient;
}

export interface SagaContext {
  clients: Clients;
  repo: BookingRepository;
  log: FastifyBaseLogger;
  requestId: string;
  onOutcome?: (status: Booking['status']) => void;
}

class StepFailure extends Error {
  constructor(
    readonly step: string,
    override readonly cause: unknown,
  ) {
    super(`${step} failed`);
  }
}

const now = () => new Date().toISOString();

function note(b: Booking, event: string, detail?: string) {
  b.timeline.push({ at: now(), event, ...(detail ? { detail } : {}) });
  b.updatedAt = now();
}

/** Turns a failed step into the HTTP error returned to the caller. */
function toHttpError(f: StepFailure, ref: string): HttpError {
  const e = f.cause;
  if (e instanceof UpstreamError) {
    const details = { bookingRef: ref, step: f.step, service: e.service };
    if (e.isClientError) {
      const upstreamMessage = (e.body as { error?: { message?: string } } | undefined)?.error?.message;
      return new HttpError(e.statusCode!, e.upstreamCode ?? 'BOOKING_REJECTED', upstreamMessage ?? e.message, details);
    }
    return new HttpError(e.kind === 'timeout' ? 504 : 502, e.kind === 'timeout' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', e.message, details);
  }
  if (e instanceof HttpError) return new HttpError(e.statusCode, e.code, e.message, { bookingRef: ref, step: f.step });
  return new HttpError(500, 'BOOKING_FAILED', 'Booking failed unexpectedly', { bookingRef: ref, step: f.step });
}

function failureOf(f: StepFailure) {
  const e = f.cause;
  if (e instanceof UpstreamError) {
    return { step: f.step, code: e.upstreamCode ?? (e.kind === 'http' ? `HTTP_${e.statusCode}` : e.kind.toUpperCase()), message: e.message, service: e.service };
  }
  return { step: f.step, code: e instanceof HttpError ? e.code : 'INTERNAL_ERROR', message: (e as Error).message };
}

const itinerary = (b: Booking) =>
  [
    ...b.flights.map((f) => `${f.direction === 'outbound' ? 'Outbound' : 'Return'}: ${f.offer.flightNumber} ${f.offer.from} → ${f.offer.to}, departs ${f.offer.departureTime.replace('T', ' ')}`),
    ...(b.hotel ? [`Hotel: ${b.hotel.offer.hotel.name}, ${b.hotel.offer.checkIn} to ${b.hotel.offer.checkOut} (${b.hotel.offer.nights} nights)`] : []),
  ].join('\n');

async function notify(ctx: SagaContext, b: Booking, template: string, data: Record<string, unknown>) {
  try {
    await ctx.clients.notification.post('/notifications', {
      requestId: ctx.requestId,
      body: {
        template,
        to: b.contact.email,
        bookingRef: b.ref,
        data: { customerName: b.passengers[0]?.firstName, itinerary: itinerary(b), ...data },
      },
    });
    note(b, `notification.${template}.sent`);
  } catch (err) {
    // Notifications are best-effort; a failure must never undo a booking.
    ctx.log.warn({ err, bookingRef: b.ref }, 'notification failed');
    note(b, `notification.${template}.failed`, (err as Error).message);
  }
}

/**
 * The booking saga. Each step that reserves or charges something registers a compensating
 * action; if any later step fails, compensations run in reverse so no seat, room or charge leaks.
 */
export async function createBooking(ctx: SagaContext, input: CreateBookingInput): Promise<Booking> {
  const { clients, repo, requestId } = ctx;
  const created = now();
  const b: Booking = {
    ref: randomCode(6, 'TD-'),
    status: 'PENDING',
    createdAt: created,
    updatedAt: created,
    contact: input.contact,
    passengers: input.passengers,
    currency: input.currency,
    flights: [],
    timeline: [{ at: created, event: 'booking.started' }],
  };
  await repo.save(b);
  ctx.log.info({ bookingRef: b.ref }, 'booking started');

  const compensations: { name: string; run: () => Promise<unknown> }[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      const result = await fn();
      note(b, `${name}.succeeded`);
      return result;
    } catch (err) {
      throw new StepFailure(name, err);
    }
  };
  const pax = input.passengers.length;

  try {
    const holdFlight = async (direction: BookedFlight['direction'], offerId: string) => {
      const hold = await step(`hold_${direction}_flight`, () =>
        clients.flight.post<Hold<FlightOffer>>('/holds', { requestId, body: { offerId, passengers: pax } }),
      );
      b.flights.push({ direction, holdId: hold.id, status: hold.status, offer: hold.offer });
      compensations.push({ name: `release_${direction}_flight`, run: () => clients.flight.delete(`/holds/${hold.id}`, { requestId }) });
    };

    await holdFlight('outbound', input.outboundOfferId);
    if (input.returnOfferId) await holdFlight('return', input.returnOfferId);

    if (input.hotelOfferId) {
      const hold = await step('hold_hotel', () =>
        clients.hotel.post<Hold<HotelOffer>>('/holds', { requestId, body: { offerId: input.hotelOfferId, rooms: 1 } }),
      );
      b.hotel = { holdId: hold.id, status: hold.status, offer: hold.offer };
      compensations.push({ name: 'release_hotel', run: () => clients.hotel.delete(`/holds/${hold.id}`, { requestId }) });
    }

    b.quote = await step('quote', () =>
      clients.pricing.post<Quote>('/quotes', {
        requestId,
        body: {
          currency: input.currency,
          items: [
            ...b.flights.map((f) => ({
              kind: 'flight',
              description: `${f.offer.from}→${f.offer.to} ${f.offer.flightNumber} × ${pax}`,
              amountEur: f.offer.totalEur,
            })),
            ...(b.hotel ? [{ kind: 'hotel', description: `${b.hotel.offer.hotel.name}, ${b.hotel.offer.nights} nights`, amountEur: b.hotel.offer.totalEur }] : []),
          ],
        },
      }),
    );

    const payment = await step('charge_payment', () =>
      clients.payment.post<Payment>('/payments', {
        requestId,
        idempotencyKey: `${b.ref}-charge`,
        // A charge is the one call we must not double-fire; give it room before declaring failure.
        timeoutMs: 15_000,
        body: { amount: b.quote!.total, currency: b.quote!.currency, reference: b.ref, card: input.payment.card },
      }),
    );
    b.payment = { id: payment.id, status: payment.status, amount: payment.amount, currency: payment.currency, brand: payment.card.brand, last4: payment.card.last4, refundedAmount: 0 };
    compensations.push({
      name: 'refund_payment',
      run: () => clients.payment.post(`/payments/${payment.id}/refunds`, { requestId, idempotencyKey: `${b.ref}-refund`, body: {} }),
    });

    await step('confirm_inventory', async () => {
      for (const f of b.flights) {
        const h = await clients.flight.post<Hold<FlightOffer, { pnr: string; tickets: string[] }>>(`/holds/${f.holdId}/confirm`, { requestId, idempotencyKey: `${b.ref}-${f.holdId}` });
        Object.assign(f, { status: h.status, pnr: h.confirmation?.pnr, tickets: h.confirmation?.tickets });
      }
      if (b.hotel) {
        const h = await clients.hotel.post<Hold<HotelOffer, { confirmationCode: string }>>(`/holds/${b.hotel.holdId}/confirm`, { requestId, idempotencyKey: `${b.ref}-${b.hotel.holdId}` });
        Object.assign(b.hotel, { status: h.status, confirmationCode: h.confirmation?.confirmationCode });
      }
    });
  } catch (err) {
    if (!(err instanceof StepFailure)) throw err;
    b.failure = failureOf(err);
    note(b, 'booking.failed', `${err.step}: ${b.failure.message}`);
    ctx.log.warn({ bookingRef: b.ref, failure: b.failure }, 'booking failed, compensating');

    for (const c of compensations.reverse()) {
      try {
        await c.run();
        note(b, `${c.name}.compensated`);
      } catch (cerr) {
        // Leave a trail for manual reconciliation rather than masking the original failure.
        ctx.log.error({ err: cerr, bookingRef: b.ref, compensation: c.name }, 'compensation failed');
        note(b, `${c.name}.compensation_failed`, (cerr as Error).message);
      }
    }
    if (b.payment && b.timeline.some((t) => t.event === 'refund_payment.compensated')) {
      b.payment.status = 'refunded';
      b.payment.refundedAmount = b.payment.amount;
    }
    b.flights.forEach((f) => (f.status = 'cancelled'));
    if (b.hotel) b.hotel.status = 'cancelled';
    b.status = 'FAILED';
    await notify(ctx, b, 'booking_failed', { reason: b.failure.message });
    await repo.save(b);
    ctx.onOutcome?.('FAILED');
    throw toHttpError(err, b.ref);
  }

  b.status = 'CONFIRMED';
  note(b, 'booking.confirmed');
  await notify(ctx, b, 'booking_confirmed', { total: b.quote!.total, currency: b.quote!.currency });
  await repo.save(b);
  ctx.onOutcome?.('CONFIRMED');
  ctx.log.info({ bookingRef: b.ref, total: b.quote!.total, currency: b.quote!.currency }, 'booking confirmed');
  return b;
}

/** Cancels a confirmed booking: releases inventory, then refunds. */
export async function cancelBooking(ctx: SagaContext, b: Booking): Promise<Booking> {
  if (b.status !== 'CONFIRMED') {
    throw new HttpError(409, 'NOT_CANCELLABLE', `Booking ${b.ref} is ${b.status} and cannot be cancelled`);
  }
  const { clients, requestId } = ctx;
  try {
    for (const f of b.flights) {
      await clients.flight.delete(`/holds/${f.holdId}`, { requestId });
      f.status = 'cancelled';
    }
    if (b.hotel) {
      await clients.hotel.delete(`/holds/${b.hotel.holdId}`, { requestId });
      b.hotel.status = 'cancelled';
    }
    if (b.payment) {
      const p = await clients.payment.post<Payment>(`/payments/${b.payment.id}/refunds`, { requestId, idempotencyKey: `${b.ref}-cancel`, body: {} });
      b.payment.status = p.status;
      b.payment.refundedAmount = p.refundedAmount;
    }
  } catch (err) {
    note(b, 'cancellation.failed', (err as Error).message);
    await ctx.repo.save(b);
    throw err;
  }
  b.status = 'CANCELLED';
  note(b, 'booking.cancelled');
  await notify(ctx, b, 'booking_cancelled', { total: b.payment?.refundedAmount, currency: b.payment?.currency });
  await ctx.repo.save(b);
  ctx.onOutcome?.('CANCELLED');
  return b;
}
