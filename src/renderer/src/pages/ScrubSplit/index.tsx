import { useEffect, useState, useCallback, useRef } from 'react'
import { Upload, FolderOpen, CheckCircle2, XCircle, Clock, RefreshCw, ExternalLink, Copy, RotateCcw } from 'lucide-react'
import { Button, Card, LogStream, JobStatusBadge } from '../../components/ui'
import { useJobsStore } from '../../store/jobs.store'
import { scrubApi, scrubResetApi, fsApi, type ScrubJobRecord } from '../../lib/ipc'
import { formatDateTime } from '../../lib/utils'
import { PromptLibraryPanel } from '../PromptLibrary'

// ─── Types ────────────────────────────────────────────────────────────────────

interface OutputFile {
  name: string
  path: string
}

function parseOutputFiles(json: string | null): OutputFile[] {
  if (!json) return []
  try {
    const paths: string[] = JSON.parse(json)
    return paths.map(p => ({ name: p.split('/').pop() ?? p, path: p }))
  } catch {
    return []
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScrubJobRow({
  record,
  isActive,
  onClick,
}: {
  record: ScrubJobRecord
  isActive: boolean
  onClick: () => void
}) {
  const files = parseOutputFiles(record.output_files)

  return (
    <div
      onClick={onClick}
      style={{
        padding:      'var(--space-3) var(--space-4)',
        borderBottom: '1px solid var(--color-border)',
        cursor:       'pointer',
        background:   isActive ? 'var(--color-bg-active)' : 'transparent',
        transition:   'background var(--transition-fast)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
        {/* Status icon */}
        <div style={{ marginTop: 2, flexShrink: 0 }}>
          {record.status === 'completed' && <CheckCircle2 size={15} color="var(--color-green-400)" />}
          {record.status === 'failed'    && <XCircle      size={15} color="var(--color-red-400)"   />}
          {(record.status === 'running' || record.status === 'pending') &&
            <Clock size={15} color="var(--color-gold-500)" />}
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize:     'var(--text-sm)',
            fontWeight:   'var(--weight-medium)' as never,
            color:        'var(--color-text-primary)',
            whiteSpace:   'nowrap',
            overflow:     'hidden',
            textOverflow: 'ellipsis',
          }}>
            {record.source_filename}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 2, display: 'flex', gap: 'var(--space-3)' }}>
            {record.row_count_original != null && (
              <span>{record.row_count_original.toLocaleString()} rows in</span>
            )}
            {record.row_count_cleaned != null && (
              <span>{record.row_count_cleaned.toLocaleString()} rows out</span>
            )}
            {files.length > 0 && (
              <span>{files.length} chunk{files.length !== 1 ? 's' : ''}</span>
            )}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 1 }}>
            {formatDateTime(record.created_at)}
          </div>
        </div>

        {/* Status badge */}
        <JobStatusBadge status={record.status as never} />
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ScrubSplit() {
  const jobs      = useJobsStore(s => s.jobs)
  const jobLogs   = useJobsStore(s => s.logs)
  const fetchJobs = useJobsStore(s => s.fetchJobs)
  const initJobs  = useJobsStore(s => s.init)

  const [scrubJobs,    setScrubJobs]    = useState<ScrubJobRecord[]>([])
  const [selectedId,   setSelectedId]   = useState<string | null>(null)
  const [uploading,    setUploading]    = useState(false)
  const [loadingJobs,  setLoadingJobs]  = useState(false)
  const [resetting,    setResetting]    = useState(false)
  // Account name extracted from the most recently completed scrub job
  const [scrubAccountName, setScrubAccountName] = useState('')

  // Find the matching JobQueue entry for the selected scrub record (for real-time logs)
  const selectedRecord = scrubJobs.find(j => j.id === selectedId) ?? null
  const liveJob  = selectedRecord
    ? jobs.find(j => {
        // The job payload stores the scrub job id — find by matching recent jobs of type scrub_process
        return j.type === 'scrub_process' && j.status !== 'completed' && j.status !== 'failed'
      }) ?? null
    : null
  const liveLogs = liveJob ? (jobLogs[liveJob.id] ?? []) : []

  const loadScrubJobs = useCallback(async (resetSelection = false) => {
    setLoadingJobs(true)
    const r = await scrubApi.listJobs()
    if (r.ok) {
      setScrubJobs(r.data)
      if (resetSelection) {
        setSelectedId(r.data.length ? r.data[0].id : null)
      } else if (r.data.length && !selectedId) {
        setSelectedId(r.data[0].id)
      }
      // Auto-populate account name from the most recent job that has one
      const withName = r.data.find(j => j.account_name)
      if (withName?.account_name) setScrubAccountName(withName.account_name)
    }
    setLoadingJobs(false)
  }, [selectedId])

  useEffect(() => {
    initJobs()
    fetchJobs()
    loadScrubJobs()
  }, [])

  // Refresh job list when a scrub job completes; loadScrubJobs auto-populates account_name
  useEffect(() => {
    if (!liveJob) return
    if (liveJob.status === 'completed' || liveJob.status === 'failed') {
      loadScrubJobs()
    }
  }, [liveJob?.status])

  async function handleUpload() {
    setUploading(true)
    const r = await scrubApi.upload()
    setUploading(false)

    if (!r.ok || !r.data) return   // user cancelled or error

    await fetchJobs()
    await loadScrubJobs()

    // Auto-select the new job
    setScrubJobs(prev => {
      const newest = prev[0]
      if (newest) setSelectedId(newest.id)
      return prev
    })
  }

  const selectedFiles = selectedRecord ? parseOutputFiles(selectedRecord.output_files) : []

  // Detect when liveJob transitions from running → gone (completed/failed) and refresh
  const prevLiveJobIdRef = useRef<string | null>(null)
  useEffect(() => {
    const prevId = prevLiveJobIdRef.current
    const currentId = liveJob?.id ?? null
    prevLiveJobIdRef.current = currentId
    if (prevId && !currentId) {
      // Job just finished — reload scrub records so redaction stats appear immediately
      loadScrubJobs()
    }
  }, [liveJob?.id])

  return (
    <div className="page animate-fade-in">
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Scrub &amp; Split</h1>
          <p className="page-subtitle">Remove PII from CSV files and split into 25 MB chunks, upload chunks into claude with one of the included custom prompts</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw size={14} />}
            onClick={async () => {
              setResetting(true)
              await scrubResetApi.reset()
              setSelectedId(null)
              setScrubJobs([])
              setScrubAccountName('')
              setResetting(false)
            }}
            disabled={resetting}
          >
            {resetting ? 'Resetting…' : 'Reset'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={() => { setSelectedId(null); setScrubJobs([]); loadScrubJobs(true) }}
            disabled={loadingJobs}
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Upload size={14} />}
            onClick={handleUpload}
            disabled={uploading}
          >
            {uploading ? 'Selecting…' : 'Select CSV File'}
          </Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 'var(--space-4)', alignItems: 'start' }}>

        {/* ── Left: Job history + video + prompts ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Card title="Job History" padding={false}>
          {scrubJobs.length === 0 && !loadingJobs && (
            <button
              onClick={handleUpload}
              disabled={uploading}
              style={{
                display: 'block', width: '100%', padding: 'var(--space-6)',
                textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)',
                background: 'transparent', border: 'none', cursor: uploading ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
              onMouseEnter={e => { if (!uploading) e.currentTarget.style.color = 'var(--color-teal-400)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-muted)' }}
            >
              No jobs yet.<br />Click here or <strong>Select CSV File</strong> to start.
            </button>
          )}
          {scrubJobs.map(record => (
            <ScrubJobRow
              key={record.id}
              record={record}
              isActive={record.id === selectedId}
              onClick={() => setSelectedId(record.id)}
            />
          ))}
        </Card>

        {/* Instructional video */}
        <Card title="How to Use">
          <div
            onClick={() => fsApi.openExternal('https://www.loom.com/share/7d87454a632141e686a68978d866cfab')}
            style={{ position: 'relative', paddingBottom: '56.25%', cursor: 'pointer', overflow: 'hidden', borderRadius: 'var(--radius-md)', background: '#0D1525', border: '1px solid var(--color-border)' }}
          >
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#DA5039', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg viewBox="0 0 24 24" fill="white" width={22} height={22}><polygon points="9.5,7.5 16.5,12 9.5,16.5"/></svg>
              </div>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', fontWeight: 600 }}>Watch Tutorial</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Opens in your browser</span>
            </div>
          </div>
          <p style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', textAlign: 'center' }}>
            Click to watch tutorial in your browser.
          </p>
        </Card>

        {/* Prompt Library */}
        <Card title="Prompt Library" subtitle="Claude prompts for account analysis">
          <PromptLibraryPanel initialAccountName={scrubAccountName} />
        </Card>

        </div>{/* end left column */}

        {/* ── Right: Metabase exports (top) + detail panel below ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>

          <MetabaseLinks />

          {/* Stats card */}
          {selectedRecord && (
            <Card title="Job Details">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
                <Stat label="Status">
                  <JobStatusBadge status={selectedRecord.status as never} />
                </Stat>
                <Stat label="Source file">
                  <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                    {selectedRecord.source_filename}
                  </span>
                </Stat>
                <Stat label="Created">
                  <span style={{ fontSize: 'var(--text-sm)' }}>{formatDateTime(selectedRecord.created_at)}</span>
                </Stat>
                {selectedRecord.row_count_original != null && (
                  <Stat label="Rows in">
                    <span style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' as never, fontFamily: 'var(--font-mono)' }}>
                      {selectedRecord.row_count_original.toLocaleString()}
                    </span>
                  </Stat>
                )}
                {selectedRecord.row_count_cleaned != null && (
                  <Stat label="Rows out">
                    <span style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' as never, fontFamily: 'var(--font-mono)' }}>
                      {selectedRecord.row_count_cleaned.toLocaleString()}
                    </span>
                  </Stat>
                )}
                {selectedFiles.length > 0 && (
                  <Stat label="Output chunks">
                    <span style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' as never, fontFamily: 'var(--font-mono)' }}>
                      {selectedFiles.length}
                    </span>
                  </Stat>
                )}
              </div>

              {/* Output files */}
              {selectedFiles.length > 0 && (
                <div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontWeight: 'var(--weight-medium)' as never, marginBottom: 'var(--space-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Output Files
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    {selectedFiles.map(f => (
                      <OutputFileRow key={f.path} file={f} />
                    ))}
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* Redaction breakdown — shown after job completes */}
          {selectedRecord?.status === 'exported' && selectedRecord.redaction_stats && (
            <RedactionBreakdown statsJson={selectedRecord.redaction_stats} />
          )}

          {/* Live log stream — only shown while a job is running */}
          {(liveJob || (selectedRecord && (selectedRecord.status === 'running' || selectedRecord.status === 'pending'))) && (
            <Card
              title="Live Log"
              subtitle={liveJob ? `Job ${liveJob.id.slice(0, 8)}… — ${liveJob.status}` : 'Waiting…'}
              padding={false}
            >
              <LogStream
                logs={liveLogs}
                maxHeight={260}
                style={{ margin: 'var(--space-3)', borderRadius: 'var(--radius-md)' }}
              />
            </Card>
          )}

          {/* Empty state — clickable upload zone */}
          {!selectedRecord && (
            <button
              onClick={handleUpload}
              disabled={uploading}
              style={{
                display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                gap:'var(--space-3)', padding:'var(--space-12)',
                color:'var(--color-text-muted)', textAlign:'center',
                width: '100%', background: 'transparent',
                border: '2px dashed var(--color-border)', borderRadius: 'var(--radius-lg)',
                cursor: uploading ? 'not-allowed' : 'pointer',
                transition: 'border-color 0.15s, background 0.15s, color 0.15s',
                fontFamily: 'inherit',
              }}
              onMouseEnter={e => {
                if (!uploading) {
                  e.currentTarget.style.borderColor = 'var(--color-teal-500)'
                  e.currentTarget.style.background  = 'rgba(86,183,163,0.06)'
                  e.currentTarget.style.color        = 'var(--color-teal-400)'
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--color-border)'
                e.currentTarget.style.background  = 'transparent'
                e.currentTarget.style.color        = 'var(--color-text-muted)'
              }}
            >
              <Upload size={32} strokeWidth={1.2} />
              <div>
                <div style={{ fontSize:'var(--text-md)', fontWeight:'var(--weight-medium)' as never, marginBottom:4 }}>
                  {uploading ? 'Selecting…' : 'No file selected'}
                </div>
                <div style={{ fontSize:'var(--text-sm)' }}>Click here to open the file picker and start a scrub job.</div>
              </div>
            </button>
          )}

        </div>
      </div>
    </div>
  )
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 'var(--weight-medium)' as never }}>
        {label}
      </div>
      {children}
    </div>
  )
}

