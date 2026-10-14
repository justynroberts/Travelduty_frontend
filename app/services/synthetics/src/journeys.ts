import { randomUUID } from 'node:crypto';
import { UpstreamError, type ServiceClient } from '@travelduty/common';

/**
 * What synthetic users do on TravelDuty. Each journey is a short sequence of the calls the web app
 * makes, so every service sees steady, realistic traffic: error and latency alerts then reflect
 * the platform's state continuously instead of only while someone is clicking around.
 */
export type JourneyName = 'browse' | 'search' | 'book' | 'my-trips';
export type Outcome = 'ok' | 'degraded' | 'sold_out' | 'failed';

export interface JourneyResult {
  journey: JourneyName;
  outcome: Outcome;
  /** The step that failed or degraded, e.g. "POST /api/bookings". */
  step?: string;
  detail?: string;
  durationMs: number;
}

export interface JourneyContext {
  gateway: ServiceClient;
  random: () => number;
  /** Bookings confirmed but not yet cancelled (cancel failed under chaos); retried before new bookings. */
  pendingCancels: Set<string>;
  now?: () => Date;
}

interface Destination {
  code: string;
}
interface TripSearch {
  outbound: { id: string; seatsLeft: number }[] | null;
  inbound: { id: string; seatsLeft: number }[] | null;
  hotels: { id: string; roomsLeft: number }[] | null;
  degraded: { service: string }[];
}

/** Weighted mix: mostly browsing and searching, a booking roughly every tenth journey. */
export const JOURNEY_WEIGHTS: Record<JourneyName, number> = { browse: 4, search: 4, book: 1, 'my-trips': 1 };

const CURRENCIES = ['GBP', 'EUR', 'USD'];
const PEOPLE = [
  ['Maren', 'Okafor'],
  ['Tomasz', 'Lindqvist'],
  ['Aiko', 'Brennan'],
  ['Rafael', 'Nwosu'],
  ['Ingrid', 'Castellano'],
  ['Kofi', 'Haugen'],
];
const card = { number: '4242424242424242', expMonth: 12, expYear: 2031, cvc: '123', holderName: 'Synthetic User' };

class StepFailed extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`${step}: ${detail}`);
  }
}

export function pickJourney(random: () => number): JourneyName {
  const entries = Object.entries(JOURNEY_WEIGHTS) as [JourneyName, number][];
  let n = random() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [name, w] of entries) if ((n -= w) < 0) return name;
  return entries[0]![0];
}

export async function runJourney(name: JourneyName, ctx: JourneyContext): Promise<JourneyResult> {
  const started = performance.now();
  const done = (outcome: Outcome, step?: string, detail?: string): JourneyResult => ({
    journey: name,
    outcome,
    step,
    detail,
    durationMs: performance.now() - started,
  });
  try {
    const r = await JOURNEYS[name](new Session(name, ctx), ctx);
    return done(r?.outcome ?? 'ok', r?.step, r?.detail);
  } catch (err) {
    if (err instanceof StepFailed) return done('failed', err.step, err.detail);
    return done('failed', undefined, (err as Error).message);
  }
}

/** One synthetic user's run: every call shares a request id prefix so it can be traced end to end. */
class Session {
  readonly requestId: string;
  constructor(
    journey: JourneyName,
    private readonly ctx: JourneyContext,
  ) {
    this.requestId = `syn-${journey}-${randomUUID().slice(0, 8)}`;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const step = `${method} ${path.split('?')[0]!.replace(/\/TD-[A-Z0-9]+/, '/:ref').replace(/\/destinations\/[A-Z]{3}$/, '/destinations/:code')}`;
    try {
      return await this.ctx.gateway.request<T>(method, path, { body, requestId: this.requestId });
    } catch (err) {
      const detail = err instanceof UpstreamError ? `HTTP ${err.statusCode ?? err.kind}${err.upstreamCode ? ` ${err.upstreamCode}` : ''}` : (err as Error).message;
      throw Object.assign(new StepFailed(step, detail), { status: err instanceof UpstreamError ? err.statusCode : undefined });
    }
  }
}

