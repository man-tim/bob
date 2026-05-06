/**
 * Expansion Opportunities page — powered by AnalysisService local algorithms.
 * Displays expansion signals, location gaps, quote facilitation, BTM opportunities,
 * and branch benchmarks based on the most recent Blueprint Messages CSV.
 */

import { useEffect, useState } from 'react'
import { TrendingUp, RefreshCw, Scissors, CheckCircle, AlertCircle, Copy, ExternalLink, Maximize2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { analysisApi, push, scrubApi, fsApi, analysisPopoutApi } from '../../lib/ipc'
import { useCompaniesStore } from '../../store/companies.store'
import { AIPanel } from '../../components/ui'

// ─── Expansion Assessment prompt (matches Prompt Library) ────────────────────

const EXPANSION_PROMPT = `Analyze [ACCOUNT NAME]'s messaging data with the sole objective of identifying expansion opportunities within the book of business, including companies that are strong candidates for adding branches, increasing adoption, or upgrading their plan.
Produce an Expansion Opportunity Report that includes:

1. High-Potential Companies for Expansion
• Identify companies that show strong engagement and are candidates to:
  ○ Add additional branches/locations
  ○ Expand usage across more teams or users
  ○ Upgrade to a higher-tier plan
• Include the company name and associated locations/branches
• Assign an expansion potential level (High / Medium / Low)

2. Expansion Signals & Justification
For each company, explain why it is a strong expansion candidate using signals such as:
• High or consistently growing message volume
• Strong engagement (active conversations, responsiveness)
• High attachment usage or workflow adoption
• Consistent quote activity and dollar volume
• Concentrated usage in one branch that could be replicated elsewhere
• Evidence of unmet demand (e.g., heavy usage by a few reps, overflow patterns)

3. Branch & Location Expansion Opportunities
• Identify companies where:
  ○ Only some locations are active while others are underutilized or inactive
  ○ A single high-performing branch indicates potential rollout to additional locations
• Call out specific locations that could be added or activated

4. Plan Upgrade Opportunities
• Highlight companies likely to benefit from a plan upgrade based on:
  ○ Usage nearing limits or scaling rapidly
  ○ Advanced feature adoption (attachments, BTM, etc.)
  ○ High volume of revenue-generating conversations (quotes)

5. Revenue Expansion Signals
• Estimate total $ value of quotes facilitated through messaging (ignore spam)
• Identify companies where messaging is clearly driving revenue and could justify deeper investment

6. Prioritized Expansion Targets
• Rank the top companies and locations for expansion
• For each, recommend a specific action:
  ○ Add X branches
  ○ Roll out to additional teams
  ○ Upgrade plan tier
• Focus on the highest-impact opportunities first

Do not include general usage summaries unless they directly support an expansion recommendation. Focus only on identifying and justifying growth opportunities.`

// ─── Shared types ─────────────────────────────────────────────────────────────

interface BranchStats {
  name: string
  total: number
  sent: number
  received: number
  sentRate: number
  inboundRatio: number
  reps: { name: string; sent: number; shareOfOutbound: number; branch: string }[]
}

interface ExpansionSignal {
  title: string
  description: string
  metric?: string
  score: number
  positive: boolean
}

interface QuoteStats {
  totalValue: number
  threadCount: number
  avg: number
  median: number
  top10: Array<{ amount: number; preview: string }>
}

interface AnalysisResult {
  accountName: string
  analyzedAt: string
  totalMessages: number
  sentMessages: number
  sentRate: number
  attachmentRate: number
  attachmentCount: number
  branches: BranchStats[]
  activeBranches: number
  quotes: QuoteStats
  btmHasRealContent: boolean
  btmMessageCount: number
  expansionSignals: ExpansionSignal[]
  expansionScore: number
  riskScore: number
  dateRange: { start: string; end: string }
}

// ─── AI prompt builders ───────────────────────────────────────────────────────

function buildExpansionPrompt(d: AnalysisResult): string {
  const sentPct   = ((d.sentRate ?? 0) * 100).toFixed(0)
  const topBranch = d.branches[0]
  const signals   = (d.expansionSignals ?? []).slice(0, 4).map(s => s.description ?? String(s)).join('; ')
  return [
    `Account: ${d.accountName}`,
    `Expansion Score: ${d.expansionScore}/100`,
    `Total Messages: ${d.totalMessages}, ${sentPct}% outbound`,
    `Active Branches: ${d.activeBranches}`,
    d.quotes?.totalValue ? `Quote Activity: $${d.quotes.totalValue.toLocaleString()} total, ${d.quotes.threadCount} threads` : null,
    d.btmMessageCount > 0 ? `BTM (Broadcast) messages: ${d.btmMessageCount}` : 'No BTM adoption yet — opportunity',
    topBranch ? `Top branch: ${topBranch.name} (${topBranch.total} messages)` : null,
    signals ? `Expansion signals: ${signals}` : null,
  ].filter(Boolean).join('\n')
}

// ─── Expansion score gauge ────────────────────────────────────────────────────

function ExpansionGauge({ score }: { score: number }) {
  const color = score >= 70 ? '#469C6C' : score >= 40 ? '#56B7A3' : '#F4B74E'
  const label = score >= 70 ? 'Strong Opportunity' : score >= 40 ? 'Moderate Opportunity' : 'Limited Signals'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 20px', background: 'var(--color-bg-card)', borderRadius: 'var(--radius-lg)', border: `1px solid ${color}40` }}>
      <div style={{ position: 'relative', width: 72, height: 72, flexShrink: 0 }}>
        <svg viewBox="0 0 72 72" width={72} height={72}>
          <circle cx={36} cy={36} r={30} fill="none" stroke="var(--color-bg-elevated)" strokeWidth={8} />
          <circle cx={36} cy={36} r={30} fill="none" stroke={color} strokeWidth={8}
            strokeDasharray={`${(score / 100) * 188.5} 188.5`}
            strokeLinecap="round"
            transform="rotate(-90 36 36)"
            style={{ transition: 'stroke-dasharray 0.8s ease' }}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
          <span style={{ fontSize: 18, fontWeight: 800, color, lineHeight: 1 }}>{score}</span>
          <span style={{ fontSize: 8, color: 'var(--color-text-muted)', fontWeight: 600 }}>/100</span>
        </div>
      </div>
      <div>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color }}>{label}</div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 2 }}>
          {score >= 70 ? 'Multiple strong growth vectors identified' : score >= 40 ? 'Key growth opportunities available' : 'Focus on platform adoption fundamentals first'}
        </div>
      </div>
    </div>
  )
}

