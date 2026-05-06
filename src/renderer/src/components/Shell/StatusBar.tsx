import { useNavigate } from 'react-router-dom'
import { useJobsStore }  from '../../store/jobs.store'
import { useAuthStore }  from '../../store/auth.store'
import { Circle, Loader2 } from 'lucide-react'

const JOB_LABELS: Record<string, string> = {
  scrub_split:     'Scrub & Split',
  scrub_process:   'Scrub & Split',
  hubspot_import:  'HubSpot Import',
  master_refresh:  'Master Refresh',
  gong_scrape:     'Gong Scrape',
  gong_collect:    'Gong Collect',
  gong_extract:    'Gong Extract',
  drive_organize:  'Drive Organize',
  calendar_sync:   'Calendar Sync',
  index_rebuild:   'Index Rebuild',
}

function jobLabel(type: string): string {
  return JOB_LABELS[type] ?? type.replace(/_/g, ' ')
}

export function StatusBar() {
  const navigate    = useNavigate()
  const activeJobs  = useJobsStore(s => s.activeJobs())
  const auth        = useAuthStore(s => s.status)
  const lastJob     = useJobsStore(s => s.jobs.find(j =>
    j.status === 'completed' || j.status === 'failed'
  ))

  const firstActive = activeJobs[0]
  const isConnected = !!auth?.isAuthenticated

  return (
    <div style={styles.bar}>

      {/* Left: auth indicator — click → Settings */}
      <button style={styles.sectionBtn} onClick={() => navigate('/settings')}>
        <Circle
          size={6}
          fill={isConnected ? 'var(--color-green-500)' : '#DA5039'}
          stroke="none"
        />
        <span style={{ ...styles.text, color: isConnected ? 'var(--color-green-500)' : '#DA5039' }}>
          {isConnected ? auth!.email : 'Not connected'}
        </span>
      </button>

      {/* Center: active job / last job status — click → Transcripts */}
      <div style={{ ...styles.section, flex: 1, justifyContent: 'center' }}>
        {firstActive ? (
          <button style={styles.sectionBtn} onClick={() => navigate('/transcripts')}>
            <Loader2 size={10} style={{ animation: 'spin 800ms linear infinite', color: 'var(--color-teal-400)' }} />
            <span style={{ ...styles.text, color: 'var(--color-teal-400)' }}>
              {jobLabel(firstActive.type)}
              {activeJobs.length > 1 ? ` +${activeJobs.length - 1} more` : ''}
              {' '}running…
            </span>
          </button>
        ) : lastJob ? (
          <button style={styles.sectionBtn} onClick={() => navigate('/transcripts')}>
            <Circle
              size={6}
              fill={lastJob.status === 'completed' ? 'var(--color-green-500)' : '#DA5039'}
              stroke="none"
            />
            <span style={styles.text}>
              {jobLabel(lastJob.type)} — {lastJob.status}
            </span>
          </button>
        ) : (
          <span style={styles.text}>Ready</span>
        )}
      </div>

      {/* Right: version */}
      <div style={styles.section}>
        <span style={styles.text}>v1.0.0</span>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    height:      'var(--statusbar-height)',
    display:     'flex',
    alignItems:  'center',
    padding:     '0 var(--space-4)',
    background:  'var(--color-bg-sidebar)',
    borderTop:   '1px solid var(--color-border)',
    gap:         'var(--space-4)',
  },
  section: {
    display:    'flex',
    alignItems: 'center',
    gap:        'var(--space-2)',
  },
  sectionBtn: {
    display:    'flex',
    alignItems: 'center',
    gap:        'var(--space-2)',
    background: 'transparent',
    border:     'none',
    cursor:     'pointer',
    padding:    '2px 4px',
    borderRadius: 'var(--radius-sm)',
  },
  text: {
    fontSize:   'var(--text-xs)',
    color:      'var(--color-text-muted)',
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'nowrap' as never,
    overflow:   'hidden',
    textOverflow: 'ellipsis',
    maxWidth:   220,
  },
}