type JourneyFn = (s: Session, ctx: JourneyContext) => Promise<{ outcome: Outcome; step?: string; detail?: string } | void>;

const pick = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)]!;
const day = (now: Date, offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

async function searchTrip(s: Session, ctx: JourneyContext, adults: number) {
  const { random } = ctx;
  const destinations = await s.call<{ items: Destination[] }>('GET', '/api/destinations');
  // Every destination is also an airport, so any two distinct ones make a valid route.
  const codes = destinations.items.map((d) => d.code);
  const from = pick(codes, random);
  const to = pick(
    codes.filter((c) => c !== from),
    random,
  );
  const now = ctx.now?.() ?? new Date();
  const out = 14 + Math.floor(random() * 100);
  const nights = 2 + Math.floor(random() * 6);
  const q = new URLSearchParams({ from, to, depart: day(now, out), return: day(now, out + nights), adults: String(adults), currency: pick(CURRENCIES, random) });
  return s.call<TripSearch>('GET', `/api/trips/search?${q}`);
}

const degradedOutcome = (trip: TripSearch) =>
  trip.degraded?.length ? { outcome: 'degraded' as const, step: 'GET /api/trips/search', detail: trip.degraded.map((d) => d.service).join(', ') } : undefined;

const JOURNEYS: Record<JourneyName, JourneyFn> = {
  async browse(s, { random }) {
    const destinations = await s.call<{ items: Destination[] }>('GET', '/api/destinations');
    await s.call('GET', `/api/destinations/${pick(destinations.items, random).code}`);
    await s.call('GET', '/api/fx/currencies');
  },

  async search(s, ctx) {
    return degradedOutcome(await searchTrip(s, ctx, 1 + Math.floor(ctx.random() * 3)));
  },

  async book(s, ctx) {
    // Finish cancellations that failed earlier, so synthetic bookings never hold inventory for long.
    for (const ref of [...ctx.pendingCancels]) {
      try {
        await s.call('POST', `/api/bookings/${ref}/cancel`);
        ctx.pendingCancels.delete(ref);
      } catch (err) {
        if ((err as { status?: number }).status === 409) ctx.pendingCancels.delete(ref);
      }
    }

    const adults = 1 + Math.floor(ctx.random() * 2);
    const trip = await searchTrip(s, ctx, adults);
    const outbound = trip.outbound?.find((o) => o.seatsLeft >= adults);
    const inbound = trip.inbound?.find((o) => o.seatsLeft >= adults);
    const hotel = trip.hotels?.find((h) => h.roomsLeft >= 1);
    if (!outbound || !inbound || !hotel) {
      return degradedOutcome(trip) ?? { outcome: 'sold_out', step: 'GET /api/trips/search', detail: 'no offer with room left' };
    }

    const user = Math.floor(ctx.random() * 50);
    const booking = await s.call<{ ref: string; status: string }>('POST', '/api/bookings', {
      outboundOfferId: outbound.id,
      returnOfferId: inbound.id,
      hotelOfferId: hotel.id,
      passengers: Array.from({ length: adults }, (_, i) => {
        const [firstName, lastName] = PEOPLE[(user + i) % PEOPLE.length]!;
        return { firstName, lastName };
      }),
      contact: { email: `synthetic.user${user}@travelduty.test` },
      currency: pick(CURRENCIES, ctx.random),
      payment: { card },
    });

    // Book-then-cancel keeps inventory level: cancelling releases the seats and room and refunds.
    ctx.pendingCancels.add(booking.ref);
    await s.call('GET', `/api/bookings/${booking.ref}`);
    await s.call('GET', `/api/notifications?bookingRef=${booking.ref}`);
    await s.call('POST', `/api/bookings/${booking.ref}/cancel`);
    ctx.pendingCancels.delete(booking.ref);
  },

  async 'my-trips'(s, { random }) {
    await s.call('GET', `/api/bookings?email=${encodeURIComponent(`synthetic.user${Math.floor(random() * 50)}@travelduty.test`)}`);
  },
};
