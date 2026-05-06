import React, { useEffect, useState, useCallback } from 'react'
import { Plus, Trash2, CheckCircle2, Clock, XCircle, RefreshCw, FileText, Calendar } from 'lucide-react'
import { Button, Card, AIPanel } from '../../components/ui'
import { followUpsApi, companiesApi, type FollowUp, type CreateFollowUpInput } from '../../lib/ipc'
import type { Company } from '@shared/types'

// Google logo color SVG (16px) — used for sync indicator
function GoogleSyncBadge() {
  return (
    <span title="Synced to Google Tasks & Calendar" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <svg width="10" height="10" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
        <path fill="#EA4335" d="M24 9.5c3.18 0 5.39 1.38 6.63 2.53l4.91-4.91C32.46 4.26 28.52 2.5 24 2.5 14.83 2.5 7.2 8.14 4.27 16.02l5.7 4.43C11.48 14.47 17.27 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M45.12 24.5c0-1.57-.14-3.09-.4-4.57H24v8.64h11.9c-.51 2.75-2.07 5.08-4.4 6.64l6.81 5.29C42.18 36.72 45.12 31.02 45.12 24.5z"/>
        <path fill="#FBBC05" d="M9.97 28.45A14.5 14.5 0 0 1 9.5 24c0-1.57.27-3.09.47-4.55l-5.7-4.43A22.35 22.35 0 0 0 1.5 24c0 3.59.86 6.99 2.37 9.98l6.1-5.53z"/>
        <path fill="#34A853" d="M24 45.5c4.52 0 8.31-1.5 11.08-4.07l-6.81-5.29c-1.5 1-3.43 1.59-4.27 1.59-6.72 0-12.47-4.95-14.03-11.35l-6.1 5.53C7.2 39.86 14.83 45.5 24 45.5z"/>
      </svg>
      <span style={{ fontSize: 9, color: 'var(--color-teal-400)', fontWeight: 600 }}>Synced</span>
    </span>
  )
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: FollowUp['status'] }) {
  if (status === 'done')      return <CheckCircle2 size={14} color="var(--color-teal-400)" />
  if (status === 'dismissed') return <XCircle      size={14} color="var(--color-text-muted)" />
  return <Clock size={14} color="#F4B74E" />
}

function statusLabel(s: FollowUp['status']): string {
  if (s === 'done')      return 'Done'
  if (s === 'dismissed') return 'Dismissed'
  return 'Open'
}

function statusColor(s: FollowUp['status']): string {
  if (s === 'done')      return 'var(--color-teal-400)'
  if (s === 'dismissed') return 'var(--color-text-muted)'
  return '#F4B74E'
}

// ─── Follow-up row ────────────────────────────────────────────────────────────

function FollowUpRow({
  item,
  onStatusChange,
  onDelete,
}: {
  item: FollowUp
  onStatusChange: (id: string, status: FollowUp['status']) => void
  onDelete: (id: string) => void
}) {
  return (
    <div style={{
      display:       'flex',
      alignItems:    'flex-start',
      gap:           'var(--space-3)',
      padding:       'var(--space-3) var(--space-4)',
      borderBottom:  '1px solid var(--color-border)',
      background:    item.status !== 'open' ? 'var(--color-bg-subtle)' : 'transparent',
      opacity:       item.status === 'dismissed' ? 0.55 : 1,
    }}>
      {/* Status icon */}
      <div style={{ marginTop: 2, flexShrink: 0 }}>
        <StatusIcon status={item.status} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize:      'var(--text-sm)',
          color:         item.status === 'done' ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
          lineHeight:    1.4,
          textDecoration: item.status === 'done' ? 'line-through' : 'none',
        }}>
          {item.description}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginTop: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontWeight: 600 }}>
            {item.company_name}
          </span>
          {item.source === 'transcript' && (
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
              <FileText size={10} /> from transcript
            </span>
          )}
          {item.due_date && (
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
              <Calendar size={10} /> {formatDueDate(item.due_date)}
            </span>
          )}
          {(item.google_task_id || item.google_calendar_event_id) && (
            <GoogleSyncBadge />
          )}
          <span style={{ fontSize: 10, color: statusColor(item.status), fontWeight: 600 }}>
            {statusLabel(item.status)}
          </span>
        </div>
        {/* AI Draft Email */}
        <div style={{ marginTop: 6 }}>
          <AIPanel
            label="Draft Email"
            prompt={`Write a short, professional follow-up email (3-4 sentences, no subject line) for this customer success task:\n\nCompany: ${item.company_name}\nTask: ${item.description}${item.due_date ? `\nDue: ${item.due_date}` : ''}`}
            systemPrompt="You are a concise B2B customer success manager. Write a short, professional follow-up email. No subject line. Be direct and actionable. Plain text only."
          />
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
        {item.status === 'open' && (
          <>
            <button
              onClick={() => onStatusChange(item.id, 'done')}
              title="Mark done"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-teal-400)', padding: 3, display: 'flex', alignItems: 'center', borderRadius: 4 }}
            >
              <CheckCircle2 size={13} strokeWidth={2} />
            </button>
            <button
              onClick={() => onStatusChange(item.id, 'dismissed')}
              title="Dismiss"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 3, display: 'flex', alignItems: 'center', borderRadius: 4 }}
            >
              <XCircle size={13} strokeWidth={2} />
            </button>
          </>
        )}
        {item.status !== 'open' && (
          <button
            onClick={() => onStatusChange(item.id, 'open')}
            title="Reopen"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#F4B74E', padding: 3, display: 'flex', alignItems: 'center', borderRadius: 4, fontSize: 10 }}
          >
            Reopen
          </button>
        )}
        <button
          onClick={() => onDelete(item.id)}
          title="Delete"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 3, display: 'flex', alignItems: 'center', borderRadius: 4 }}
        >
          <Trash2 size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

