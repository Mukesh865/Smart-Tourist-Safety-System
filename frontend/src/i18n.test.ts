import { expect, test } from 'vitest'
import { keysOf, LANGUAGES, translate } from './i18n'

test('every language defines exactly the same keys, none empty', () => {
  const en = keysOf('en').sort()
  for (const lang of LANGUAGES) {
    expect(keysOf(lang).sort(), lang).toEqual(en)
    for (const k of keysOf(lang)) expect(translate(lang, k).trim().length, `${lang}.${k}`).toBeGreaterThan(0)
  }
})

test('placeholders are replaced, and every placeholder survives translation', () => {
  expect(translate('en', 'zoneNear', { zone: 'Cliff', dist: '200 m' })).toBe('Cliff is 200 m away.')
  expect(translate('hi', 'zoneNear', { zone: 'Cliff', dist: '200 m' })).toContain('Cliff')
  for (const k of keysOf('en')) {
    const holes = (translate('en', k).match(/\{(\w+)\}/g) ?? []).sort()
    expect((translate('hi', k).match(/\{(\w+)\}/g) ?? []).sort(), k).toEqual(holes)
  }
})

test('unknown languages fall back to English', () => {
  expect(translate('fr', 'tabHome')).toBe('Home')
  expect(translate('hi', 'tabHome')).not.toBe('Home')
})
