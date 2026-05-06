import { useEffect, useState } from 'react'
import { LogIn, LogOut, Plus, Trash2, Clock, X, BookOpen, RefreshCw, Link, Pencil, Check, Chrome, DownloadCloud, CheckCircle2, AlertCircle, Bell, BellOff, Sparkles, Cpu, Trash } from 'lucide-react'
import { Button, Card, Badge } from '../../components/ui'
import { useAuthStore }    from '../../store/auth.store'
import { useUIStore }      from '../../store/ui.store'
import { useServicesStore } from '../../store/services.store'
import { schedulesApi, searchApi, gongScraperApi, settingsApi, quickLinksApi, fsApi, appApi, push, notificationsApi, localAiApi } from '../../lib/ipc'
import type { QuickLink, NotificationSettings, AIStatus } from '../../lib/ipc'
import type { Schedule, JobType } from '@shared/types'

// ─── Schedule form ────────────────────────────────────────────────────────────

const JOB_OPTIONS: Array<{ value: JobType; label: string }> = [
  { value: 'gong_collect',   label: 'Gong — Collect transcript links' },
  { value: 'drive_organize', label: 'Drive — Organize transcript files' },
  { value: 'calendar_sync',  label: 'Calendar — Sync Google Calendar' },
  { value: 'index_rebuild',  label: 'Knowledge — Rebuild search index' },
  { value: 'hubspot_import', label: 'HubSpot — Import companies & contacts' },
]

const CRON_PRESETS = [
  { label: 'Every hour',        value: '0 * * * *' },
  { label: 'Every 6 hours',     value: '0 */6 * * *' },
  { label: 'Daily at 9am',      value: '0 9 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Weekdays at 8am',   value: '0 8 * * 1-5' },
  { label: 'Custom',            value: 'custom' },
]

