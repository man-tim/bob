/**
 * Risk Analysis page — powered by AnalysisService local algorithms.
 * Displays risk flags, branch health, monthly trend, and rep engagement
 * based on the most recent Blueprint Messages CSV run through Scrub & Split.
 */

import { useEffect, useState } from 'react'
import { ShieldAlert, RefreshCw, Scissors, Copy, ExternalLink, Maximize2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { analysisApi, push, scrubApi, fsApi, analysisPopoutApi } from '../../lib/ipc'
import { AIPanel } from '../../components/ui'

// ─── Risk Assessment prompt (matches Prompt Library) ─────────────────────────

const RISK_PROMPT = `Analyze [ACCOUNT NAME]'s messaging data with the sole objective of identifying at-risk companies, branches, and locations within the book of business.
Produce a Risk Assessment Report that:

1. Identifies At-Risk Entities
• List all companies, branches, and locations considered at risk
• Assign a risk level (High / Medium / Low) to each
• Clearly include the location/branch name for every flagged item

2. Explains Risk Drivers
For each at-risk entity, specify the exact reasons, such as:
• Declining or low message volume
• Poor response/engagement rates
• Rep inactivity or inconsistency
• Low or absent quote activity
• Sudden drops or abnormal usage patterns

3. Quote-Based Risk Signals
• Identify entities with low, declining, or no quote activity
• Include total $ value of legitimate quotes discussed (ignore spam)
• Highlight where messaging is not translating into revenue conversations

4. Rep-Level Risk Contribution
• Identify reps contributing to risk (low activity, poor engagement, missed opportunities)
• Map reps to the specific branches/locations they impact

5. Prioritized Risk Summary
• Rank the top at-risk companies and locations
• Call out the most urgent risks requiring action
• Briefly note potential causes (adoption issue, behavior issue, or business decline)

Do not include general usage summaries or trend reports unless they directly support a risk conclusion. Focus only on actionable risk identification and explanation.`

// ─── Shared types (mirrored from AnalysisService) ────────────────────────────

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
  btmHasRealContent: boolean
  riskFlags: RiskFlag[]
  riskScore: number
  expansionScore: number
  dateRange: { start: string; end: string }
  themes: { name: string; count: number; percentage: number }[]
  quotes: { totalValue: number; threadCount: number; avg: number; median: number }
}

// ─── AI prompt builders ───────────────────────────────────────────────────────

function buildRiskPrompt(d: AnalysisResult): string {
  const flags = d.riskFlags.slice(0, 5).map(f => `${f.severity.toUpperCase()}: ${f.description}`).join('; ')
  const sentPct = ((d.sentRate ?? 0) * 100).toFixed(0)
  const topBranch = d.branches[0]
  return [
    `Account: ${d.accountName}`,
    `Risk Score: ${d.riskScore}/100 (higher = more risk)`,
    `Messages: ${d.totalMessages} total, ${sentPct}% outbound`,
    `Active Branches: ${d.activeBranches}`,
    flags ? `Risk Flags: ${flags}` : null,
    topBranch ? `Lowest branch outbound rate: ${((topBranch.sentRate ?? 0) * 100).toFixed(0)}% (${topBranch.name})` : null,
  ].filter(Boolean).join('\n')
}

// ─── Safe number helpers ──────────────────────────────────────────────────────

/** Safely call toFixed — returns '0' if value is null/undefined/NaN/Infinity */
function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return '0.' + '0'.repeat(digits)
  return ((n) * 100).toFixed(digits)
}
function fix(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return '0.' + '0'.repeat(digits)
  return (n).toFixed(digits)
}
function fix0(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '0'
  return (n).toFixed(0)
}

// ─── Mini SVG bar chart ───────────────────────────────────────────────────────

