import { envNumber, envOptional, startService } from '@travelduty/common';
import { buildSynthetics } from './app.js';

const synthetics = buildSynthetics({
  // No retries: a synthetic user should see exactly what a customer sees.
  makeGateway: (app) =>
    app.client({
      name: 'gateway',
      baseUrl: envOptional('GATEWAY_URL') ?? 'http://localhost:8080',
      timeoutMs: envNumber('SYNTHETICS_TIMEOUT_MS', 30_000),
      retries: 0,
      headers: { 'user-agent': 'TravelDuty-Synthetics/0.1' },
    }),
  users: envNumber('SYNTHETICS_USERS', 3),
  thinkMs: [envNumber('SYNTHETICS_THINK_MIN_MS', 1_000), envNumber('SYNTHETICS_THINK_MAX_MS', 4_000)],
  paused: envOptional('SYNTHETICS_ENABLED') === 'false',
  adminToken: envOptional('ADMIN_TOKEN'),
});

await startService(synthetics.app, envNumber('PORT', 8088));
synthetics.start();
