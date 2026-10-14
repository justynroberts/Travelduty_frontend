import { DEFAULT_PORTS, envNumber, envOptional, serviceUrl, startService } from '@travelduty/common';
import { buildBookingApp } from './app.js';
import { MemoryBookingRepository, PostgresBookingRepository, type BookingRepository } from './repository.js';

const databaseUrl = envOptional('DATABASE_URL');
let repo: BookingRepository;
if (databaseUrl) {
  const pg = new PostgresBookingRepository(databaseUrl);
  await pg.init();
  repo = pg;
} else {
  repo = new MemoryBookingRepository();
}

const timeoutMs = envNumber('UPSTREAM_TIMEOUT_MS', 5_000);
const app = buildBookingApp({
  repo,
  makeClients: (app) => ({
    flight: app.client({ name: 'flight-service', baseUrl: serviceUrl('flight'), timeoutMs }),
    hotel: app.client({ name: 'hotel-service', baseUrl: serviceUrl('hotel'), timeoutMs }),
    pricing: app.client({ name: 'pricing-service', baseUrl: serviceUrl('pricing'), timeoutMs }),
    payment: app.client({ name: 'payment-service', baseUrl: serviceUrl('payment'), timeoutMs }),
    notification: app.client({ name: 'notification-service', baseUrl: serviceUrl('notification'), timeoutMs, retries: 0 }),
  }),
});

app.log.info({ storage: databaseUrl ? 'postgres' : 'memory' }, 'booking repository ready');
await startService(app, envNumber('PORT', DEFAULT_PORTS.booking), () => repo.close());
