/**
 * PopoutRisk — pop-out window version of the Risk Analysis page.
 * Designed for sharing in Google Meet: no Claude/copy buttons,
 * column visibility toggles to hide sensitive metrics.
 */

import { useEffect, useState } from 'react'
import { Eye, EyeOff, RefreshCw } from 'lucide-react'
import { analysisApi } from '../../lib/ipc'

// ─── Types (mirrored from AnalysisService) ────────────────────────────────────

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

interface MonthlyPoint {
  label: string
  yearMonth: string
  count: number
  change: number | null
}

interface RiskFlag {
  severity: 'critical' | 'high' | 'medium'
  title: string
  description: string
  branch?: string
  metric?: string
}

interface AnalysisResult {
  accountName: string
  analyzedAt: string
  totalMessages: number
  sentMessages: number
  receivedMessages: number
  sentRate: number
  spamCount: number
  realMessages: number
  attachmentCount: number
  attachmentRate: number
  branches: BranchStats[]
  activeBranches: number
  topReps: { name: string; sent: number; shareOfOutbound: number; branch: string }[]
  monthlyTrend: MonthlyPoint[]
  avgClaimTimeMinutes: number | null
  btmMessageCount: number
  riskFlags: RiskFlag[]
  riskScore: number
  expansionScore: number
  dateRange: { start: string; end: string }
  themes: { name: string; count: number; percentage: number }[]
  quotes: { totalValue: number; threadCount: number; avg: number; median: number }
}

function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return '0.' + '0'.repeat(digits)
  return ((n) * 100).toFixed(digits)
}
function fix0(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '0'
  return (n).toFixed(0)
}

// ─── Visible columns config ───────────────────────────────────────────────────

const COLUMNS = [
  { id: 'overview',   label: 'Volume Overview' },
  { id: 'riskFlags',  label: 'Risk Flags' },
  { id: 'branches',   label: 'Branch Performance' },
  { id: 'reps',       label: 'Top Reps' },
  { id: 'trend',      label: 'Monthly Trend' },
]

const LS_KEY = 'popout-risk-hidden-cols'

function loadHidden(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')) } catch { return new Set() }
}
function saveHidden(s: Set<string>) { localStorage.setItem(LS_KEY, JSON.stringify([...s])) }

// ─── Mini horizontal bar ──────────────────────────────────────────────────────

function HBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div style={{ flex: 1, height: 6, background: 'var(--color-bg-elevated)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, (value / max) * 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
    </div>
  )
}

function SeverityBadge({ severity }: { severity: RiskFlag['severity'] }) {
  const map = {
    critical: { bg: 'rgba(218,80,57,0.15)', color: '#DA5039', label: 'CRITICAL' },
    high:     { bg: 'rgba(244,183,78,0.15)', color: '#F4B74E', label: 'HIGH' },
    medium:   { bg: 'rgba(99,102,241,0.15)', color: '#818CF8', label: 'MEDIUM' },
  }
  const s = map[severity]
  return (
    <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: s.bg, color: s.color, letterSpacing: '0.08em' }}>
      {s.label}
    </span>
  )
}

// ─── Mini SVG bar chart ───────────────────────────────────────────────────────

