import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Building2, FileText, CalendarDays, Activity,
  RefreshCw, PlayCircle, Download, BookOpen, Scissors,
  Search as SearchIcon, ExternalLink as ExtLinkIcon, Zap,
  GripVertical, MoreHorizontal, ChevronUp, ChevronDown,
  EyeOff, Plus,
} from 'lucide-react'
import { StatCard, Card, Button, JobStatusBadge } from '../../components/ui'
import pkLogo  from '../../assets/pk-logo-light.png'
import bobLogo from '../../assets/bob.png'
import bookImg from '../../assets/book.png'
import { useCompaniesStore } from '../../store/companies.store'
import { useJobsStore }      from '../../store/jobs.store'
import { useAuthStore }      from '../../store/auth.store'
import { useUIStore }        from '../../store/ui.store'
import { transcriptsApi, calendarApi, searchApi, fsApi, authApi, servicesApi, gongScraperApi } from '../../lib/ipc'
import { formatRelative, formatTime } from '../../lib/utils'
import type { CalendarEvent } from '@shared/types'

// ─── Widget registry ──────────────────────────────────────────────────────────
const DEFAULT_STAT_ORDER   = ['companies', 'transcripts', 'upcoming-stat', 'active']
const DEFAULT_WIDGET_ORDER = ['upcoming', 'jobs', 'actions', 'knowledge']
const ALL_STAT_IDS   = new Set(DEFAULT_STAT_ORDER)
const ALL_WIDGET_IDS = new Set(DEFAULT_WIDGET_ORDER)

export const WIDGET_LABELS: Record<string, string> = {
  'companies':     'Companies',
  'transcripts':   'Transcripts',
  'upcoming-stat': 'Upcoming Calls',
  'active':        'Active B.O.B. Processes',
  'upcoming':      'Upcoming Calls (detail)',
  'jobs':          'Recent Jobs',
  'actions':       'Quick Actions',
  'knowledge':     'Knowledge Base',
}

function loadOrder(key: string, defaults: string[]): string[] {
  try {
    const saved = localStorage.getItem(key)
    if (saved) {
      const arr = JSON.parse(saved) as string[]
      const merged = arr.filter(id => defaults.includes(id))
      for (const id of defaults) if (!merged.includes(id)) merged.push(id)
      return merged
    }
  } catch { /* ignore */ }
  return [...defaults]
}

function saveOrder(key: string, order: string[]) {
  localStorage.setItem(key, JSON.stringify(order))
}

function loadHidden(): string[] {
  try {
    const s = localStorage.getItem('dashboard-hidden-widgets')
    return s ? JSON.parse(s) : []
  } catch { return [] }
}

function saveHidden(h: string[]) {
  localStorage.setItem('dashboard-hidden-widgets', JSON.stringify(h))
}

// ─── Draggable widget shell ───────────────────────────────────────────────────
interface WidgetShellProps {
  id: string
  order: string[]
  dragOver: string | null
  onDragStart: (id: string) => void
  onDragOver:  (id: string) => void
  onDragLeave: () => void
  onDrop:      (id: string) => void
  onMove:      (id: string, dir: -1 | 1) => void
  onHide:      (id: string) => void
  children: React.ReactNode
}

