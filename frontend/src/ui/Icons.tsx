import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>
const base = (p: P) => ({ width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p })

export const IconShield = (p: P) => <svg {...base(p)}><path d="M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></svg>
export const IconMap = (p: P) => <svg {...base(p)}><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></svg>
export const IconBell = (p: P) => <svg {...base(p)}><path d="M6 9a6 6 0 1112 0c0 6 2 7 2 7H4s2-1 2-7z" /><path d="M10 20a2 2 0 004 0" /></svg>
export const IconUsers = (p: P) => <svg {...base(p)}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.5 3.2-5.5 6.5-5.5s5.9 2 6.5 5.5" /><path d="M16 5a3.5 3.5 0 010 7M18 14.8c2 .6 3.2 2.2 3.5 5.2" /></svg>
export const IconCog = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 00-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 00-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 002 1.2l.4 2.7h4l.4-2.7a7 7 0 002-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" /></svg>
export const IconSun = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
export const IconMoon = (p: P) => <svg {...base(p)}><path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" /></svg>
export const IconMenu = (p: P) => <svg {...base(p)}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
export const IconQr = (p: P) => <svg {...base(p)}><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" /><path d="M14 14h3v3h-3zM20 14v6h-3M14 20h0" /></svg>
export const IconLogout = (p: P) => <svg {...base(p)}><path d="M9 4H5v16h4" /><path d="M16 8l4 4-4 4M20 12H9" /></svg>
export const IconChart = (p: P) => <svg {...base(p)}><path d="M4 20V4M4 20h16" /><path d="M8 16v-5M12 16V8M16 16v-8" /></svg>
export const IconHome = (p: P) => <svg {...base(p)}><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></svg>
export const IconCheck = (p: P) => <svg {...base(p)}><path d="M5 12l5 5 9-10" /></svg>
export const IconAlert = (p: P) => <svg {...base(p)}><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5M12 18h0" /></svg>
export const IconClipboard = (p: P) => <svg {...base(p)}><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4h6v3H9zM9 12h6M9 16h4" /></svg>
export const IconEye = (p: P) => <svg {...base(p)}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
