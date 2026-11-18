import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import RequireRole from './components/RequireRole'
import Auth from './pages/Auth'
import { homeFor, useAuth } from './store'

// Heavy pages (maps, QR, charts) are loaded on demand to keep the first load small.
const Analytics = lazy(() => import('./pages/Analytics'))
const Calibration = lazy(() => import('./pages/Calibration'))
const Admin = lazy(() => import('./pages/Admin'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Evaluation = lazy(() => import('./pages/Evaluation'))
const Ledger = lazy(() => import('./pages/Ledger'))
const Family = lazy(() => import('./pages/Family'))
const Officer = lazy(() => import('./pages/Officer'))
const TouristLayout = lazy(() => import('./pages/tourist/TouristContext').then((m) => ({ default: m.TouristLayout })))
const TouristHome = lazy(() => import('./pages/tourist/TouristHome'))
const TouristMap = lazy(() => import('./pages/tourist/TouristMap'))
const TouristSafety = lazy(() => import('./pages/tourist/TouristSafety'))
const TouristId = lazy(() => import('./pages/tourist/TouristId'))
const TouristSettings = lazy(() => import('./pages/tourist/TouristSettings'))
const Tourists = lazy(() => import('./pages/Tourists'))
const Profile = lazy(() => import('./pages/Profile'))
const Verify = lazy(() => import('./pages/Verify'))
const Zones = lazy(() => import('./pages/Zones'))

function Home() {
  const { user, loading } = useAuth()
  if (loading) return <p className="p-6">Loading…</p>
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />
}

export default function App() {
  const restore = useAuth((s) => s.restore)
  useEffect(() => { restore() }, [restore])
  return (
    <Suspense fallback={<p className="p-6">Loading…</p>}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Auth mode="login" />} />
        <Route path="/register" element={<Auth mode="register" />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/family/:token" element={<Family />} />
        <Route path="/tourist" element={<RequireRole roles={['tourist']}><TouristLayout /></RequireRole>}>
          <Route index element={<TouristHome />} />
          <Route path="map" element={<TouristMap />} />
          <Route path="safety" element={<TouristSafety />} />
          <Route path="id" element={<TouristId />} />
          <Route path="settings" element={<TouristSettings />} />
        </Route>
        <Route path="/officer" element={<RequireRole roles={['officer', 'admin']}><Officer /></RequireRole>} />
        <Route path="/dashboard" element={<RequireRole roles={['police', 'admin']}><Dashboard /></RequireRole>} />
        <Route path="/analytics" element={<RequireRole roles={['police', 'admin']}><Analytics /></RequireRole>} />
        <Route path="/zones" element={<RequireRole roles={['police', 'admin']}><Zones /></RequireRole>} />
        <Route path="/evaluation" element={<RequireRole roles={['police', 'admin']}><Evaluation /></RequireRole>} />
        <Route path="/tourists" element={<RequireRole roles={['officer', 'admin']}><Tourists /></RequireRole>} />
        <Route path="/ledger" element={<RequireRole roles={['police', 'admin']}><Ledger /></RequireRole>} />
        <Route path="/calibration" element={<RequireRole roles={['admin']}><Calibration /></RequireRole>} />
        <Route path="/admin" element={<RequireRole roles={['admin']}><Admin /></RequireRole>} />
        <Route path="/profile" element={<RequireRole roles={['tourist', 'officer', 'police', 'admin']}><Profile /></RequireRole>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
