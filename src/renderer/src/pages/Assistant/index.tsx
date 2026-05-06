/* Knowledge Assistant — port of prokeep-assistant-v2.1.0
 * Fuzzy search across internal and customer knowledge bases via the search API.
 */

import { useState, useEffect, useMemo } from 'react'
import { Search, ExternalLink, BookOpen, Users } from 'lucide-react'
import { searchApi, fsApi } from '../../lib/ipc'
import { AIPanel } from '../../components/ui'

function ChromeColorIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 12 L12 2 A10 10 0 0 1 20.66 17 Z" fill="#EA4335"/>
      <path d="M12 12 L20.66 17 A10 10 0 0 1 3.34 17 Z" fill="#FBBC05"/>
      <path d="M12 12 L3.34 17 A10 10 0 0 1 12 2 Z" fill="#34A853"/>
      <circle cx="12" cy="12" r="5.5" fill="white"/>
      <circle cx="12" cy="12" r="4" fill="#4285F4"/>
    </svg>
  )
}

interface KbEntry { id: string; title: string; url: string; content: string; section: string | null }

function scoreEntry(e: KbEntry, q: string): number {
  if (!q) return 1
  const query = q.toLowerCase()
  const t = (e.title   || '').toLowerCase()
  const c = (e.content || '').toLowerCase()
  const s = (e.section || '').toLowerCase()
  const terms = query.split(/\s+/).filter(Boolean)
  let score = 0
  for (const term of terms) {
    if (t.includes(term))  score += t === term ? 100 : t.startsWith(term) ? 60 : 30
    if (c.includes(term))  score += 10
    if (s.includes(term))  score += 20
  }
  return score
}

function doSearch(entries: KbEntry[], q: string): KbEntry[] {
  if (!q.trim()) return entries
  return entries.map(e => ({ e, s: scoreEntry(e, q) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.e)
}

function hl(text: string, q: string): React.ReactNode {
  if (!q.trim() || !text) return text
  const terms  = q.trim().split(/\s+/).filter(Boolean)
  const pattern = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return text.split(pattern).map((p, i) =>
    pattern.test(p)
      ? <mark key={i} style={{ background: 'rgba(86,183,163,0.25)', color: 'var(--color-teal-400)', borderRadius: 2, padding: '0 1px' }}>{p}</mark>
      : p
  )
}

function snip(content: string, q: string, len = 120): string {
  if (!q.trim()) return content.slice(0, len) + (content.length > len ? '…' : '')
  const idx = content.toLowerCase().indexOf(q.toLowerCase().split(/\s+/)[0])
  const start = Math.max(0, idx < 0 ? 0 : idx - 30)
  const end   = Math.min(content.length, start + len)
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '')
}

function Card({ entry: e, query }: { entry: KbEntry; query: string }) {
  return (
    <div onClick={() => fsApi.openExternal(e.url)}
      style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}
      onMouseEnter={ev => (ev.currentTarget.style.background = 'var(--color-bg-elevated)')}
      onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)' as never, color: 'var(--color-text-primary)', marginBottom: 2 }}>{hl(e.title, query)}</div>
          {e.section && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-teal-500)', marginBottom: 4 }}>{hl(e.section, query)}</div>}
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>{hl(snip(e.content, query), query)}</div>
        </div>
        <ExternalLink size={13} style={{ flexShrink: 0, color: 'var(--color-text-muted)', marginTop: 2 }} />
      </div>
      <div style={{ fontSize: 9, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.url}</div>
    </div>
  )
}