function BarChart({ data }: { data: MonthlyPoint[] }) {
  if (data.length === 0) return null
  const maxVal = Math.max(...data.map(d => d.count), 1)
  const barW   = Math.max(12, Math.min(40, Math.floor(560 / data.length) - 4))
  const chartH = 100
  const chartW = data.length * (barW + 4)

  return (
    <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
      <svg width={chartW} height={chartH + 30} style={{ display: 'block' }}>
        {data.map((d, i) => {
          const barH = Math.max(2, Math.round((d.count / maxVal) * chartH))
          const x    = i * (barW + 4)
          const y    = chartH - barH
          const isUp  = d.change != null && d.change > 0
          const isDown = d.change != null && d.change < 0
          const color = isDown ? '#DA5039' : isUp ? '#34A853' : '#56B7A3'
          return (
            <g key={d.yearMonth}>
              <rect x={x} y={y} width={barW} height={barH} rx={2} fill={color} opacity={0.85} />
              <text x={x + barW / 2} y={chartH + 12} textAnchor="middle" fontSize={8} fill="var(--color-text-muted)">
                {d.label.slice(0, 3)}
              </text>
              <text x={x + barW / 2} y={chartH + 22} textAnchor="middle" fontSize={7} fill="var(--color-text-muted)">
                {d.yearMonth.slice(2)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PopoutRisk() {
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
      No analysis data available. Run Scrub & Split first.
    </div>
  )

  const analyzedDate = new Date(data.analyzedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0D1525', color: 'var(--color-text-primary)' }}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0, background: 'var(--color-bg-surface)', borderBottom: '1px solid var(--color-border)', padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{data.accountName} — Risk Analysis</h2>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
            Analyzed {analyzedDate} · {data.totalMessages.toLocaleString()} messages · {data.activeBranches} branches
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {COLUMNS.map(col => (
            <button
              key={col.id}
              onClick={() => toggleCol(col.id)}
              title={hidden.has(col.id) ? `Show ${col.label}` : `Hide ${col.label}`}
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

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>

        {/* Volume Overview */}
        {show('overview') && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
            {[
              { label: 'Total Messages', value: data.totalMessages.toLocaleString() },
              { label: 'Staff Sent',     value: `${data.sentMessages.toLocaleString()} (${pct(data.sentRate)}%)` },
              { label: 'Customer Reply', value: `${data.receivedMessages.toLocaleString()} (${pct(1 - (data.sentRate ?? 0))}%)` },
              { label: 'Attachment Rate',value: `${pct(data.attachmentRate)}%` },
            ].map(c => (
              <div key={c.label} style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 4 }}>{c.label}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--color-text-primary)' }}>{c.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Risk Flags */}
        {show('riskFlags') && data.riskFlags.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Risk Flags</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.riskFlags.map((flag, i) => (
                <div key={i} style={{
                  padding: '12px 14px', borderRadius: 'var(--radius-md)',
                  background: flag.severity === 'critical' ? 'rgba(218,80,57,0.06)' : flag.severity === 'high' ? 'rgba(244,183,78,0.06)' : 'var(--color-bg-card)',
                  border: `1px solid ${flag.severity === 'critical' ? 'rgba(218,80,57,0.25)' : flag.severity === 'high' ? 'rgba(244,183,78,0.25)' : 'var(--color-border)'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <SeverityBadge severity={flag.severity} />
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{flag.title}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{flag.description}</div>
                  {flag.metric && <div style={{ marginTop: 6, fontSize: 10, fontWeight: 600, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>{flag.metric}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Branch Performance */}
        {show('branches') && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Branch Performance</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 120px', gap: 8, padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <span>Branch</span><span style={{ textAlign: 'right' }}>Total</span><span style={{ textAlign: 'right' }}>Sent</span><span style={{ textAlign: 'right' }}>Recv</span><span>Outbound %</span>
              </div>
              {data.branches.slice(0, 5).map((branch, i) => {
                const isRisk = branch.inboundRatio > 4 || branch.sentRate < 0.25
                return (
                  <div key={branch.name} style={{
                    display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 120px', gap: 8,
                    padding: '9px 12px', borderRadius: 'var(--radius-md)',
                    background: i % 2 === 0 ? 'var(--color-bg-card)' : 'transparent',
                    border: isRisk ? '1px solid rgba(218,80,57,0.15)' : '1px solid transparent',
                    alignItems: 'center',
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                      {branch.name}{isRisk && <span style={{ marginLeft: 6, fontSize: 9, color: '#DA5039' }}>⚠</span>}
                    </span>
                    <span style={{ fontSize: 13, textAlign: 'right', color: 'var(--color-text-secondary)' }}>{branch.total.toLocaleString()}</span>
                    <span style={{ fontSize: 13, textAlign: 'right', color: 'var(--color-teal-400)' }}>{branch.sent.toLocaleString()}</span>
                    <span style={{ fontSize: 13, textAlign: 'right', color: 'var(--color-text-muted)' }}>{branch.received.toLocaleString()}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <HBar value={(branch.sentRate ?? 0) * 100} max={100} color={(branch.sentRate ?? 0) >= 0.40 ? '#469C6C' : (branch.sentRate ?? 0) < 0.20 ? '#DA5039' : '#F4B74E'} />
                      <span style={{ fontSize: 10, color: 'var(--color-text-muted)', width: 32, flexShrink: 0 }}>{fix0((branch.sentRate ?? 0) * 100)}%</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Top Reps */}
        {show('reps') && data.topReps.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Top Reps</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 70px 80px', gap: 8, padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <span>Rep</span><span>Branch</span><span style={{ textAlign: 'right' }}>Sent</span><span style={{ textAlign: 'right' }}>Share</span>
              </div>
              {data.topReps.slice(0, 8).map((rep, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 70px 80px', gap: 8, padding: '7px 12px', borderRadius: 'var(--radius-md)', background: i % 2 === 0 ? 'var(--color-bg-card)' : 'transparent', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{rep.name}</span>
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

        {/* Monthly Trend */}
        {show('trend') && data.monthlyTrend.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Monthly Trend</div>
            <div style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '14px 16px' }}>
              <BarChart data={data.monthlyTrend} />
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
