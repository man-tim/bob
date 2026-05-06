import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Building2, Globe, User, Phone, Mail,
  FileText, Calendar, ExternalLink, Search, X,
  Star, TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp,
  Edit3, Check, BookOpen, AlertCircle, Plus, Trash2,
  ClipboardList, CheckCircle2,
} from 'lucide-react'
import { companiesApi, companyNotesApi, searchApi, fsApi, followUpsApi } from '../../lib/ipc'
import type { FollowUp } from '../../lib/ipc'
import { TierBadge, HealthBadge, AIPanel }       from '../../components/ui'
import { formatRelative, formatARR }              from '../../lib/utils'
import type { CompanyDetail, GlobalSearchResult, CompanyNote } from '../../lib/ipc'
import type { Contact }                           from '@shared/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

import type { Company } from '@shared/types'

function buildBriefingPrompt(
  company: Company,
  callCount: number,
  lastCallAt: string | null,
  avgSentiment: number | null,
  recentActionItems: string[],
  transcripts: CompanyDetail['transcripts'],
): string {
  const lastCall  = lastCallAt ? new Date(lastCallAt).toLocaleDateString() : 'never'
  const sentiment = avgSentiment == null ? 'unknown' : avgSentiment >= 0.3 ? 'positive' : avgSentiment <= -0.3 ? 'at risk' : 'neutral'
  const recentTx  = transcripts.slice(0, 2).map(t => t.summary ?? t.call_title ?? '').filter(Boolean).join(' | ')
  const items     = recentActionItems.slice(0, 3).join('; ')

  return [
    `Account: ${company.name}`,
    company.arr ? `ARR: $${company.arr.toLocaleString()}` : null,
    company.tier ? `Tier: ${company.tier}` : null,
    `Total Gong calls: ${callCount}, last call: ${lastCall}`,
    `Overall sentiment: ${sentiment}`,
    recentTx    ? `Recent call summaries: ${recentTx}` : null,
    items       ? `Open action items: ${items}` : null,
  ].filter(Boolean).join('\n')
}

function sentimentLabel(s: number | null): { label: string; color: string; icon: React.ReactNode } {
  if (s === null) return { label: 'N/A', color: 'var(--color-text-muted)', icon: <Minus size={12} /> }
  if (s >= 0.3)   return { label: 'Positive', color: 'var(--color-teal-500)', icon: <TrendingUp size={12} /> }
  if (s <= -0.3)  return { label: 'At Risk',  color: '#DA5039',              icon: <TrendingDown size={12} /> }
  return            { label: 'Neutral',  color: '#F4B74E',              icon: <Minus size={12} /> }
}

function rolePillColor(role: string): string {
  switch (role) {
    case 'champion':       return 'rgba(86, 183, 163, 0.15)'
    case 'economic_buyer': return 'rgba(244, 183, 78, 0.15)'
    case 'blocker':        return 'rgba(218, 80, 57, 0.12)'
    default:               return 'var(--color-bg-surface)'
  }
}

function rolePillText(role: string): string {
  switch (role) {
    case 'champion':       return 'Champion'
    case 'economic_buyer': return 'Economic Buyer'
    case 'user':           return 'User'
    case 'blocker':        return 'Blocker'
    default:               return 'Contact'
  }
}

function searchTypeColor(type: GlobalSearchResult['type']): string {
  switch (type) {
    case 'company':    return 'var(--color-teal-500)'
    case 'transcript': return '#F4B74E'
    case 'knowledge':  return 'rgba(86, 183, 163, 0.6)'
  }
}

