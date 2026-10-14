import { DEFAULT_PORTS, envNumber, envOptional, serviceUrl, startService } from '@travelduty/common';
import { buildGateway } from './app.js';

const timeoutMs = envNumber('UPSTREAM_TIMEOUT_MS', 8_000);

const app = buildGateway({
  adminToken: envOptional('ADMIN_TOKEN'),
  auth: { username: envOptional('ADMIN_USERNAME'), password: envOptional('ADMIN_PASSWORD') },
  // Traefik + nginx in front on Coolify (2), nginx alone locally (1); the login rate limit keys on req.ip.
  service: { trustProxy: envNumber('TRUST_PROXY_HOPS', 1) },
  makeClients: (app) => ({
    destination: app.client({ name: 'destination-service', baseUrl: serviceUrl('destination'), timeoutMs }),
    flight: app.client({ name: 'flight-service', baseUrl: serviceUrl('flight'), timeoutMs }),
    hotel: app.client({ name: 'hotel-service', baseUrl: serviceUrl('hotel'), timeoutMs }),
    pricing: app.client({ name: 'pricing-service', baseUrl: serviceUrl('pricing'), timeoutMs }),
    // Bookings run a multi-step saga including a card charge; give them longer and never retry.
    booking: app.client({ name: 'booking-service', baseUrl: serviceUrl('booking'), timeoutMs: 30_000, retries: 0 }),
    payment: app.client({ name: 'payment-service', baseUrl: serviceUrl('payment'), timeoutMs }),
    notification: app.client({ name: 'notification-service', baseUrl: serviceUrl('notification'), timeoutMs }),
  }),
});

await startService(app, envNumber('PORT', DEFAULT_PORTS.gateway));
