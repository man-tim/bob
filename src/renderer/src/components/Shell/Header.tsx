import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Loader2, Wifi, WifiOff, Bell, X, AlertCircle, CheckCircle, AlertTriangle, ScrollText, RefreshCw, Trash2, Copy, Sparkles } from 'lucide-react'
import { useJobsStore }  from '../../store/jobs.store'
import { useAuthStore }  from '../../store/auth.store'
import { useCompaniesStore } from '../../store/companies.store'
import { useUIStore }    from '../../store/ui.store'
import { actionsLogApi, masterRefreshApi, appMasterResetApi, push, type ActionsLogEntry } from '../../lib/ipc'
import { formatRelative } from '../../lib/utils'
import type { Job } from '@shared/types'
import { AskBOB } from '../ui/AskBOB'

// Map exact routes AND prefix-matched patterns to titles
const PAGE_TITLES: Array<{ test: (p: string) => boolean; title: string; subtitle: string }> = [
  { test: p => p === '/dashboard',              title: 'Dashboard',       subtitle: 'Your CSM workspace at a glance' },
  { test: p => p.startsWith('/companies/') && p.length > 12, title: 'Company Detail', subtitle: 'CSM Copilot' },
  { test: p => p === '/companies',              title: 'Companies',       subtitle: 'Master Book of Business' },
  { test: p => p === '/transcripts',            title: 'Transcripts',     subtitle: 'Gong Scrubber & data processing' },
  { test: p => p === '/calendar',               title: 'Calendar',        subtitle: 'Week at a Glance' },
  { test: p => p === '/scrub',                  title: 'Scrub & Split',   subtitle: 'CSV PII removal' },
  { test: p => p === '/risk',                   title: 'Risk',            subtitle: 'Account health analysis' },
  { test: p => p === '/expansion',              title: 'Expansion',       subtitle: 'Growth opportunity analysis' },
  { test: p => p === '/prompts',                title: 'Prompt Library',  subtitle: 'Claude prompts for account analysis' },
  { test: p => p === '/flyer',                  title: 'Flyer Creator',   subtitle: 'QR codes & printable PDFs' },
  { test: p => p === '/settings',               title: 'Settings',        subtitle: 'Integrations & configuration' },
]

function getTitle(pathname: string) {
  return PAGE_TITLES.find(t => t.test(pathname)) ?? { title: 'B.O.B.', subtitle: '' }
}

