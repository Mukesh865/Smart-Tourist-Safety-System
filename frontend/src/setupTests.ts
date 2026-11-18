import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'   // IndexedDB for the offline queue tests
import { configure } from '@testing-library/react'

// Lazy-loaded pages can take longer than the 1 s default on a busy machine.
configure({ asyncUtilTimeout: 5000 })

// jsdom has no ResizeObserver (used by chart containers)
if (!(globalThis as any).ResizeObserver) {
  ;(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}
