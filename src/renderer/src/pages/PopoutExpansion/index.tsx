/**
 * PopoutExpansion — pop-out window version of the Expansion Opportunities page.
 * No Claude/copy buttons; column visibility toggles for screen sharing.
 */

import { useEffect, useState } from 'react'
import { Eye, EyeOff, RefreshCw } from 'lucide-react'
import { analysisApi } from '../../lib/ipc'

interface BranchStats {
  name: string
  total: number
  sent: number
  received: number
  sentRate: number
  inboundRatio: number
  avgClaimTimeMinutes: number | null
  reps: { name: string; sent: number; shareOfOutbound: number; branch: string }[]
}

interface AnalysisResult {
  accountName: string
  analyzedAt: string
  totalMessages: number
  sentMessages: number
  receivedMessages: number
  sentRate: number
  attachmentCount: number
  attachmentRate: number
  branches: BranchStats[]
  activeBranches: number
  topReps: { name: string; sent: number; shareOfOutbound: number; branch: string }[]
  btmMessageCount: number
  expansionScore: number
  quotes: { totalValue: number; threadCount: number; avg: number; median: number }
  themes: { name: string; count: number; percentage: number }[]
}

function pct(n: number | null | undefined, d = 1): string {
  if (n == null || !isFinite(n)) return '0.' + '0'.repeat(d)
  return (n * 100).toFixed(d)
}

function fmt$(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)    return `$${(v / 1_000).toFixed(1)}k`
  return `$${v.toLocaleString()}`
}

function HBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div style={{ flex: 1, height: 6, background: 'var(--color-bg-elevated)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, (value / max) * 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
    </div>
  )
}

const COLUMNS = [
  { id: 'overview',    label: 'Volume Overview' },
  { id: 'quotes',      label: 'Quote Activity' },
  { id: 'btm',         label: 'BTM Opportunities' },
  { id: 'branches',    label: 'Branch Benchmarks' },
  { id: 'reps',        label: 'Top Reps' },
  { id: 'themes',      label: 'Themes' },
]

const LS_KEY = 'popout-expansion-hidden-cols'
function loadHidden(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')) } catch { return new Set() }
}
function saveHidden(s: Set<string>) { localStorage.setItem(LS_KEY, JSON.stringify([...s])) }

