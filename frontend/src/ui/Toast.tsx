import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

export type ToastKind = 'info' | 'success' | 'error' | 'alert'
interface ToastItem { id: number; kind: ToastKind; text: string }
interface Opts { kind?: ToastKind; ms?: number }
type Push = (text: string, opts?: Opts) => number

const ToastCtx = createContext<{ toast: Push; dismiss: (id: number) => void }>({ toast: () => 0, dismiss: () => {} })

const STYLE: Record<ToastKind, string> = {
  info: 'border-line', success: 'border-ok', error: 'border-danger', alert: 'border-danger bg-danger/10',
}

/** Non-blocking messages. Errors/alerts use role="alert" (announced at once); others role="status". */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const next = useRef(1)

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), [])
  const toast = useCallback<Push>((text, opts = {}) => {
    const id = next.current++
    const kind = opts.kind ?? 'info'
    setItems((l) => [...l.slice(-3), { id, kind, text }])
    const ms = opts.ms ?? (kind === 'error' || kind === 'alert' ? 8000 : 4500)
    if (ms > 0) setTimeout(() => dismiss(id), ms)
    return id
  }, [dismiss])

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss])
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div role="region" aria-label="Notifications" className="pointer-events-none fixed inset-x-0 bottom-20 z-[2000] flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end md:pr-6">
        {items.map((t) => (
          <div key={t.id} role={t.kind === 'error' || t.kind === 'alert' ? 'alert' : 'status'}
               className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border-l-4 bg-surface p-3 text-sm shadow-lg ring-1 ring-black/5 ${STYLE[t.kind]}`}>
            <span className="flex-1">{t.text}</span>
            <button className="text-muted hover:text-ink" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx).toast