export function Assistant() {
  const [tab,      setTab]      = useState<'internal' | 'customer'>('internal')
  const [query,    setQuery]    = useState('')
  const [internal, setInternal] = useState<KbEntry[]>([])
  const [customer, setCustomer] = useState<KbEntry[]>([])
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    Promise.all([
      searchApi.query('', 'internal'),
      searchApi.query('', 'customer'),
    ]).then(([ir, cr]) => {
      if (ir.ok) setInternal(ir.data.map(r => ({ id: r.item.id, title: r.item.title, url: r.item.url, content: r.item.content, section: r.item.section })))
      if (cr.ok) setCustomer(cr.data.map(r => ({ id: r.item.id, title: r.item.title, url: r.item.url, content: r.item.content, section: r.item.section })))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const entries  = tab === 'internal' ? internal : customer
  const results  = useMemo(() => doSearch(entries, query), [entries, query])

  const sections = useMemo(() => {
    if (query) return null
    const map = new Map<string, KbEntry[]>()
    for (const e of entries) { const sec = e.section || 'General'; if (!map.has(sec)) map.set(sec, []); map.get(sec)!.push(e) }
    return map
  }, [entries, query])

  return (
    <div className="page animate-fade-in">
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Knowledge Assistant</h1>
          <p className="page-subtitle">Prokeep internal and customer-facing resources</p>
        </div>
        <button
          onClick={() => fsApi.openExternal('https://chromewebstore.google.com/detail/hlagcfdkbahdmmgjmgggpnnheipfnmnj?utm_source=item-share-cb')}
          title="Install Prokeep Knowledge Assistant Chrome Extension"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 14px',
            background: 'transparent',
            border: '1.5px solid #4285F4',
            borderRadius: 'var(--radius-md)',
            color: '#4285F4',
            fontSize: 'var(--text-sm)', fontWeight: 600,
            cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(66,133,244,0.1)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
        >
          <ChromeColorIcon size={18} />
          Install Knowledge Assistant
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 'var(--space-4)', borderBottom: '1px solid var(--color-border)' }}>
        {([['internal','Internal', <BookOpen size={14} />], ['customer','Customer', <Users size={14} />]] as const).map(([key, label, icon]) => (
          <button key={key} onClick={() => { setTab(key as 'internal' | 'customer'); setQuery('') }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', border: 'none', borderBottom: `2px solid ${tab===key?'var(--color-teal-500)':'transparent'}`, background: 'transparent', color: tab===key?'var(--color-teal-500)':'var(--color-text-muted)', fontWeight: 'var(--weight-medium)' as never, fontSize: 'var(--text-sm)', cursor: 'pointer', marginBottom: -1 }}>
            {icon}{label}
            <span style={{ fontSize: 10, background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)', padding: '1px 6px', borderRadius: 'var(--radius-full)', marginLeft: 4 }}>
              {(key === 'internal' ? internal : customer).length}
            </span>
          </button>
        ))}
      </div>

      {/* Search + AI */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 'var(--space-4)' }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 480 }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)' }} />
          <input className="input" style={{ paddingLeft: 36, width: '100%' }}
            placeholder={`Search ${tab} resources…`} value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        {query.trim().length > 2 && (
          <AIPanel
            label="Ask BOB"
            prompt={`A customer success manager is searching the Prokeep knowledge base for: "${query}". Summarize in 2-3 sentences what this feature/topic is and how it helps CSMs in their day-to-day work.`}
            systemPrompt="You are B.O.B., a helpful assistant for Prokeep CSMs. Give a concise, practical answer. Plain text only."
            maxTokens={200}
          />
        )}
      </div>

      {/* Results */}
      <div style={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-muted)' }}>Loading resources…</div>
        ) : query ? (
          results.length === 0
            ? <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--color-text-muted)' }}>No results for "{query}"</div>
            : results.map(e => <Card key={e.id} entry={e} query={query} />)
        ) : sections ? (
          Array.from(sections.entries()).map(([sec, items]) => (
            <div key={sec}>
              <div style={{ padding: 'var(--space-2) var(--space-4)', background: 'var(--color-bg-subtle)', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)' as never, color: 'var(--color-text-secondary)', textTransform: 'uppercase' as never, letterSpacing: '0.06em' }}>
                {sec} · {items.length}
              </div>
              {items.map(e => <Card key={e.id} entry={e} query="" />)}
            </div>
          ))
        ) : null}
      </div>
    </div>
  )
}