function MetabaseLinks() {
  const LINKS = [
    { label: 'Blueprint Messages', sub: 'Step 1 — Export data', url: 'https://metabase.bi.prokeep.com/question#eyJkYXRhc2V0X3F1ZXJ5Ijp7ImRhdGFiYXNlIjo1LCJ0eXBlIjoicXVlcnkiLCJxdWVyeSI6eyJzb3VyY2UtdGFibGUiOjQ1MH19LCJkaXNwbGF5IjoidGFibGUiLCJ2aXN1YWxpemF0aW9uX3NldHRpbmdzIjp7fX0=' },
    { label: 'Channels Enabled',   sub: 'Step 2 — Active locations', url: 'https://metabase.bi.prokeep.com/question#eyJkYXRhc2V0X3F1ZXJ5Ijp7ImRhdGFiYXNlIjo1LCJ0eXBlIjoicXVlcnkiLCJxdWVyeSI6eyJzb3VyY2UtdGFibGUiOjU2Mn19LCJkaXNwbGF5IjoidGFibGUiLCJ2aXN1YWxpemF0aW9uX3NldHRpbmdzIjp7fX0=' },
  ]
  return (
    <Card title="Metabase Exports">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {LINKS.map(l => (
          <button key={l.url} onClick={() => fsApi.openExternal(l.url)}
            style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'var(--space-3)', border:'1px solid var(--color-border)', borderRadius:'var(--radius-md)', background:'var(--color-bg-subtle)', cursor:'pointer', textAlign:'left' }}>
            <div>
              <div style={{ fontSize:'var(--text-sm)', fontWeight:'var(--weight-medium)' as never, color:'var(--color-text-primary)' }}>{l.label}</div>
              <div style={{ fontSize:'var(--text-xs)', color:'var(--color-text-muted)' }}>{l.sub}</div>
            </div>
            <ExternalLink size={13} style={{ color:'var(--color-text-muted)', flexShrink:0 }} />
          </button>
        ))}
      </div>
    </Card>
  )
}