export function PopoutExpansion() {
  const [data,    setData]    = useState<AnalysisResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [hidden,  setHidden]  = useState<Set<string>>(loadHidden)

  async function load() {
    setLoading(true)
    const r = await analysisApi.getLatest()
    if (r.ok && r.data) setData(r.data as AnalysisResult)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function toggleCol(id: string) {
    setHidden(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      saveHidden(next)
      return next
    })
  }

  const show = (id: string) => !hidden.has(id)

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0D1525' }}>
      <RefreshCw size={20} style={{ animation: 'spin 800ms linear infinite', color: 'var(--color-text-muted)' }} />
    </div>
  )

  if (!data) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0D1525', color: 'var(--color-text-muted)', fontSize: 14 }}>
      No analysis data. Run Scrub & Split first.
    </div>
  )

  const analyzedDate = new Date(data.analyzedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0D1525', color: 'var(--color-text-primary)' }}>

      {/* Header */}
      <div style={{ flexShrink: 0, background: 'var(--color-bg-surface)', borderBottom: '1px solid var(--color-border)', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{data.accountName} — Expansion Opportunities</h2>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
            Analyzed {analyzedDate} · Expansion Score: {data.expansionScore}/100
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {COLUMNS.map(col => (
            <button
              key={col.id}
              onClick={() => toggleCol(col.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '4px 10px', borderRadius: 20, fontSize: 11, cursor: 'pointer',
                border: `1px solid ${hidden.has(col.id) ? 'var(--color-border)' : 'var(--color-teal-600)'}`,
                background: hidden.has(col.id) ? 'transparent' : 'rgba(86,183,163,0.1)',
                color: hidden.has(col.id) ? 'var(--color-text-muted)' : 'var(--color-teal-400)',
                fontWeight: hidden.has(col.id) ? 400 : 600,
              }}
            >
              {hidden.has(col.id) ? <EyeOff size={10} /> : <Eye size={10} />}
              {col.label}
            </button>
          ))}
          <button onClick={load} style={{ padding: '4px 8px', borderRadius: 'var(--radius-sm)', background: 'none', border: '1px solid var(--color-border)', cursor: 'pointer', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <RefreshCw size={11} /> Refresh
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>

        {show('overview') && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
            {[
              { label: 'Total Messages',  value: data.totalMessages.toLocaleString() },
              { label: 'Attachment Rate', value: `${pct(data.attachmentRate)}%` },
              { label: 'Active Branches', value: data.activeBranches.toString() },
              { label: 'Expansion Score', value: `${data.expansionScore}/100` },
            ].map(c => (
              <div key={c.label} style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 4 }}>{c.label}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--color-text-primary)' }}>{c.value}</div>
              </div>
            ))}
          </div>
        )}

        {show('quotes') && data.quotes && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Quote Activity</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
              {[
                { label: 'Total Quote Value',  value: fmt$(data.quotes.totalValue) },
                { label: 'Quoting Threads',    value: data.quotes.threadCount.toLocaleString() },
                { label: 'Avg Quote Value',    value: fmt$(data.quotes.avg) },
              ].map(c => (
                <div key={c.label} style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 4 }}>{c.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#34A853' }}>{c.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {show('btm') && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>BTM Opportunities</div>
            <div style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '14px 16px' }}>
              <div style={{ fontSize: 14, color: 'var(--color-text-primary)', fontWeight: 600 }}>
                {data.btmMessageCount.toLocaleString()} BTM messages sent
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                {data.btmMessageCount === 0
                  ? '⚡ No BTM usage detected — strong opportunity to introduce broadcast messaging'
                  : data.btmMessageCount < 50
                  ? '🟡 Low BTM adoption — educate on broadcast use cases to drive engagement'
                  : '✅ Good BTM adoption — consider scaling to more branches'}
              </div>
            </div>
          </div>
        )}

        {show('branches') && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Branch Benchmarks</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 100px', gap: 8, padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <span>Branch</span><span style={{ textAlign: 'right' }}>Total</span><span style={{ textAlign: 'right' }}>Sent</span><span>Outbound %</span>
              </div>
              {data.branches.slice(0, 5).map((b, i) => (
                <div key={b.name} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 100px', gap: 8, padding: '9px 12px', borderRadius: 'var(--radius-md)', background: i % 2 === 0 ? 'var(--color-bg-card)' : 'transparent', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{b.name}</span>
                  <span style={{ fontSize: 13, textAlign: 'right', color: 'var(--color-text-secondary)' }}>{b.total.toLocaleString()}</span>
                  <span style={{ fontSize: 13, textAlign: 'right', color: 'var(--color-teal-400)' }}>{b.sent.toLocaleString()}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <HBar value={(b.sentRate ?? 0) * 100} max={100} color={(b.sentRate ?? 0) >= 0.40 ? '#469C6C' : '#F4B74E'} />
                    <span style={{ fontSize: 10, color: 'var(--color-text-muted)', width: 30, flexShrink: 0 }}>{((b.sentRate ?? 0) * 100).toFixed(0)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {show('reps') && data.topReps.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Top Reps</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {data.topReps.slice(0, 8).map((rep, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 70px 80px', gap: 8, padding: '7px 12px', borderRadius: 'var(--radius-md)', background: i % 2 === 0 ? 'var(--color-bg-card)' : 'transparent', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{rep.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{rep.branch}</span>
                  <span style={{ fontSize: 13, textAlign: 'right', color: 'var(--color-teal-400)' }}>{rep.sent.toLocaleString()}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                    <HBar value={(rep.shareOfOutbound ?? 0) * 100} max={100} color="var(--color-teal-600)" />
                    <span style={{ fontSize: 10, color: 'var(--color-text-muted)', width: 30, flexShrink: 0 }}>{pct(rep.shareOfOutbound)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {show('themes') && data.themes.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Conversation Themes</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {data.themes.slice(0, 12).map(t => (
                <div key={t.name} style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '8px 12px', textAlign: 'center', minWidth: 90 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-teal-400)' }}>{t.count.toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>{t.name}</div>
                  <div style={{ fontSize: 9, color: 'var(--color-text-muted)', marginTop: 1 }}>{t.percentage.toFixed(1)}%</div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
