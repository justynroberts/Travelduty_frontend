import { ServiceClient } from '@travelduty/common';
import { fakeFetch, type FakeHandler } from '@travelduty/common/testing';
import type { Clients } from '../src/saga.js';

type Reply = { status?: number; body?: unknown };

/**
 * A small in-memory model of the downstream services (flight, hotel, pricing, payment,
 * notification) that honours the contract shapes, records every call, and lets a test
 * override any endpoint to simulate failures.
 */
export class FakeWorld {
  calls: string[] = [];
  holds = new Map<string, { status: string; kind: 'flight' | 'hotel'; quantity: number }>();
  payments = new Map<string, { amount: number; refunded: number }>();
  notifications: { template: string; to: string }[] = [];
  overrides = new Map<string, (body: unknown) => Reply>();
  private seq = 0;

  clients(): Clients {
    const make = (name: string) =>
      new ServiceClient({ name, baseUrl: `http://${name}`, retries: 1, retryBaseDelayMs: 1, fetchImpl: fakeFetch(this.handler) });
    return {
      flight: make('flight-service'),
      hotel: make('hotel-service'),
      pricing: make('pricing-service'),
      payment: make('payment-service'),
      notification: make('notification-service'),
    };
  }

  /** Override `"<METHOD> <host><path-pattern>"`, e.g. `"POST payment-service/payments"` or `"DELETE hotel-service/holds/{id}"`. */
  on(route: string, reply: (body: unknown) => Reply) {
    this.overrides.set(route, reply);
  }

  holdStatuses(kind: 'flight' | 'hotel') {
    return [...this.holds.values()].filter((h) => h.kind === kind).map((h) => h.status);
  }

  private handler: FakeHandler = ({ method, url, body }) => {
    const key = `${method} ${url.host}${url.pathname.replace(/\/(fh|hh|pay)_[a-z0-9]+/, '/{id}')}`;
    this.calls.push(key);
    const override = this.overrides.get(key);
    if (override) return override(body);
    return this.default(key, method, url, body as Record<string, unknown>);
  };

  private default(key: string, method: string, url: URL, body: Record<string, unknown>): Reply {
    const id = url.pathname.split('/')[2] ?? '';
    switch (key) {
      case 'POST flight-service/holds': {
        const hid = `fh_${++this.seq}`;
        this.holds.set(hid, { status: 'held', kind: 'flight', quantity: body.passengers as number });
        const offerId = String(body.offerId);
        const [, from, to, date] = offerId.split('.');
        return {
          status: 201,
          body: {
            id: hid, status: 'held', quantity: body.passengers, expiresAt: new Date(Date.now() + 9e5).toISOString(),
            offer: { id: offerId, airline: { code: 'NX', name: 'Nimbus Air' }, flightNumber: 'NX123', from, to, departureTime: `${date}T08:00`, arrivalTime: `${date}T10:45`, durationMinutes: 165, stops: 0, cabin: 'economy', adults: body.passengers, totalEur: 100 * Number(body.passengers) },
          },
        };
      }
      case 'POST hotel-service/holds': {
        const hid = `hh_${++this.seq}`;
        this.holds.set(hid, { status: 'held', kind: 'hotel', quantity: 1 });
        return {
          status: 201,
          body: {
            id: hid, status: 'held', quantity: 1, expiresAt: new Date(Date.now() + 9e5).toISOString(),
            offer: { id: body.offerId, hotel: { id: 'LIS-1', name: 'Casa Teste', stars: 4 }, city: 'LIS', checkIn: '2026-11-02', checkOut: '2026-11-06', nights: 4, guests: 2, totalEur: 400 },
          },
        };
      }
      case 'POST flight-service/holds/{id}/confirm':
      case 'POST hotel-service/holds/{id}/confirm': {
        const h = this.holds.get(id)!;
        h.status = 'confirmed';
        const confirmation = h.kind === 'flight' ? { pnr: 'ABC234', tickets: ['417-0000000001', '417-0000000002'].slice(0, h.quantity) } : { confirmationCode: 'HTL-ABC234' };
        return { body: { id, status: 'confirmed', quantity: h.quantity, confirmation } };
      }
      case 'DELETE flight-service/holds/{id}':
      case 'DELETE hotel-service/holds/{id}': {
        const h = this.holds.get(id);
        if (!h) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no hold' } } };
        h.status = 'cancelled';
        return { body: { id, status: 'cancelled' } };
      }
      case 'POST pricing-service/quotes': {
        const items = body.items as { kind: string; description: string; amountEur: number }[];
        const subtotal = items.reduce((s, i) => s + i.amountEur, 0);
        return { status: 201, body: { id: 'q_1', currency: body.currency, rate: 1, rateDate: '2026-10-13', rateStale: false, lines: items.map((i) => ({ ...i, amount: i.amountEur })), taxes: [], fees: [], subtotal, taxTotal: 0, feeTotal: 4.99, total: subtotal + 4.99, totalEur: subtotal + 4.99 } };
      }
      case 'POST payment-service/payments': {
        const pid = `pay_${++this.seq}`;
        this.payments.set(pid, { amount: body.amount as number, refunded: 0 });
        return { status: 201, body: { id: pid, status: 'captured', amount: body.amount, currency: body.currency, card: { brand: 'visa', last4: '4242' }, refundedAmount: 0 } };
      }
      case 'POST payment-service/payments/{id}/refunds': {
        const p = this.payments.get(id)!;
        p.refunded = p.amount;
        return { body: { id, status: 'refunded', amount: p.amount, currency: 'EUR', card: { brand: 'visa', last4: '4242' }, refundedAmount: p.amount } };
      }
      case 'POST notification-service/notifications':
        this.notifications.push({ template: body.template as string, to: body.to as string });
        return { status: 202, body: { id: 'ntf_1' } };
      default:
        return { status: 404, body: { error: { code: 'NOT_FOUND', message: `fake has no route ${method} ${url.pathname}` } } };
    }
  }
}

export const validBooking = (overrides: Record<string, unknown> = {}) => ({
  outboundOfferId: 'FL.LHR.LIS.2026-11-02.economy.0',
  returnOfferId: 'FL.LIS.LHR.2026-11-06.economy.1',
  hotelOfferId: 'HT.LIS.1.2026-11-02.2026-11-06.2',
  passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }, { firstName: 'Charles', lastName: 'Babbage' }],
  contact: { email: 'ada@example.com' },
  currency: 'GBP',
  payment: { card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'Ada Lovelace' } },
  ...overrides,
});