function searchTypeLabel(type: GlobalSearchResult['type']): string {
  switch (type) {
    case 'company':    return 'Company'
    case 'transcript': return 'Transcript'
    case 'knowledge':  return 'Wiki'
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatChip({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div style={styles.statChip}>
      <span style={styles.statValue}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
      {sub && <span style={styles.statSub}>{sub}</span>}
    </div>
  )
}

function ContactCard({ contact }: { contact: Contact }) {
  return (
    <div style={styles.contactCard}>
      <div style={styles.contactTopRow}>
        <span style={styles.contactName}>{contact.name}</span>
        {contact.is_primary && (
          <Star size={11} style={{ color: '#F4B74E', flexShrink: 0, fill: '#F4B74E' }} />
        )}
      </div>
      {contact.title && (
        <span style={styles.contactTitle}>{contact.title}</span>
      )}
      <span style={{
        ...styles.rolePill,
        background: rolePillColor(contact.role),
      }}>
        {rolePillText(contact.role)}
      </span>
      <div style={styles.contactLinks}>
        {contact.email && (
          <a href={`mailto:${contact.email}`} style={styles.contactLink}>
            <Mail size={11} strokeWidth={2} />
            {contact.email}
          </a>
        )}
        {contact.phone && (
          <a href={`tel:${contact.phone}`} style={styles.contactLink}>
            <Phone size={11} strokeWidth={2} />
            {contact.phone}
          </a>
        )}
      </div>
    </div>
  )
}

function TranscriptCard({ transcript }: {
  transcript: CompanyDetail['transcripts'][number]
}) {
  const [expanded, setExpanded] = useState(false)
  const sent  = sentimentLabel(transcript.sentiment_score)
  const items = transcript.action_items ?? []

  return (
    <div style={styles.txCard}>
      {/* Header */}
      <div style={styles.txHeader}>
        <div style={styles.txMeta}>
          <span style={styles.txDate}>
            {new Date(transcript.called_at).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
            })}
          </span>
          <span style={{ ...styles.sentimentPill, color: sent.color, borderColor: sent.color }}>
            {sent.icon} {sent.label}
          </span>
        </div>
        <button style={styles.txExpandBtn} onClick={() => setExpanded(e => !e)}>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      <span style={styles.txTitle}>{transcript.call_title ?? 'Untitled call'}</span>

      {/* Summary */}
      {transcript.summary && (
        <p style={styles.txSummary}>{transcript.summary}</p>
      )}

      {/* Action items — always show first one, rest on expand */}
      {items.length > 0 && (
        <div style={styles.actionItems}>
          {(expanded ? items : items.slice(0, 2)).map((item, i) => (
            <div key={i} style={styles.actionItem}>
              <AlertCircle size={10} strokeWidth={2.5} style={{ color: '#F4B74E', flexShrink: 0, marginTop: 2 }} />
              <span>{item}</span>
            </div>
          ))}
          {!expanded && items.length > 2 && (
            <button style={styles.txMoreBtn} onClick={() => setExpanded(true)}>
              +{items.length - 2} more action items
            </button>
          )}
        </div>
      )}

      {/* Drive link */}
      {expanded && transcript.drive_file_id && (
        <button
          style={styles.driveLinkBtn}
          onClick={() => fsApi.openExternal(
            `https://drive.google.com/file/d/${transcript.drive_file_id}/view`
          )}
        >
          <ExternalLink size={11} strokeWidth={2} />
          View transcript in Drive
        </button>
      )}
    </div>
  )
}

// ─── Global Search Bar ────────────────────────────────────────────────────────

