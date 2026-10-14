import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { NO_CHAOS, registerChaos, type ChaosState } from './chaos.js';
import { envNumber, envOptional } from './config.js';
import { HttpError, UpstreamError } from './errors.js';
import type { CallResult, ClientOptions } from './http-client.js';
import { ServiceClient } from './http-client.js';

export interface ServiceOptions {
  name: string;
  version?: string;
  /** Pass `false` in tests to silence logs. Defaults to JSON logs at LOG_LEVEL. */
  logger?: boolean;
  /** Overrides chaos settings otherwise read from CHAOS_* env vars. */
  chaos?: Partial<ChaosState>;
  adminToken?: string;
  /** Dependency checks for `/ready`; each returns true when healthy. */
  readiness?: Record<string, () => Promise<boolean>>;
  /** Used by chaos injection; override for deterministic tests. */
  random?: () => number;
  /** Reverse-proxy hops to trust for the client IP (`req.ip`). Off by default. */
  trustProxy?: number;
}

export interface ServiceMetrics {
  registry: Registry;
  recordCall: (result: CallResult) => void;
}

declare module 'fastify' {
  interface FastifyInstance {
    serviceName: string;
    metrics: ServiceMetrics;
    chaos: ChaosState;
    /** Creates a ServiceClient whose calls are recorded in this service's metrics. */
    client: (opts: ClientOptions) => ServiceClient;
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; service?: string };
}

/**
 * Builds a Fastify instance with the conventions every TravelDuty service shares:
 * structured logs with request-id propagation, `/health`, `/ready`, Prometheus `/metrics`,
 * chaos injection, and a uniform `{ error: { code, message } }` error envelope.
 */
export function createService(opts: ServiceOptions): FastifyInstance {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : { level: process.env.LOG_LEVEL ?? 'info', base: { service: opts.name } },
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
    },
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    ajv: { customOptions: { coerceTypes: true, removeAdditional: true, allErrors: false } },
    // Trust the nearest `trustProxy` hops' X-Forwarded-For entries, and no further.
    trustProxy: (_addr: string, hop: number) => hop < (opts.trustProxy ?? 0),
  });

  // Accept an empty body with a JSON content-type (common for POST/DELETE actions such as
  // `/bookings/:ref/cancel`); Fastify's default parser rejects it with a 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new HttpError(400, 'VALIDATION_ERROR', 'Request body is not valid JSON'), undefined);
    }
  });

  const started = Date.now();
  const registry = new Registry();
  registry.setDefaultLabels({ service: opts.name });
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const upstreamCalls = new Counter({
    name: 'upstream_calls_total',
    help: 'Outbound calls to other services and external APIs',
    labelNames: ['target', 'method', 'outcome', 'status'],
    registers: [registry],
  });
  const upstreamDuration = new Histogram({
    name: 'upstream_call_duration_seconds',
    help: 'Outbound call latency',
    labelNames: ['target', 'method'],
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const recordCall = (r: CallResult) => {
    upstreamCalls.inc({ target: r.target, method: r.method, outcome: r.outcome, status: String(r.status ?? 'none') });
    upstreamDuration.observe({ target: r.target, method: r.method }, r.durationMs / 1000);
  };

  app.decorate('serviceName', opts.name);
  app.decorate('metrics', { registry, recordCall });
  app.decorate('client', (clientOpts: ClientOptions) =>
    new ServiceClient({
      ...clientOpts,
      onResult: (r) => {
        recordCall(r);
        clientOpts.onResult?.(r);
      },
    }),
  );

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    httpRequests.inc({ method: req.method, route, status: String(reply.statusCode) });
    httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });

  const chaos = registerChaos(
    app,
    opts.name,
    {
      latencyMs: envNumber('CHAOS_LATENCY_MS', NO_CHAOS.latencyMs),
      jitterMs: envNumber('CHAOS_JITTER_MS', NO_CHAOS.jitterMs),
      errorRate: envNumber('CHAOS_ERROR_RATE', NO_CHAOS.errorRate),
      errorStatus: envNumber('CHAOS_ERROR_STATUS', NO_CHAOS.errorStatus),
      ...opts.chaos,
    },
    opts.adminToken ?? envOptional('ADMIN_TOKEN'),
    opts.random,
  );
  app.decorate('chaos', chaos);

  app.get('/health', async () => ({
    status: 'ok',
    service: opts.name,
    version: opts.version ?? process.env.APP_VERSION ?? 'dev',
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
  }));

  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, boolean> = {};
    await Promise.all(
      Object.entries(opts.readiness ?? {}).map(async ([name, check]) => {
        checks[name] = await check().catch(() => false);
      }),
    );
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` } });
  });

  app.setErrorHandler((err: FastifyError | HttpError | UpstreamError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) },
      } satisfies ErrorBody);
    }
    if (err instanceof UpstreamError) {
      // Pass client errors (validation, not found, card declined...) straight through.
      if (err.isClientError) {
        return reply.code(err.statusCode!).send(
          err.body ?? { error: { code: 'UPSTREAM_REJECTED', message: err.message, service: err.service } },
        );
      }
      req.log.error({ err, upstream: err.service, kind: err.kind, status: err.statusCode }, 'upstream failure');
      return reply.code(err.kind === 'timeout' ? 504 : 502).send({
        error: {
          code: err.kind === 'timeout' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
          message: err.message,
          service: err.service,
        },
      } satisfies ErrorBody);
    }
    if (err.validation) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } } satisfies ErrorBody);
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } satisfies ErrorBody);
  });

  return app;
}

/** Listens on `port` and wires graceful shutdown on SIGINT/SIGTERM. */
export async function startService(app: FastifyInstance, port: number, onClose?: () => Promise<void>) {
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await onClose?.();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}
