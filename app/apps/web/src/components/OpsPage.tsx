import { ArrowClockwise, SignOut } from '@phosphor-icons/react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, type AdminSession, api, type Chaos, type ServiceStatus } from '../api';
import { Button, Code, Field, Input, Notice } from './ui';

/** Live service status plus fault injection, for incident-response drills. */
export function OpsPage() {
  const [status, setStatus] = useState<ServiceStatus[] | null>(null);
  const [chaos, setChaos] = useState<Record<string, Chaos | null> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<AdminSession | null>(null);

  const refresh = useCallback(async () => {
    // Service status is public; chaos control needs a signed-in session on deployments that require one.
    const [s, a] = await Promise.allSettled([api.status(), api.adminSession()]);
    if (s.status === 'fulfilled') setStatus(s.value.services);
    const admin = a.status === 'fulfilled' ? a.value : null;
    setSession(admin);
    let failed = s.status === 'rejected' ? s.reason : a.status === 'rejected' ? a.reason : null;
    if (admin?.authenticated) {
      try {
        setChaos(await api.chaos());
      } catch (err) {
        failed ??= err;
      }
    } else {
      setChaos(null);
    }
    setError(failed ? (failed instanceof ApiError ? `${failed.message} (${failed.code})` : 'The gateway is unreachable.') : null);
  }, []);

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    void refresh();
  };

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
        <div className="flex gap-2">
          <Button onClick={refresh}>
            <ArrowClockwise size={20} weight="light" aria-hidden />
            Refresh now
          </Button>
          {session?.required && session.authenticated && session.passwordLogin && (
            <Button onClick={signOut}>
              <SignOut size={20} weight="light" aria-hidden />
              Sign out
            </Button>
          )}
        </div>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {session && !session.authenticated && (session.passwordLogin ? <SignInForm onSignedIn={refresh} /> : <Notice tone="muted">Chaos control on this deployment needs an x-admin-token header; use the API directly.</Notice>)}
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
    } catch {
      // A 401 (token removed or rotated) or outage: the refresh shows why.
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

function SignInForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.login(username.trim(), password);
      setPassword('');
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The gateway is unreachable.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <p className="text-sm text-muted">Chaos controls are locked on this deployment. Sign in to change error rates and latency.</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <Field label="Username">
            {(id) => <Input id={id} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />}
          </Field>
        </div>
        <div className="min-w-[12rem] flex-1">
          <Field label="Password">
            {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
        </div>
        <Button variant="primary" busy={busy} disabled={!username.trim() || !password}>
          Sign in
        </Button>
      </div>
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