function GlobalSearch({ onNavigate }: { onNavigate: (r: GlobalSearchResult) => void }) {
  const navigate = useNavigate()
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<GlobalSearchResult[]>([])
  const [open,    setOpen]    = useState(false)
  const [loading, setLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!query.trim() || query.length < 2) { setResults([]); setOpen(false); return }

    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      setLoading(true)
      const res = await searchApi.global(query.trim(), 12)
      if (res.ok) { setResults(res.data); setOpen(true) }
      setLoading(false)
    }, 220)

    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [query])

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleSelect(r: GlobalSearchResult) {
    setOpen(false)
    setQuery('')
    if (r.type === 'company') {
      navigate(`/companies/${r.id}`)
    } else if (r.type === 'transcript' && r.companyId) {
      navigate(`/companies/${r.companyId}`)
    } else if (r.type === 'knowledge' && r.url) {
      fsApi.openExternal(r.url)
    }
    onNavigate(r)
  }

  return (
    <div ref={containerRef} style={styles.searchWrap}>
      <div style={styles.searchInputWrap}>
        <Search size={14} strokeWidth={2} style={styles.searchIcon} />
        <input
          style={styles.searchInput}
          placeholder="Search companies, transcripts, wiki…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
        />
        {query && (
          <button style={styles.searchClear} onClick={() => { setQuery(''); setResults([]); setOpen(false) }}>
            <X size={12} />
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <div style={styles.searchDropdown}>
          {results.map(r => (
            <button key={`${r.type}:${r.id}`} style={styles.searchResultRow} onClick={() => handleSelect(r)}>
              <span style={{ ...styles.searchTypePill, color: searchTypeColor(r.type) }}>
                {searchTypeLabel(r.type)}
              </span>
              <div style={styles.searchResultContent}>
                <span style={styles.searchResultTitle}>{r.title}</span>
                {r.subtitle && <span style={styles.searchResultSub}>{r.subtitle}</span>}
                {r.snippet && <span style={styles.searchResultSnippet}>{r.snippet}</span>}
              </div>
              <span style={styles.searchScore}>{r.score}%</span>
            </button>
          ))}
        </div>
      )}

      {open && loading && (
        <div style={styles.searchDropdown}>
          <div style={{ padding: '12px 16px', color: 'var(--color-text-muted)', fontSize: 12 }}>
            Searching…
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Notes Editor ─────────────────────────────────────────────────────────────

function NotesEditor({ companyId }: { companyId: string }) {
  const [notes,   setNotes]   = useState<CompanyNote[]>([])
  const [draft,   setDraft]   = useState('')
  const [adding,  setAdding]  = useState(false)
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    companyNotesApi.list(companyId).then(r => { if (r.ok) setNotes(r.data) })
  }, [companyId])

  async function handleAdd() {
    if (!draft.trim()) return
    setSaving(true)
    const r = await companyNotesApi.add(companyId, draft.trim())
    if (r.ok) setNotes(prev => [r.data, ...prev])
    setDraft('')
    setAdding(false)
    setSaving(false)
  }

  async function handleDelete(noteId: string) {
    await companyNotesApi.delete(noteId)
    setNotes(prev => prev.filter(n => n.id !== noteId))
  }

  function formatNoteDate(iso: string) {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div style={styles.notesWrap}>
      <div style={styles.notesTitleRow}>
        <span style={styles.panelLabel}>Notes ({notes.length})</span>
        {!adding && (
          <button style={styles.notesEditBtn} onClick={() => setAdding(true)}>
            <Plus size={11} strokeWidth={2} /> Add Note
          </button>
        )}
      </div>

      {adding && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          <textarea
            style={styles.notesTextarea}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Add account notes, context, key history…"
            autoFocus
            rows={4}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              style={{ ...styles.notesEditBtn, color: 'var(--color-teal-500)', padding: '3px 8px', border: '1px solid var(--color-teal-700)', borderRadius: 'var(--radius-sm)' }}
              onClick={handleAdd}
              disabled={saving}
            >
              <Check size={11} strokeWidth={2} /> {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              style={{ ...styles.notesEditBtn, padding: '3px 8px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)' }}
              onClick={() => { setAdding(false); setDraft('') }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {notes.length === 0 && !adding ? (
        <p style={{ ...styles.notesText, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          No notes yet. Click "Add Note" to start.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {notes.map(note => (
            <div key={note.id} style={styles.noteCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{formatNoteDate(note.created_at)}</span>
                <button
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 0, display: 'flex', alignItems: 'center', flexShrink: 0 }}
                  onClick={() => handleDelete(note.id)}
                  title="Delete note"
                >
                  <Trash2 size={11} strokeWidth={2} />
                </button>
              </div>
              <p style={styles.notesText}>{note.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Knowledge Sidebar ────────────────────────────────────────────────────────

function KnowledgeSidebar({ companyName }: { companyName: string }) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<GlobalSearchResult[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Pre-seed with company name
  useEffect(() => {
    if (!companyName) return
    searchApi.global(companyName, 5).then(r => {
      if (r.ok) setResults(r.data.filter(x => x.type === 'knowledge'))
    })
  }, [companyName])

  function handleChange(v: string) {
    setQuery(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!v.trim()) return
    timerRef.current = setTimeout(async () => {
      const res = await searchApi.global(v.trim(), 8)
      if (res.ok) setResults(res.data.filter(x => x.type === 'knowledge'))
    }, 240)
  }

  return (
    <div style={styles.knowledgeWrap}>
      <div style={styles.panelLabel}>
        <BookOpen size={12} strokeWidth={2} style={{ marginRight: 5 }} />
        Knowledge Base
      </div>

      <div style={{ position: 'relative', marginBottom: 8 }}>
        <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)' }} />
        <input
          style={{ ...styles.miniSearchInput }}
          placeholder={`Search wiki…`}
          value={query}
          onChange={e => handleChange(e.target.value)}
        />
      </div>

      <div style={styles.knowledgeResults}>
        {results.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 11, margin: 0 }}>
            No wiki results. Try searching above.
          </p>
        ) : (
          results.map(r => (
            <button
              key={r.id}
              style={styles.knowledgeItem}
              onClick={() => r.url && fsApi.openExternal(r.url)}
            >
              <span style={styles.knowledgeTitle}>{r.title}</span>
              {r.subtitle && <span style={styles.knowledgeSub}>{r.subtitle}</span>}
              {r.snippet && <span style={styles.knowledgeSnippet}>{r.snippet}</span>}
              <ExternalLink size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0, marginTop: 2 }} />
            </button>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Follow Ups Panel ─────────────────────────────────────────────────────────

function FollowUpsPanel({ companyId }: { companyId: string }) {
  const [items,   setItems]   = useState<FollowUp[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    followUpsApi.list(companyId).then(r => {
      if (r.ok) setItems(r.data)
      setLoading(false)
    })
  }, [companyId])

  async function handleStatus(id: string, status: FollowUp['status']) {
    const r = await followUpsApi.update(id, { status })
    if (r.ok) setItems(prev => prev.map(i => i.id === id ? r.data : i))
  }

  const open = items.filter(i => i.status === 'open')

  if (loading) return null
  if (items.length === 0) return null

  return (
    <div style={{ marginTop: 'var(--space-5)' }}>
      <div style={styles.panelLabel}>
        <ClipboardList size={12} strokeWidth={2} style={{ marginRight: 5 }} />
        Follow Ups ({open.length} open)
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
        {items.slice(0, 8).map(item => (
          <div key={item.id} style={{
            display:       'flex',
            alignItems:    'flex-start',
            gap:           6,
            padding:       '7px 10px',
            background:    item.status !== 'open' ? 'var(--color-bg-subtle)' : 'var(--color-bg-surface)',
            border:        '1px solid var(--color-border)',
            borderRadius:  'var(--radius-md)',
            opacity:       item.status === 'dismissed' ? 0.5 : 1,
          }}>
            <div style={{ marginTop: 2, flexShrink: 0 }}>
              {item.status === 'done'      && <CheckCircle2 size={12} color="var(--color-teal-400)" />}
              {item.status === 'dismissed' && <X size={12} color="var(--color-text-muted)" />}
              {item.status === 'open'      && <AlertCircle  size={12} color="#F4B74E" />}
            </div>
            <span style={{
              flex:           1,
              fontSize:       12,
              color:          item.status !== 'open' ? 'var(--color-text-muted)' : 'var(--color-text-secondary)',
              lineHeight:     1.4,
              textDecoration: item.status === 'done' ? 'line-through' : 'none',
            }}>
              {item.description}
            </span>
            {item.status === 'open' && (
              <button
                onClick={() => handleStatus(item.id, 'done')}
                title="Mark done"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-teal-400)', padding: 0, display: 'flex', alignItems: 'center', flexShrink: 0 }}
              >
                <Check size={11} strokeWidth={2.5} />
              </button>
            )}
          </div>
        ))}
        {items.length > 8 && (
          <p style={{ fontSize: 11, color: 'var(--color-text-muted)', margin: 0, textAlign: 'center' }}>
            +{items.length - 8} more — see Follow Ups tab
          </p>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function CompanyDetail() {
  const { id }       = useParams<{ id: string }>()
  const navigate     = useNavigate()
  const [detail, setDetail] = useState<CompanyDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    const res = await companiesApi.details(id)
    if (res.ok) {
      setDetail(res.data)
    } else {
      setError((!res.ok ? res.error : null) ?? 'Company not found')
    }
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.loadingState}>
          <div style={styles.spinner} />
          <span style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Loading company…</span>
        </div>
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div style={styles.page}>
        <div style={styles.errorState}>
          <Building2 size={32} strokeWidth={1.5} style={{ color: 'var(--color-text-muted)', marginBottom: 12 }} />
          <p style={{ color: '#DA5039', margin: 0 }}>{error ?? 'Company not found'}</p>
          <button style={styles.backBtn} onClick={() => navigate('/companies')}>
            ← Back to Companies
          </button>
        </div>
      </div>
    )
  }

  const { company, contacts, transcripts, upcomingEvents,
          callCount, lastCallAt, avgSentiment, recentActionItems, driveFolder } = detail
  const sent = sentimentLabel(avgSentiment)

  return (
    <div style={styles.page}>

      {/* ── Top bar: back + global search ── */}
      <div style={styles.topBar}>
        <button style={styles.backBtn} onClick={() => navigate('/companies')}>
          <ArrowLeft size={14} strokeWidth={2} />
          Companies
        </button>
        <GlobalSearch onNavigate={() => {}} />
      </div>

      {/* ── Company header ── */}
      <div style={styles.companyHeader}>
        <div style={styles.companyHeaderLeft}>
          <div style={styles.companyIconWrap}>
            <Building2 size={20} strokeWidth={1.8} style={{ color: 'var(--color-teal-500)' }} />
          </div>
          <div>
            <div style={styles.companyNameRow}>
              <h1 style={styles.companyName}>{company.name}</h1>
              <TierBadge tier={company.tier} />
              <HealthBadge score={company.health_score} />
            </div>
            <div style={styles.companyMeta}>
              {company.industry && <span>{company.industry}</span>}
              {company.csm_owner && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <User size={11} strokeWidth={2} />
                  {company.csm_owner}
                </span>
              )}
              {company.website && (
                <button
                  style={styles.websiteLink}
                  onClick={() => fsApi.openExternal(company.website!)}
                >
                  <Globe size={11} strokeWidth={2} />
                  {company.website.replace(/^https?:\/\//, '')}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Stats chips */}
        <div style={styles.statsRow}>
          <StatChip label="ARR" value={company.arr ? formatARR(company.arr) : '—'} />
          <StatChip label="Calls" value={callCount} sub={lastCallAt ? `Last: ${formatRelative(lastCallAt)}` : undefined} />
          <StatChip
            label="Sentiment"
            value={
              <span style={{ color: sent.color, display: 'flex', alignItems: 'center', gap: 4 }}>
                {sent.icon} {sent.label}
              </span>
            }
          />
          {driveFolder && (
            <button
              style={styles.driveChip}
              onClick={() => fsApi.openExternal(driveFolder.url)}
            >
              <ExternalLink size={11} strokeWidth={2} />
              Drive Folder
            </button>
          )}
          {/* AI Briefing button */}
          <AIPanel
            label="AI Briefing"
            prompt={buildBriefingPrompt(company, callCount, lastCallAt, avgSentiment, recentActionItems, transcripts)}
            systemPrompt="You are B.O.B., a concise customer success assistant. Write a 2-3 sentence account briefing for an upcoming customer meeting. Focus on health signals, recent activity, and what to watch for. Plain text only, no bullet points."
          />
        </div>
      </div>

      {/* ── 3-column body ── */}
      <div style={styles.body}>

        {/* Left: Contacts + Notes */}
        <div style={styles.leftCol}>
          <div style={styles.panelLabel}>
            <User size={12} strokeWidth={2} style={{ marginRight: 5 }} />
            Contacts ({contacts.length})
          </div>

          {contacts.length === 0 ? (
            <p style={styles.emptyNote}>No contacts. Import from HubSpot to populate.</p>
          ) : (
            <div style={styles.contactList}>
              {contacts.map(c => <ContactCard key={c.id} contact={c} />)}
            </div>
          )}

          <div style={{ marginTop: 'var(--space-5)' }}>
            <NotesEditor companyId={company.id} />
          </div>

          {/* Recent Action Items summary */}
          {recentActionItems.length > 0 && (
            <div style={{ marginTop: 'var(--space-5)' }}>
              <div style={styles.panelLabel}>
                <AlertCircle size={12} strokeWidth={2} style={{ marginRight: 5 }} />
                Open Action Items
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                {recentActionItems.slice(0, 5).map((item, i) => (
                  <div key={i} style={styles.actionItem}>
                    <AlertCircle size={10} strokeWidth={2.5} style={{ color: '#F4B74E', flexShrink: 0, marginTop: 2 }} />
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Follow Ups */}
          <FollowUpsPanel companyId={company.id} />
        </div>

        {/* Center: Transcript timeline */}
        <div style={styles.centerCol}>
          <div style={styles.panelLabel}>
            <FileText size={12} strokeWidth={2} style={{ marginRight: 5 }} />
            Call History ({callCount})
          </div>

          {transcripts.length === 0 ? (
            <div style={styles.emptyPanel}>
              <FileText size={28} strokeWidth={1.5} style={{ color: 'var(--color-text-muted)', marginBottom: 8 }} />
              <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: 13 }}>
                No transcripts yet. Sync Gong transcripts to populate.
              </p>
            </div>
          ) : (
            <div style={styles.txList}>
              {transcripts.map(t => <TranscriptCard key={t.id} transcript={t} />)}
            </div>
          )}
        </div>

        {/* Right: Calendar + Knowledge */}
        <div style={styles.rightCol}>

          {/* Upcoming calls */}
          <div style={{ marginBottom: 'var(--space-5)' }}>
            <div style={styles.panelLabel}>
              <Calendar size={12} strokeWidth={2} style={{ marginRight: 5 }} />
              Upcoming Calls ({upcomingEvents.length})
            </div>

            {upcomingEvents.length === 0 ? (
              <p style={styles.emptyNote}>No scheduled calls.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {upcomingEvents.map(ev => (
                  <div key={ev.id} style={styles.eventCard}>
                    <span style={styles.eventTime}>
                      {new Date(ev.start_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {' '}
                      {new Date(ev.start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span style={styles.eventTitle}>{ev.title}</span>
                    {ev.meet_link && (
                      <button
                        style={styles.meetMiniBtn}
                        onClick={() => fsApi.openExternal(ev.meet_link!)}
                      >
                        Join
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Knowledge base search, seeded with company name */}
          <KnowledgeSidebar companyName={company.name} />
        </div>

      </div>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: {
    display:       'flex',
    flexDirection: 'column',
    height:        '100%',
    overflow:      'hidden',
    background:    'var(--color-bg-base)',
  },

  loadingState: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            12,
    flex:           1,
  },
  spinner: {
    width:           24,
    height:          24,
    border:          '2px solid var(--color-teal-800)',
    borderTopColor:  'var(--color-teal-500)',
    borderRadius:    '50%',
    animation:       'spin 0.8s linear infinite',
  },
  errorState: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            12,
    flex:           1,
  },

  // Top bar
  topBar: {
    display:      'flex',
    alignItems:   'center',
    gap:          'var(--space-4)',
    padding:      'var(--space-3) var(--space-5)',
    borderBottom: '1px solid var(--color-border)',
    flexShrink:   0,
  },
  backBtn: {
    display:      'flex',
    alignItems:   'center',
    gap:          6,
    padding:      '5px 10px',
    background:   'transparent',
    border:       '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    color:        'var(--color-text-secondary)',
    fontSize:     'var(--text-sm)',
    cursor:       'pointer',
    flexShrink:   0,
    fontWeight:   'var(--weight-medium)' as never,
  },

  // Search bar
  searchWrap: {
    position: 'relative',
    flex:     1,
    maxWidth: 500,
  },
  searchInputWrap: {
    position: 'relative',
    display:  'flex',
    alignItems: 'center',
  },
  searchIcon: {
    position:  'absolute',
    left:      10,
    color:     'var(--color-text-muted)',
    flexShrink: 0,
  },
  searchInput: {
    width:        '100%',
    padding:      '7px 30px 7px 32px',
    background:   'var(--color-bg-surface)',
    border:       '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    fontSize:     'var(--text-sm)',
    color:        'var(--color-text-primary)',
    outline:      'none',
  },
  searchClear: {
    position:   'absolute',
    right:      8,
    background: 'transparent',
    border:     'none',
    color:      'var(--color-text-muted)',
    cursor:     'pointer',
    padding:    2,
    display:    'flex',
    alignItems: 'center',
  },
  searchDropdown: {
    position:     'absolute',
    top:          'calc(100% + 6px)',
    left:         0,
    right:        0,
    background:   'var(--color-bg-card)',
    border:       '1px solid var(--color-border)',
    borderRadius: 'var(--radius-lg)',
    boxShadow:    '0 8px 24px rgba(0,0,0,0.18)',
    zIndex:       100,
    overflow:     'hidden',
    maxHeight:    380,
    overflowY:    'auto' as never,
  },
  searchResultRow: {
    display:    'flex',
    alignItems: 'flex-start',
    gap:        10,
    padding:    '10px 14px',
    background: 'transparent',
    border:     'none',
    width:      '100%',
    textAlign:  'left' as never,
    cursor:     'pointer',
    borderBottom: '1px solid var(--color-border)',
  },
  searchTypePill: {
    fontSize:      10,
    fontWeight:    700 as never,
    textTransform: 'uppercase' as never,
    letterSpacing: '0.05em',
    flexShrink:    0,
    marginTop:     2,
    width:         60,
  },
  searchResultContent: {
    flex:          1,
    display:       'flex',
    flexDirection: 'column' as never,
    minWidth:      0,
    gap:           2,
  },
  searchResultTitle: {
    fontSize:   'var(--text-sm)',
    fontWeight: 'var(--weight-medium)' as never,
    color:      'var(--color-text-primary)',
    whiteSpace: 'nowrap' as never,
    overflow:   'hidden',
    textOverflow: 'ellipsis',
  },
  searchResultSub: {
    fontSize: 11,
    color:    'var(--color-text-muted)',
  },
  searchResultSnippet: {
    fontSize:  11,
    color:     'var(--color-text-secondary)',
    overflow:  'hidden',
    display:   '-webkit-box' as never,
    WebkitLineClamp: 2 as never,
    WebkitBoxOrient: 'vertical' as never,
  },
  searchScore: {
    fontSize:   10,
    color:      'var(--color-text-muted)',
    flexShrink: 0,
    marginTop:  2,
  },

  // Company header
  companyHeader: {
    display:        'flex',
    alignItems:     'flex-start',
    justifyContent: 'space-between',
    gap:            'var(--space-4)',
    padding:        'var(--space-4) var(--space-5)',
    borderBottom:   '1px solid var(--color-border)',
    flexShrink:     0,
    background:     'var(--color-bg-card)',
  },
  companyHeaderLeft: {
    display:    'flex',
    alignItems: 'flex-start',
    gap:        'var(--space-3)',
  },
  companyIconWrap: {
    width:          44,
    height:         44,
    borderRadius:   'var(--radius-lg)',
    background:     'var(--color-teal-900)',
    border:         '1px solid var(--color-teal-700)',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
  companyNameRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        10,
    flexWrap:   'wrap' as never,
  },
  companyName: {
    fontSize:   'var(--text-xl)',
    fontWeight: 'var(--weight-bold)' as never,
    color:      'var(--color-text-primary)',
    margin:     0,
    letterSpacing: '-0.01em',
  },
  companyMeta: {
    display:    'flex',
    alignItems: 'center',
    gap:        12,
    marginTop:  4,
    flexWrap:   'wrap' as never,
    fontSize:   'var(--text-sm)',
    color:      'var(--color-text-secondary)',
  },
  websiteLink: {
    display:    'flex',
    alignItems: 'center',
    gap:        4,
    background: 'transparent',
    border:     'none',
    color:      'var(--color-teal-500)',
    cursor:     'pointer',
    fontSize:   'var(--text-sm)',
    padding:    0,
  },

  // Stats
  statsRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        'var(--space-3)',
    flexShrink: 0,
    flexWrap:   'wrap' as never,
  },
  statChip: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'flex-end',
    padding:       '6px 12px',
    background:    'var(--color-bg-surface)',
    border:        '1px solid var(--color-border)',
    borderRadius:  'var(--radius-md)',
    minWidth:      72,
  },
  statValue: {
    fontSize:   'var(--text-md)',
    fontWeight: 'var(--weight-bold)' as never,
    color:      'var(--color-text-primary)',
    lineHeight: 1.2,
    display:    'flex',
    alignItems: 'center',
    gap:        4,
  },
  statLabel: {
    fontSize: 10,
    color:    'var(--color-text-muted)',
    textTransform: 'uppercase' as never,
    letterSpacing: '0.05em',
    marginTop: 1,
  },
  statSub: {
    fontSize: 10,
    color:    'var(--color-text-muted)',
  },
  driveChip: {
    display:      'flex',
    alignItems:   'center',
    gap:          5,
    padding:      '6px 12px',
    background:   'rgba(86, 183, 163, 0.08)',
    border:       '1px solid rgba(86, 183, 163, 0.3)',
    borderRadius: 'var(--radius-md)',
    color:        'var(--color-teal-500)',
    fontSize:     'var(--text-xs)',
    fontWeight:   'var(--weight-medium)' as never,
    cursor:       'pointer',
  },

  // 3-column layout
  body: {
    display:   'grid',
    gridTemplateColumns: '240px 1fr 240px',
    gap:       0,
    flex:      1,
    overflow:  'hidden',
  },

  // Columns
  leftCol: {
    borderRight:   '1px solid var(--color-border)',
    padding:       'var(--space-4)',
    overflowY:     'auto' as never,
    display:       'flex',
    flexDirection: 'column',
  },
  centerCol: {
    padding:       'var(--space-4)',
    overflowY:     'auto' as never,
    display:       'flex',
    flexDirection: 'column',
  },
  rightCol: {
    borderLeft:    '1px solid var(--color-border)',
    padding:       'var(--space-4)',
    overflowY:     'auto' as never,
    display:       'flex',
    flexDirection: 'column',
  },

  panelLabel: {
    display:       'flex',
    alignItems:    'center',
    fontSize:      10,
    fontWeight:    700 as never,
    color:         'var(--color-text-muted)',
    textTransform: 'uppercase' as never,
    letterSpacing: '0.07em',
    marginBottom:  8,
  },

  // Contacts
  contactList: {
    display:       'flex',
    flexDirection: 'column',
    gap:           'var(--space-2)',
  },
  contactCard: {
    display:       'flex',
    flexDirection: 'column',
    gap:           3,
    padding:       '10px 12px',
    background:    'var(--color-bg-surface)',
    border:        '1px solid var(--color-border)',
    borderRadius:  'var(--radius-md)',
  },
  contactTopRow: {
    display:     'flex',
    alignItems:  'center',
    gap:         6,
    justifyContent: 'space-between',
  },
  contactName: {
    fontSize:   'var(--text-sm)',
    fontWeight: 'var(--weight-semibold)' as never,
    color:      'var(--color-text-primary)',
  },
  contactTitle: {
    fontSize: 11,
    color:    'var(--color-text-muted)',
  },
  rolePill: {
    display:      'inline-flex',
    alignSelf:    'flex-start',
    padding:      '1px 6px',
    borderRadius: 4,
    fontSize:     10,
    fontWeight:   600 as never,
    color:        'var(--color-text-secondary)',
    marginTop:    2,
  },
  contactLinks: {
    display:       'flex',
    flexDirection: 'column',
    gap:           2,
    marginTop:     3,
  },
  contactLink: {
    display:    'flex',
    alignItems: 'center',
    gap:        4,
    fontSize:   11,
    color:      'var(--color-teal-500)',
    textDecoration: 'none',
    overflow:   'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as never,
  },

  // Notes
  notesWrap: { display: 'flex', flexDirection: 'column', gap: 6 },
  notesTitleRow: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
  },
  notesEditBtn: {
    display:    'flex',
    alignItems: 'center',
    gap:        4,
    background: 'transparent',
    border:     'none',
    color:      'var(--color-text-muted)',
    cursor:     'pointer',
    fontSize:   11,
    padding:    0,
  },
  notesTextarea: {
    width:        '100%',
    padding:      8,
    background:   'var(--color-bg-surface)',
    border:       '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    color:        'var(--color-text-primary)',
    fontSize:     12,
    lineHeight:   1.5,
    resize:       'vertical' as never,
    fontFamily:   'inherit',
    outline:      'none',
    boxSizing:    'border-box' as never,
  },
  notesText: {
    fontSize:   12,
    color:      'var(--color-text-secondary)',
    lineHeight: 1.6,
    margin:     0,
    whiteSpace: 'pre-wrap' as never,
  },
  noteCard: {
    display:       'flex',
    flexDirection: 'column',
    gap:           4,
    padding:       '8px 10px',
    background:    'var(--color-bg-surface)',
    border:        '1px solid var(--color-border)',
    borderRadius:  'var(--radius-md)',
  },

  // Action items
  actionItems: {
    display:       'flex',
    flexDirection: 'column',
    gap:           4,
    marginTop:     6,
  },
  actionItem: {
    display:    'flex',
    alignItems: 'flex-start',
    gap:        6,
    fontSize:   12,
    color:      'var(--color-text-secondary)',
    lineHeight: 1.4,
  },

  // Transcripts
  txList: {
    display:       'flex',
    flexDirection: 'column',
    gap:           'var(--space-3)',
    marginTop:     8,
  },
  txCard: {
    display:       'flex',
    flexDirection: 'column',
    gap:           5,
    padding:       '12px 14px',
    background:    'var(--color-bg-card)',
    border:        '1px solid var(--color-border)',
    borderRadius:  'var(--radius-lg)',
  },
  txHeader: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
  },
  txMeta: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
  },
  txDate: {
    fontSize:   11,
    color:      'var(--color-text-muted)',
    fontFamily: 'var(--font-mono)',
  },
  sentimentPill: {
    display:      'flex',
    alignItems:   'center',
    gap:          4,
    fontSize:     10,
    fontWeight:   600 as never,
    border:       '1px solid',
    borderRadius: 20,
    padding:      '1px 7px',
  },
  txExpandBtn: {
    background: 'transparent',
    border:     'none',
    color:      'var(--color-text-muted)',
    cursor:     'pointer',
    padding:    2,
    display:    'flex',
    alignItems: 'center',
  },
  txTitle: {
    fontSize:   'var(--text-sm)',
    fontWeight: 'var(--weight-semibold)' as never,
    color:      'var(--color-text-primary)',
    lineHeight: 1.3,
  },
  txSummary: {
    fontSize:   12,
    color:      'var(--color-text-secondary)',
    margin:     0,
    lineHeight: 1.5,
  },
  txMoreBtn: {
    background: 'transparent',
    border:     'none',
    color:      'var(--color-teal-500)',
    cursor:     'pointer',
    fontSize:   11,
    padding:    '2px 0',
    textAlign:  'left' as never,
  },
  driveLinkBtn: {
    display:      'flex',
    alignItems:   'center',
    gap:          5,
    background:   'transparent',
    border:       'none',
    color:        'var(--color-teal-500)',
    cursor:       'pointer',
    fontSize:     11,
    padding:      '4px 0 0',
    textAlign:    'left' as never,
  },

  // Calendar events
  eventCard: {
    display:       'flex',
    flexDirection: 'column',
    gap:           3,
    padding:       '8px 10px',
    background:    'var(--color-bg-surface)',
    border:        '1px solid var(--color-border)',
    borderRadius:  'var(--radius-md)',
  },
  eventTime: {
    fontSize:   10,
    color:      '#DA5039',
    fontWeight: 700 as never,
    fontFamily: 'var(--font-mono)',
  },
  eventTitle: {
    fontSize:   'var(--text-xs)',
    color:      'var(--color-text-primary)',
    lineHeight: 1.3,
  },
  meetMiniBtn: {
    alignSelf:    'flex-start',
    marginTop:    2,
    padding:      '2px 8px',
    background:   'rgba(86, 183, 163, 0.12)',
    border:       '1px solid rgba(86, 183, 163, 0.3)',
    borderRadius: 4,
    color:        'var(--color-teal-500)',
    fontSize:     10,
    cursor:       'pointer',
  },

  // Knowledge
  knowledgeWrap: {
    display:       'flex',
    flexDirection: 'column',
    flex:          1,
  },
  miniSearchInput: {
    width:        '100%',
    padding:      '5px 8px 5px 26px',
    background:   'var(--color-bg-surface)',
    border:       '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize:     12,
    color:        'var(--color-text-primary)',
    outline:      'none',
    boxSizing:    'border-box' as never,
  },
  knowledgeResults: {
    display:       'flex',
    flexDirection: 'column',
    gap:           'var(--space-2)',
    flex:          1,
    overflowY:     'auto' as never,
  },
  knowledgeItem: {
    display:       'flex',
    flexDirection: 'column',
    gap:           2,
    padding:       '8px 10px',
    background:    'var(--color-bg-surface)',
    border:        '1px solid var(--color-border)',
    borderRadius:  'var(--radius-md)',
    cursor:        'pointer',
    textAlign:     'left' as never,
    alignItems:    'flex-start',
    width:         '100%',
  },
  knowledgeTitle: {
    fontSize:   'var(--text-xs)',
    fontWeight: 'var(--weight-semibold)' as never,
    color:      'var(--color-teal-500)',
    lineHeight: 1.3,
  },
  knowledgeSub: {
    fontSize: 10,
    color:    'var(--color-text-muted)',
  },
  knowledgeSnippet: {
    fontSize:  10,
    color:     'var(--color-text-secondary)',
    lineHeight: 1.4,
    overflow:  'hidden',
    display:   '-webkit-box' as never,
    WebkitLineClamp: 2 as never,
    WebkitBoxOrient: 'vertical' as never,
  },

  // Empty states
  emptyNote: {
    fontSize: 12,
    color:    'var(--color-text-muted)',
    margin:   '4px 0',
    fontStyle: 'italic',
  },
  emptyPanel: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    padding:        '48px 0',
    flex:           1,
  },
}
