import { ArrowClockwise } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Chaos, type ServiceStatus } from '../api';
import { Button, Code, Notice } from './ui';

/** Live service status plus fault injection, for incident-response drills. */
export function OpsPage() {
  const [status, setStatus] = useState<ServiceStatus[] | null>(null);
  const [chaos, setChaos] = useState<Record<string, Chaos | null> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.status(), api.chaos()]);
      setStatus(s.services);
      setChaos(c);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} (${err.code})` : 'The gateway is unreachable.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[60ch] text-sm text-muted">
          Every service exposes the same chaos controls. Raise an error rate or add latency, then watch the trip search degrade and bookings compensate. Refreshes every 5 seconds.
        </p>
        <Button onClick={refresh}>
          <ArrowClockwise size={20} weight="light" aria-hidden />
          Refresh now
        </Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {!status && !error && <div className="skeleton h-64 w-full" />}
      {status && (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="num w-full min-w-[44rem] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Service</th>
                <th className="px-4 py-2 font-medium">Health</th>
                <th className="px-4 py-2 font-medium">Latency</th>
                <th className="px-4 py-2 font-medium">Error rate</th>
                <th className="px-4 py-2 font-medium">Added latency</th>
                <th className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {status.map((s) => (
                <ChaosRow key={s.service} status={s} chaos={chaos?.[s.service] ?? null} onChange={refresh} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ChaosRow({ status, chaos, onChange }: { status: ServiceStatus; chaos: Chaos | null; onChange: () => void }) {
  const [rate, setRate] = useState(0);
  const [latency, setLatency] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (chaos && !dirty) {
      setRate(Math.round(chaos.errorRate * 100));
      setLatency(chaos.latencyMs);
    }
  }, [chaos, dirty]);

  const apply = async (reset = false) => {
    setBusy(true);
    try {
      if (reset) await api.resetChaos(status.service);
      else await api.setChaos(status.service, { errorRate: rate / 100, latencyMs: latency });
      setDirty(false);
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const up = status.status === 'up';
  return (
    <tr>
      <td className="px-4 py-3">
        <Code>{status.service}</Code>
        {status.version && <span className="ml-2 text-xs text-muted">{status.version}</span>}
      </td>
      <td className={`px-4 py-3 ${up ? 'text-ok' : 'text-danger'}`}>{up ? 'up' : `down: ${status.error ?? 'no response'}`}</td>
      <td className="px-4 py-3 font-mono">{status.latencyMs} ms</td>
      <td className="px-4 py-3">
        <label className="flex items-center gap-2">
          <span className="sr-only">Error rate for {status.service}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={rate}
            disabled={!chaos}
            onChange={(e) => {
              setRate(Number(e.target.value));
              setDirty(true);
            }}
            className="w-28 accent-[var(--td-accent-ink)]"
          />
          <span className="w-10 font-mono text-xs">{rate}%</span>
        </label>
      </td>
      <td className="px-4 py-3">
        <label className="flex items-center gap-1">
          <span className="sr-only">Added latency for {status.service} in milliseconds</span>
          <input
            type="number"
            min={0}
            max={60000}
            step={100}
            value={latency}
            disabled={!chaos}
            onChange={(e) => {
              setLatency(Number(e.target.value));
              setDirty(true);
            }}
            className="min-h-9 w-24 rounded-md border border-line bg-surface px-2 font-mono text-xs"
          />
          <span className="text-xs text-muted">ms</span>
        </label>
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-2">
          <Button variant={dirty ? 'primary' : 'quiet'} busy={busy} disabled={!chaos || !dirty} onClick={() => apply()} className="min-h-9 px-3">
            Apply
          </Button>
          <Button busy={busy} disabled={!chaos} onClick={() => apply(true)} className="min-h-9 px-3">
            Reset
          </Button>
        </div>
      </td>
    </tr>
  );
}
