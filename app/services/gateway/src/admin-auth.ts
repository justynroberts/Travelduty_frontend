import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from '@travelduty/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Who may use the gateway's /api/admin routes (chaos control).
 *
 * People sign in with ADMIN_USERNAME / ADMIN_PASSWORD and get a signed, HttpOnly session cookie;
 * scripts send ADMIN_TOKEN as `x-admin-token`. With neither configured, admin routes stay open,
 * which is the local-development default.
 *
 * Brute force: each client IP gets MAX_IP_FAILURES attempts per window before a lockout, and a
 * global failure budget locks sign-in for everyone when attempts come from many IPs at once.
 * Every failure is also slowed down. Credentials are compared in constant time.
 */
export interface AdminAuthOptions {
  token?: string;
  username?: string;
  password?: string;
  sessionTtlMs?: number;
  /** Delay added to every failed sign-in. Tests pass 0. */
  failureDelayMs?: number;
  now?: () => number;
}

export const SESSION_COOKIE = 'td_admin';
const WINDOW_MS = 15 * 60_000;
const MAX_IP_FAILURES = 5;
const IP_LOCK_MS = 15 * 60_000;
const MAX_GLOBAL_FAILURES = 20;
const GLOBAL_LOCK_MS = 5 * 60_000;
const MAX_TRACKED_IPS = 10_000;

interface IpRecord {
  failures: number[];
  lockedUntil: number;
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const sameSecret = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));

export function createAdminAuth(opts: AdminAuthOptions) {
  const now = opts.now ?? Date.now;
  const ttl = opts.sessionTtlMs ?? 8 * 60 * 60_000;
  const failureDelayMs = opts.failureDelayMs ?? 1_000;
  const passwordLogin = Boolean(opts.username && opts.password);
  const required = passwordLogin || Boolean(opts.token);
  // Sessions are signed with a per-process key, so a gateway restart signs everyone out.
  const key = randomBytes(32);

  const ips = new Map<string, IpRecord>();
  let globalFailures: number[] = [];
  let globalLockedUntil = 0;

  const sign = (exp: number) => createHmac('sha256', key).update(`admin:${exp}`).digest('base64url');

  const validSession = (req: FastifyRequest) => {
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE);
    const [expText, sig] = raw?.split('.') ?? [];
    const exp = Number(expText);
    if (!sig || !Number.isFinite(exp) || exp < now()) return false;
    const expected = Buffer.from(sign(exp));
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const validToken = (req: FastifyRequest) => {
    const given = req.headers['x-admin-token'];
    return Boolean(opts.token) && typeof given === 'string' && sameSecret(given, opts.token!);
  };

  const isAdmin = (req: FastifyRequest) => !required || validToken(req) || validSession(req);

  /** Seconds until this IP may try again, or 0. */
  const lockedFor = (ip: string) => {
    const until = Math.max(globalLockedUntil, ips.get(ip)?.lockedUntil ?? 0);
    return Math.max(0, Math.ceil((until - now()) / 1000));
  };

  const recordFailure = (ip: string) => {
    const t = now();
    if (ips.size >= MAX_TRACKED_IPS && !ips.has(ip)) {
      for (const [k, r] of ips) if (r.lockedUntil < t && r.failures.every((f) => f < t - WINDOW_MS)) ips.delete(k);
      if (ips.size >= MAX_TRACKED_IPS) ips.delete(ips.keys().next().value!);
    }
    const rec = ips.get(ip) ?? { failures: [], lockedUntil: 0 };
    rec.failures = [...rec.failures.filter((f) => f > t - WINDOW_MS), t];
    if (rec.failures.length >= MAX_IP_FAILURES) {
      rec.lockedUntil = t + IP_LOCK_MS;
      rec.failures = [];
    }
    ips.set(ip, rec);

    globalFailures = [...globalFailures.filter((f) => f > t - WINDOW_MS), t];
    if (globalFailures.length >= MAX_GLOBAL_FAILURES) {
      globalLockedUntil = t + GLOBAL_LOCK_MS;
      globalFailures = [];
    }
  };

  const cookie = (req: FastifyRequest, value: string, maxAgeSeconds: number) => {
    const secure = String(req.headers['x-forwarded-proto'] ?? '').includes('https') ? '; Secure' : '';
    return `${SESSION_COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
  };

  return {
    required,
    passwordLogin,
    isAdmin,

    async requireAdmin(req: FastifyRequest) {
      if (!isAdmin(req)) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in, or send a valid x-admin-token header');
    },

    async login(req: FastifyRequest, reply: FastifyReply, username: string, password: string) {
      if (!passwordLogin) throw new HttpError(404, 'NOT_FOUND', 'Password sign-in is not configured');
      const wait = lockedFor(req.ip);
      if (wait > 0) {
        reply.header('retry-after', String(wait));
        throw new HttpError(429, 'TOO_MANY_ATTEMPTS', `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} min.`, { retryAfterSeconds: wait });
      }
      // Evaluate both so a wrong username takes as long as a wrong password.
      const userOk = sameSecret(username, opts.username!);
      const passOk = sameSecret(password, opts.password!);
      if (!(userOk && passOk)) {
        recordFailure(req.ip);
        req.log.warn({ ip: req.ip }, 'admin sign-in failed');
        if (failureDelayMs) await new Promise((r) => setTimeout(r, failureDelayMs));
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'Wrong username or password');
      }
      ips.delete(req.ip);
      req.log.info({ ip: req.ip }, 'admin signed in');
      const exp = now() + ttl;
      reply.header('set-cookie', cookie(req, `${exp}.${sign(exp)}`, Math.floor(ttl / 1000)));
      return { authenticated: true, expiresAt: new Date(exp).toISOString() };
    },

    logout(req: FastifyRequest, reply: FastifyReply) {
      reply.header('set-cookie', cookie(req, '', 0));
      return { authenticated: false };
    },
  };
}

function readCookie(header: string | undefined, name: string) {
  for (const part of header?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}