function AddScheduleModal({
  onSave,
  onClose,
}: {
  onSave:  (schedule: Partial<Schedule>) => Promise<void>
  onClose: () => void
}) {
  const [name,       setName]       = useState('')
  const [jobType,    setJobType]    = useState<JobType>('calendar_sync')
  const [preset,     setPreset]     = useState('0 9 * * *')
  const [customCron, setCustomCron] = useState('')
  const [saving,     setSaving]     = useState(false)
  const [err,        setErr]        = useState<string | null>(null)

  const cronValue = preset === 'custom' ? customCron : preset

  async function handleSave() {
    if (!name.trim())      { setErr('Schedule name is required.'); return }
    if (!cronValue.trim()) { setErr('Cron expression is required.'); return }
    setSaving(true)
    setErr(null)
    try {
      await onSave({ name: name.trim(), job_type: jobType, cron_expression: cronValue, is_active: true })
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={modalStyles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={modalStyles.dialog}>
        <div style={modalStyles.header}>
          <span style={modalStyles.headerTitle}>Add Schedule</span>
          <button style={modalStyles.closeBtn} onClick={onClose}><X size={14} /></button>
        </div>

        <div style={modalStyles.body}>
          <label style={modalStyles.label}>Name</label>
          <input
            className="input"
            style={{ marginBottom: 'var(--space-3)' }}
            placeholder="e.g. Daily Gong Collect"
            value={name}
            onChange={e => setName(e.target.value)}
          />

          <label style={modalStyles.label}>Job Type</label>
          <select
            className="input select"
            style={{ marginBottom: 'var(--space-3)' }}
            value={jobType}
            onChange={e => setJobType(e.target.value as JobType)}
          >
            {JOB_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <label style={modalStyles.label}>Schedule</label>
          <select
            className="input select"
            style={{ marginBottom: preset === 'custom' ? 'var(--space-2)' : 'var(--space-3)' }}
            value={preset}
            onChange={e => setPreset(e.target.value)}
          >
            {CRON_PRESETS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>

          {preset === 'custom' && (
            <input
              className="input"
              style={{ marginBottom: 'var(--space-3)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
              placeholder="* * * * * (minute hour day month weekday)"
              value={customCron}
              onChange={e => setCustomCron(e.target.value)}
            />
          )}

          {cronValue && preset !== 'custom' && (
            <p style={{ fontSize: 10, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', margin: '-8px 0 12px' }}>
              {cronValue}
            </p>
          )}

          {err && (
            <p style={{ fontSize: 'var(--text-xs)', color: '#DA5039', margin: '0 0 var(--space-3)' }}>{err}</p>
          )}
        </div>

        <div style={modalStyles.footer}>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary"   size="sm" loading={saving} onClick={handleSave}>
            Create Schedule
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Settings page ────────────────────────────────────────────────────────────

export function Settings() {
  const auth     = useAuthStore(s => s.status)
  const authLoad = useAuthStore(s => s.loading)
  const login    = useAuthStore(s => s.login)
  const logout   = useAuthStore(s => s.logout)
  const authInit = useAuthStore(s => s.init)
  const addToast           = useUIStore(s => s.addToast)
  const setStoreLinks      = useUIStore(s => s.setQuickLinks)
  const loadStoreLinks     = useUIStore(s => s.loadQuickLinks)
  const reconnectService   = useUIStore(s => s.reconnectService)
  const setReconnectService = useUIStore(s => s.setReconnectService)
  const services        = useServicesStore(s => s.status)
  const connectingHS    = useServicesStore(s => s.connectingHS)
  const connectingGong  = useServicesStore(s => s.connectingGong)
  const connectHubSpot  = useServicesStore(s => s.connectHubSpot)
  const connectGong     = useServicesStore(s => s.connectGong)

  const [schedules,      setSchedules]      = useState<Schedule[]>([])
  const [loadingSch,     setLoadingSch]     = useState(false)
  const [showAddModal,   setShowAddModal]   = useState(false)
  const [knowledgeCount, setKnowledgeCount] = useState<number | null>(null)
  const [rebuilding,     setRebuilding]     = useState(false)

  const [sheetUrl,       setSheetUrl]       = useState('')
  const [sheetUrlEdit,   setSheetUrlEdit]   = useState('')
  const [editingSheet,   setEditingSheet]   = useState(false)
  const [savingSheet,    setSavingSheet]    = useState(false)

  const [quickLinks,     setQuickLinks]     = useState<QuickLink[]>([])
  const [savingLinks,    setSavingLinks]    = useState(false)
  const [newLinkUrl,     setNewLinkUrl]     = useState('')
  const [newLinkLabel,   setNewLinkLabel]   = useState('')
  const [newLinkColor,   setNewLinkColor]   = useState('#64748B')

  // App update state
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateStatus,   setUpdateStatus]   = useState<{ status: string; message?: string } | null>(null)

  // Notification preferences
  const [notifSettings,  setNotifSettings]  = useState<NotificationSettings>({ enabled: true, windowsMin: [24 * 60, 60, 0] })
  const [savingNotif,    setSavingNotif]    = useState(false)

  // Local AI model
  const [aiStatus,       setAiStatus]       = useState<AIStatus | null>(null)
  const [aiDownloading,  setAiDownloading]  = useState(false)
  const [aiDeleting,     setAiDeleting]     = useState(false)

  useEffect(() => {
    authInit()
    loadSchedules()
    loadKnowledgeCount()
    loadSheetUrl()
    loadQuickLinks()
    loadNotifSettings()
    loadAiStatus()
    // Listen for update status pushed from main
    const unsubUpdate = push.onUpdateStatus(payload => {
      setUpdateStatus(payload as { status: string; message?: string })
      setUpdateChecking(false)
    })
    // Listen for AI download progress
    const unsubAiProg = (push as any).onAiProgress((p: { pct: number; mbDownloaded: number; mbTotal: number }) => {
      setAiStatus(prev => prev ? { ...prev, downloadState: 'downloading', downloadPct: p.pct, mbDownloaded: p.mbDownloaded, mbTotal: p.mbTotal } : prev)
      if (p.pct >= 100) {
        setAiDownloading(false)
        loadAiStatus()
      }
    })
    return () => { unsubUpdate(); unsubAiProg() }
  }, [])

  async function handleCheckForUpdates() {
    setUpdateChecking(true)
    setUpdateStatus(null)
    const r = await appApi.checkForUpdates()
    if (r.ok && r.data) setUpdateStatus(r.data)
    else setUpdateChecking(false)
    // Actual result arrives via push.onUpdateStatus
  }

  async function loadSchedules() {
    setLoadingSch(true)
    const r = await schedulesApi.list()
    if (r.ok) setSchedules(r.data)
    setLoadingSch(false)
  }

  async function loadKnowledgeCount() {
    const r = await searchApi.query('prokeep', 'all')
    if (r.ok) setKnowledgeCount(r.data.length > 0 ? r.data.length : 0)
  }

  async function handleDeleteSchedule(id: string) {
    await schedulesApi.delete(id)
    await loadSchedules()
    addToast({ title: 'Schedule deleted', level: 'ok' })
  }

  async function handleToggleSchedule(s: Schedule) {
    await schedulesApi.update({ id: s.id, is_active: !s.is_active })
    await loadSchedules()
    addToast({ title: s.is_active ? 'Schedule paused' : 'Schedule resumed', level: 'info' })
  }

  async function handleAddSchedule(data: Partial<Schedule>) {
    const r = await schedulesApi.create(data)
    if (r.ok) {
      await loadSchedules()
      addToast({ title: 'Schedule created', body: data.name, level: 'ok' })
    } else {
      throw new Error(r.error ?? 'Failed to create schedule')
    }
  }

  async function loadSheetUrl() {
    const r = await gongScraperApi.getState()
    if (r.ok) { setSheetUrl(r.data.sheetUrl ?? ''); setSheetUrlEdit(r.data.sheetUrl ?? '') }
  }

  async function handleSaveSheetUrl() {
    setSavingSheet(true)
    await settingsApi.setSheetUrl(sheetUrlEdit)
    setSheetUrl(sheetUrlEdit)
    setEditingSheet(false)
    setSavingSheet(false)
    addToast({ title: 'Spreadsheet URL saved', level: 'ok' })
  }

  async function loadQuickLinks() {
    await loadStoreLinks()
    const r = await quickLinksApi.get()
    if (r.ok) setQuickLinks(r.data)
  }

  async function handleSaveLinks(links: QuickLink[]) {
    setSavingLinks(true)
    await quickLinksApi.set(links)
    setQuickLinks(links)
    setStoreLinks(links)   // keep sidebar in sync immediately
    setSavingLinks(false)
    addToast({ title: 'Quick Links saved', level: 'ok' })
  }

  function handleAddLink() {
    if (!newLinkUrl.trim() || !newLinkLabel.trim()) return
    const updated = [...quickLinks, { url: newLinkUrl.trim(), label: newLinkLabel.trim(), color: newLinkColor }]
    setNewLinkUrl(''); setNewLinkLabel(''); setNewLinkColor('#64748B')
    handleSaveLinks(updated)
  }

  function handleRemoveLink(idx: number) {
    handleSaveLinks(quickLinks.filter((_, i) => i !== idx))
  }

  function handleLinkColorChange(idx: number, color: string) {
    const updated = quickLinks.map((l, i) => i === idx ? { ...l, color } : l)
    handleSaveLinks(updated)
  }

  async function loadNotifSettings() {
    const r = await notificationsApi.getSettings()
    if (r.ok) setNotifSettings(r.data)
  }

  async function handleToggleNotifications() {
    const next = { ...notifSettings, enabled: !notifSettings.enabled }
    setNotifSettings(next)
    setSavingNotif(true)
    await notificationsApi.setSettings({ enabled: next.enabled })
    setSavingNotif(false)
  }

  function handleNotifWindowToggle(minutes: number) {
    const current = notifSettings.windowsMin
    const next = current.includes(minutes)
      ? current.filter(m => m !== minutes)
      : [...current, minutes].sort((a, b) => b - a)
    const updated = { ...notifSettings, windowsMin: next }
    setNotifSettings(updated)
    notificationsApi.setSettings({ windowsMin: next }).catch(console.error)
  }

  async function loadAiStatus() {
    const r = await localAiApi.getStatus()
    if (r.ok && r.data) setAiStatus(r.data)
  }

  async function handleAiDownload() {
    setAiDownloading(true)
    await localAiApi.startDownload()
    // Progress arrives via PUSH_AI_PROGRESS listener; final state via loadAiStatus
    setTimeout(loadAiStatus, 1000)
  }

  function handleAiCancelDownload() {
    localAiApi.cancelDownload().catch(() => {})
    setAiDownloading(false)
    loadAiStatus()
  }

  async function handleAiDelete() {
    if (!confirm('Delete the local AI model (~1.2 GB)? AI features will be unavailable until re-downloaded.')) return
    setAiDeleting(true)
    await localAiApi.deleteModel().catch(() => {})
    setAiDeleting(false)
    await loadAiStatus()
    addToast({ title: 'AI model deleted', body: 'You can re-download it any time from this page.', level: 'ok' })
  }

  async function handleRebuildIndex() {
    setRebuilding(true)
    const r = await searchApi.rebuild()
    if (r.ok) {
      addToast({ title: 'Knowledge index rebuilt', body: 'Search index refreshed from latest data.', level: 'ok' })
      await loadKnowledgeCount()
    } else {
      addToast({ title: 'Rebuild failed', body: r.error, level: 'error' })
    }
    setRebuilding(false)
  }

  return (
    <div className="page animate-fade-in" style={{ maxWidth: 720 }}>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Integrations, schedules, and preferences</p>
      </div>

      {/* ── Login-needed banner ─────────────────────────────────────────── */}
      {reconnectService && (
        <div style={{
          marginBottom: 'var(--space-4)', padding: '12px 16px',
          background: reconnectService === 'hubspot' ? 'rgba(255,122,0,0.12)' : 'rgba(155,109,255,0.12)',
          border: `2px solid ${reconnectService === 'hubspot' ? '#FF7A00' : '#9B6DFF'}`,
          borderRadius: 'var(--radius-lg)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>⚠️</span>
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                {reconnectService === 'hubspot' ? 'HubSpot' : 'Gong'} login required
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 2 }}>
                The scraper encountered a login prompt. Click the highlighted Reconnect button below.
              </div>
            </div>
          </div>
          <button onClick={() => setReconnectService(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 4, fontSize: 16, lineHeight: 1 }}>✕</button>
        </div>
      )}

      {/* ── Google auth connect/disconnect ───────────────────────────────── */}
      <Card
        title="Google Integration"
        subtitle="Required for Calendar, Drive, and Sheets"
        style={{ marginBottom: 'var(--space-4)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {auth?.isAuthenticated ? (
              <>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)' }}>
                  Connected as <strong>{auth.email}</strong>
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {auth.scopes.map(s => (
                    <Badge key={s} label={s.split('/').pop()!} variant="teal" />
                  ))}
                </div>
              </>
            ) : (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                Not connected. Sign in with your @prokeep.com Google account.
              </span>
            )}
          </div>

          {auth?.isAuthenticated ? (
            <Button variant="danger" size="sm" icon={<LogOut size={13} />} onClick={logout}>
              Disconnect
            </Button>
          ) : (
            <Button variant="primary" size="sm" icon={<LogIn size={13} />} loading={authLoad} onClick={login}>
              Connect Google
            </Button>
          )}
        </div>
      </Card>

      {/* ── HubSpot Integration ─────────────────────────────────────────── */}
      <Card
        title="HubSpot Integration"
        subtitle="Company list import — connected via Google SSO · Window closes automatically once connected"
        style={{ marginBottom: 'var(--space-4)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {services.hubspot.connected ? (
              <>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#FF7A00', boxShadow: '0 0 5px #FF7A0099', flexShrink: 0 }} />
                  HubSpot Connected
                </span>
                {services.hubspot.connectedAt && (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                    Last verified {new Date(services.hubspot.connectedAt).toLocaleString()}
                  </span>
                )}
              </>
            ) : (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                Not connected. Click Connect to open HubSpot — Google SSO will complete automatically if you're signed in.
              </span>
            )}
          </div>
          <Button
            variant={services.hubspot.connected ? 'ghost' : 'primary'}
            size="sm"
            loading={connectingHS}
            onClick={() => { connectHubSpot(); setReconnectService(null) }}
            style={{
              ...(services.hubspot.connected ? {} : { background: '#FF7A00', borderColor: '#FF7A00' }),
              ...(reconnectService === 'hubspot' ? { boxShadow: '0 0 0 4px #FF7A0055, 0 0 16px #FF7A0088', transform: 'scale(1.05)' } : {}),
            }}
          >
            {reconnectService === 'hubspot' ? '👉 Reconnect HubSpot' : (services.hubspot.connected ? 'Reconnect' : 'Connect HubSpot')}
          </Button>
        </div>
      </Card>

      {/* ── Gong Integration ─────────────────────────────────────────────── */}
      <Card
        title="Gong Integration"
        subtitle="Call transcript scraping — session persists between opens · Window closes automatically once connected"
        style={{ marginBottom: 'var(--space-4)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {services.gong.connected ? (
              <>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#9B6DFF', boxShadow: '0 0 5px #9B6DFF99', flexShrink: 0 }} />
                  Gong Connected
                </span>
                {services.gong.connectedAt && (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                    Last verified {new Date(services.gong.connectedAt).toLocaleString()}
                  </span>
                )}
              </>
            ) : (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                Not connected. Click Connect — a Gong window will open for you to log in. Your session is remembered permanently.
              </span>
            )}
          </div>
          <Button
            variant={services.gong.connected ? 'ghost' : 'primary'}
            size="sm"
            loading={connectingGong}
            onClick={() => { connectGong(); setReconnectService(null) }}
            style={{
              ...(services.gong.connected ? {} : { background: '#9B6DFF', borderColor: '#9B6DFF' }),
              ...(reconnectService === 'gong' ? { boxShadow: '0 0 0 4px #9B6DFF55, 0 0 16px #9B6DFF88', transform: 'scale(1.05)' } : {}),
            }}
          >
            {reconnectService === 'gong' ? '👉 Reconnect Gong' : (services.gong.connected ? 'Reconnect' : 'Connect Gong')}
          </Button>
        </div>
      </Card>

      {/* ── Knowledge base ───────────────────────────────────────────────── */}
      <Card
        title="Knowledge Base"
        subtitle="Internal and customer-facing wiki pages for search"
        style={{ marginBottom: 'var(--space-4)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <BookOpen size={14} strokeWidth={1.8} style={{ color: 'var(--color-teal-500)' }} />
              <span>
                {knowledgeCount !== null
                  ? `${knowledgeCount} pages in search index`
                  : 'Index not yet built'}
              </span>
            </div>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: 0 }}>
              Source files: <code style={{ color: 'var(--color-teal-400)' }}>resources/data/internal.json</code> +{' '}
              <code style={{ color: 'var(--color-teal-400)' }}>resources/data/customer.json</code>
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={13} />}
            loading={rebuilding}
            onClick={handleRebuildIndex}
          >
            Rebuild Index
          </Button>
        </div>
      </Card>

      {/* ── Master Spreadsheet ───────────────────────────────────────────── */}
      <Card
        title="Master Spreadsheet"
        subtitle="Google Sheet created by Step 1 of the Gong Scrubber"
        style={{ marginBottom: 'var(--space-4)' }}
      >
        {editingSheet ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <input
              className="input input-sm"
              style={{ flex: 1 }}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={sheetUrlEdit}
              onChange={e => setSheetUrlEdit(e.target.value)}
            />
            <Button variant="primary" size="sm" icon={<Check size={13} />} loading={savingSheet} onClick={handleSaveSheetUrl}>
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setEditingSheet(false); setSheetUrlEdit(sheetUrl) }}>
              Cancel
            </Button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
            <span style={{ fontSize: 'var(--text-sm)', color: sheetUrl ? 'var(--color-teal-400)' : 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {sheetUrl || 'No spreadsheet linked yet — run Step 1 in the Gong Scrubber.'}
            </span>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
              {sheetUrl && (
                <Button variant="ghost" size="sm" icon={<Link size={13} />} onClick={() => window.open(sheetUrl, '_blank')}>
                  Open
                </Button>
              )}
              <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => setEditingSheet(true)}>
                Edit
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── Quick Links ───────────────────────────────────────────────────── */}
      <Card
        title="Quick Links"
        subtitle="Shortcuts shown in the sidebar — add, remove, or change colors"
        style={{ marginBottom: 'var(--space-4)' }}
        padding={false}
      >
        {quickLinks.map((link, idx) => (
          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--color-border)' }}>
            <input
              type="color"
              value={link.color}
              onChange={e => handleLinkColorChange(idx, e.target.value)}
              style={{ width: 24, height: 24, padding: 0, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none' }}
              title="Change color"
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)' as never, color: link.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{link.label}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{link.url}</div>
            </div>
            <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} loading={savingLinks} onClick={() => handleRemoveLink(idx)} />
          </div>
        ))}
        <div style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-4)', alignItems: 'center' }}>
          <input
            type="color"
            value={newLinkColor}
            onChange={e => setNewLinkColor(e.target.value)}
            style={{ width: 24, height: 24, padding: 0, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none', flexShrink: 0 }}
          />
          <input
            className="input input-sm"
            style={{ width: 110, flexShrink: 0 }}
            placeholder="Label"
            value={newLinkLabel}
            onChange={e => setNewLinkLabel(e.target.value)}
          />
          <input
            className="input input-sm"
            style={{ flex: 1 }}
            placeholder="https://..."
            value={newLinkUrl}
            onChange={e => setNewLinkUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddLink()}
          />
          <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={handleAddLink}>
            Add
          </Button>
        </div>
      </Card>

      {/* ── Schedules ────────────────────────────────────────────────────── */}
      <Card
        title="Automated Schedules"
        subtitle="Background jobs that run on a cron schedule"
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={13} />}
            onClick={() => setShowAddModal(true)}
          >
            Add Schedule
          </Button>
        }
        padding={false}
      >
        {loadingSch ? (
          <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            Loading…
          </div>
        ) : schedules.length === 0 ? (
          <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-muted)' }}>
            <Clock size={28} style={{ margin: '0 auto var(--space-3)', opacity: 0.4 }} />
            <p style={{ fontSize: 'var(--text-sm)' }}>No schedules configured.</p>
            <p style={{ fontSize: 'var(--text-xs)', marginTop: 4 }}>
              Add a schedule to automatically run Gong scraping or calendar sync.
            </p>
          </div>
        ) : (
          schedules.map(s => (
            <div key={s.id} style={styles.scheduleRow}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.scheduleName}>{s.name}</div>
                <div style={styles.scheduleMeta}>
                  <code style={styles.cronCode}>{s.cron_expression}</code>
                  <span>·</span>
                  <span>{s.job_type.replace(/_/g, ' ')}</span>
                  {s.last_run_at && (
                    <span>· last ran {new Date(s.last_run_at).toLocaleString()}</span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <Badge
                  label={s.is_active ? 'active' : 'paused'}
                  variant={s.is_active ? 'green' : 'gray'}
                  dot
                />
                <Button variant="ghost" size="sm" onClick={() => handleToggleSchedule(s)}>
                  {s.is_active ? 'Pause' : 'Resume'}
                </Button>
                <Button
                  variant="ghost" size="sm"
                  icon={<Trash2 size={13} />}
                  onClick={() => handleDeleteSchedule(s.id)}
                />
              </div>
            </div>
          ))
        )}
      </Card>

      {/* ── Chrome Extensions ────────────────────────────────────────────── */}
      <Card
        title="Chrome Extensions"
        subtitle="Install Prokeep browser extensions for enhanced workflow"
        style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-4)' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)' as never, color: 'var(--color-text-primary)', marginBottom: 2 }}>
                Week at a Glance
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                View your upcoming customer calls directly in Chrome
              </div>
            </div>
            <Button
              variant="secondary" size="sm"
              icon={<Chrome size={13} />}
              onClick={() => fsApi.openExternal('https://chromewebstore.google.com/detail/kkdhmffbhhmgaacdegkpfabhlplnkpil?utm_source=item-share-cb')}
            >
              Install Extension
            </Button>
          </div>
          <div style={{ height: 1, background: 'var(--color-border)' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)' as never, color: 'var(--color-text-primary)', marginBottom: 2 }}>
                Prokeep Knowledge Assistant
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                Access Prokeep knowledge base articles from any web page
              </div>
            </div>
            <Button
              variant="secondary" size="sm"
              icon={<Chrome size={13} />}
              onClick={() => fsApi.openExternal('https://chromewebstore.google.com/detail/hlagcfdkbahdmmgjmgggpnnheipfnmnj?utm_source=item-share-cb')}
            >
              Install Extension
            </Button>
          </div>
        </div>
      </Card>

      {/* ── App Updates ──────────────────────────────────────────────────── */}
      <Card
        title="App Updates"
        subtitle="Keep B.O.B. up to date automatically"
        style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-4)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
              Current version: <strong style={{ color: 'var(--color-text-primary)' }}>1.0.0</strong>
            </div>
            {updateStatus && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                {updateStatus.status === 'not-available' && <CheckCircle2 size={14} style={{ color: '#34A853', flexShrink: 0 }} />}
                {updateStatus.status === 'available'     && <DownloadCloud size={14} style={{ color: 'var(--color-teal-400)', flexShrink: 0 }} />}
                {updateStatus.status === 'downloaded'    && <CheckCircle2 size={14} style={{ color: 'var(--color-teal-400)', flexShrink: 0 }} />}
                {updateStatus.status === 'error'         && <AlertCircle  size={14} style={{ color: '#DA5039', flexShrink: 0 }} />}
                {updateStatus.status === 'checking'      && (
                  <div style={{ width: 14, height: 14, border: '2px solid var(--color-teal-700)', borderTopColor: 'var(--color-teal-500)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                )}
                <span style={{
                  fontSize: 'var(--text-xs)',
                  color: updateStatus.status === 'error' ? '#DA5039'
                       : updateStatus.status === 'not-available' ? '#34A853'
                       : 'var(--color-teal-400)',
                }}>
                  {updateStatus.message ?? (
                    updateStatus.status === 'checking'      ? 'Checking for updates…' :
                    updateStatus.status === 'available'     ? 'Update found — downloading…' :
                    updateStatus.status === 'not-available' ? 'You\'re on the latest version.' :
                    updateStatus.status === 'downloaded'    ? 'Update ready — quit & relaunch to install.' :
                    ''
                  )}
                </span>
              </div>
            )}
            {!updateStatus && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                Updates download silently in the background and install on next relaunch.
              </div>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<DownloadCloud size={13} />}
            loading={updateChecking}
            onClick={handleCheckForUpdates}
          >
            Check for Updates
          </Button>
        </div>
      </Card>

      {/* ── Local AI Model ───────────────────────────────────────────────── */}
      <Card
        title="Local AI Model"
        subtitle="DeepSeek-R1-Distill-Qwen-1.5B · runs 100% on-device via Metal GPU"
        style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-4)' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
          <div style={{ flex: 1 }}>
            {/* Status row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Cpu size={14} strokeWidth={1.8} style={{ color: aiStatus?.loadState === 'ready' ? '#34A853' : 'var(--color-text-muted)', flexShrink: 0 }} />
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>
                {!aiStatus
                  ? 'Checking status…'
                  : !aiStatus.downloaded
                  ? 'Not downloaded — ~1.24 GB'
                  : aiStatus.loadState === 'ready'
                  ? 'Model ready'
                  : aiStatus.loadState === 'loading'
                  ? 'Loading into memory…'
                  : aiStatus.loadState === 'error'
                  ? `Load error: ${aiStatus.loadError}`
                  : 'Downloaded — will load on first use'}
              </span>
            </div>

            {/* Download progress bar */}
            {aiStatus?.downloadState === 'downloading' && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginBottom: 4 }}>
                  <span>Downloading… {aiStatus.downloadPct}%</span>
                  <span>{aiStatus.mbDownloaded.toFixed(0)} / {aiStatus.mbTotal.toFixed(0)} MB</span>
                </div>
                <div style={{ height: 4, background: 'var(--color-bg-elevated)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${aiStatus.downloadPct}%`, height: '100%', background: 'var(--color-teal-500)', borderRadius: 2, transition: 'width 0.3s' }} />
                </div>
              </div>
            )}

            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', margin: 0 }}>
              Powers AI Assist buttons in Follow-Ups, Company Detail, Risk, and Expansion pages. Stored in your user data folder — persists across updates.
            </p>
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, alignItems: 'flex-end' }}>
            {aiStatus?.downloadState === 'downloading' ? (
              <Button variant="ghost" size="sm" onClick={handleAiCancelDownload}>
                Cancel Download
              </Button>
            ) : !aiStatus?.downloaded ? (
              <Button
                variant="primary"
                size="sm"
                icon={<DownloadCloud size={13} />}
                loading={aiDownloading}
                onClick={handleAiDownload}
              >
                Download Model
              </Button>
            ) : (
              <>
                {aiStatus.loadState !== 'ready' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Sparkles size={13} />}
                    onClick={() => localAiApi.load().then(loadAiStatus)}
                  >
                    Load Now
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash size={13} />}
                  loading={aiDeleting}
                  onClick={handleAiDelete}
                  style={{ color: '#DA5039' }}
                >
                  Delete Model
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* ── Notification Preferences ─────────────────────────────────────── */}
      <Card
        title="Notification Preferences"
        subtitle="Follow-up due date reminders via macOS notifications"
        style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-4)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {notifSettings.enabled
              ? <Bell size={15} style={{ color: 'var(--color-teal-400)' }} />
              : <BellOff size={15} style={{ color: 'var(--color-text-muted)' }} />
            }
            <span style={{ fontSize: 'var(--text-sm)', color: notifSettings.enabled ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}>
              {notifSettings.enabled ? 'Notifications enabled' : 'Notifications disabled'}
            </span>
          </div>
          <Button
            variant={notifSettings.enabled ? 'ghost' : 'secondary'}
            size="sm"
            icon={notifSettings.enabled ? <BellOff size={13} /> : <Bell size={13} />}
            loading={savingNotif}
            onClick={handleToggleNotifications}
          >
            {notifSettings.enabled ? 'Disable' : 'Enable'}
          </Button>
        </div>

        {notifSettings.enabled && (
          <div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
              Remind me before due date
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              {[
                { label: '24 hours before', minutes: 24 * 60 },
                { label: '1 hour before',   minutes: 60 },
                { label: 'At due time',      minutes: 0 },
              ].map(({ label, minutes }) => {
                const active = notifSettings.windowsMin.includes(minutes)
                return (
                  <button
                    key={minutes}
                    onClick={() => handleNotifWindowToggle(minutes)}
                    style={{
                      padding: '5px 12px',
                      borderRadius: 'var(--radius-md)',
                      border: `1px solid ${active ? 'var(--color-teal-500)' : 'var(--color-border)'}`,
                      background: active ? 'var(--color-teal-muted)' : 'transparent',
                      color: active ? 'var(--color-teal-400)' : 'var(--color-text-muted)',
                      fontSize: 'var(--text-xs)',
                      cursor: 'pointer',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            <p style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
              Notifications are checked every 2 minutes. Follow-ups without a due date will not trigger notifications.
            </p>
          </div>
        )}
      </Card>

      {/* ── About ────────────────────────────────────────────────────────── */}
      <Card title="About" style={{ marginTop: 'var(--space-4)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
          <InfoRow label="Version"   value="1.0.0" />
          <InfoRow label="Platform"  value="macOS" />
          <InfoRow label="Runtime"   value="Electron + React 18" />
          <InfoRow label="Database"  value="SQLite (WAL mode)" />
          <InfoRow label="Search"    value="Fuse.js (fuzzy, in-memory)" />
          <InfoRow label="Jobs"      value="SQLite-backed queue, 2 concurrent" />
        </div>
      </Card>

      {showAddModal && (
        <AddScheduleModal
          onSave={handleAddSchedule}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ color: 'var(--color-text-secondary)' }}>{value}</div>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  scheduleRow: {
    display:      'flex',
    alignItems:   'center',
    gap:          'var(--space-4)',
    padding:      'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--color-border)',
  },
  scheduleName: {
    fontSize:   'var(--text-sm)',
    fontWeight: 'var(--weight-medium)' as never,
    color:      'var(--color-text-primary)',
  },
  scheduleMeta: {
    fontSize:   'var(--text-xs)',
    color:      'var(--color-text-muted)',
    display:    'flex',
    alignItems: 'center',
    gap:        'var(--space-2)',
    marginTop:  2,
  },
  cronCode: {
    fontFamily:   'var(--font-mono)',
    fontSize:     'var(--text-xs)',
    color:        'var(--color-teal-400)',
    background:   'var(--color-teal-muted)',
    padding:      '1px 6px',
    borderRadius: 'var(--radius-sm)',
  },
}

const modalStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position:       'fixed',
    inset:          0,
    background:     'rgba(13, 21, 37, 0.7)',
    backdropFilter: 'blur(4px)',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         1000,
  },
  dialog: {
    background:   'var(--color-bg-card)',
    border:       '1px solid var(--color-border)',
    borderRadius: 'var(--radius-xl)',
    width:        440,
    boxShadow:    '0 24px 64px rgba(0,0,0,0.4)',
    overflow:     'hidden',
  },
  header: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        'var(--space-4) var(--space-5)',
    borderBottom:   '1px solid var(--color-border)',
  },
  headerTitle: {
    fontSize:   'var(--text-md)',
    fontWeight: 'var(--weight-semibold)' as never,
    color:      'var(--color-text-primary)',
  },
  closeBtn: {
    display:      'flex',
    alignItems:   'center',
    background:   'transparent',
    border:       'none',
    color:        'var(--color-text-muted)',
    cursor:       'pointer',
    padding:      4,
    borderRadius: 'var(--radius-sm)',
  },
  body: {
    padding:       'var(--space-5)',
    display:       'flex',
    flexDirection: 'column',
  },
  footer: {
    display:        'flex',
    justifyContent: 'flex-end',
    gap:            'var(--space-2)',
    padding:        'var(--space-3) var(--space-5)',
    borderTop:      '1px solid var(--color-border)',
    background:     'var(--color-bg-surface)',
  },
  label: {
    fontSize:      'var(--text-xs)',
    fontWeight:    600 as never,
    color:         'var(--color-text-muted)',
    textTransform: 'uppercase' as never,
    letterSpacing: '0.05em',
    marginBottom:  5,
    display:       'block',
  },
}
