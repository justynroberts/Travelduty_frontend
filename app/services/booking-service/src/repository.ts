import pg from 'pg';
import type { Booking } from './types.js';

export interface BookingRepository {
  save(booking: Booking): Promise<void>;
  get(ref: string): Promise<Booking | undefined>;
  list(filter: { email?: string; limit: number }): Promise<Booking[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryBookingRepository implements BookingRepository {
  private readonly bookings = new Map<string, Booking>();

  async save(booking: Booking) {
    this.bookings.set(booking.ref, structuredClone(booking));
  }
  async get(ref: string) {
    const b = this.bookings.get(ref);
    return b && structuredClone(b);
  }
  async list({ email, limit }: { email?: string; limit: number }) {
    return [...this.bookings.values()]
      .filter((b) => !email || b.contact.email.toLowerCase() === email.toLowerCase())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((b) => structuredClone(b));
  }
  async ping() {
    return true;
  }
  async close() {}
}

/** Bookings stored as JSONB documents, with the queryable fields promoted to columns. */
export class PostgresBookingRepository implements BookingRepository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  /** Creates the schema, retrying while the database is still starting. */
  async init(attempts = 30, delayMs = 1_000) {
    for (let i = 1; ; i++) {
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS bookings (
            ref         TEXT PRIMARY KEY,
            email       TEXT NOT NULL,
            status      TEXT NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL,
            updated_at  TIMESTAMPTZ NOT NULL,
            doc         JSONB NOT NULL
          );
          CREATE INDEX IF NOT EXISTS bookings_email_idx ON bookings (lower(email), created_at DESC);
          CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);
        `);
        return;
      } catch (err) {
        if (i >= attempts) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async save(b: Booking) {
    await this.pool.query(
      `INSERT INTO bookings (ref, email, status, created_at, updated_at, doc)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (ref) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc`,
      [b.ref, b.contact.email, b.status, b.createdAt, b.updatedAt, JSON.stringify(b)],
    );
  }

  async get(ref: string) {
    const res = await this.pool.query<{ doc: Booking }>('SELECT doc FROM bookings WHERE ref = $1', [ref]);
    return res.rows[0]?.doc;
  }

  async list({ email, limit }: { email?: string; limit: number }) {
    const res = await this.pool.query<{ doc: Booking }>(
      `SELECT doc FROM bookings WHERE ($1::text IS NULL OR lower(email) = lower($1)) ORDER BY created_at DESC LIMIT $2`,
      [email ?? null, limit],
    );
    return res.rows.map((r) => r.doc);
  }

  async ping() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    await this.pool.end();
  }
}