const FILTER_LOGIC = ' If I included the enabled locations spreadsheet, please use it to narrow down the results of the data. Exclusively focus on locations in this sheet that contain "True" in the "channel enabled" column within the spreadsheet. If I did not include this spreadsheet, please process my other requests above.'

const PROMPTS = [
  { label: 'Full Account Analysis',       text: 'Comprehensively analyze [ACCOUNT NAME]\'s messaging data, then give me total volume, sent/received split, branch-by-branch volume, top reps, themes, attachment rate, BTM usage, trend direction, and any risk or engagement flags - then combine that data into a single Usage and Trend Report document representing the whole account. Within that same report, also include how much money in quotes has been facilitated through all of the messages in the account. When gathering quote data, ignore spam, only focus on real quotes where a dollar amount was suggested to a customer or brought up somewhere within the conversation. Doesn\'t have to be an approved quote, just facilitated in some way through Prokeep.' + FILTER_LOGIC },
  { label: 'Executive Summary',            text: 'Review [ACCOUNT NAME]\'s Prokeep messaging data and write a tight executive summary - one page, narrative format, suitable for leadership. Lead with the headline number, tell the story of how this account is using Prokeep, whether they are healthy or at risk, and what the single most important takeaway is. Keep it direct and avoid bullet-point lists - this should read like a concise business brief.' + FILTER_LOGIC },
  { label: 'Rep Performance Breakdown',    text: 'Analyze the rep-level activity in [ACCOUNT NAME]\'s Prokeep messaging data. For each rep, show total message volume, outbound vs. inbound breakdown, average response patterns, and thread activity. Identify who is most active, who has gone quiet or shows declining engagement, and flag any reps worth recognizing for strong performance or flagging for coaching conversations. Present findings as a ranked breakdown by activity level.' + FILTER_LOGIC },
  { label: 'BTM Usage Report',            text: 'Focus exclusively on broadcast text messaging activity in [ACCOUNT NAME]\'s Prokeep data. Identify how many BTM messages were sent, which branches sent them, estimated recipient reach where inferable, and any patterns in timing or content type. Assess whether BTM is being used consistently or sporadically, and note whether there are branches not using it at all. Summarize with a recommendation on where BTM adoption could be strengthened.' + FILTER_LOGIC },
  { label: 'Upsell & Expansion',          text: 'Review [ACCOUNT NAME]\'s Prokeep usage data and identify upsell and expansion opportunities. Look for features with low or no adoption, branches with high message volume that may benefit from additional seats or capabilities, and usage patterns that suggest readiness for Growth Hub, integrations, or other add-ons. Frame each opportunity with the supporting data and a recommended conversation angle for the account team.' + FILTER_LOGIC },
  { label: 'CSAT & Sentiment Signals',    text: 'Analyze [ACCOUNT NAME]\'s Prokeep messaging data for customer satisfaction and sentiment signals. Look at response time patterns, thread length and resolution patterns, message tone where readable, and any recurring friction points or complaints visible in the conversations. Flag any red flags - unanswered threads, escalating language, or high-volume complaint patterns. Summarize with an overall sentiment assessment and any specific areas to address.' + FILTER_LOGIC },
  { label: 'QBR Talking Points',          text: 'Pull the 5 to 7 most compelling data points from [ACCOUNT NAME]\'s Prokeep messaging data to use in a quarterly business review. For each talking point, state the metric or finding, explain why it matters, and frame it as either a win to celebrate, a trend to highlight, or a forward-looking recommendation. Output should be structured as ready-to-use QBR talking points that a Prokeep employee could bring directly into a customer conversation.' + FILTER_LOGIC },
  { label: 'Mid-Year Review + Deck',      text: 'You are going to do two things with the [ACCOUNT NAME] Prokeep data I am uploading.\n\nFirst, conduct a full mid-year review analysis. Cover total message volume, sent/received split, branch-by-branch performance, top and lowest-activity reps, thread and response trends, BTM usage, attachment rate, quotes facilitated, any risk flags, and a half-year trend direction assessment. Write this up as a structured Mid-Year Review report with clear sections.\n\nSecond, using that analysis, build a complete PowerPoint presentation deck for the mid-year review.' + FILTER_LOGIC },
]

