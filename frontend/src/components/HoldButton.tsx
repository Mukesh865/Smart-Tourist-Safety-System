import { useEffect, useRef, useState, type ReactNode } from 'react'

/** Press-and-hold button (pointer, touch, or Space/Enter held). The ring fills while held; letting go early cancels,
 *  so a pocket press or a brush against the screen cannot trigger a panic alert. */
export default function HoldButton({ onComplete, holdMs = 1500, disabled, children, describedBy, className = '' }:
  { onComplete: () => void; holdMs?: number; disabled?: boolean; children: ReactNode; describedBy?: string; className?: string }) {
  const [progress, setProgress] = useState(0)
  const startRef = useRef<number | null>(null)
  const raf = useRef<number | null>(null)
  const done = useRef(false)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const stop = () => {
    startRef.current = null
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = null
    setProgress(0)
  }
  const start = () => {
    if (disabled || startRef.current !== null) return
    done.current = false
    startRef.current = performance.now()
    const step = (now: number) => {
      if (startRef.current === null) return
      const p = Math.min((now - startRef.current) / holdMs, 1)
      setProgress(p)
      if (p >= 1) {
        if (!done.current) {
          done.current = true
          try { navigator.vibrate?.(200) } catch { /* not supported */ }
          onCompleteRef.current()
        }
        stop()
        return
      }
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
  }
  useEffect(() => stop, [])

  const R = 46, C = 2 * Math.PI * R
  return (
    <button type="button" disabled={disabled} aria-describedby={describedBy}
            onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop} onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); start() } }}
            onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') stop() }}
            onBlur={stop}
            className={`relative touch-none select-none rounded-full bg-red-600 text-white shadow-lg transition active:scale-95 disabled:opacity-50 ${className}`}>
      <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="4" />
        <circle cx="50" cy="50" r={R} fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={C * (1 - progress)} />
      </svg>
      <span className="relative text-2xl font-extrabold tracking-wide">{children}</span>
    </button>
  )
}
