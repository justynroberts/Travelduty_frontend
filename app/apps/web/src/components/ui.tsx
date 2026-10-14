import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useId } from 'react';

type Variant = 'primary' | 'quiet' | 'danger';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-text font-medium hover-fine:brightness-105',
  quiet: 'border border-line bg-surface text-text hover-fine:bg-raised',
  danger: 'border border-danger/50 text-danger bg-surface hover-fine:bg-danger/10',
};

export function Button({
  variant = 'quiet',
  busy,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm transition-[transform,filter,background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-55 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

const control =
  'min-h-11 w-full min-w-0 rounded-md border border-line bg-surface px-3 text-sm text-text placeholder:text-muted aria-invalid:border-danger';

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={`${control} ${props.className ?? ''}`} />;

export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={`${control} ${props.className ?? ''}`} />;

export function Notice({ tone = 'muted', children }: { tone?: 'muted' | 'danger' | 'ok'; children: ReactNode }) {
  const tones = { muted: 'text-muted border-line', danger: 'text-danger border-danger/40', ok: 'text-ok border-ok/40' };
  return <div className={`rounded-md border bg-surface px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}

export const Code = ({ children }: { children: ReactNode }) => <span className="font-mono text-[0.92em] tracking-tight">{children}</span>;