// ─── Horizontal bar ───────────────────────────────────────────────────────────

function HBar({ value, max, color = '#56B7A3' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div style={{ height: 6, background: 'var(--color-bg-elevated)', borderRadius: 3, overflow: 'hidden', flex: 1 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
    </div>
  )
}

// ─── Safe helpers ─────────────────────────────────────────────────────────────

function safeN(n: number | null | undefined): number {
  if (n == null || !isFinite(n as number) || isNaN(n as number)) return 0
  return n as number
}
function pct(n: number | null | undefined, digits = 1): string {
  return (safeN(n) * 100).toFixed(digits)
}
function fix0(n: number | null | undefined): string {
  return safeN(n).toFixed(0)
}

// ─── Currency formatter ───────────────────────────────────────────────────────

function fmtCurrency(n: number): string {
  const v = safeN(n)
  if (v >= 1000000) return `$${(v / 1000000).toFixed(1)}M`
  if (v >= 1000)    return `$${(v / 1000).toFixed(1)}k`
  return `$${v.toLocaleString()}`
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ExpansionPage() {
  const navigate = useNavigate()
  const [data,        setData]        = useState<AnalysisResult | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [outputFiles, setOutputFiles] = useState<string[]>([])
  const [copied,      setCopied]      = useState<'files' | 'prompt' | null>(null)

  // Pull company data to compute location gap
  const companies  = useCompaniesStore(s => s.result?.items ?? [])
  const fetchCos   = useCompaniesStore(s => s.fetch)

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
    navigator.clipboard.writeText(EXPANSION_PROMPT)
    setCopied('prompt')
    setTimeout(() => setCopied(null), 2000)
  }

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const r = await analysisApi.getLatest()
      if (r.ok && r.data) {
        // Validate that the result has the minimum fields we need.
        // Old DB rows from a prior schema version may be missing fields — treat as stale.
        const d = r.data as AnalysisResult
        if (!d.accountName || d.totalMessages === undefined) {
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
    // Make sure companies are loaded so location gap is accurate
    if (companies.length === 0) {
      fetchCos({ page: 1, pageSize: 200, sortBy: 'name', sortDir: 'asc' }).catch(() => {})
    }
    // Auto-refresh when a new analysis completes
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
      <TrendingUp size={48} strokeWidth={1.5} style={{ color: 'var(--color-text-muted)' }} />
      <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--color-text-primary)' }}>No analysis data yet</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', maxWidth: 360, lineHeight: 1.6 }}>
        Upload a Blueprint Messages CSV through Scrub & Split — the Expansion analysis will automatically appear here once processing completes.
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

  // Compute location gap from companies store (find the matched company)
  const matchedCompany = companies.find(c =>
    c.name.toLowerCase().includes(data.accountName.toLowerCase().split(' ')[0].toLowerCase()) ||
    data.accountName.toLowerCase().includes(c.name.toLowerCase().split(' ')[0].toLowerCase())
  )
  const activeLocations    = matchedCompany?.subscribed_locations ? parseInt(matchedCompany.subscribed_locations as string) || 0 : data.activeBranches
  const potentialLocations = matchedCompany?.potential_locations  ? parseInt(matchedCompany.potential_locations as string)  || 0 : 0
  const locationGap        = Math.max(0, potentialLocations - activeLocations)
  const locationCoverage   = potentialLocations > 0 ? Math.round((activeLocations / potentialLocations) * 100) : 100

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
              label="AI Talking Points"
              prompt={buildExpansionPrompt(data)}
              systemPrompt="You are a customer success manager preparing for an expansion conversation. Given the following usage data, write 2-3 concise, compelling talking points for why this account is ready to expand (add branches, adopt more features, or upgrade). Plain text, numbered list."
            />
            <button onClick={() => analysisPopoutApi.open('expansion')} title="Pop out for screen sharing" style={{ background: 'none', border: '1px solid var(--color-teal-700)', borderRadius: 'var(--radius-md)', padding: '5px 8px', cursor: 'pointer', color: 'var(--color-teal-400)', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
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
        Analyzed {analyzedDate} · {data.activeBranches} active branch{data.activeBranches !== 1 ? 'es' : ''}
      </div>

      {/* Expansion gauge */}
      <div style={{ marginBottom: 20 }}>
        <ExpansionGauge score={data.expansionScore} />
      </div>

      {/* Key metrics row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: 'Quote Volume', value: fmtCurrency(data.quotes?.totalValue ?? 0), sub: `${data.quotes?.threadCount ?? 0} threads` },
          { label: 'Avg Quote', value: fmtCurrency(data.quotes?.avg ?? 0), sub: `median ${fmtCurrency(data.quotes?.median ?? 0)}` },
          { label: 'Attachment Rate', value: `${pct(data.attachmentRate)}%`, sub: `${data.attachmentCount ?? 0} msgs w/ files` },
          { label: 'BTM Campaigns', value: data.btmHasRealContent ? 'Active' : 'None', sub: `${data.btmMessageCount ?? 0} BTM records` },
        ].map(card => (
          <div key={card.label} style={{ background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginBottom: 4 }}>{card.label}</div>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: 'var(--color-text-primary)' }}>{card.value}</div>
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>{card.sub}</div>
          </div>
        ))}
      </div>

      {/* Expansion signals */}
      {(data.expansionSignals ?? []).length > 0 && (
        <Section title="Growth Opportunity Signals" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(data.expansionSignals ?? []).slice(0, 5).map((signal, i) => (
              <div key={i} style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                background: signal.positive ? 'rgba(70,156,108,0.06)' : 'rgba(86,183,163,0.06)',
                border: `1px solid ${signal.positive ? 'rgba(70,156,108,0.2)' : 'rgba(86,183,163,0.2)'}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  {signal.positive
                    ? <CheckCircle size={15} style={{ color: '#469C6C', flexShrink: 0, marginTop: 1 }} />
                    : <AlertCircle size={15} style={{ color: '#56B7A3', flexShrink: 0, marginTop: 1 }} />
                  }
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>{signal.title}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{signal.description}</div>
                    {signal.metric && (
                      <div style={{ marginTop: 6, fontSize: 10, fontWeight: 600, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>{signal.metric}</div>
                    )}
                  </div>
                  <div style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: signal.positive ? '#469C6C' : '#56B7A3', background: signal.positive ? 'rgba(70,156,108,0.12)' : 'rgba(86,183,163,0.12)', padding: '2px 6px', borderRadius: 4 }}>
                    +{signal.score}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Location gap analysis */}
      {potentialLocations > 0 && (
        <Section title="Location Gap Analysis" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* Visual coverage bar */}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 'var(--text-xs)' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Location Coverage</span>
                <span style={{ fontWeight: 700, color: locationCoverage < 60 ? '#DA5039' : locationCoverage < 80 ? '#F4B74E' : '#469C6C' }}>{locationCoverage}%</span>
              </div>
              <div style={{ height: 10, background: 'var(--color-bg-elevated)', borderRadius: 5, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{
                  height: '100%',
                  width: `${locationCoverage}%`,
                  background: locationCoverage < 60 ? 'linear-gradient(90deg, #DA5039, #F4B74E)' : locationCoverage < 80 ? '#F4B74E' : '#469C6C',
                  borderRadius: 5,
                  transition: 'width 0.6s ease',
                }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                {[
                  { label: 'Active Locations', value: activeLocations, color: '#469C6C' },
                  { label: 'Potential Locations', value: potentialLocations, color: 'var(--color-text-muted)' },
                  { label: 'Expansion Gap', value: locationGap, color: locationGap > 0 ? '#F4B74E' : '#469C6C' },
                ].map(item => (
                  <div key={item.label} style={{ textAlign: 'center', padding: '10px 8px', background: 'var(--color-bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: item.color }}>{item.value}</div>
                    <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>{item.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Interpretation */}
            <div style={{ minWidth: 200, maxWidth: 280, padding: '12px 14px', background: 'var(--color-bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              {locationGap > 0 ? (
                <>
                  <strong style={{ color: '#F4B74E' }}>📍 {locationGap} untapped location{locationGap !== 1 ? 's' : ''}</strong>
                  <br /><br />
                  {data.accountName} has {potentialLocations} potential locations but only {activeLocations} are currently subscribed to Prokeep. Each additional location represents a direct revenue expansion opportunity.
                  <br /><br />
                  <strong>Talking point:</strong> Reference the success metrics from the {(data.branches ?? []).find(b => b.sentRate > 0.4)?.name || 'active'} branch as evidence of ROI when pitching to unlicensed locations.
                </>
              ) : (
                <>
                  <strong style={{ color: '#469C6C' }}>✅ Full location coverage</strong>
                  <br /><br />
                  All known locations are active on Prokeep. Focus expansion conversations on feature adoption (BTM, integrations, Growth Hub) rather than new location sign-ups.
                </>
              )}
            </div>
          </div>
        </Section>
      )}

      {/* Quote facilitation */}
      {(data.quotes?.threadCount ?? 0) > 0 && (
        <Section title="Quote Facilitation" style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 32, fontWeight: 800, color: '#469C6C' }}>{fmtCurrency(data.quotes?.totalValue ?? 0)}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Total facilitated across {data.quotes?.threadCount ?? 0} threads</div>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1, textAlign: 'center', padding: '10px 8px', background: 'var(--color-bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text-primary)' }}>{fmtCurrency(data.quotes?.avg ?? 0)}</div>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>Avg per thread</div>
              </div>
              <div style={{ flex: 1, textAlign: 'center', padding: '10px 8px', background: 'var(--color-bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text-primary)' }}>{fmtCurrency(data.quotes?.median ?? 0)}</div>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>Median thread value</div>
              </div>
            </div>
          </div>

          {/* Top quotes */}
          {(data.quotes?.top10 ?? []).length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Top Quote Threads</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {(data.quotes?.top10 ?? []).slice(0, 8).map((q, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--color-bg-card)', borderRadius: 'var(--radius-md)' }}>
                    <span style={{ width: 28, fontSize: 'var(--text-sm)', fontWeight: 800, color: '#469C6C', flexShrink: 0 }}>{fmtCurrency(q.amount)}</span>
                    <span style={{ flex: 1, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.preview}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(70,156,108,0.06)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(70,156,108,0.15)', fontSize: 'var(--text-xs)', color: '#469C6C', lineHeight: 1.5 }}>
            💡 <strong>ROI Talking Point:</strong> Prokeep is actively facilitating {fmtCurrency(data.quotes?.totalValue ?? 0)} in revenue conversations — these are deals happening through the platform that wouldn't exist otherwise.
          </div>
        </Section>
      )}

      {/* Branch benchmarks */}
      <Section title="Branch Engagement Benchmarks" style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
          Branches with 40%+ outbound rate demonstrate the ideal engagement model — staff initiating conversations rather than only responding.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(data.branches ?? []).slice(0, 5).map(branch => {
            const tier = branch.sentRate >= 0.40 ? 'best' : branch.sentRate >= 0.25 ? 'ok' : 'poor'
            const tierColor = { best: '#469C6C', ok: '#F4B74E', poor: '#DA5039' }[tier]
            const tierLabel = { best: '✅ Best Practice', ok: '🟡 Needs Coaching', poor: '⚠️ Low Engagement' }[tier]
            return (
              <div key={branch.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--color-bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
                <div style={{ width: 130, flexShrink: 0 }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}>{branch.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 1 }}>{branch.total} total messages</div>
                </div>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <HBar value={branch.sentRate * 100} max={100} color={tierColor} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: tierColor, flexShrink: 0, width: 36 }}>{fix0(branch.sentRate * 100)}%</span>
                </div>
                <span style={{ fontSize: 10, fontWeight: 600, color: tierColor, flexShrink: 0 }}>{tierLabel}</span>
              </div>
            )
          })}
        </div>

        {/* Best practice reps */}
        {(data.branches ?? []).some(b => b.sentRate >= 0.40) && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(86,183,163,0.06)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(86,183,163,0.15)', fontSize: 'var(--text-xs)', color: 'var(--color-teal-400)', lineHeight: 1.5 }}>
            💡 <strong>Expansion Angle:</strong> Use top-performing branches as internal case studies to coach underperforming locations and justify additional seat licenses.
          </div>
        )}
      </Section>

      {/* BTM opportunity */}
      {!data.btmHasRealContent && (
        <Section title="Broadcast Text Messaging (BTM) Opportunity" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
            No active BTM campaigns were detected in this account's data. Broadcast Text Messaging enables mass customer outreach for:
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              { icon: '📢', text: 'Seasonal promotions & price alerts' },
              { icon: '📦', text: 'New product announcements' },
              { icon: '🔁', text: 'Customer re-engagement campaigns' },
              { icon: '📊', text: 'QBR follow-up & recap messaging' },
            ].map(item => (
              <div key={item.text} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--color-bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)' }}>
                <span>{item.icon}</span>
                <span>{item.text}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: 'var(--text-xs)', color: '#56B7A3', lineHeight: 1.5 }}>
            💡 <strong>Pitch angle:</strong> Given the {data.activeBranches ?? 0} active branches and {(data.totalMessages ?? 0).toLocaleString()} messages/year, a single BTM campaign to existing contacts could generate hundreds of incremental touchpoints with zero additional labor cost.
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