function WidgetShell({ id, order, dragOver, onDragStart, onDragOver, onDragLeave, onDrop, onMove, onHide, children }: WidgetShellProps) {
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const idx = order.indexOf(id)
  const isFirst = idx === 0
  const isLast  = idx === order.length - 1

  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  const handleColor = 'rgba(255,255,255,0.55)'
  const handleHover = 'rgba(255,255,255,1)'

  return (
    <div
      draggable
      onDragStart={() => onDragStart(id)}
      onDragOver={e => { e.preventDefault(); onDragOver(id) }}
      onDragLeave={onDragLeave}
      onDrop={e => { e.preventDefault(); onDrop(id) }}
      style={{
        position: 'relative',
        outline: dragOver === id ? '2px solid var(--color-teal-500)' : 'none',
        borderRadius: 'var(--radius-lg)',
        transition: 'outline 80ms',
      }}
    >
      {/* Drag handle — top-left corner */}
      <div
        title="Drag to rearrange"
        style={{
          position: 'absolute', top: 6, left: 6, zIndex: 10,
          color: handleColor, cursor: 'grab', lineHeight: 0,
          transition: 'color 120ms',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.color = handleHover }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.color = handleColor }}
      >
        <GripVertical size={13} />
      </div>

      {/* Move / customize dropdown — top-right corner */}
      <div ref={menuRef} style={{ position: 'absolute', top: 5, right: 6, zIndex: 10 }}>
        <button
          onClick={() => setShowMenu(m => !m)}
          title="Widget options"
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: handleColor, padding: '2px 3px', borderRadius: 4,
            lineHeight: 0, transition: 'color 120ms',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = handleHover }}
          onMouseLeave={e => { if (!showMenu) (e.currentTarget as HTMLButtonElement).style.color = handleColor }}
        >
          <MoreHorizontal size={14} />
        </button>
        {showMenu && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4,
            background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            minWidth: 160, overflow: 'hidden', zIndex: 200,
          }}>
            {!isFirst && (
              <button onClick={() => { onMove(id, -1); setShowMenu(false) }} style={menuItemStyle}>
                <ChevronUp size={13} /> Move earlier
              </button>
            )}
            {!isLast && (
              <button onClick={() => { onMove(id, 1); setShowMenu(false) }} style={menuItemStyle}>
                <ChevronDown size={13} /> Move later
              </button>
            )}
            <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 0' }} />
            <button
              onClick={() => { onHide(id); setShowMenu(false) }}
              style={{ ...menuItemStyle, color: '#DA5039' }}
            >
              <EyeOff size={13} /> No Table
            </button>
          </div>
        )}
      </div>

      {children}
    </div>
  )
}

const menuItemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  width: '100%', padding: '8px 12px',
  background: 'transparent', border: 'none',
  color: 'var(--color-text-primary)', fontSize: 'var(--text-xs)',
  fontWeight: 500, cursor: 'pointer', textAlign: 'left',
}

