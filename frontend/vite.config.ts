/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    // The service worker is skipped under Vitest; in production it precaches the app shell and caches a few API reads.
    !process.env.VITEST && VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Smart Tourist Safety', short_name: 'TouristSafe', description: 'Digital tourist ID, safety alerts and a panic button that works offline.',
        start_url: '/tourist', scope: '/', display: 'standalone', orientation: 'portrait',
        background_color: '#091014', theme_color: '#0f766e',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // Authenticated reads are cached ONLY so the app opens offline; the cache is deleted on logout (see store.ts).
        runtimeCaching: [
          { urlPattern: ({ url }) => /^\/api\/(zones|me\/(trip|contacts|profile)|ledger\/my-credential)$/.test(url.pathname),
            handler: 'NetworkFirst', options: { cacheName: 'api-cache', networkTimeoutSeconds: 4, expiration: { maxEntries: 30, maxAgeSeconds: 3 * 86400 } } },
          { urlPattern: /^https:\/\/[abc]\.tile\.openstreetmap\.org\//, handler: 'CacheFirst',
            options: { cacheName: 'osm-tiles', expiration: { maxEntries: 300, maxAgeSeconds: 7 * 86400 }, cacheableResponse: { statuses: [0, 200] } } },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000', changeOrigin: true, ws: true },
    },
  },
  preview: {
    proxy: { '/api': { target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000', changeOrigin: true, ws: true } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.ts',
    exclude: ['e2e/**', 'node_modules/**'],   // Playwright specs run via `npm run e2e`
  },
})