// ─── Due-date display helper ──────────────────────────────────────────────────

function formatDueDate(d: string): string {
  if (d.includes('T')) {
    // datetime — show "May 15 · 2:30 PM"
    const dt = new Date(d)
    const datePart = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const timePart = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    return `${datePart} · ${timePart}`
  }
  // date-only — avoid UTC-offset midnight shift by parsing at noon local
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ─── Manual entry form ────────────────────────────────────────────────────────

function AddFollowUpForm({
  companies,
  onAdd,
  onCancel,
}: {
  companies: Company[]
  onAdd: (input: CreateFollowUpInput) => Promise<void>
  onCancel: () => void
}) {
  const [description,  setDescription]  = useState('')
  const [companyId,    setCompanyId]    = useState('')
  const [dueDate,      setDueDate]      = useState('')
  const [dueTime,      setDueTime]      = useState('')
  const [saving,       setSaving]       = useState(false)

  const selectedCompany = companies.find(c => c.id === companyId)

  async function handleSubmit() {
    if (!description.trim()) return
    setSaving(true)
    // Combine date + time into "YYYY-MM-DDTHH:MM" when both are set
    const dueDateValue = dueDate
      ? (dueTime ? `${dueDate}T${dueTime}` : dueDate)
      : null
    await onAdd({
      company_id:   companyId || null,
      company_name: selectedCompany?.name ?? 'General',
      description:  description.trim(),
      source:       'manual',
      due_date:     dueDateValue,
    })
    setSaving(false)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: 'var(--space-2) var(--space-3)',
    background: 'var(--color-bg-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--text-sm)',
    outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-4)', background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', marginBottom: 'var(--space-4)' }}>
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)' as never, color: 'var(--color-text-primary)' }}>
        Add Follow-Up
      </div>

      {/* Description */}
      <textarea
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="What needs to be followed up on?"
        rows={3}
        autoFocus
        style={{
          width:        '100%',
          padding:      'var(--space-2) var(--space-3)',
          background:   'var(--color-bg-surface)',
          border:       '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          color:        'var(--color-text-primary)',
          fontSize:     'var(--text-sm)',
          lineHeight:   1.5,
          resize:       'vertical',
          fontFamily:   'inherit',
          outline:      'none',
          boxSizing:    'border-box',
        }}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)' }}>
        {/* Company */}
        <div>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>
            Company (optional)
          </label>
          <select
            value={companyId}
            onChange={e => setCompanyId(e.target.value)}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            <option value="">— No company —</option>
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Due date */}
        <div>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', display: 'block', marginBottom: 4, fontWeight: 600 }}>
            Due Date (optional)
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={e => { setDueDate(e.target.value); if (!e.target.value) setDueTime('') }}
            style={inputStyle}
          />
        </div>

        {/* Due time */}
        <div>
          <label style={{ fontSize: 'var(--text-xs)', color: dueDate ? 'var(--color-text-muted)' : 'var(--color-text-disabled)', display: 'block', marginBottom: 4, fontWeight: 600 }}>
            Time (optional)
          </label>
          <input
            type="time"
            value={dueTime}
            onChange={e => setDueTime(e.target.value)}
            disabled={!dueDate}
            style={{
              ...inputStyle,
              opacity: dueDate ? 1 : 0.4,
              cursor:  dueDate ? 'auto' : 'not-allowed',
            }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!description.trim() || saving}>
          {saving ? 'Saving…' : 'Add Follow-Up'}
        </Button>
      </div>
    </div>
  )
}

// ─── Filter tab ───────────────────────────────────────────────────────────────

