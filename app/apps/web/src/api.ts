export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? res.statusText, e.details);
  }
  return body as T;
}

export interface AdminSession {
  /** False when the deployment leaves chaos control open (local development). */
  required: boolean;
  passwordLogin: boolean;
  authenticated: boolean;
}

export interface Destination {
  code: string;
  city: string;
  country: string;
  currency: string;
  tags: string[];
  blurb: string;
}

export interface Price {
  amount: number;
  currency: string;
}

export interface FlightOffer {
  id: string;
  airline: { code: string; name: string };
  flightNumber: string;
  from: string;
  to: string;
  departureTime: string;
  arrivalTime: string;
  durationMinutes: number;
  stops: number;
  seatsLeft: number;
  price: Price;
}

export interface HotelOffer {
  id: string;
  hotel: { name: string; stars: number; rating: number; neighbourhood: string; amenities: string[] };
  nights: number;
  roomsLeft: number;
  price: Price;
}

export interface DayForecast {
  date: string;
  summary: string;
  weatherCode: number;
  tempMaxC: number;
  tempMinC: number;
  precipitationChance: number | null;
}

export interface TripSearch {
  query: { from: string; to: string; depart: string; return: string | null; adults: number; currency: string };
  currency: string;
  rate: { value: number; date: string | null; stale: boolean };
  destination:
    | (Destination & {
        weather?: { days: DayForecast[]; stale: boolean } | null;
        holidays?: { items: { date: string; name: string }[] } | null;
      })
    | null;
  outbound: FlightOffer[];
  inbound: FlightOffer[] | null;
  hotels: HotelOffer[] | null;
  nights: number | null;
  degraded: { service: string; reason: string }[];
}

export interface Booking {
  ref: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
  createdAt: string;
  contact: { email: string };
  passengers: { firstName: string; lastName: string }[];
  flights: { direction: string; status: string; pnr?: string; tickets?: string[]; offer: FlightOffer }[];
  hotel?: { status: string; confirmationCode?: string; offer: HotelOffer & { checkIn: string; checkOut: string } };
  quote?: { total: number; currency: string; subtotal: number; taxTotal: number; feeTotal: number };
  payment?: { status: string; brand: string; last4: string; refundedAmount: number };
  failure?: { step: string; code: string; message: string };
}

export interface ServiceStatus {
  service: string;
  status: 'up' | 'down';
  latencyMs: number;
  version?: string;
  error?: string;
}

export interface Chaos {
  latencyMs: number;
  jitterMs: number;
  errorRate: number;
  errorStatus: number;
}

export const api = {
  destinations: () => request<{ items: Destination[] }>('/destinations'),
  currencies: () => request<{ currencies: string[] }>('/fx/currencies'),
  searchTrips: (q: Record<string, string | number>) =>
    request<TripSearch>(`/trips/search?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`),
  createBooking: (body: unknown) => request<Booking>('/bookings', { method: 'POST', body: JSON.stringify(body) }),
  bookings: (email: string) => request<{ items: Booking[] }>(`/bookings?email=${encodeURIComponent(email)}`),
  cancelBooking: (ref: string) => request<Booking>(`/bookings/${ref}/cancel`, { method: 'POST' }),
  status: () => request<{ status: string; services: ServiceStatus[] }>('/status'),
  adminSession: () => request<AdminSession>('/admin/session'),
  login: (username: string, password: string) =>
    request<{ authenticated: boolean }>('/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ authenticated: boolean }>('/admin/logout', { method: 'POST' }),
  chaos: () => request<Record<string, Chaos | null>>('/admin/chaos'),
  setChaos: (service: string, patch: Partial<Chaos>) =>
    request<Chaos>(`/admin/chaos/${service}`, { method: 'PUT', body: JSON.stringify(patch) }),
  resetChaos: (service: string) => request<Chaos>(`/admin/chaos/${service}`, { method: 'DELETE' }),
};

export const money = (p: Price) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency }).format(p.amount);

export const hhmm = (iso: string) => iso.slice(11, 16);

export const duration = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