function BarChart({ data }: { data: MonthlyPoint[] }) {
  if (data.length === 0) return null
  const maxVal = Math.max(...data.map(d => d.count), 1)
  const barW   = Math.max(12, Math.min(40, Math.floor(560 / data.length) - 4))
  const chartH = 120
  const chartW = data.length * (barW + 4)

  return (
    <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
      <svg width={chartW} height={chartH + 36} style={{ display: 'block' }}>
        {data.map((d, i) => {
          const barH  = Math.max(2, Math.round((d.count / maxVal) * chartH))
          const x     = i * (barW + 4)
          const y     = chartH - barH
          const isDip = d.change !== null && d.change < -40
          const isPeak= d.count === maxVal && d.count > 0
          const fill  = isDip ? '#DA5039' : isPeak ? '#56B7A3' : '#2A7991'
          return (
            <g key={d.yearMonth}>
              <title>{d.label}: {d.count} messages{d.change !== null ? ` (${(d.change ?? 0) > 0 ? '+' : ''}${fix0(d.change)}%)` : ''}</title>
              <rect x={x} y={y} width={barW} height={barH} rx={2} fill={fill} opacity={0.85} />
              {/* Count label on hover via title */}
              <text x={x + barW / 2} y={chartH + 14} textAnchor="middle" fontSize={8} fill="#64748b" transform={`rotate(-45, ${x + barW / 2}, ${chartH + 14})`}>
                {d.label}
              </text>
              {isDip && (
                <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontSize={8} fill="#DA5039">▼</text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ─── Horizontal mini bar ──────────────────────────────────────────────────────

function HBar({ value, max, color = '#2A7991' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div style={{ height: 6, background: 'var(--color-bg-elevated)', borderRadius: 3, overflow: 'hidden', flex: 1 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
    </div>
  )
}

// ─── Risk severity badge ──────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  const cfg = {
    critical: { bg: 'rgba(218,80,57,0.12)', color: '#DA5039', label: 'CRITICAL' },
    high:     { bg: 'rgba(244,183,78,0.12)', color: '#F4B74E', label: 'HIGH' },
    medium:   { bg: 'rgba(100,116,139,0.12)', color: '#94a3b8', label: 'MEDIUM' },
  }[severity] ?? { bg: 'rgba(100,116,139,0.12)', color: '#94a3b8', label: severity.toUpperCase() }
  return (
    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', background: cfg.bg, color: cfg.color }}>
      {cfg.label}
    </span>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function RiskPage() {
  const navigate = useNavigate()
  const [data,        setData]        = useState<AnalysisResult | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [outputFiles, setOutputFiles] = useState<string[]>([])
  const [copied,      setCopied]      = useState<'files' | 'prompt' | null>(null)

  // Load the latest scrub job's output files for the "Copy Scrubbed Files" button
  async function loadOutputFiles() {
    try {
      const r = await scrubApi.listJobs()
      if (r.ok && r.data.length > 0) {
        const latest = r.data.find(j => j.status === 'exported' && j.output_files)
        if (latest?.output_files) {
          const paths: string[] = JSON.parse(latest.output_files)
          setOutputFiles(paths)
        }
      }
    } catch { /* ignore */ }
  }

  function handleCopyFiles() {
    if (outputFiles.length === 0) return
    navigator.clipboard.writeText(outputFiles.join('\n'))
    setCopied('files')
    setTimeout(() => setCopied(null), 2000)
  }

  function handleCopyPrompt() {
    navigator.clipboard.writeText(RISK_PROMPT)
    setCopied('prompt')
    setTimeout(() => setCopied(null), 2000)
  }

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const r = await analysisApi.getLatest()
      if (r.ok && r.data) {
        const d = r.data as AnalysisResult
        // Reject stale DB rows from old schema versions that are missing key fields
        if (!d.accountName || d.totalMessages === undefined || !Array.isArray(d.branches)) {
          setData(null)
        } else {
          setData(d)
        }
      } else {
        setData(null)
      }
    } catch {
      setError('Failed to load analysis data')
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    loadOutputFiles()
    // Auto-refresh when a new analysis completes (Scrub & Split ran)
    const unsub = push.onAnalysisDone(result => {
      setData(result as AnalysisResult)
      setLoading(false)
      setError(null)
      loadOutputFiles()
    })
    return () => { unsub() }
  }, [])

  if (loading) return (
    <div className="page animate-fade-in" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <RefreshCw size={20} style={{ animation: 'spin 800ms linear infinite', color: 'var(--color-text-muted)' }} />
    </div>
  )

  if (!data) return (
    <div className="page animate-fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, textAlign: 'center', padding: 40 }}>
      <ShieldAlert size={48} strokeWidth={1.5} style={{ color: 'var(--color-text-muted)' }} />
      <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--color-text-primary)' }}>No analysis data yet</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', maxWidth: 360, lineHeight: 1.6 }}>
        Upload a Blueprint Messages CSV through Scrub & Split — the Risk analysis will automatically appear here once processing completes.
      </div>
      <button onClick={() => navigate('/scrub')} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--color-teal-600)', border: 'none', borderRadius: 'var(--radius-md)', color: 'white', fontSize: 'var(--text-sm)', fontWeight: 600, cursor: 'pointer' }}>
        <Scissors size={14} />
        Go to Scrub & Split
      </button>
    </div>
  )

  if (error) return (
    <div className="page animate-fade-in" style={{ padding: 32, color: '#DA5039' }}>{error}</div>
  )

  const analyzedDate = new Date(data.analyzedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const btnBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', borderRadius: 'var(--radius-md)', border: 'none',
    fontFamily: 'inherit', fontSize: 'var(--text-sm)', fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap' as const,
  }

  return (
    <div className="page animate-fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0, background: 'var(--color-bg-surface)', borderBottom: '1px solid var(--color-border)', padding: '12px 20px' }}>

        {/* Company name row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: 'var(--color-text-primary)', margin: 0 }}>{data.accountName}</h2>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <AIPanel
              label="AI Risk Narrative"
              prompt={buildRiskPrompt(data)}
              systemPrompt="You are a customer success analyst. Given the following risk metrics, write a 2-3 sentence plain-language risk narrative explaining the key concerns and what a CSM should do next. No markdown, no bullet points."
            />
            <button onClick={() => analysisPopoutApi.open('risk')} title="Pop out for screen sharing" style={{ background: 'none', border: '1px solid var(--color-teal-700)', borderRadius: 'var(--radius-md)', padding: '5px 8px', cursor: 'pointer', color: 'var(--color-teal-400)', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              <Maximize2 size={12} /> Pop Out
            </button>
            <button onClick={load} title="Refresh" style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '5px 8px', cursor: 'pointer', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>

        {/* Snapshot notice */}
        <div style={{ textAlign: 'center', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
          This is a <strong>Snapshot</strong> of activity based strictly on text analysis. For more in-depth observations, please use AI!
        </div>

        {/* 4 action buttons */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={handleCopyFiles} disabled={outputFiles.length === 0}
            style={{ ...btnBase, background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', color: outputFiles.length === 0 ? 'var(--color-text-muted)' : 'var(--color-text-primary)' }}>
            <Copy size={13} />
            {copied === 'files' ? 'Copied!' : '1. Copy Scrubbed Files'}
          </button>
          <button onClick={handleCopyPrompt}
            style={{ ...btnBase, background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}>
            <Copy size={13} />
            {copied === 'prompt' ? 'Copied!' : '2. Copy Prompt'}
          </button>
          <button onClick={() => fsApi.openExternal('https://claude.ai/')}
            style={{ ...btnBase, background: '#FF6B2C', color: '#fff' }}>
            <ExternalLink size={13} />
            3. Open Claude in Browser
          </button>
          <button onClick={() => fsApi.openExternal('claude://')}
            style={{ ...btnBase, background: '#FF6B2C', color: '#fff' }}>
            <ExternalLink size={13} />
            Open Claude in App
          </button>
        </div>
      </div>

      {/* ── Scrollable content ───────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-5)' }}>

      {/* Analyzed meta */}
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginBottom: 16 }}>
        Analyzed {analyzedDate} · {data.totalMessages.toLocaleString()} real messages · {data.activeBranches} active branch{data.activeBranches !== 1 ? 'es' : ''}
      </div>

      {/* Volume overview cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: 'Total Messages', value: data.totalMessages.toLocaleString(), sub: 'post-filter' },
          { label: 'Staff Sent', value: data.sentMessages.toLocaleString(), sub: `${pct(data.sentRate)}% of total` },
          { label: 'Customer Inbound', value: data.receivedMessages.toLocaleString(), sub: `${pct(1 - (data.sentRate ?? 0))}% of total` },
          { label: 'Attachment Rate', value: `${pct(data.attachmentRate)}%`, sub: `${data.attachmentCount} messages` },
        ].map(card => (
          <div key={card.label} style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginBottom: 4 }}>{card.label}</div>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: 'var(--color-text-primary)' }}>{card.value}</div>
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>{card.sub}</div>
          </div>
        ))}
      </div>

      {/* Risk flags */}
      {data.riskFlags.length > 0 && (
        <Section title="Risk Flags" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.riskFlags.slice(0, 5).map((flag, i) => (
              <div key={i} style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                background: flag.severity === 'critical' ? 'rgba(218,80,57,0.06)' : flag.severity === 'high' ? 'rgba(244,183,78,0.06)' : 'var(--color-bg-card)',
                border: `1px solid ${flag.severity === 'critical' ? 'rgba(218,80,57,0.25)' : flag.severity === 'high' ? 'rgba(244,183,78,0.25)' : 'var(--color-border)'}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <SeverityBadge severity={flag.severity} />
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}>{flag.title}</span>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{flag.description}</div>
                {flag.metric && (
                  <div style={{ marginTop: 6, fontSize: 10, fontWeight: 600, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>{flag.metric}</div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Branch performance */}
      <Section title="Branch Performance" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {/* Header row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 120px 120px', gap: 8, padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <span>Branch</span><span style={{ textAlign: 'right' }}>Total</span><span style={{ textAlign: 'right' }}>Sent</span><span style={{ textAlign: 'right' }}>Received</span><span>Outbound %</span><span>Inbound %</span>
          </div>
          {data.branches.slice(0, 5).map((branch, i) => {
            const isRisk = branch.inboundRatio > 4 || (branch.sent / (data.monthlyTrend.length || 1)) < 2
            const inboundPct = (1 - (branch.sentRate ?? 0)) * 100
            const inboundColor = inboundPct > 80 ? '#DA5039' : inboundPct > 60 ? '#F4B74E' : 'var(--color-text-muted)'
            return (
              <div key={branch.name} style={{
                display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 120px 120px', gap: 8,
                padding: '10px 12px', borderRadius: 'var(--radius-md)',
                background: i % 2 === 0 ? 'var(--color-bg-card)' : 'transparent',
                border: isRisk ? '1px solid rgba(218,80,57,0.15)' : '1px solid transparent',
                alignItems: 'center',
              }}>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  {branch.name}
                  {isRisk && <span style={{ marginLeft: 6, fontSize: 9, color: '#DA5039', fontWeight: 700 }}>⚠</span>}
                </span>
                <span style={{ fontSize: 'var(--text-sm)', textAlign: 'right', color: 'var(--color-text-secondary)' }}>{branch.total.toLocaleString()}</span>
                <span style={{ fontSize: 'var(--text-sm)', textAlign: 'right', color: 'var(--color-teal-400)' }}>{branch.sent.toLocaleString()}</span>
                <span style={{ fontSize: 'var(--text-sm)', textAlign: 'right', color: 'var(--color-text-muted)' }}>{branch.received.toLocaleString()}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <HBar value={(branch.sentRate ?? 0) * 100} max={100} color={(branch.sentRate ?? 0) >= 0.40 ? '#469C6C' : (branch.sentRate ?? 0) < 0.20 ? '#DA5039' : '#F4B74E'} />
                  <span style={{ fontSize: 10, color: 'var(--color-text-muted)', width: 32, flexShrink: 0 }}>{fix0((branch.sentRate ?? 0) * 100)}%</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <HBar value={inboundPct} max={100} color={inboundPct > 80 ? '#DA5039' : inboundPct > 60 ? '#F4B74E' : 'var(--color-bg-elevated)'} />
                  <span style={{ fontSize: 10, color: inboundColor, width: 32, flexShrink: 0 }}>{fix0(inboundPct)}%</span>
                </div>
              </div>
            )
          })}
        </div>

        {/* Response time */}
        {data.avgClaimTimeMinutes !== null && (
          <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--color-bg-elevated)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
            <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>Avg Claim Time:</span>{' '}
            {data.avgClaimTimeMinutes < 60
              ? `${data.avgClaimTimeMinutes} minutes`
              : `${fix(data.avgClaimTimeMinutes / 60)} hours`}
            {' '}— {data.avgClaimTimeMinutes < 15 ? '✅ Fast response rate' : data.avgClaimTimeMinutes < 120 ? '🟡 Moderate response time' : '⚠️ Slow claim time — review staffing coverage'}
          </div>
        )}
      </Section>

      {/* Monthly trend */}
      <Section title="Monthly Message Trend" style={{ marginBottom: 20 }}>
        <div style={{ marginBottom: 6 }}>
          <BarChart data={data.monthlyTrend} />
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--color-text-muted)', flexWrap: 'wrap' }}>
          <span><span style={{ color: '#56B7A3', fontWeight: 700 }}>■</span> Peak month</span>
          <span><span style={{ color: '#2A7991', fontWeight: 700 }}>■</span> Normal month</span>
          <span><span style={{ color: '#DA5039', fontWeight: 700 }}>■</span> Significant dip (&gt;40% drop)</span>
        </div>
      </Section>

      {/* Top reps */}
      {data.topReps.length > 0 && (
        <Section title="Rep Engagement" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.topReps.slice(0, 8).map((rep, i) => (
              <div key={rep.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                <span style={{ width: 18, fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0, textAlign: 'right' }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rep.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0, marginLeft: 8 }}>{rep.sent} sent · {pct(rep.shareOfOutbound)}%</span>
                  </div>
                  <HBar value={rep.sent} max={data.topReps[0]?.sent || 1} color="#2A7991" />
                </div>
                <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0, width: 60, textAlign: 'right' }}>{rep.branch}</span>
              </div>
            ))}
          </div>
          {/* Single-rep dominance warning */}
          {data.topReps[0] && data.topReps[0].shareOfOutbound > 0.40 && (
            <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(244,183,78,0.08)', border: '1px solid rgba(244,183,78,0.2)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-xs)', color: '#F4B74E' }}>
              ⚠️ <strong>{data.topReps[0].name}</strong> accounts for {fix0(data.topReps[0].shareOfOutbound)}% of all outbound — heavy key-person dependency risk.
            </div>
          )}
        </Section>
      )}

      {/* Conversation themes */}
      {data.themes.length > 0 && (
        <Section title="Conversation Themes" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.themes.filter(t => t.count > 0).map(theme => (
              <div key={theme.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 180, fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', flexShrink: 0 }}>{theme.name}</span>
                <HBar value={theme.count} max={data.themes[0]?.count || 1} color="#56B7A3" />
                <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0, width: 60, textAlign: 'right' }}>{theme.count} ({fix(theme.percentage)}%)</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      </div>{/* end scrollable content */}
    </div>
  )
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', ...style }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
        {title}
      </div>
      <div style={{ padding: '14px' }}>
        {children}
      </div>
    </div>
  )
}