export function Header() {
  const navigate  = useNavigate()
  const { pathname } = useLocation()
  const meta      = getTitle(pathname)
  const jobs       = useJobsStore(s => s.jobs)
  const activeJobs = useJobsStore(s => s.activeJobs())
  const fetchCos   = useCompaniesStore(s => s.fetch)
  const fetchJobs  = useJobsStore(s => s.fetchJobs)
  const addToast   = useUIStore(s => s.addToast)
  const clearGongLogs = useUIStore(s => s.clearGongLogs)
  const auth      = useAuthStore(s => s.status)

  const [showLog,      setShowLog]      = useState(false)
  const [showActLog,   setShowActLog]   = useState(false)
  const [showAskBOB,   setShowAskBOB]   = useState(false)
  const [dismissedAt,  setDismissedAt]  = useState<number>(() =>
    parseInt(localStorage.getItem('failedJobsDismissedAt') ?? '0', 10)
  )
  const [refreshing,   setRefreshing]   = useState(false)
  const [resetting,    setResetting]    = useState(false)

  // ── Global progress bar state ──────────────────────────────────────────────
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(null)
  const progressHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const unsubProgress = push.onJobProgress(({ step, total, label }) => {
      const pct = total > 0 ? Math.min(100, Math.round((step / total) * 100)) : 0
      setProgress({ pct, label: label || '' })
      if (progressHideTimer.current) clearTimeout(progressHideTimer.current)
    })
    const unsubStatus = push.onJobStatus(({ status }) => {
      if (status === 'completed' || status === 'failed') {
        setProgress(prev => prev ? { ...prev, pct: 100 } : null)
        if (progressHideTimer.current) clearTimeout(progressHideTimer.current)
        progressHideTimer.current = setTimeout(() => setProgress(null), 1500)
      }
    })
    return () => { unsubProgress(); unsubStatus() }
  }, [])

  const failedCount = jobs.filter(j => j.status === 'failed' && new Date(j.created_at).getTime() > dismissedAt).length

  function handleBellClick() {
    setShowLog(true)
  }
  function handleCloseBell() {
    setShowLog(false)
    const now = Date.now()
    setDismissedAt(now)
    localStorage.setItem('failedJobsDismissedAt', String(now))
  }

  async function handleMasterReset() {
    const confirmed = window.confirm(
      'Master Reset will wipe ALL saved app data back to a first-time state:\n\n' +
      '• All companies, transcripts, and calendar events\n' +
      '• All contacts and company notes\n' +
      '• All jobs, schedules, and scrub jobs\n' +
      '• All Gong scraper state and activity log\n\n' +
      'Your Google, Gong, and HubSpot connections are kept.\n' +
      'Your quick links, saved prompts, and flyer templates are kept.\n\n' +
      'This cannot be undone. Continue?'
    )
    if (!confirmed) return
    setResetting(true)
    try {
      const r = await appMasterResetApi.reset()
      if (r.ok) {
        clearGongLogs()
        await Promise.all([
          fetchJobs(),
          fetchCos({ page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc' }),
        ])
        addToast({ title: 'Master Reset complete — all data cleared', level: 'ok' })
      } else {
        addToast({ title: 'Master Reset failed', body: (r as { error?: string }).error, level: 'error' })
      }
    } catch {
      addToast({ title: 'Master Reset failed', body: 'An unexpected error occurred', level: 'error' })
    }
    setResetting(false)
  }

  async function handleMasterRefresh() {
    setRefreshing(true)
    try {
      const r = await masterRefreshApi.refresh()
      if (r.ok) {
        await fetchCos({ page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc' })
        addToast({ title: `Master Refresh complete — ${r.data.synced} companies synced`, level: 'ok' })
      } else {
        addToast({ title: 'Master Refresh failed', body: r.error, level: 'error' })
      }
    } catch {
      addToast({ title: 'Master Refresh failed', body: 'Could not connect to spreadsheet', level: 'error' })
    }
    setRefreshing(false)
  }

  return (
    <>
      {/* Global progress bar — thin stripe that appears at the very top of the content area */}
      {progress && (
        <div style={{
          position:   'absolute',
          top:        0,
          left:       0,
          right:      0,
          zIndex:     2000,
          height:     3,
          background: 'var(--color-bg-elevated)',
          overflow:   'hidden',
        }}>
          <div style={{
            height:     '100%',
            width:      `${progress.pct}%`,
            background: progress.pct >= 100
              ? 'var(--color-green-500)'
              : 'linear-gradient(90deg, var(--color-teal-600), var(--color-teal-400))',
            transition: 'width 0.3s ease, background 0.3s ease',
          }} />
          {/* Label tooltip below bar */}
          {progress.label && progress.pct < 100 && (
            <div style={{
              position:    'absolute',
              top:         4,
              left:        '50%',
              transform:   'translateX(-50%)',
              background:  'var(--color-bg-surface)',
              border:      '1px solid var(--color-border)',
              borderRadius: 4,
              padding:     '2px 8px',
              fontSize:    10,
              color:       'var(--color-text-secondary)',
              whiteSpace:  'nowrap',
              boxShadow:   '0 2px 8px rgba(0,0,0,0.3)',
            }}>
              {progress.pct}% — {progress.label}
            </div>
          )}
        </div>
      )}
      <div style={styles.header}>
        {/* macOS traffic light spacer */}
        <div style={styles.trafficLightSpacer} />

        {/* Page title */}
        <div style={styles.titleBlock}>
          <h1 style={styles.title}>{meta.title}</h1>
          {meta.subtitle && <span style={styles.subtitle}>{meta.subtitle}</span>}
        </div>

        {/* Right cluster */}
        <div style={styles.right}>

          {/* Ask BOB Anything */}
          <button
            onClick={() => setShowAskBOB(true)}
            title="Ask B.O.B. anything — powered by local AI"
            style={{
              ...styles.actionBtn,
              background: 'rgba(86,183,163,0.12)',
              border: '1px solid rgba(86,183,163,0.3)',
              color: 'var(--color-teal-400)',
              fontWeight: 700,
            }}
          >
            <Sparkles size={11} strokeWidth={2} style={{ flexShrink: 0 }} />
            Ask BOB Anything
          </button>

          {/* Master Reset */}
          <button
            data-help="Master Reset: wipes ALL saved app data (companies, transcripts, calendar events, contacts, jobs, scrub state, Gong scraper state) back to a first-time state. Your Google, Gong, and HubSpot connections are preserved. Use this to start fresh."
            style={styles.resetBtn}
            onClick={handleMasterReset}
            disabled={resetting}
            title="Reset all app data to first-time state"
          >
            <Trash2 size={11} strokeWidth={2} style={{ flexShrink: 0 }} />
            Master Reset
          </button>

          {/* Master Refresh */}
          <button
            data-help="Master Refresh: re-reads your Master Account Spreadsheet and syncs the latest company data into the app. Use this after manually editing the spreadsheet."
            style={styles.actionBtn}
            onClick={handleMasterRefresh}
            disabled={refreshing}
            title="Pull latest data from Master Spreadsheet"
          >
            <RefreshCw size={11} strokeWidth={2} style={{ flexShrink: 0, animation: refreshing ? 'spin 800ms linear infinite' : undefined }} />
            Master Refresh
          </button>

          {/* Actions Log */}
          <button data-help="Actions Log: a persistent history of everything the Gong Scrubber has done — every step, warning, and result. Use this to diagnose issues or verify past runs." style={styles.actionBtn} onClick={() => setShowActLog(true)} title="View actions log">
            <ScrollText size={11} strokeWidth={2} style={{ flexShrink: 0 }} />
            Actions Log
          </button>

          {/* Failed jobs alert */}
          {failedCount > 0 && (
            <button style={styles.alertBadge} onClick={handleBellClick} title="View activity log">
              <Bell size={12} strokeWidth={2} style={{ flexShrink: 0 }} />
              {failedCount} failed
            </button>
          )}

          {/* Active jobs indicator */}
          {activeJobs.length > 0 && (
            <button style={styles.jobBadge} onClick={() => setShowLog(true)} title="View activity log">
              <Loader2 size={12} style={{ animation: 'spin 800ms linear infinite', flexShrink: 0 }} />
              {activeJobs.length} running
            </button>
          )}

          {/* Auth status pill */}
          <button
            style={{
              ...styles.authPill,
              ...(auth?.isAuthenticated ? styles.authPillConnected : styles.authPillDisconnected),
            }}
            onClick={() => navigate('/settings')}
            title={auth?.isAuthenticated ? `Connected as ${auth.email}` : 'Click to connect Google'}
          >
            {auth?.isAuthenticated
              ? <Wifi    size={11} strokeWidth={2} />
              : <WifiOff size={11} strokeWidth={2} />
            }
            {auth?.isAuthenticated ? 'Google' : 'Connect'}
          </button>
        </div>
      </div>

      {/* Jobs activity log modal */}
      {showLog && <ActivityLog jobs={jobs} onClose={handleCloseBell} />}

      {/* Persistent actions log modal */}
      {showActLog && <ActionsLogModal onClose={() => setShowActLog(false)} />}

      {/* Global Ask BOB modal */}
      <AskBOB open={showAskBOB} onClose={() => setShowAskBOB(false)} />
    </>
  )
}

// ─── Job type → friendly name map ────────────────────────────────────────────
const JOB_TYPE_LABELS: Record<string, string> = {
  scrub_split:     'Scrub & Split',
  scrub_process:   'Scrub & Split',
  hubspot_import:  'HubSpot Import',
  master_refresh:  'Master Refresh',
  gong_scrape:     'Gong Scrape',
  gong_collect:    'Gong Collect',
  gong_extract:    'Gong Extract',
  calendar_sync:   'Calendar Sync',
  drive_organize:  'Drive Organize',
  index_rebuild:   'Index Rebuild',
}
function friendlyJobType(type: string): string {
  return JOB_TYPE_LABELS[type] ?? type.replace(/_/g, ' ')
}

function friendlyStatus(status: string): string {
  if (status === 'completed' || status === 'done') return '✓ Complete'
  if (status === 'failed')  return 'Failed'
  if (status === 'running') return 'Running…'
  if (status === 'pending') return 'Pending'
  return status
}

// ─── Jobs Activity Log ────────────────────────────────────────────────────────

function ActivityLog({ jobs, onClose }: { jobs: Job[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  const sorted = [...jobs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  function handleCopyLog() {
    const text = sorted.map(job =>
      `[${new Date(job.created_at).toLocaleString()}] ${friendlyJobType(job.type)} — ${friendlyStatus(job.status)}${job.status === 'failed' && job.error ? `\n  Error: ${job.error}` : ''}`
    ).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>Activity Log</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={handleCopyLog}
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: copied ? 'var(--color-green-500)' : 'var(--color-text-muted)', background: 'none', border: '1px solid var(--color-border)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
            >
              <Copy size={10} />
              {copied ? 'Copied!' : 'Copy Log'}
            </button>
            <button style={styles.closeBtn} onClick={onClose}><X size={14} /></button>
          </div>
        </div>
        <div style={styles.logList}>
          {jobs.length === 0 ? (
            <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
              No activity yet
            </div>
          ) : (
            sorted.map(job => (
              <div key={job.id} style={styles.logRow}>
                <StatusIcon status={job.status} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.logType}>{friendlyJobType(job.type)}</div>
                  {job.status === 'failed' && job.error && (
                    <div style={styles.logError}>{job.error}</div>
                  )}
                </div>
                <div style={styles.logTime}>{formatRelative(job.created_at)}</div>
                <div style={{ ...styles.logStatus, color: statusColor(job.status) }}>{friendlyStatus(job.status)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Persistent Actions Log ───────────────────────────────────────────────────

function ActionsLogModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<ActionsLogEntry[]>([])
  const addToast = useUIStore(s => s.addToast)

  useEffect(() => {
    actionsLogApi.get().then(r => { if (r.ok) setEntries([...r.data].reverse()) })
  }, [])

  async function handleClear() {
    await actionsLogApi.clear()
    setEntries([])
    addToast({ title: 'Actions log cleared', level: 'ok' })
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={{ ...styles.modal, width: 560 }} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>Actions Log</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={handleClear}
              style={{ fontSize: 11, color: 'var(--color-text-muted)', background: 'none', border: '1px solid var(--color-border)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
            >
              Clear log
            </button>
            <button style={styles.closeBtn} onClick={onClose}><X size={14} /></button>
          </div>
        </div>
        <div style={{ ...styles.logList, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          {entries.length === 0 ? (
            <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', fontFamily: 'inherit' }}>
              No log entries yet. Run the Gong Scrubber to generate logs.
            </div>
          ) : entries.map((e, i) => (
            <div key={i} style={{
              display:      'flex',
              gap:          8,
              padding:      '3px 14px',
              borderBottom: i < entries.length - 1 ? '1px solid rgba(255,255,255,0.04)' : undefined,
              color: e.cls === 'log-err'  ? 'var(--color-red-400)'
                   : e.cls === 'log-ok'   ? 'var(--color-green-400)'
                   : e.cls === 'log-warn' ? '#F4B74E'
                   : e.cls === 'log-step' ? 'var(--color-teal-400)'
                   : 'var(--color-text-secondary)',
            }}>
              <span style={{ flexShrink: 0, color: 'var(--color-text-muted)' }}>{e.ts}</span>
              <span>{e.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status: string }) {
  const size = 14
  if (status === 'failed')                       return <AlertCircle  size={size} style={{ color: '#DA5039', flexShrink: 0 }} />
  if (status === 'completed' || status === 'done') return <CheckCircle  size={size} style={{ color: 'var(--color-green-500)', flexShrink: 0 }} />
  if (status === 'running')                      return <Loader2      size={size} style={{ color: 'var(--color-teal-400)', flexShrink: 0, animation: 'spin 800ms linear infinite' }} />
  return                                                <AlertTriangle size={size} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
}

function statusColor(status: string): string {
  if (status === 'failed')                         return '#DA5039'
  if (status === 'completed' || status === 'done') return 'var(--color-green-500)'
  if (status === 'running')                        return 'var(--color-teal-400)'
  return 'var(--color-text-muted)'
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    height:       'var(--header-height)',
    display:      'flex',
    alignItems:   'center',
    padding:      '0 var(--space-5)',
    background:   'var(--color-bg-content)',
    borderBottom: '1px solid var(--color-border)',
    gap:          'var(--space-4)',
    position:     'relative',
    overflow:     'visible',
  },
  trafficLightSpacer: { width: 0 },
  titleBlock: {
    display:    'flex',
    alignItems: 'baseline',
    gap:        'var(--space-3)',
  },
  title: {
    fontSize:   'var(--text-lg)',
    fontWeight: 'var(--weight-semibold)' as never,
    color:      'var(--color-text-primary)',
    margin:     0,
  },
  subtitle: {
    fontSize: 'var(--text-sm)',
    color:    'var(--color-text-muted)',
  },
  right: {
    marginLeft: 'auto',
    display:    'flex',
    alignItems: 'center',
    gap:        'var(--space-2)',
  },
  actionBtn: {
    display:      'flex',
    alignItems:   'center',
    gap:          5,
    padding:      '4px 10px',
    borderRadius: 'var(--radius-full)',
    background:   'var(--color-bg-elevated)',
    border:       '1px solid var(--color-border)',
    color:        'var(--color-text-secondary)',
    fontSize:     'var(--text-xs)',
    fontWeight:   'var(--weight-medium)' as never,
    cursor:       'pointer',
  },
  resetBtn: {
    display:      'flex',
    alignItems:   'center',
    gap:          5,
    padding:      '4px 10px',
    borderRadius: 'var(--radius-full)',
    background:   'rgba(218, 80, 57, 0.07)',
    border:       '1px solid rgba(218, 80, 57, 0.35)',
    color:        '#DA5039',
    fontSize:     'var(--text-xs)',
    fontWeight:   'var(--weight-medium)' as never,
    cursor:       'pointer',
  },
  jobBadge: {
    display:      'flex',
    alignItems:   'center',
    gap:          5,
    padding:      '4px 10px',
    borderRadius: 'var(--radius-full)',
    background:   'var(--color-teal-muted)',
    border:       '1px solid rgba(86, 183, 163, 0.2)',
    color:        'var(--color-teal-400)',
    fontSize:     'var(--text-xs)',
    fontWeight:   'var(--weight-medium)' as never,
    cursor:       'pointer',
  },
  alertBadge: {
    display:      'flex',
    alignItems:   'center',
    gap:          5,
    padding:      '4px 10px',
    borderRadius: 'var(--radius-full)',
    background:   'rgba(218, 80, 57, 0.08)',
    border:       '1px solid rgba(218, 80, 57, 0.25)',
    color:        '#DA5039',
    fontSize:     'var(--text-xs)',
    fontWeight:   'var(--weight-medium)' as never,
    cursor:       'pointer',
  },
  authPill: {
    display:      'flex',
    alignItems:   'center',
    gap:          5,
    padding:      '4px 10px',
    borderRadius: 'var(--radius-full)',
    fontSize:     'var(--text-xs)',
    fontWeight:   'var(--weight-medium)' as never,
    cursor:       'pointer',
    border:       '1px solid',
  },
  authPillConnected: {
    background:  'rgba(70, 156, 108, 0.08)',
    borderColor: 'rgba(70, 156, 108, 0.25)',
    color:       'var(--color-green-500)',
  },
  authPillDisconnected: {
    background:  'rgba(100, 116, 139, 0.08)',
    borderColor: 'rgba(100, 116, 139, 0.2)',
    color:       'var(--color-text-muted)',
  },
  overlay: {
    position:   'fixed' as never,
    inset:      0,
    background: 'rgba(0,0,0,0.5)',
    zIndex:     1000,
    display:    'flex',
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    padding:    'var(--space-5)',
  },
  modal: {
    width:        420,
    maxHeight:    '80vh',
    display:      'flex',
    flexDirection:'column' as never,
    background:   'var(--color-bg-surface)',
    border:       '1px solid var(--color-border)',
    borderRadius: 'var(--radius-xl)',
    overflow:     'hidden',
    boxShadow:    '0 20px 60px rgba(0,0,0,0.4)',
  },
  modalHeader: {
    display:      'flex',
    alignItems:   'center',
    justifyContent:'space-between',
    padding:      'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--color-border)',
    flexShrink:   0,
  },
  modalTitle: {
    fontSize:   'var(--text-sm)',
    fontWeight: 'var(--weight-semibold)' as never,
    color:      'var(--color-text-primary)',
  },
  closeBtn: {
    background: 'transparent',
    border:     'none',
    color:      'var(--color-text-muted)',
    cursor:     'pointer',
    padding:    4,
    display:    'flex',
    alignItems: 'center',
  },
  logList: {
    overflowY:  'auto' as never,
    flex:       1,
  },
  logRow: {
    display:      'flex',
    alignItems:   'flex-start',
    gap:          'var(--space-3)',
    padding:      'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--color-border)',
  },
  logType: {
    fontSize:      'var(--text-sm)',
    fontWeight:    'var(--weight-medium)' as never,
    color:         'var(--color-text-primary)',
    textTransform: 'capitalize' as never,
  },
  logError: {
    fontSize:  'var(--text-xs)',
    color:     '#DA5039',
    marginTop: 2,
  },
  logTime: {
    fontSize:  'var(--text-xs)',
    color:     'var(--color-text-muted)',
    flexShrink: 0,
    whiteSpace: 'nowrap' as never,
  },
  logStatus: {
    fontSize:      'var(--text-xs)',
    fontWeight:    'var(--weight-medium)' as never,
    textTransform: 'capitalize' as never,
    flexShrink:    0,
  },
}
