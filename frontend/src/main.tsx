import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import 'leaflet/dist/leaflet.css'
import './index.css'
import App from './App'
import { registerSW } from 'virtual:pwa-register'
import { ErrorBoundary, ThemeProvider, ToastProvider } from './ui'

try { registerSW({ immediate: true }) } catch { /* service workers unavailable (private mode, http): the app still works online */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <ErrorBoundary>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ErrorBoundary>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
)
