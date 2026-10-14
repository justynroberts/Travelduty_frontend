export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';

export interface Passenger {
  firstName: string;
  lastName: string;
}

export interface CardInput {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  holderName: string;
}

export interface CreateBookingInput {
  outboundOfferId: string;
  returnOfferId?: string;
  hotelOfferId?: string;
  passengers: Passenger[];
  contact: { email: string; phone?: string };
  currency: string;
  payment: { card: CardInput };
}

/** Shapes returned by flight-service / hotel-service (see docs/contract.md). */
export interface Hold<O, C = unknown> {
  id: string;
  status: 'held' | 'confirmed' | 'cancelled' | 'expired';
  offer: O;
  quantity: number;
  expiresAt: string;
  confirmation?: C;
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
  cabin: string;
  totalEur: number;
  adults: number;
}

export interface HotelOffer {
  id: string;
  hotel: { id: string; name: string; stars: number };
  city: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  totalEur: number;
}

export interface Quote {
  id: string;
  currency: string;
  rate: number;
  rateDate: string;
  rateStale: boolean;
  lines: { kind: string; description: string; amountEur: number; amount: number }[];
  taxes: { description: string; amountEur: number; amount: number }[];
  fees: { description: string; amountEur: number; amount: number }[];
  subtotal: number;
  taxTotal: number;
  feeTotal: number;
  total: number;
  totalEur: number;
}

export interface Payment {
  id: string;
  status: string;
  amount: number;
  currency: string;
  card: { brand: string; last4: string };
  refundedAmount: number;
}

export interface BookedFlight {
  direction: 'outbound' | 'return';
  holdId: string;
  status: string;
  offer: FlightOffer;
  pnr?: string;
  tickets?: string[];
}

export interface BookedHotel {
  holdId: string;
  status: string;
  offer: HotelOffer;
  confirmationCode?: string;
}

export interface TimelineEvent {
  at: string;
  event: string;
  detail?: string;
}

export interface Booking {
  ref: string;
  status: BookingStatus;
  createdAt: string;
  updatedAt: string;
  contact: { email: string; phone?: string };
  passengers: Passenger[];
  currency: string;
  flights: BookedFlight[];
  hotel?: BookedHotel;
  quote?: Quote;
  /** Card data is never stored — only the processor's payment id, brand and last 4. */
  payment?: { id: string; status: string; amount: number; currency: string; brand: string; last4: string; refundedAmount: number };
  failure?: { step: string; code: string; message: string; service?: string };
  timeline: TimelineEvent[];
}