type FilterTab = 'open' | 'done' | 'dismissed' | 'all'

function FilterTabs({ active, onChange }: { active: FilterTab; onChange: (t: FilterTab) => void }) {
  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'open',      label: 'Open' },
    { key: 'done',      label: 'Done' },
    { key: 'dismissed', label: 'Dismissed' },
    { key: 'all',       label: 'All' },
  ]
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 'var(--space-4)' }}>
      {tabs.map(t => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          style={{
            padding:      '4px 12px',
            border:       `1px solid ${active === t.key ? 'var(--color-teal-600)' : 'var(--color-border)'}`,
            borderRadius: 20,
            background:   active === t.key ? 'rgba(86,183,163,0.12)' : 'transparent',
            color:        active === t.key ? 'var(--color-teal-400)' : 'var(--color-text-secondary)',
            fontSize:     'var(--text-xs)',
            fontWeight:   active === t.key ? 700 : 400,
            cursor:       'pointer',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function FollowUps() {
  const [items,      setItems]      = useState<FollowUp[]>([])
  const [companies,  setCompanies]  = useState<Company[]>([])
  const [loading,    setLoading]    = useState(false)
  const [parsing,    setParsing]    = useState(false)
  const [showAdd,    setShowAdd]    = useState(false)
  const [filter,     setFilter]     = useState<FilterTab>('open')
  const [parseMsg,   setParseMsg]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await followUpsApi.list()
    if (r.ok) setItems(r.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    companiesApi.list({ pageSize: 500 }).then(r => {
      if (r.ok) setCompanies(r.data.items)
    })
  }, [load])

  async function handleAdd(input: CreateFollowUpInput) {
    const r = await followUpsApi.create(input)
    if (r.ok) {
      setItems(prev => [r.data, ...prev])
      setShowAdd(false)
    }
  }

  async function handleStatusChange(id: string, status: FollowUp['status']) {
    const r = await followUpsApi.update(id, { status })
    if (r.ok) setItems(prev => prev.map(i => i.id === id ? r.data : i))
  }

  async function handleDelete(id: string) {
    await followUpsApi.delete(id)
    setItems(prev => prev.filter(i => i.id !== id))
  }

  async function handleParseTranscripts() {
    setParsing(true)
    setParseMsg(null)
    const r = await followUpsApi.parseTranscripts()
    if (r.ok) {
      setParseMsg(`Found ${r.data.created} new follow-up${r.data.created !== 1 ? 's' : ''} from transcripts.`)
      await load()
    } else {
      setParseMsg('Parse failed — check console.')
    }
    setParsing(false)
  }

  // Filter
  const filtered = items.filter(i => filter === 'all' ? true : i.status === filter)

  const openCount = items.filter(i => i.status === 'open').length

  return (
    <div className="page animate-fade-in">
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Follow Ups</h1>
          <p className="page-subtitle">
            Track commitments and action items — {openCount} open
          </p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button
            variant="ghost"
            size="sm"
            icon={<FileText size={14} />}
            onClick={handleParseTranscripts}
            disabled={parsing}
          >
            {parsing ? 'Parsing…' : 'Parse Transcripts'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={load}
            disabled={loading}
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => setShowAdd(s => !s)}
          >
            Add Follow-Up
          </Button>
        </div>
      </div>

      {/* Parse result banner */}
      {parseMsg && (
        <div style={{ margin: '0 0 var(--space-4)', padding: 'var(--space-3) var(--space-4)', background: 'rgba(86,183,163,0.08)', border: '1px solid rgba(86,183,163,0.25)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {parseMsg}
          <button onClick={() => setParseMsg(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 0 }}>✕</button>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <AddFollowUpForm
          companies={companies}
          onAdd={handleAdd}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* Filter tabs */}
      <FilterTabs active={filter} onChange={setFilter} />

      {/* List */}
      <Card padding={false}>
        {loading ? (
          <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)' }}>
            <CheckCircle2 size={32} strokeWidth={1.2} style={{ color: 'var(--color-teal-700)' }} />
            <div>
              <div style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-medium)' as never, marginBottom: 4 }}>
                {filter === 'open' ? 'No open follow-ups' : `No ${filter} follow-ups`}
              </div>
              <div style={{ fontSize: 'var(--text-sm)' }}>
                {filter === 'open'
                  ? 'Click "Add Follow-Up" to create one, or "Parse Transcripts" to extract from calls.'
                  : 'Switch tabs to see other follow-ups.'}
              </div>
            </div>
          </div>
        ) : (
          filtered.map(item => (
            <FollowUpRow
              key={item.id}
              item={item}
              onStatusChange={handleStatusChange}
              onDelete={handleDelete}
            />
          ))
        )}
      </Card>
    </div>
  )
}
