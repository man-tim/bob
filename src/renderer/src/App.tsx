import { useEffect, lazy, Suspense } from 'react'
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Sidebar }        from './components/Shell/Sidebar'
import { Header }         from './components/Shell/Header'
import { StatusBar }      from './components/Shell/StatusBar'
import { Toaster, ErrorBoundary, HelpTooltip, FeedbackLogger, ScrollShimmer } from './components/ui'

// Eagerly loaded — always visible, tiny bundles
import { Dashboard }      from './pages/Dashboard'
import { Companies }      from './pages/Companies'
import { Transcripts }    from './pages/Transcripts'
import { CalendarPage }   from './pages/Calendar'
import { Settings }       from './pages/Settings'

// Lazy loaded — large pages that are only needed on demand
const CompanyDetail = lazy(() =>
  import('./pages/CompanyDetail').then(m => ({ default: m.CompanyDetail }))
)
const FlyerCreator  = lazy(() =>
  import('./pages/FlyerCreator').then(m => ({ default: m.FlyerCreator }))
)
const ScrubSplit    = lazy(() =>
  import('./pages/ScrubSplit').then(m => ({ default: m.ScrubSplit }))
)
const Assistant     = lazy(() =>
  import('./pages/Assistant').then(m => ({ default: m.Assistant }))
)
const PromptLibrary = lazy(() =>
  import('./pages/PromptLibrary').then(m => ({ default: m.PromptLibrary }))
)
const RiskPage = lazy(() =>
  import('./pages/Risk').then(m => ({ default: m.RiskPage }))
)
const ExpansionPage = lazy(() =>
  import('./pages/Expansion').then(m => ({ default: m.ExpansionPage }))
)
const FollowUps = lazy(() =>
  import('./pages/FollowUps').then(m => ({ default: m.FollowUps }))
)
const PopoutRisk = lazy(() =>
  import('./pages/PopoutRisk').then(m => ({ default: m.PopoutRisk }))
)
const PopoutExpansion = lazy(() =>
  import('./pages/PopoutExpansion').then(m => ({ default: m.PopoutExpansion }))
)

import { useUIStore }       from './store/ui.store'
import { useAuthStore }     from './store/auth.store'
import { useJobsStore }     from './store/jobs.store'
import { useServicesStore } from './store/services.store'
import { push, masterRefreshApi, calendarRematchApi, calendarApi } from './lib/ipc'
import { LogIn, Wifi } from 'lucide-react'

/**
 * Wraps ErrorBoundary with a key derived from the current pathname,
 * so navigating to a different tab resets any error state and keeps
 * errors scoped to the page where they occurred.
 */
function KeyedErrorBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return <ErrorBoundary key={pathname}>{children}</ErrorBoundary>
}

/** Listens for PUSH_NAVIGATE from the tray menu and drives React Router. */
function TrayNavigationListener() {
  const navigate = useNavigate()
  useEffect(() => {
    const unsub = push.onNavigate(({ path }) => {
      navigate(path)
    })
    return unsub
  }, [navigate])
  return null
}

/** Minimal inline spinner shown while a lazy page chunk loads */
function PageLoader() {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)',
    }}>
      Loading…
    </div>
  )
}

/** Shown over the app when the user hasn't connected Google yet */
function AuthGate({ onLogin }: { onLogin: () => void }) {
  const loading = useAuthStore(s => s.loading)
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'var(--color-bg-base)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        textAlign: 'center', maxWidth: 380,
        padding: 'var(--space-8)',
        background: 'var(--color-bg-card)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: 'rgba(86,183,163,0.12)',
          border: '1px solid rgba(86,183,163,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto var(--space-4)',
        }}>
          <Wifi size={24} strokeWidth={1.8} style={{ color: 'var(--color-teal-500)' }} />
        </div>
        <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-bold)', color: 'var(--color-text-primary)', margin: '0 0 var(--space-2)' }}>
          Connect to get started
        </h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', margin: '0 0 var(--space-6)', lineHeight: 1.6 }}>
          Sign in with your <strong>@prokeep.com</strong> Google account. This also connects HubSpot automatically — one login, everything works.
        </p>
        <button
          onClick={onLogin}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            width: '100%', padding: '10px 20px',
            background: loading ? 'var(--color-bg-surface)' : 'var(--color-teal-600)',
            border: 'none', borderRadius: 'var(--radius-md)',
            color: 'white', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          <LogIn size={15} strokeWidth={2} />
          {loading ? 'Connecting…' : 'Sign in with Google'}
        </button>
      </div>
    </div>
  )
}

