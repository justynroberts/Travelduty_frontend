import { X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, money, type Booking, type FlightOffer, type HotelOffer } from '../api';
import { Button, Code, Field, Input, Notice } from './ui';

const TEST_CARDS = [
  ['4242 4242 4242 4242', 'succeeds'],
  ['4000 0000 0000 0002', 'is declined'],
  ['4000 0000 0000 9995', 'has insufficient funds'],
  ['4000 0000 0000 0119', 'simulates the processor being down'],
] as const;

const SAMPLE_NAMES = [
  ['Maren', 'Okafor'],
  ['Tomasz', 'Lindqvist'],
  ['Inés', 'Caldeira'],
  ['Priya', 'Ramaswamy'],
  ['Joel', 'Achterberg'],
  ['Hana', 'Moriyama'],
];

interface Props {
  open: boolean;
  onClose: () => void;
  adults: number;
  currency: string;
  selection: { out: FlightOffer; back?: FlightOffer; hotel?: HotelOffer };
  onBooked: (b: Booking) => void;
}

export function Checkout({ open, onClose, adults, currency, selection, onBooked }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [passengers, setPassengers] = useState(() => SAMPLE_NAMES.slice(0, adults).map(([firstName, lastName]) => ({ firstName: firstName!, lastName: lastName! })));
  const [email, setEmail] = useState('maren.okafor@example.com');
  const [card, setCard] = useState({ number: '4242 4242 4242 4242', exp: '12/30', cvc: '123', holderName: 'Maren Okafor' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    setPassengers((p) => Array.from({ length: adults }, (_, i) => p[i] ?? { firstName: '', lastName: '' }));
  }, [adults]);

  const [mm, yy] = card.exp.split('/').map((s) => Number(s.trim()));
  const errors = {
    email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? undefined : 'Enter an email address like name@example.com',
    number: /^[0-9 ]{12,23}$/.test(card.number) ? undefined : 'Card numbers are 12 to 19 digits',
    exp: mm && mm >= 1 && mm <= 12 && yy !== undefined && yy >= 0 ? undefined : 'Use MM/YY, for example 12/30',
    cvc: /^[0-9]{3,4}$/.test(card.cvc) ? undefined : '3 or 4 digits from the back of the card',
  };
  const valid = !Object.values(errors).some(Boolean) && passengers.every((p) => p.firstName.trim() && p.lastName.trim()) && card.holderName.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched({ email: true, number: true, exp: true, cvc: true });
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const booking = await api.createBooking({
        outboundOfferId: selection.out.id,
        returnOfferId: selection.back?.id,
        hotelOfferId: selection.hotel?.id,
        passengers,
        contact: { email },
        currency,
        payment: { card: { number: card.number.replace(/\s/g, ''), expMonth: mm, expYear: 2000 + (yy ?? 0), cvc: card.cvc, holderName: card.holderName } },
      });
      onBooked(booking);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'We could not reach TravelDuty. Check your connection and try again.'));
    } finally {
      setBusy(false);
    }
  }

  const show = (k: keyof typeof errors) => (touched[k] ? errors[k] : undefined);
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));

  return (
    <dialog ref={ref} onClose={onClose} className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-text">
      <form onSubmit={submit} className="flex max-h-[90dvh] flex-col">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg font-medium">Travellers and payment</h2>
          <button type="button" onClick={onClose} aria-label="Close checkout" className="rounded-md p-2 text-muted hover-fine:text-text">
            <X size={20} weight="light" aria-hidden />
          </button>
        </header>

        <div className="flex flex-col gap-6 overflow-y-auto px-5 py-5">
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-medium">Travellers, as on their passports</legend>
            {passengers.map((p, i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-2">
                {(['firstName', 'lastName'] as const).map((k) => (
                  <Field key={k} label={`Traveller ${i + 1} ${k === 'firstName' ? 'first name' : 'last name'}`}>
                    {(id) => (
                      <Input
                        id={id}
                        value={p[k]}
                        autoComplete="off"
                        onChange={(e) => setPassengers((all) => all.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))}
                      />
                    )}
                  </Field>
                ))}
              </div>
            ))}
            <Field label="Email for the confirmation" error={show('email')}>
              {(id) => <Input id={id} type="email" value={email} onBlur={blur('email')} aria-invalid={Boolean(show('email'))} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-medium">Card</legend>
            <Field label="Card number" error={show('number')}>
              {(id) => <Input id={id} inputMode="numeric" className="font-mono" value={card.number} onBlur={blur('number')} aria-invalid={Boolean(show('number'))} onChange={(e) => setCard({ ...card, number: e.target.value })} />}
            </Field>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_2fr]">
              <Field label="Expiry" error={show('exp')}>
                {(id) => <Input id={id} placeholder="MM/YY" value={card.exp} onBlur={blur('exp')} aria-invalid={Boolean(show('exp'))} onChange={(e) => setCard({ ...card, exp: e.target.value })} />}
              </Field>
              <Field label="Security code" error={show('cvc')}>
                {(id) => <Input id={id} inputMode="numeric" value={card.cvc} onBlur={blur('cvc')} aria-invalid={Boolean(show('cvc'))} onChange={(e) => setCard({ ...card, cvc: e.target.value })} />}
              </Field>
              <div className="col-span-2 sm:col-span-1">
                <Field label="Name on card">{(id) => <Input id={id} value={card.holderName} onChange={(e) => setCard({ ...card, holderName: e.target.value })} />}</Field>
              </div>
            </div>
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Sample cards for this demo</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {TEST_CARDS.map(([n, what]) => (
                  <li key={n}>
                    <button type="button" className="underline decoration-line underline-offset-2 hover-fine:text-text" onClick={() => setCard({ ...card, number: n })}>
                      <Code>{n}</Code>
                    </button>{' '}
                    {what}
                  </li>
                ))}
              </ul>
            </details>
          </fieldset>

          {error && (
            <Notice tone="danger">
              {error.code === 'CARD_DECLINED'
                ? `${error.message}. Try another card; nothing was charged and your seats were released.`
                : error.status === 409
                  ? `${error.message}. Search again to see what is still available.`
                  : `${error.message}. Nothing was charged.`}
              {typeof error.details?.bookingRef === 'string' && (
                <span className="mt-1 block text-xs">
                  Reference <Code>{error.details.bookingRef}</Code>
                </span>
              )}
            </Notice>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
          <p className="text-xs text-muted">
            Flights from <span className="num font-mono">{money(selection.out.price)}</span>. Final price including taxes is confirmed when you pay.
          </p>
          <Button type="submit" variant="primary" busy={busy}>
            {busy ? 'Booking' : 'Pay and book'}
          </Button>
        </footer>
      </form>
    </dialog>
  );
}