export function Dashboard() {
  const navigate    = useNavigate()
  const companies   = useCompaniesStore(s => s.result)
  const fetchCos    = useCompaniesStore(s => s.fetch)
  const importHubs  = useCompaniesStore(s => s.importFromHubSpot)
  const jobs        = useJobsStore(s => s.jobs)
  const fetchJobs   = useJobsStore(s => s.fetchJobs)
  const auth        = useAuthStore(s => s.status)
  const authLogin   = useAuthStore(s => s.login)
  const addToast    = useUIStore(s => s.addToast)

  const [transcriptCount, setTranscriptCount] = useState(0)
  const [upcomingEvents,  setUpcomingEvents]   = useState<CalendarEvent[]>([])
  const [syncing,         setSyncing]          = useState(false)
  const [importing,       setImporting]        = useState(false)
  const [indexing,        setIndexing]         = useState(false)
  const [showStartModal,  setShowStartModal]   = useState(false)
  const [startRunning,    setStartRunning]     = useState(false)
  const [startStep,       setStartStep]        = useState('')

  // Widget order + hidden state
  const [statOrder,   setStatOrder]   = useState<string[]>(() => loadOrder('dashboard-stat-order',   DEFAULT_STAT_ORDER))
  const [widgetOrder, setWidgetOrder] = useState<string[]>(() => loadOrder('dashboard-widget-order', DEFAULT_WIDGET_ORDER))
  const [hidden,      setHidden]      = useState<string[]>(loadHidden)
  const [dragOver,    setDragOver]    = useState<string | null>(null)
  const dragSource = useRef<string | null>(null)

  function hideWidget(id: string) {
    setHidden(h => { const n = [...h, id]; saveHidden(n); return n })
  }
  function showWidget(id: string) {
    setHidden(h => { const n = h.filter(x => x !== id); saveHidden(n); return n })
  }

  function makeDragHandlers(setOrder: React.Dispatch<React.SetStateAction<string[]>>, storageKey: string) {
    return {
      onDragStart: (id: string) => { dragSource.current = id },
      onDragOver:  (id: string) => setDragOver(id),
      onDragLeave: ()           => setDragOver(null),
      onDrop: (targetId: string) => {
        const src = dragSource.current
        if (!src || src === targetId) { setDragOver(null); return }
        setOrder(order => {
          const arr = [...order]
          const si = arr.indexOf(src), ti = arr.indexOf(targetId)
          if (si === -1 || ti === -1) return order
          arr.splice(si, 1); arr.splice(ti, 0, src)
          saveOrder(storageKey, arr)
          return arr
        })
        setDragOver(null); dragSource.current = null
      },
      onMove: (id: string, dir: -1 | 1) => {
        setOrder(order => {
          const arr = [...order]
          const idx = arr.indexOf(id), nxt = idx + dir
          if (nxt < 0 || nxt >= arr.length) return arr
          ;[arr[idx], arr[nxt]] = [arr[nxt], arr[idx]]
          saveOrder(storageKey, arr)
          return arr
        })
      },
    }
  }

  const statDragHandlers   = makeDragHandlers(setStatOrder,   'dashboard-stat-order')
  const widgetDragHandlers = makeDragHandlers(setWidgetOrder, 'dashboard-widget-order')

  const statShellProps = (id: string) => ({
    id,
    order: statOrder.filter(x => !hidden.includes(x)),
    dragOver, onHide: hideWidget,
    ...statDragHandlers,
  })
  const shellProps = (id: string) => ({
    id,
    order: widgetOrder.filter(x => !hidden.includes(x)),
    dragOver, onHide: hideWidget,
    ...widgetDragHandlers,
  })

  const allHidden = hidden.filter(id => ALL_STAT_IDS.has(id) || ALL_WIDGET_IDS.has(id))

  useEffect(() => {
    // Always fetch with a clean (unfiltered) query so dashboard totals are never stale
    fetchCos({ page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc' })
    fetchJobs()
    loadTranscripts()
    loadEvents()
  }, [])

  async function loadTranscripts() {
    // Use gongScraperApi state to match the count shown on the Transcripts page
    const r = await gongScraperApi.getState()
    if (r.ok) setTranscriptCount(r.data.recentTranscripts?.length ?? 0)
  }

  async function loadEvents() {
    const r = await calendarApi.events()
    if (r.ok) setUpcomingEvents(r.data.slice(0, 5))
  }

  async function handleCalendarSync() {
    setSyncing(true)
    const r = await calendarApi.sync()
    if (!r.ok) addToast({ title: 'Sync failed', body: r.error, level: 'error' })
    else addToast({ title: 'Calendar synced', level: 'ok' })
    await loadEvents()
    setSyncing(false)
  }

  async function handleHubSpotImport() {
    setImporting(true)
    const jobId = await importHubs()
    if (jobId) addToast({ title: 'HubSpot import started', body: 'Check Recent Jobs for progress', level: 'info' })
    else       addToast({ title: 'Import failed', body: 'Could not start HubSpot import', level: 'error' })
    setImporting(false)
  }

  async function handleRebuildIndex() {
    setIndexing(true)
    const r = await searchApi.rebuild()
    if (r.ok) addToast({ title: 'Knowledge index rebuilt', body: 'Search index refreshed from latest data', level: 'ok' })
    else      addToast({ title: 'Index rebuild failed', body: r.error, level: 'error' })
    setIndexing(false)
  }

  async function handleStartHere() {
    setStartRunning(true)

    // Step 1: Google login
    setStartStep('Connecting Google…')
    try { await authApi.login() } catch { /* ignore — may already be authed */ }

    // Step 2: Connect HubSpot
    setStartStep('Connecting HubSpot…')
    try { await servicesApi.connectHubSpot() } catch { /* ignore */ }

    // Step 3: Connect Gong
    setStartStep('Connecting Gong…')
    try { await servicesApi.connectGong() } catch { /* ignore */ }

    // Step 4: Navigate to Transcripts and kick off Run All
    setStartStep('')
    setStartRunning(false)
    setShowStartModal(false)
    navigate('/transcripts')
    // Fire-and-forget — Transcripts page will show live progress
    try { gongScraperApi.runAll() } catch { /* ignore */ }
  }

  const activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'pending')
  const recentJobs = jobs.slice(0, 5)

  return (
    <div className="page animate-fade-in">

      {/* Auth banner */}
      {!auth?.isAuthenticated && (
        <div style={styles.authBanner}>
          <span>Connect Google to enable Gong scraping, Calendar sync, and Drive access.</span>
          <Button variant="primary" size="sm" onClick={authLogin}>Connect Google</Button>
        </div>
      )}

      {/* Hero block — page header + Start Here, with book anchored to this container */}
      <div style={{ position: 'relative' }}>
        <div className="page-header">
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Your CSM workspace at a glance</p>
        </div>

        {/* Book illustration — right edge of hero, vertically centered to the whole block */}
        <img
          src={bookImg}
          alt=""
          style={{
            position: 'absolute', right: 0, top: '50%',
            transform: 'translateY(-50%)',
            height: 220, width: 'auto', objectFit: 'contain',
            opacity: 0.88, pointerEvents: 'none', zIndex: 0,
          }}
        />

      {/* Start Here button */}
      <div style={{ ...styles.startHereWrap, position: 'relative', zIndex: 1 }}>
        {/* Logos above button */}
        <div style={styles.logoRow}>
          <img src={pkLogo}  alt="Prokeep" style={styles.logoPK}  />
          <div style={styles.logoDivider} />
          <img src={bobLogo} alt="B.O.B."  style={styles.logoBOB} />
        </div>
        <button style={styles.startHereBtn} onClick={() => setShowStartModal(true)}>
          <Zap size={20} style={{ flexShrink: 0 }} />
          Start Here!
        </button>
        <div style={styles.startHereSub}>
          Connects Google, HubSpot, and Gong. Then syncs all companies in your B.O.B., creates folders for each company, scrapes your most recent call transcripts into those folders, and organizes everything in your Google drive.
        </div>
      </div>
      </div>{/* end hero block */}

      {/* Start Here modal */}
      {showStartModal && (
        <div style={styles.modalOverlay} onClick={() => { if (!startRunning) setShowStartModal(false) }}>
          <div style={styles.modalBox} onClick={e => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>Ready to get started?</h2>
            <p style={styles.modalBody}>
              This will connect you to Google, HubSpot, and Gong — then automatically sync all your companies, create Drive folders, scrape recent call transcripts, and organize everything. This may take a few minutes.
            </p>
            <p style={styles.modalSub}>
              Connects Google, HubSpot, and Gong. Then syncs all companies in your B.O.B., creates folders for each company, scrapes your most recent call transcripts into those folders, and organizes everything in your Google drive.
            </p>
            {startRunning && startStep && (
              <div style={styles.stepIndicator}>{startStep}</div>
            )}
            <div style={styles.modalActions}>
              <Button
                variant="ghost"
                disabled={startRunning}
                onClick={() => setShowStartModal(false)}
              >
                Never mind
              </Button>
              <Button
                variant="primary"
                loading={startRunning}
                icon={<Zap size={15} />}
                onClick={handleStartHere}
              >
                Go ahead
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Stat cards — draggable + hideable */}
      {statOrder.some(id => !hidden.includes(id)) && (
        <div className="stat-grid" style={{ marginBottom: 'var(--space-6)' }}>
          {statOrder.filter(id => !hidden.includes(id)).map(id => (
            <WidgetShell key={id} {...statShellProps(id)}>
              {id === 'companies' && (
                <div style={styles.statWrap} onClick={() => navigate('/companies')} role="button" tabIndex={0}>
                  <StatCard label="Companies" value={companies?.total ?? '—'} sub="in Book of Business"
                    icon={<Building2 size={18} />} accent="var(--color-teal-500)" />
                </div>
              )}
              {id === 'transcripts' && (
                <div style={styles.statWrap} onClick={() => navigate('/transcripts')} role="button" tabIndex={0}>
                  <StatCard label="Transcripts" value={transcriptCount} sub="collected from Gong"
                    icon={<FileText size={18} />} accent="var(--color-gold-500)" />
                </div>
              )}
              {id === 'upcoming-stat' && (
                <div style={styles.statWrap} onClick={() => navigate('/calendar')} role="button" tabIndex={0}>
                  <StatCard label="Upcoming Calls" value={upcomingEvents.length} sub="next 7 days"
                    icon={<CalendarDays size={18} />} accent="var(--color-green-500)" />
                </div>
              )}
              {id === 'active' && (
                <div style={styles.statWrap}
                  onClick={() => activeJobs.length > 0 && navigate('/transcripts')}
                  role="button" tabIndex={0}
                >
                  <StatCard label="Active B.O.B. Processes" value={activeJobs.length}
                    sub={activeJobs.length > 0 ? 'running now' : 'queue clear'}
                    icon={<Activity size={18} />}
                    accent={activeJobs.length > 0 ? 'var(--color-teal-400)' : undefined} />
                </div>
              )}
            </WidgetShell>
          ))}
        </div>
      )}

      {/* Draggable lower widgets */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
        {widgetOrder.filter(id => !hidden.includes(id)).map((id, idx) => {
          const visibleCount = widgetOrder.filter(x => !hidden.includes(x)).length
          const isWide = idx >= 2 || visibleCount === 1
          return (
            <div key={id} style={{ gridColumn: isWide ? 'span 2' : 'span 1' }}>
              <WidgetShell {...shellProps(id)}>

                {id === 'upcoming' && (
                  <Card
                    title="Upcoming Calls"
                    action={
                      <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} loading={syncing} onClick={handleCalendarSync}>
                        Sync
                      </Button>
                    }
                  >
                    {upcomingEvents.length === 0 ? (
                      <div className="empty-state" style={{ padding: 'var(--space-8) 0' }}>
                        <CalendarDays size={28} />
                        <p>No upcoming calls. Sync your calendar.</p>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                        {upcomingEvents.map(ev => (
                          <div key={ev.id} style={styles.eventRow}
                            onClick={() => ev.company_id && navigate(`/companies/${ev.company_id}`)}
                            role={ev.company_id ? 'button' : undefined}
                          >
                            <div style={styles.eventTime}>{formatTime(ev.start_at)}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={styles.eventTitle}>{ev.title}</div>
                              {ev.company && <div style={styles.eventCompany}>{ev.company.name}</div>}
                            </div>
                          </div>
                        ))}
                        <Button variant="ghost" size="sm" style={{ alignSelf: 'flex-start', marginTop: 'var(--space-1)' }} onClick={() => navigate('/calendar')}>
                          View all →
                        </Button>
                      </div>
                    )}
                  </Card>
                )}

                {id === 'jobs' && (
                  <Card
                    title="Recent Jobs"
                    action={<Button variant="ghost" size="sm" onClick={() => navigate('/transcripts')}>View all</Button>}
                  >
                    {recentJobs.length === 0 ? (
                      <div className="empty-state" style={{ padding: 'var(--space-8) 0' }}>
                        <Activity size={28} />
                        <p>No jobs run yet. Start by running Gong Scrubber.</p>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                        {recentJobs.map(job => (
                          <div key={job.id} style={styles.jobRow} onClick={() => navigate('/transcripts')} role="button">
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={styles.jobType}>{job.type.replace(/_/g, ' ')}</div>
                              <div style={styles.jobTime}>{formatRelative(job.created_at)}</div>
                            </div>
                            <JobStatusBadge status={job.status} />
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                )}

                {id === 'actions' && (
                  <Card title="Quick Actions">
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
                      <Button variant="primary"   icon={<PlayCircle size={15} />}   onClick={() => navigate('/transcripts')}>Run Gong Scrubber</Button>
                      <Button variant="secondary" icon={<Building2 size={15} />}    onClick={() => navigate('/companies')}>View Companies</Button>
                      <Button variant="secondary" icon={<CalendarDays size={15} />} onClick={() => navigate('/calendar')}>Week at a Glance</Button>
                      <Button variant="secondary" icon={<Scissors size={15} />}     onClick={() => navigate('/scrub')}>Scrub & Split CSV</Button>
                      <Button variant="secondary" icon={<Download size={15} />}     loading={importing} onClick={handleHubSpotImport}>Import HubSpot</Button>
                      <Button variant="ghost"     icon={<BookOpen size={15} />}     loading={indexing}  onClick={handleRebuildIndex}>Rebuild Knowledge Index</Button>
                      <Button variant="secondary" icon={<BookOpen size={15} />}     onClick={() => navigate('/assistant')}>Knowledge Assistant</Button>
                    </div>
                  </Card>
                )}

                {id === 'knowledge' && <KnowledgeWidget />}

              </WidgetShell>
            </div>
          )
        })}
      </div>

      {/* Add Table — shown when any widget is hidden */}
      {allHidden.length > 0 && (
        <AddTableBar hidden={allHidden} onAdd={showWidget} />
      )}
    </div>
  )
}

// ─── Add Table bar ────────────────────────────────────────────────────────────
function AddTableBar({ hidden, onAdd }: { hidden: string[]; onAdd: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative', marginTop: 'var(--space-4)', display: 'flex', justifyContent: 'center' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 20px',
          background: 'transparent',
          border: '1.5px dashed var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          color: 'var(--color-text-muted)',
          fontSize: 'var(--text-sm)', fontWeight: 600,
          cursor: 'pointer', transition: 'border-color 120ms, color 120ms',
          width: '100%',
        }}
        onMouseEnter={e => { const b = e.currentTarget as HTMLButtonElement; b.style.borderColor = 'var(--color-teal-500)'; b.style.color = 'var(--color-teal-400)' }}
        onMouseLeave={e => { const b = e.currentTarget as HTMLButtonElement; b.style.borderColor = 'var(--color-border)'; b.style.color = 'var(--color-text-muted)' }}
      >
        <Plus size={15} /> Add Table
        <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 400 }}>({hidden.length} hidden)</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          marginBottom: 6,
          background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          minWidth: 240, overflow: 'hidden', zIndex: 200,
        }}>
          <div style={{ padding: '6px 12px', fontSize: 10, color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Add back to dashboard
          </div>
          {hidden.map(id => (
            <button key={id} onClick={() => { onAdd(id); if (hidden.length === 1) setOpen(false) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '9px 14px',
                background: 'transparent', border: 'none',
                color: 'var(--color-text-primary)', fontSize: 'var(--text-xs)',
                fontWeight: 500, cursor: 'pointer', textAlign: 'left',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-surface)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              <Plus size={12} style={{ color: 'var(--color-teal-500)', flexShrink: 0 }} />
              {WIDGET_LABELS[id] ?? id}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Knowledge widget ─────────────────────────────────────────────────────────

function KnowledgeWidget() {
  const navigate = useNavigate()
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<Array<{ item: { id: string; title: string; url: string; section: string | null }; score: number }>>([])

  async function handleSearch(q: string) {
    setQuery(q)
    if (!q.trim()) { setResults([]); return }
    const r = await searchApi.query(q, 'all')
    if (r.ok) setResults(r.data.slice(0, 5))
  }

  return (
    <Card title="Knowledge Base" action={<Button variant="ghost" size="sm" onClick={() => navigate('/assistant')}>Browse all →</Button>}>
    <div>
      <div style={{ position: 'relative', marginBottom: 'var(--space-2)' }}>
        <SearchIcon size={13} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--color-text-muted)' }} />
        <input className="input input-sm" style={{ paddingLeft: 30, width: '100%' }}
          placeholder="Search knowledge base…" value={query} onChange={e => handleSearch(e.target.value)} />
      </div>
      {results.length > 0 && (
        <div style={{ background:'var(--color-bg-surface)', border:'1px solid var(--color-border)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
          {results.map(r => (
            <div key={r.item.id} onClick={() => fsApi.openExternal(r.item.url)}
              style={{ padding:'var(--space-2) var(--space-3)', borderBottom:'1px solid var(--color-border)', cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center', gap:'var(--space-2)' }}
              onMouseEnter={e => (e.currentTarget.style.background='var(--color-bg-elevated)')}
              onMouseLeave={e => (e.currentTarget.style.background='transparent')}>
              <div>
                <div style={{ fontSize:'var(--text-xs)', fontWeight:'var(--weight-medium)' as never, color:'var(--color-text-primary)' }}>{r.item.title}</div>
                {r.item.section && <div style={{ fontSize:10, color:'var(--color-text-muted)' }}>{r.item.section}</div>}
              </div>
              <ExtLinkIcon size={11} style={{ flexShrink:0, color:'var(--color-text-muted)' }} />
            </div>
          ))}
        </div>
      )}
    </div>
    </Card>
  )
}

const styles: Record<string, React.CSSProperties> = {
  startHereWrap: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    marginBottom:  'var(--space-6)',
    gap:           'var(--space-3)',
  },
  logoRow: {
    display:     'flex',
    alignItems:  'center',
    justifyContent: 'center',
    gap:         'var(--space-5)',
    marginBottom:'var(--space-1)',
  },
  logoPK: {
    height:    52,
    width:     'auto',
    objectFit: 'contain' as never,
    opacity:   0.92,
  },
  logoDivider: {
    width:      1,
    height:     44,
    background: 'var(--color-border)',
    flexShrink: 0,
  },
  logoBOB: {
    height:    64,
    width:     'auto',
    objectFit: 'contain' as never,
  },
  startHereBtn: {
    display:        'flex',
    alignItems:     'center',
    gap:            'var(--space-2)',
    padding:        '14px 36px',
    fontSize:       '1.125rem',
    fontWeight:     700,
    color:          '#fff',
    background:     'var(--color-teal-500)',
    border:         'none',
    borderRadius:   'var(--radius-lg)',
    cursor:         'pointer',
    boxShadow:      '0 4px 16px rgba(0,0,0,0.25)',
    transition:     'background 120ms ease, transform 120ms ease',
    letterSpacing:  '0.01em',
  },
  startHereSub: {
    fontSize:  'var(--text-xs)',
    color:     'var(--color-text-muted)',
    textAlign: 'center',
    maxWidth:  520,
  },
  modalOverlay: {
    position:        'fixed',
    inset:           0,
    background:      'rgba(0,0,0,0.55)',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          1000,
    backdropFilter:  'blur(2px)',
  },
  modalBox: {
    background:   'var(--color-bg-surface)',
    border:       '1px solid var(--color-border)',
    borderRadius: 'var(--radius-xl)',
    padding:      'var(--space-8)',
    maxWidth:     520,
    width:        '90%',
    boxShadow:    '0 16px 48px rgba(0,0,0,0.4)',
  },
  modalTitle: {
    fontSize:     'var(--text-xl)',
    fontWeight:   700,
    color:        'var(--color-text-primary)',
    marginBottom: 'var(--space-4)',
  },
  modalBody: {
    fontSize:     'var(--text-sm)',
    color:        'var(--color-text-primary)',
    lineHeight:   1.6,
    marginBottom: 'var(--space-3)',
  },
  modalSub: {
    fontSize:     'var(--text-xs)',
    color:        'var(--color-text-muted)',
    lineHeight:   1.6,
    marginBottom: 'var(--space-5)',
  },
  stepIndicator: {
    fontSize:     'var(--text-xs)',
    color:        'var(--color-teal-400)',
    marginBottom: 'var(--space-3)',
    fontFamily:   'var(--font-mono)',
  },
  modalActions: {
    display:        'flex',
    justifyContent: 'flex-end',
    gap:            'var(--space-3)',
  },
  authBanner: {
    display:      'flex',
    alignItems:   'center',
    justifyContent:'space-between',
    padding:      'var(--space-3) var(--space-4)',
    marginBottom: 'var(--space-5)',
    background:   'var(--color-gold-muted)',
    border:       '1px solid rgba(244,183,78,0.25)',
    borderRadius: 'var(--radius-lg)',
    fontSize:     'var(--text-sm)',
    color:        'var(--color-gold-500)',
  },
  statWrap: {
    cursor:       'pointer',
    borderRadius: 'var(--radius-lg)',
    transition:   'transform 120ms ease, opacity 120ms ease',
  },
  eventRow: {
    display:      'flex',
    gap:          'var(--space-3)',
    alignItems:   'flex-start',
    padding:      'var(--space-2) 0',
    borderBottom: '1px solid var(--color-border)',
    cursor:       'pointer',
  },
  eventTime: {
    fontSize:   'var(--text-xs)',
    color:      'var(--color-teal-400)',
    fontFamily: 'var(--font-mono)',
    flexShrink: 0,
    width:      50,
    paddingTop: 1,
  },
  eventTitle: {
    fontSize:     'var(--text-sm)',
    fontWeight:   'var(--weight-medium)' as never,
    color:        'var(--color-text-primary)',
    overflow:     'hidden',
    textOverflow: 'ellipsis',
    whiteSpace:   'nowrap' as never,
  },
  eventCompany: {
    fontSize: 'var(--text-xs)',
    color:    'var(--color-text-muted)',
  },
  jobRow: {
    display:      'flex',
    alignItems:   'center',
    gap:          'var(--space-3)',
    padding:      'var(--space-2) 0',
    borderBottom: '1px solid var(--color-border)',
    cursor:       'pointer',
  },
  jobType: {
    fontSize:      'var(--text-sm)',
    color:         'var(--color-text-primary)',
    fontWeight:    'var(--weight-medium)' as never,
    textTransform: 'capitalize' as never,
  },
  jobTime: {
    fontSize: 'var(--text-xs)',
    color:    'var(--color-text-muted)',
  },
}
