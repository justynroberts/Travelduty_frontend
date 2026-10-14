import { useState, type FormEvent } from 'react';
import { ApiError, api, hhmm, money, type Booking } from '../api';
import { Button, Code, Field, Input, Notice } from './ui';

const statusTone: Record<Booking['status'], string> = {
  CONFIRMED: 'text-ok',
  CANCELLED: 'text-muted',
  FAILED: 'text-danger',
  PENDING: 'text-accent-ink',
};

export function BookingSummary({ booking, onCancelled }: { booking: Booking; onCancelled?: (b: Booking) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      onCancelled?.(await api.cancelBooking(booking.ref));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cancellation failed. Try again in a moment.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <article className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-medium">
          Booking <Code>{booking.ref}</Code>
        </h3>
        <span className={`text-sm font-medium ${statusTone[booking.status]}`}>{booking.status.toLowerCase()}</span>
      </header>
      <ul className="flex flex-col gap-2 text-sm">
        {booking.flights.map((f) => (
          <li key={f.offer.id} className="flex flex-wrap justify-between gap-x-4">
            <span>
              <Code>
                {f.offer.from} {hhmm(f.offer.departureTime)}
              </Code>
              <span className="text-muted"> to </span>
              <Code>
                {f.offer.to} {hhmm(f.offer.arrivalTime)}
              </Code>
              <span className="text-muted">
                {' '}
                on {f.offer.departureTime.slice(0, 10)}, {f.offer.airline.name} {f.offer.flightNumber}
              </span>
            </span>
            {f.pnr && (
              <span className="text-muted">
                PNR <Code>{f.pnr}</Code>
              </span>
            )}
          </li>
        ))}
        {booking.hotel && (
          <li className="flex flex-wrap justify-between gap-x-4">
            <span>
              {booking.hotel.offer.hotel.name}
              <span className="text-muted">
                , {booking.hotel.offer.checkIn} to {booking.hotel.offer.checkOut}
              </span>
            </span>
            {booking.hotel.confirmationCode && <Code>{booking.hotel.confirmationCode}</Code>}
          </li>
        )}
      </ul>
      <p className="text-sm text-muted">{booking.passengers.map((p) => `${p.firstName} ${p.lastName}`).join(', ')}</p>
      {booking.quote && (
        <dl className="num grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t border-line pt-3 text-sm">
          <dt className="text-muted">Fares</dt>
          <dd className="text-right font-mono">{money({ amount: booking.quote.subtotal, currency: booking.quote.currency })}</dd>
          <dt className="text-muted">Taxes</dt>
          <dd className="text-right font-mono">{money({ amount: booking.quote.taxTotal, currency: booking.quote.currency })}</dd>
          <dt className="text-muted">Service fee</dt>
          <dd className="text-right font-mono">{money({ amount: booking.quote.feeTotal, currency: booking.quote.currency })}</dd>
          <dt className="font-medium">{booking.status === 'CANCELLED' ? 'Refunded' : 'Total'}</dt>
          <dd className="text-right font-mono font-medium">{money({ amount: booking.quote.total, currency: booking.quote.currency })}</dd>
        </dl>
      )}
      {booking.payment && (
        <p className="text-xs text-muted">
          Paid with {booking.payment.brand} ending {booking.payment.last4}, payment {booking.payment.status.replace('_', ' ')}
        </p>
      )}
      {booking.failure && <Notice tone="danger">{booking.failure.message}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {booking.status === 'CONFIRMED' && onCancelled && (
        <div className="flex gap-2">
          {confirming ? (
            <>
              <Button variant="danger" busy={busy} onClick={cancel}>
                Cancel and refund
              </Button>
              <Button onClick={() => setConfirming(false)}>Keep booking</Button>
            </>
          ) : (
            <Button onClick={() => setConfirming(true)}>Cancel booking</Button>
          )}
        </div>
      )}
    </article>
  );
}

export function TripsPage({ initialEmail }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail ?? '');
  const [items, setItems] = useState<Booking[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      setItems((await api.bookings(email)).items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load bookings.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <form onSubmit={find} className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <Field label="Email used for the booking">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        </div>
        <Button type="submit" variant="primary" busy={loading}>
          Find my trips
        </Button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {loading && [0, 1].map((i) => <div key={i} className="skeleton h-40 w-full" />)}
      {!loading && items?.length === 0 && <Notice>No trips for {email} yet. Bookings appear here as soon as they are confirmed.</Notice>}
      {!loading &&
        items?.map((b) => <BookingSummary key={b.ref} booking={b} onCancelled={(nb) => setItems((all) => all?.map((x) => (x.ref === nb.ref ? nb : x)) ?? null)} />)}
    </div>
  );
}