export function App() {
  const sidebarCollapsed = useUIStore(s => s.sidebarCollapsed)
  const authInit  = useAuthStore(s => s.init)
  const authLogin = useAuthStore(s => s.login)
  const authStatus = useAuthStore(s => s.status)
  const jobsInit      = useJobsStore(s => s.init)
  const addToast      = useUIStore(s => s.addToast)
  const appendGongLog = useUIStore(s => s.appendGongLog)
  const servicesInit  = useServicesStore(s => s.init)
  const helpMode      = useUIStore(s => s.helpMode)

  useEffect(() => {
    servicesInit()
    // Init auth first, then fire data-sync tasks only if authenticated
    authInit().then(() => {
      const auth = useAuthStore.getState().status
      if (auth?.isAuthenticated) {
        masterRefreshApi.refresh().catch(() => {})   // pull latest companies from spreadsheet
        calendarApi.sync().catch(() => {})           // pull calendar events from Google
        calendarRematchApi.rematch().catch(() => {}) // link existing events to companies
      }
    }).catch(() => {})
    jobsInit()

    // Global push → toast bridge
    const unsubNotify = push.onNotify(({ title, body, level }) => {
      addToast({ title, body, level: level as never })
    })

    // Surface job failures as error toasts
    const unsubStatus = push.onJobStatus(({ jobId: _id, status }) => {
      if (status === 'failed') {
        addToast({
          title: 'Job failed',
          body: 'A background task encountered an error. Check Recent Jobs for details.',
          level: 'error',
        })
      }
    })

    // Accumulate Gong scraper logs in the store so they survive page navigation.
    // Session-scoped only — the store resets on app close (not persisted to disk).
    const unsubGongLog = push.onGongLog(entry => appendGongLog(entry))

    return () => { unsubNotify(); unsubStatus(); unsubGongLog() }
  }, [])

  return (
    <HashRouter>
      <TrayNavigationListener />
      <AppRoutes helpMode={helpMode} sidebarCollapsed={sidebarCollapsed} authStatus={authStatus} authLogin={authLogin} />
    </HashRouter>
  )
}

// ─── AppRoutes: distinguishes shell vs bare popout windows ────────────────────

function AppRoutes({ helpMode, sidebarCollapsed, authStatus, authLogin }: {
  helpMode: boolean
  sidebarCollapsed: boolean
  authStatus: import('@shared/types').AuthStatus | null
  authLogin: () => void
}) {
  const { pathname } = useLocation()

  if (pathname.startsWith('/popout/')) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/popout/risk"      element={<PopoutRisk />} />
          <Route path="/popout/expansion" element={<PopoutExpansion />} />
        </Routes>
      </Suspense>
    )
  }

  return (
    <>
      <div className="app-layout" style={helpMode ? { cursor: 'help' } : undefined}>
        <aside className={`app-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <Sidebar />
        </aside>

        <div className="app-main">
          <header className="app-header">
            <Header />
          </header>

          <main className="app-content">
            <KeyedErrorBoundary>
              <Suspense fallback={<PageLoader />}>
                <Routes>
                  <Route path="/"               element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard"      element={<Dashboard />} />
                  <Route path="/companies"      element={<Companies />} />
                  <Route path="/companies/:id"  element={<CompanyDetail />} />
                  <Route path="/transcripts"    element={<Transcripts />} />
                  <Route path="/calendar"       element={<CalendarPage />} />
                  <Route path="/scrub"          element={<ScrubSplit />} />
                  <Route path="/risk"           element={<RiskPage />} />
                  <Route path="/expansion"      element={<ExpansionPage />} />
                  <Route path="/flyer"          element={<FlyerCreator />} />
                  <Route path="/followups"      element={<FollowUps />} />
                  <Route path="/prompts"        element={<PromptLibrary />} />
                  <Route path="/assistant"      element={<Assistant />} />
                  <Route path="/settings"       element={<Settings />} />
                </Routes>
              </Suspense>
            </KeyedErrorBoundary>
          </main>

          <footer className="app-statusbar">
            <StatusBar />
          </footer>
        </div>
      </div>

      {/* Startup auth gate — shown until Google is connected */}
      {authStatus !== null && !authStatus.isAuthenticated && (
        <AuthGate onLogin={authLogin} />
      )}

      {/* Global toast overlay — rendered outside the scrollable content area */}
      <Toaster />

      {/* How-To Mode tooltip — follows cursor when help mode is active */}
      <HelpTooltip />

      {/* Feedback Logger — developer tool for capturing UI corrections */}
      <FeedbackLogger />

      {/* Scroll-driven background shimmer — renders behind everything */}
      <ScrollShimmer />
    </>
  )
}
