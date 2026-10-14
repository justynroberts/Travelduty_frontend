export function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

export function envOptional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function envNumber(name: string, fallback: number): number {
  const raw = envOptional(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return n;
}

/** Default local ports, shared by every service's config and the dev launcher. */
export const DEFAULT_PORTS = {
  gateway: 8080,
  destination: 8081,
  flight: 8082,
  hotel: 8083,
  pricing: 8084,
  booking: 8085,
  payment: 8086,
  notification: 8087,
} as const;

export type ServiceKey = keyof typeof DEFAULT_PORTS;

export function serviceUrl(key: ServiceKey): string {
  return env(`${key.toUpperCase()}_SERVICE_URL`, `http://localhost:${DEFAULT_PORTS[key]}`);
}