function ClaudePrompts() {
  const [selected, setSelected] = useState(0)
  const [copied,   setCopied]   = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(PROMPTS[selected].text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card title="Copy a Prompt for Claude">
      <div style={{ marginBottom: 'var(--space-3)' }}>
        <select value={selected} onChange={e => setSelected(+e.target.value)}
          style={{ width:'100%', padding:'var(--space-2) var(--space-3)', background:'var(--color-bg-subtle)', border:'1px solid var(--color-border)', borderRadius:'var(--radius-md)', color:'var(--color-text-primary)', fontSize:'var(--text-sm)', cursor:'pointer' }}>
          {PROMPTS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
        </select>
      </div>
      <div style={{ padding:'var(--space-3)', background:'var(--color-bg-subtle)', borderRadius:'var(--radius-md)', fontSize:'var(--text-xs)', color:'var(--color-text-secondary)', lineHeight:1.6, maxHeight:160, overflowY:'auto', marginBottom:'var(--space-3)', fontFamily:'var(--font-mono)', whiteSpace:'pre-wrap' }}>
        {PROMPTS[selected].text}
      </div>
      <div style={{ display:'flex', gap:'var(--space-2)' }}>
        <Button variant="primary" size="sm" icon={<Copy size={13} />} onClick={handleCopy} style={{ flex:1 }}>
          {copied ? 'Copied!' : 'Copy Prompt'}
        </Button>
        <Button variant="ghost" size="sm" icon={<ExternalLink size={13} />} onClick={() => fsApi.openExternal('https://claude.ai/')} style={{ background: '#FF6B2C', color: '#fff', border: 'none' }}>
          Open Claude
        </Button>
      </div>
    </Card>
  )
}

function RedactionBreakdown({ statsJson }: { statsJson: string }) {
  let stats: Record<string, number> = {}
  try { stats = JSON.parse(statsJson) } catch { return null }

  const LABELS: Record<string, string> = {
    SSN: 'SSNs', CC: 'Credit Cards', Routing: 'Routing Numbers',
    Account: 'Account Numbers', TaxID: 'Tax IDs / EINs',
    PW: 'Passwords', Keys: 'API Keys', total: 'Total Redacted',
  }

  const entries = Object.entries(stats).filter(([k]) => k !== 'total')
  const total   = stats['total'] ?? 0

  return (
    <Card title="Redaction Breakdown">
      <div style={{ marginBottom: 'var(--space-3)', padding: 'var(--space-3)', background: 'rgba(86,183,163,0.08)', border: '1px solid rgba(86,183,163,0.25)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)' as never, color: 'var(--color-text-primary)' }}>Total Items Redacted</span>
        <span style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-bold)' as never, fontFamily: 'var(--font-mono)', color: 'var(--color-teal-400)' }}>{total.toLocaleString()}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
        {entries.map(([key, val]) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--space-2) var(--space-3)', background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)' }}>
            <span style={{ color: 'var(--color-text-secondary)' }}>{LABELS[key] ?? key}</span>
            <span style={{ fontWeight: 'var(--weight-bold)' as never, fontFamily: 'var(--font-mono)', color: val > 0 ? 'var(--color-teal-400)' : 'var(--color-text-muted)' }}>{val}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function OutputFileRow({ file }: { file: OutputFile }) {
  function openFolder() {
    // Ask main process to reveal in Finder / Explorer
    window.electron?.invoke('fs:open-external', file.path)
  }

  return (
    <div
      style={{
        display:      'flex',
        alignItems:   'center',
        gap:          'var(--space-2)',
        padding:      'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-sm)',
        background:   'var(--color-bg-subtle)',
        fontSize:     'var(--text-xs)',
        fontFamily:   'var(--font-mono)',
        cursor:       'pointer',
      }}
      onClick={openFolder}
      title={file.path}
    >
      <FolderOpen size={12} style={{ flexShrink: 0, color: 'var(--color-teal-500)' }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {file.name}
      </span>
    </div>
  )
}
