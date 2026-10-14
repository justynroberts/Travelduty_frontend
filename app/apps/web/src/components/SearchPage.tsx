import {
  AirplaneTakeoff,
  ArrowsLeftRight,
  CheckCircle,
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Sun,
  type Icon,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, api, duration, hhmm, money, type Booking, type Destination, type FlightOffer, type HotelOffer, type TripSearch } from '../api';
import { Checkout } from './Checkout';
import { Button, Code, Field, Input, Notice, Select } from './ui';

const isoIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function weatherIcon(code: number): Icon {
  if (code <= 1) return Sun;
  if (code === 2) return CloudSun;
  if (code === 45 || code === 48) return CloudFog;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return CloudSnow;
  if (code >= 95) return CloudLightning;
  if (code >= 51) return CloudRain;
  return Cloud;
}

const CURRENCIES = ['EUR', 'GBP', 'USD', 'JPY', 'AUD', 'SGD', 'ZAR', 'MXN', 'ISK', 'THB', 'CHF'];

export function SearchPage({ onBooked }: { onBooked: (b: Booking) => void }) {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [form, setForm] = useState({ from: 'LHR', to: 'LIS', depart: isoIn(21), ret: isoIn(25), adults: 2, currency: 'GBP' });
  const [result, setResult] = useState<TripSearch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<{ out?: FlightOffer; back?: FlightOffer; hotel?: HotelOffer }>({});
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  useEffect(() => {
    api.destinations().then((d) => setDestinations(d.items), () => setDestinations([]));
  }, []);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const formError = form.from === form.to ? 'Choose two different cities' : form.ret && form.ret <= form.depart ? 'Return must be after departure' : null;

  async function search(e?: FormEvent) {
    e?.preventDefault();
    if (formError) return;
    setLoading(true);
    setError(null);
    setPick({});
    try {
      const r = await api.searchTrips({ from: form.from, to: form.to, depart: form.depart, ...(form.ret ? { return: form.ret } : {}), adults: form.adults, currency: form.currency });
      setResult(r);
      setPick({ out: r.outbound[0], back: r.inbound?.[0], hotel: r.hotels?.[0] });
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? `${err.message} (${err.code})` : 'Search failed. Check that the gateway is running and try again.');
    } finally {
      setLoading(false);
    }
  }

  const total = useMemo(() => {
    const parts = [pick.out, pick.back, pick.hotel].filter(Boolean) as { price: { amount: number; currency: string } }[];
    if (!parts.length || !result) return null;
    return { amount: parts.reduce((s, p) => s + p.price.amount, 0), currency: result.currency };
  }, [pick, result]);
  const ready = Boolean(pick.out && (!result?.inbound || pick.back));

  const cityOf = (code: string) => destinations.find((d) => d.code === code)?.city ?? code;

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={search} className="grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-[1fr_auto_1fr_10rem_10rem_6rem_7rem_auto] lg:items-end">
        <Field label="From">
          {(id) => (
            <Select id={id} value={form.from} onChange={(e) => set('from', e.target.value)}>
              {destinations.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.city} ({d.code})
                </option>
              ))}
              {!destinations.length && <option value={form.from}>{form.from}</option>}
            </Select>
          )}
        </Field>
        <button
          type="button"
          aria-label="Swap origin and destination"
          onClick={() => setForm((f) => ({ ...f, from: f.to, to: f.from }))}
          className="hidden min-h-11 items-center justify-center rounded-md px-2 text-muted hover-fine:text-text lg:flex"
        >
          <ArrowsLeftRight size={20} weight="light" aria-hidden />
        </button>
        <Field label="To" error={form.from === form.to ? 'Choose two different cities' : undefined}>
          {(id) => (
            <Select id={id} value={form.to} onChange={(e) => set('to', e.target.value)} aria-invalid={form.from === form.to}>
              {destinations.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.city} ({d.code})
                </option>
              ))}
              {!destinations.length && <option value={form.to}>{form.to}</option>}
            </Select>
          )}
        </Field>
        <Field label="Depart">{(id) => <Input id={id} type="date" min={isoIn(0)} value={form.depart} onChange={(e) => set('depart', e.target.value)} />}</Field>
        <Field label="Return" error={form.ret && form.ret <= form.depart ? 'Return must be after departure' : undefined}>
          {(id) => <Input id={id} type="date" min={form.depart} value={form.ret} onChange={(e) => set('ret', e.target.value)} />}
        </Field>
        <Field label="Travellers">
          {(id) => (
            <Select id={id} value={form.adults} onChange={(e) => set('adults', Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Currency">
          {(id) => (
            <Select id={id} value={form.currency} onChange={(e) => set('currency', e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="primary" busy={loading} disabled={Boolean(formError)}>
          <AirplaneTakeoff size={20} weight="light" aria-hidden />
          {loading ? 'Searching' : 'Search trips'}
        </Button>
      </form>

      {error && <Notice tone="danger">{error}</Notice>}
      {loading && <ResultsSkeleton />}
      {!loading && !result && !error && (
        <p className="max-w-[60ch] text-muted">
          Pick a route and dates to see live fares, hotels, a weather forecast and public holidays at your destination. Fares and hotels are simulated; weather, holidays and exchange rates come from public APIs.
        </p>
      )}

      {!loading && result && (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-8">
            {result.degraded.length > 0 && (
              <Notice>
                Some details are unavailable right now: {result.degraded.map((d) => d.service.replace('-service', '')).join(', ')}. You can still book.
              </Notice>
            )}
            <FlightList
              title={`${cityOf(result.query.from)} to ${cityOf(result.query.to)}`}
              date={result.query.depart}
              offers={result.outbound}
              selected={pick.out?.id}
              onSelect={(o) => setPick((p) => ({ ...p, out: o }))}
            />
            {result.inbound && (
              <FlightList
                title={`${cityOf(result.query.to)} to ${cityOf(result.query.from)}`}
                date={result.query.return!}
                offers={result.inbound}
                selected={pick.back?.id}
                onSelect={(o) => setPick((p) => ({ ...p, back: o }))}
              />
            )}
            {result.hotels && (
              <HotelList offers={result.hotels} nights={result.nights ?? 0} selected={pick.hotel?.id} onSelect={(h) => setPick((p) => ({ ...p, hotel: p.hotel?.id === h.id ? undefined : h }))} />
            )}
          </div>
          <DestinationPanel result={result} />
        </div>
      )}

      {result && total && (
        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-4 py-3 sm:-mx-6 sm:px-6">
          <div>
            <p className="text-xs text-muted">
              {result.query.adults} {result.query.adults === 1 ? 'traveller' : 'travellers'}
              {pick.hotel ? `, ${result.nights} nights at ${pick.hotel.hotel.name}` : ', flights only'}
            </p>
            <p className="num font-mono text-lg font-medium">{money(total)}</p>
            <p className="text-xs text-muted">Taxes and the service fee are added at checkout</p>
          </div>
          <Button variant="primary" disabled={!ready} onClick={() => setCheckoutOpen(true)}>
            Continue to payment
          </Button>
        </div>
      )}

      {result && pick.out && (
        <Checkout
          open={checkoutOpen}
          onClose={() => setCheckoutOpen(false)}
          adults={result.query.adults}
          currency={result.currency}
          selection={{ out: pick.out, back: pick.back, hotel: pick.hotel }}
          onBooked={(b) => {
            setCheckoutOpen(false);
            setResult(null);
            onBooked(b);
          }}
        />
      )}
    </div>
  );
}

function FlightList({ title, date, offers, selected, onSelect }: { title: string; date: string; offers: FlightOffer[]; selected?: string; onSelect: (o: FlightOffer) => void }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">
        {title} <span className="text-muted">{longDate(date)}</span>
      </h2>
      {offers.length === 0 ? (
        <Notice>No seats left on this day. Try another date.</Notice>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface" role="radiogroup" aria-label={`${title} flights`}>
          {offers.map((o) => {
            const active = o.id === selected;
            return (
              <li key={o.id}>
                <button
                  role="radio"
                  aria-checked={active}
                  onClick={() => onSelect(o)}
                  className={`grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors duration-150 sm:grid-cols-[12rem_minmax(0,1fr)_9rem_auto] ${active ? 'bg-raised' : 'hover-fine:bg-raised/60'}`}
                >
                  <span className="num whitespace-nowrap font-mono text-base">
                    {hhmm(o.departureTime)}
                    <span className="text-muted"> to </span>
                    {hhmm(o.arrivalTime)}
                    {o.arrivalTime.slice(0, 10) !== o.departureTime.slice(0, 10) && <sup className="ml-0.5 text-xs text-accent-ink">+1</sup>}
                  </span>
                  <span className="order-3 col-span-2 min-w-0 text-sm text-muted sm:order-none sm:col-span-1">
                    {o.airline.name} <Code>{o.flightNumber}</Code>
                    {o.seatsLeft <= 3 && <span className="text-accent-ink">, {o.seatsLeft} left</span>}
                  </span>
                  <span className="hidden text-sm text-muted sm:block">
                    {duration(o.durationMinutes)}, {o.stops === 0 ? 'direct' : `${o.stops} stop`}
                  </span>
                  <span className="flex items-center justify-end gap-2">
                    <span className="num font-mono font-medium">{money(o.price)}</span>
                    <CheckCircle size={20} weight={active ? 'fill' : 'light'} className={active ? 'text-accent-ink' : 'text-line'} aria-hidden />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function HotelList({ offers, nights, selected, onSelect }: { offers: HotelOffer[]; nights: number; selected?: string; onSelect: (h: HotelOffer) => void }) {
  return (
    <section aria-label="Hotels" className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">
        Where to stay <span className="text-muted">{nights} nights, optional</span>
      </h2>
      {offers.length === 0 ? (
        <Notice>Every hotel is full for these dates. You can still book flights only.</Notice>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {offers.map((h) => {
            const active = h.id === selected;
            return (
              <li key={h.id}>
                <button
                  aria-pressed={active}
                  onClick={() => onSelect(h)}
                  className={`flex h-full w-full flex-col gap-1 rounded-lg border p-4 text-left transition-colors duration-150 ${active ? 'border-accent-ink bg-raised' : 'border-line bg-surface hover-fine:bg-raised/60'}`}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="font-medium">{h.hotel.name}</span>
                    <CheckCircle size={20} weight={active ? 'fill' : 'light'} className={`shrink-0 ${active ? 'text-accent-ink' : 'text-line'}`} aria-hidden />
                  </span>
                  <span className="text-sm text-muted">
                    {h.hotel.stars}-star in {h.hotel.neighbourhood}, rated {h.hotel.rating.toFixed(1)}
                  </span>
                  <span className="text-xs text-muted">{h.hotel.amenities.join(', ')}</span>
                  <span className="mt-2 flex items-baseline justify-between">
                    <span className="num font-mono font-medium">{money(h.price)}</span>
                    <span className="text-xs text-muted">{money({ amount: h.price.amount / nights, currency: h.price.currency })} a night</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DestinationPanel({ result }: { result: TripSearch }) {
  const d = result.destination;
  if (!d) return <aside className="text-sm text-muted">Destination details are unavailable right now.</aside>;
  return (
    <aside className="flex flex-col gap-6 lg:sticky lg:top-4 lg:self-start">
      <div>
        <h2 className="text-2xl font-bold">{d.city}</h2>
        <p className="text-sm text-muted">{d.country}, pays in {d.currency}</p>
        <p className="mt-2 text-sm">{d.blurb}</p>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Next 7 days</h3>
        {d.weather ? (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {d.weather.days.map((w) => {
              const WIcon = weatherIcon(w.weatherCode);
              return (
                <li key={w.date} className="grid grid-cols-[5.5rem_1.5rem_minmax(0,1fr)_auto] items-center gap-2 py-1.5">
                  <span className="text-muted">{longDate(w.date)}</span>
                  <WIcon size={20} weight="light" aria-hidden />
                  <span className="truncate">{w.summary}</span>
                  <span className="num font-mono text-xs">
                    {Math.round(w.tempMaxC)}° <span className="text-muted">{Math.round(w.tempMinC)}°</span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">Forecast unavailable.</p>
        )}
        <p className="text-xs text-muted">Forecast by Open-Meteo{d.weather?.stale ? ', cached' : ''}</p>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Public holidays during your trip</h3>
        {d.holidays?.items.length ? (
          <ul className="text-sm">
            {d.holidays.items.map((h) => (
              <li key={h.date + h.name}>
                <span className="text-muted">{longDate(h.date)}</span> {h.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{d.holidays ? 'None. Shops and museums keep normal hours.' : 'Holiday calendar unavailable.'}</p>
        )}
      </div>
      {result.currency !== 'EUR' && (
        <p className="text-xs text-muted">
          1 EUR = {result.rate.value} {result.currency}, ECB reference rate{result.rate.date ? ` of ${result.rate.date}` : ''}
        </p>
      )}
    </aside>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]" aria-label="Loading results">
      <div className="flex flex-col gap-3">
        <div className="skeleton h-6 w-64" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-14 w-full" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <div className="skeleton h-8 w-40" />
        <div className="skeleton h-40 w-full" />
      </div>
    </div>
  );
}
