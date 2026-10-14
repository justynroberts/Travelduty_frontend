#!/usr/bin/env node
// End-to-end check against a running platform (docker compose up). Exercises every service,
// including the real external APIs, through the public gateway.
//   node scripts/e2e.mjs              # GATEWAY_URL defaults to http://localhost:8080

const base = (process.env.GATEWAY_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const runId = `e2e-${Date.now()}`;
let failures = 0;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-request-id': `${runId}-${path.split('?')[0].replaceAll('/', '_')}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function waitForPlatform() {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      const r = await call('GET', '/api/status');
      if (r.body?.status === 'ok') return r.body;
      if (Date.now() > deadline) return r.body;
    } catch {
      if (Date.now() > deadline) throw new Error(`gateway not reachable at ${base}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

const card = (number) => ({ number, expMonth: 12, expYear: 2031, cvc: '123', holderName: 'Maren Okafor' });

const status = await waitForPlatform();
check('all services healthy', status?.status === 'ok', status?.services?.filter((s) => s.status !== 'up').map((s) => s.service).join(', '));

const dest = await call('GET', '/api/destinations');
check('destination catalogue', dest.status === 200 && dest.body.count === 14, `${dest.body?.count} destinations`);

const depart = day(30);
const ret = day(34);
const trip = await call('GET', `/api/trips/search?from=LHR&to=LIS&depart=${depart}&return=${ret}&adults=2&currency=GBP`);
check('trip search', trip.status === 200, `HTTP ${trip.status}`);
check('trip search propagates request id', trip.headers.get('x-request-id')?.startsWith(runId));
check('flights both ways', trip.body?.outbound?.length > 0 && trip.body?.inbound?.length > 0);
check('hotels (Java service)', trip.body?.hotels?.length > 0, `${trip.body?.hotels?.length} offers`);
check('prices converted with live ECB rate (Frankfurter)', trip.body?.currency === 'GBP' && trip.body?.rate?.value > 0, `1 EUR = ${trip.body?.rate?.value} GBP on ${trip.body?.rate?.date}`);
check('live weather (Open-Meteo)', trip.body?.destination?.weather?.days?.length > 0, trip.body?.destination?.weather?.days?.[0]?.summary);
check('live public holidays (Nager.Date)', Array.isArray(trip.body?.destination?.holidays?.items));
check('no degraded dependencies', trip.body?.degraded?.length === 0, JSON.stringify(trip.body?.degraded));

// Inventory is finite: re-search before each booking and pick offers that still have room.
async function freshOffers() {
  const r = await call('GET', `/api/trips/search?from=LHR&to=LIS&depart=${depart}&return=${ret}&adults=2`);
  const roomy = (items, field, need) => items?.find((o) => o[field] >= need);
  return {
    outboundOfferId: roomy(r.body.outbound, 'seatsLeft', 2)?.id,
    returnOfferId: roomy(r.body.inbound, 'seatsLeft', 2)?.id,
    hotelOfferId: roomy(r.body.hotels, 'roomsLeft', 1)?.id,
  };
}

const booking = {
  ...(await freshOffers()),
  passengers: [{ firstName: 'Maren', lastName: 'Okafor' }, { firstName: 'Tomasz', lastName: 'Lindqvist' }],
  contact: { email: `${runId}@example.com` },
  currency: 'GBP',
  payment: { card: card('4242424242424242') },
};

const ok = await call('POST', '/api/bookings', booking);
check('booking confirmed (saga across 5 services)', ok.status === 201 && ok.body.status === 'CONFIRMED', `${ok.body?.ref} ${ok.body?.quote?.total} ${ok.body?.quote?.currency}`);
check('tickets issued (Go)', ok.body?.flights?.every((f) => f.tickets?.length === 2));
check('hotel confirmed (Java)', /^HTL-/.test(ok.body?.hotel?.confirmationCode ?? ''));
check('payment captured (Rust)', ok.body?.payment?.status === 'captured' && ok.body.payment.last4 === '4242');

const declined = await call('POST', '/api/bookings', { ...booking, ...(await freshOffers()), payment: { card: card('4000000000000002') } });
check('declined card returns 402', declined.status === 402 && declined.body.error.code === 'CARD_DECLINED');
const failedRef = declined.body?.error?.details?.bookingRef;
const failed = await call('GET', `/api/bookings/${failedRef}`);
check('declined booking recorded as FAILED with holds released', failed.body?.status === 'FAILED' && failed.body.flights.every((f) => f.status === 'cancelled'));

const processorDown = await call('POST', '/api/bookings', { ...booking, ...(await freshOffers()), payment: { card: card('4000000000000119') } });
check('processor outage returns 502', processorDown.status === 502, processorDown.body?.error?.code);

const list = await call('GET', `/api/bookings?email=${encodeURIComponent(booking.contact.email)}`);
check('bookings listed from Postgres', list.body?.items?.length === 3);

const cancelled = await call('POST', `/api/bookings/${ok.body.ref}/cancel`);
check('cancellation refunds', cancelled.status === 200 && cancelled.body.status === 'CANCELLED' && cancelled.body.payment.status === 'refunded');

const notes = await call('GET', `/api/notifications?bookingRef=${ok.body.ref}`);
const templates = notes.body?.items?.map((n) => n.template).sort();
check('notifications sent (Go)', JSON.stringify(templates) === JSON.stringify(['booking_cancelled', 'booking_confirmed']), templates?.join(', '));

// Chaos: make hotels fail, the trip search should degrade rather than error.
await call('PUT', '/api/admin/chaos/hotel-service', { errorRate: 1 });
const degraded = await call('GET', `/api/trips/search?from=LHR&to=LIS&depart=${depart}&return=${ret}&adults=1`);
check('chaos on hotel-service degrades trip search', degraded.status === 200 && degraded.body.hotels === null && degraded.body.degraded.some((d) => d.service === 'hotel-service'));
await call('DELETE', '/api/admin/chaos/hotel-service');
const recovered = await call('GET', `/api/trips/search?from=LHR&to=LIS&depart=${depart}&return=${ret}&adults=1`);
check('hotel-service recovers after chaos reset', recovered.body?.hotels?.length > 0);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
