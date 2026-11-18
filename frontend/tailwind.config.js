const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: token('base'), sunken: token('sunken'), surface: token('surface'),
        ink: token('ink'), muted: token('muted'), line: token('line'),
        brand: token('brand'), 'brand-ink': token('brand-ink'),
        danger: token('danger'), warn: token('warn'), ok: token('ok'),
      },
      borderColor: { DEFAULT: token('line') },
    },
  },
  plugins: [],
}
