import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';

export interface ChaosState {
  /** Added to every non-admin request. */
  latencyMs: number;
  /** Random extra latency in [0, jitterMs). */
  jitterMs: number;
  /** Probability (0-1) of failing a request with `errorStatus`. */
  errorRate: number;
  errorStatus: number;
}

export const NO_CHAOS: ChaosState = { latencyMs: 0, jitterMs: 0, errorRate: 0, errorStatus: 503 };

// `/api/admin` is the gateway's admin door: without it, gateway chaos would block its own reset.
const EXEMPT = /^\/(health|ready|metrics|admin|api\/admin)(\/|\?|$)/;

/**
 * Fault injection for incident-response demos. Every service exposes `/admin/chaos` so latency
 * and error rates can be dialled up at runtime (or preset via CHAOS_* env vars).
 */
export function registerChaos(
  app: FastifyInstance,
  serviceName: string,
  initial: ChaosState,
  adminToken: string | undefined,
  random: () => number = Math.random,
) {
  const state: ChaosState = { ...initial };

  app.addHook('onRequest', async (req, reply) => {
    if (EXEMPT.test(req.url)) return;
    const delay = state.latencyMs + (state.jitterMs > 0 ? random() * state.jitterMs : 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (state.errorRate > 0 && random() < state.errorRate) {
      req.log.warn({ chaos: state }, 'chaos: injecting failure');
      return reply.code(state.errorStatus).send({
        error: { code: 'CHAOS_INJECTED', message: `Injected failure in ${serviceName}` },
      });
    }
  });

  const guard = async (req: { headers: Record<string, unknown> }) => {
    if (adminToken && req.headers['x-admin-token'] !== adminToken) {
      throw new HttpError(401, 'UNAUTHORIZED', 'A valid x-admin-token header is required');
    }
  };

  app.get('/admin/chaos', { preHandler: guard }, async () => state);

  app.put<{ Body: Partial<ChaosState> }>(
    '/admin/chaos',
    {
      preHandler: guard,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            latencyMs: { type: 'integer', minimum: 0, maximum: 60_000 },
            jitterMs: { type: 'integer', minimum: 0, maximum: 60_000 },
            errorRate: { type: 'number', minimum: 0, maximum: 1 },
            errorStatus: { type: 'integer', minimum: 400, maximum: 599 },
          },
        },
      },
    },
    async (req) => {
      Object.assign(state, req.body);
      req.log.warn({ chaos: state }, 'chaos: configuration changed');
      return state;
    },
  );

  app.delete('/admin/chaos', { preHandler: guard }, async (req) => {
    Object.assign(state, NO_CHAOS);
    req.log.info('chaos: reset');
    return state;
  });

  return state;
}
