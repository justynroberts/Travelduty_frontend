import { useState } from 'react';
import type { Booking } from './api';
import { OpsPage } from './components/OpsPage';
import { SearchPage } from './components/SearchPage';
import { ThemeSwitch } from './components/ThemeSwitch';
import { BookingSummary, TripsPage } from './components/TripsPage';
import { Button } from './components/ui';

type View = 'search' | 'trips' | 'ops';

const NAV: { id: View; label: string }[] = [
  { id: 'search', label: 'Book a trip' },
  { id: 'trips', label: 'My trips' },
  { id: 'ops', label: 'Operations' },
];

export function App() {
  const [view, setView] = useState<View>('search');
  const [booked, setBooked] = useState<Booking | null>(null);

  return (
    <div className="mx-auto flex min-h-dvh max-w-[90rem] flex-col px-4 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4 py-5">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <a href="/" className="text-xl font-bold tracking-tight">
            TravelDuty
          </a>
          <nav aria-label="Main" className="flex gap-1 text-sm">
            {NAV.map((n) => (
              <button
                key={n.id}
                aria-current={view === n.id ? 'page' : undefined}
                onClick={() => setView(n.id)}
                className={`min-h-11 whitespace-nowrap rounded-md px-2 transition-colors sm:px-3 duration-150 ${view === n.id ? 'text-text font-medium underline decoration-accent decoration-2 underline-offset-[6px]' : 'text-muted hover-fine:text-text'}`}
              >
                {n.label}
              </button>
            ))}
          </nav>
        </div>
        <ThemeSwitch />
      </header>

      <main className="flex-1 pb-12 pt-4">
        {view === 'search' && !booked && (
          <>
            <h1 className="mb-6 text-3xl font-bold sm:text-4xl">Where to next?</h1>
            <SearchPage onBooked={setBooked} />
          </>
        )}
        {view === 'search' && booked && (
          <div className="flex max-w-3xl flex-col gap-6">
            <h1 className="text-3xl font-bold">You're going to {booked.flights[0]?.offer.to}</h1>
            <p className="text-muted">We emailed the confirmation to {booked.contact.email}. Tickets and hotel codes are below.</p>
            <BookingSummary booking={booked} />
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setBooked(null)}>
                Book another trip
              </Button>
              <Button onClick={() => setView('trips')}>See all my trips</Button>
            </div>
          </div>
        )}
        {view === 'trips' && (
          <>
            <h1 className="mb-6 text-3xl font-bold">My trips</h1>
            <TripsPage initialEmail={booked?.contact.email ?? 'maren.okafor@example.com'} />
          </>
        )}
        {view === 'ops' && (
          <>
            <h1 className="mb-6 text-3xl font-bold">Platform status</h1>
            <OpsPage />
          </>
        )}
      </main>

      <footer className="border-t border-line py-5 text-xs text-muted">
        TravelDuty is a sample application. Flights, hotels and payments are simulated. Weather by Open-Meteo, holidays by Nager.Date, exchange rates by the ECB via Frankfurter.
      </footer>
    </div>
  );
}
