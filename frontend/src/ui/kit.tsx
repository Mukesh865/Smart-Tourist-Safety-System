import { Component, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'

const cx = (...a: (string | false | undefined | null)[]) => a.filter(Boolean).join(' ')

/* ---------- Button ---------- */
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }
const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand text-white dark:text-slate-950 hover:brightness-110',
  secondary: 'border border-line bg-surface text-ink hover:bg-sunken',
  danger: 'bg-danger text-white dark:text-slate-950 hover:brightness-110',
  ghost: 'text-ink hover:bg-sunken',
}
export function Button({ variant = 'primary', size = 'md', loading, disabled, className, children, ...rest }: BtnProps) {
  return (
    <button {...rest} disabled={disabled || loading} aria-busy={loading || undefined}
            className={cx('inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'min-h-[2rem] px-3 py-1 text-xs' : 'min-h-[2.5rem] px-4 py-2 text-sm', VARIANT[variant], className)}>
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  )
}

/* ---------- Layout bits ---------- */
export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('card', className)}>{children}</div>
}

const TONE = {
  neutral: 'bg-sunken text-muted', brand: 'bg-brand/15 text-brand-ink', ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn', danger: 'bg-danger/15 text-danger',
}
export type Tone = keyof typeof TONE
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold', TONE[tone], className)}>{children}</span>
}

export function StatCard({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: Tone; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={cx('mt-1 text-2xl font-bold', tone === 'danger' && 'text-danger', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn')}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className ?? 'h-5 w-5')} viewBox="0 0 24 24" fill="none" role="status" aria-label="Loading">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-md bg-sunken', className ?? 'h-4 w-full')} />
}

export function EmptyState({ title, hint, action, icon }: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line p-8 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="font-semibold">{title}</p>
      {hint && <p className="max-w-sm text-sm text-muted">{hint}</p>}
      {action}
    </div>
  )
}

/* ---------- Forms ---------- */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string, describedBy?: string) => ReactNode }) {
  const id = useId()
  const hid = `${id}-h`
  const described = error || hint ? hid : undefined
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      {children(id, described)}
      {error ? <p id={hid} role="alert" className="text-xs text-danger">{error}</p> : hint ? <p id={hid} className="text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

export function TextInput({ label, hint, error, ...rest }: { label: string; hint?: string; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return <Field label={label} hint={hint} error={error}>{(id, d) => <input id={id} aria-describedby={d} aria-invalid={!!error || undefined} className="input" {...rest} />}</Field>
}

export function SelectInput({ label, children, ...rest }: { label: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  return <Field label={label}>{(id) => <select id={id} className="input" {...rest}>{children}</select>}</Field>
}

/* ---------- Modal / confirm ---------- */
export function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose            // always call the latest handler without re-running the effect below
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()                // focus moves into the dialog once, when it opens (not on every re-render)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.() }   // return focus to the trigger
  }, [open])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[3000] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
           className="max-h-[90vh] w-full overflow-auto rounded-t-2xl bg-surface p-5 shadow-xl outline-none sm:max-w-lg sm:rounded-2xl">
        <h2 className="mb-3 text-lg font-bold">{title}</h2>
        <div className="space-y-3">{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger, onConfirm, onCancel }:
  { open: boolean; title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal open={open} title={title} onClose={onCancel}
           footer={<><Button variant="secondary" onClick={onCancel}>Cancel</Button>
             <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <p className="text-sm text-muted">{message}</p>
    </Modal>
  )
}

/* ---------- Tabs ---------- */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-lg bg-sunken p-1">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
                className={cx('rounded-md px-3 py-1.5 text-sm font-medium transition', value === t.id ? 'bg-surface shadow-sm' : 'text-muted hover:text-ink')}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- Error boundary ---------- */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" className="mx-auto mt-16 max-w-md rounded-xl border border-danger/40 bg-surface p-6 text-center">
        <h1 className="text-lg font-bold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">The page hit an unexpected error. Your data is safe. Try reloading.</p>
        <Button className="mt-4" onClick={() => window.location.reload()}>Reload</Button>
      </div>
    )
  }
}
