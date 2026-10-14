import { timingSafeEqual, createHash } from 'node:crypto';
import { HttpError, createService, type ServiceClient, type ServiceOptions } from '@travelduty/common';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Counter, Gauge, Histogram } from 'prom-client';
import { JOURNEY_WEIGHTS, type JourneyName, type JourneyResult, type Outcome, pickJourney, runJourney } from './journeys.js';

export interface SyntheticsDeps {
  makeGateway: (app: FastifyInstance) => ServiceClient;
  /** Concurrent synthetic users. */
  users?: number;
  /** Pause between a user's journeys, picked uniformly from [min, max] ms. */
  thinkMs?: [number, number];
  /** Start paused (SYNTHETICS_ENABLED=false). */
  paused?: boolean;
  adminToken?: string;
  random?: () => number;
  service?: Partial<ServiceOptions>;
}

interface JourneyStats {
  runs: number;
  outcomes: Record<Outcome, number>;
  last?: JourneyResult & { at: string };
  lastFailure?: JourneyResult & { at: string };
}

const OUTCOMES: Outcome[] = ['ok', 'degraded', 'sold_out', 'failed'];

/**
 * TravelDuty Synthetics: simulated users running real journeys through the gateway around the
 * clock. Its own metrics (`synthetic_journeys_total`, `synthetic_journey_duration_seconds`) say
 * whether a customer could actually browse, search and book right now.
 */
export function buildSynthetics(deps: SyntheticsDeps) {
  const app = createService({ name: 'synthetics', adminToken: deps.adminToken, ...deps.service });
  const gateway = deps.makeGateway(app);
  const random = deps.random ?? Math.random;
  const users = deps.users ?? 3;
  const [thinkMin, thinkMax] = deps.thinkMs ?? [1_000, 4_000];
  const pendingCancels = new Set<string>();
  let paused = deps.paused ?? false;
  let stopped = false;

  const registry = app.metrics.registry;
  const journeys = new Counter({
    name: 'synthetic_journeys_total',
    help: 'Synthetic user journeys run, by outcome',
    labelNames: ['journey', 'outcome', 'step'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'synthetic_journey_duration_seconds',
    help: 'Synthetic journey duration end to end',
    labelNames: ['journey', 'outcome'],
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30],
    registers: [registry],
  });
  new Gauge({
    name: 'synthetic_users_active',
    help: 'Synthetic users currently running journeys (0 while paused)',
    registers: [registry],
    collect() {
      this.set(paused || stopped ? 0 : users);
    },
  });
  new Gauge({
    name: 'synthetic_pending_cancellations',
    help: 'Synthetic bookings whose cancellation failed and will be retried',
    registers: [registry],
    collect() {
      this.set(pendingCancels.size);
    },
  });

  const stats = Object.fromEntries(
    (Object.keys(JOURNEY_WEIGHTS) as JourneyName[]).map((j) => [j, { runs: 0, outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 0])) } as JourneyStats]),
  ) as Record<JourneyName, JourneyStats>;

  const record = (r: JourneyResult) => {
    // Label failures with the failing step so a dashboard can say *where* customers get stuck.
    journeys.inc({ journey: r.journey, outcome: r.outcome, step: r.outcome === 'ok' ? '' : (r.step ?? 'unknown') });
    duration.observe({ journey: r.journey, outcome: r.outcome }, r.durationMs / 1000);
    const s = stats[r.journey];
    const stamped = { ...r, durationMs: Math.round(r.durationMs), at: new Date().toISOString() };
    s.runs++;
    s.outcomes[r.outcome]++;
    s.last = stamped;
    if (r.outcome === 'failed') {
      s.lastFailure = stamped;
      app.log.warn({ journey: r.journey, step: r.step, detail: r.detail }, 'synthetic journey failed');
    } else {
      app.log.debug({ journey: r.journey, outcome: r.outcome, ms: stamped.durationMs }, 'synthetic journey');
    }
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** One user's loop. Users start staggered so they don't move in lockstep. */
  const user = async (n: number) => {
    await sleep(n * 700);
    while (!stopped) {
      if (paused) {
        await sleep(1_000);
        continue;
      }
      const name = pickJourney(random);
      record(await runJourney(name, { gateway, random, pendingCancels }));
      await sleep(thinkMin + random() * (thinkMax - thinkMin));
    }
  };

  /** Runs one journey now and records it, as a user would. For tests. */
  const runOnce = async (name: JourneyName) => {
    const r = await runJourney(name, { gateway, random, pendingCancels });
    record(r);
    return r;
  };

  const tokenOk = (req: FastifyRequest) => {
    if (!deps.adminToken) return true;
    const given = req.headers['x-admin-token'];
    const digest = (v: string) => createHash('sha256').update(v).digest();
    return typeof given === 'string' && timingSafeEqual(digest(given), digest(deps.adminToken));
  };
  const requireAdmin = async (req: FastifyRequest) => {
    if (!tokenOk(req)) throw new HttpError(401, 'UNAUTHORIZED', 'A valid x-admin-token header is required');
  };

  app.get('/status', async () => ({
    running: !paused && !stopped,
    users,
    thinkMs: [thinkMin, thinkMax],
    pendingCancellations: [...pendingCancels],
    journeys: stats,
  }));
  app.post('/admin/synthetics/pause', { preHandler: requireAdmin }, async () => {
    paused = true;
    app.log.info('synthetics paused');
    return { running: false };
  });
  app.post('/admin/synthetics/resume', { preHandler: requireAdmin }, async () => {
    paused = false;
    app.log.info('synthetics resumed');
    return { running: true };
  });

  app.addHook('onClose', async () => {
    stopped = true;
  });

  return {
    app,
    runOnce,
    /** Start the synthetic users; they stop when the app closes. */
    start() {
      app.log.info({ users, thinkMs: [thinkMin, thinkMax], paused }, 'synthetics starting');
      for (let i = 0; i < users; i++) void user(i);
    },
  };
}
