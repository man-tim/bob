import { Check } from 'lucide-react'

type StepStatus = 'idle' | 'running' | 'done' | 'error' | 'locked'

interface Step {
  id:      string
  label:   string
  sub?:    string
  status:  StepStatus
}

interface StepProgressProps {
  steps:   Step[]
  style?:  React.CSSProperties
}

export function StepProgress({ steps, style }: StepProgressProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, ...style }}>
      {steps.map((step, i) => (
        <StepRow key={step.id} step={step} index={i + 1} />
      ))}
    </div>
  )
}

function StepRow({ step, index }: { step: Step; index: number }) {
  const { status, label, sub } = step

  const circleStyle: React.CSSProperties = {
    width:          28,
    height:         28,
    borderRadius:   '50%',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
    fontSize:       'var(--text-xs)',
    fontWeight:     'var(--weight-bold)' as never,
    transition:     'all var(--transition-base)',
    ...circleVariant(status, index),
  }

  const labelStyle: React.CSSProperties = {
    fontSize:   'var(--text-sm)',
    fontWeight: status === 'running' ? 'var(--weight-semibold)' as never : 'var(--weight-medium)' as never,
    color: status === 'locked'
      ? 'var(--color-text-disabled)'
      : status === 'error'
      ? 'var(--color-red-400)'
      : status === 'done'
      ? 'var(--color-text-secondary)'
      : 'var(--color-text-primary)',
  }

  return (
    <div style={{
      display:     'flex',
      alignItems:  'center',
      gap:         'var(--space-3)',
      padding:     'var(--space-2) var(--space-3)',
      borderRadius:'var(--radius-md)',
      background:  status === 'running' ? 'var(--color-teal-muted)' : 'transparent',
    }}>
      <div style={circleStyle}>
        {status === 'done'    ? <Check size={13} strokeWidth={3} /> :
         status === 'running' ? <Spinner /> :
         index}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={labelStyle}>{label}</div>
        {sub && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  )
}

function circleVariant(status: StepStatus, index: number): React.CSSProperties {
  switch (status) {
    case 'done':    return { background: 'var(--color-green-muted)', color: 'var(--color-green-400)', border: '1.5px solid var(--color-green-600)' }
    case 'running': return { background: 'var(--color-teal-muted)',  color: 'var(--color-teal-400)',  border: '1.5px solid var(--color-teal-600)' }
    case 'error':   return { background: 'var(--color-red-muted)',   color: 'var(--color-red-400)',   border: '1.5px solid var(--color-red-600)' }
    case 'locked':  return { background: 'transparent', color: 'var(--color-text-disabled)', border: '1.5px solid var(--color-border)' }
    default:        return { background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)', border: '1.5px solid var(--color-border-hover)' }
  }
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" style={{ animation: 'spin 800ms linear infinite' }}>
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeDasharray="20" strokeDashoffset="5" strokeLinecap="round" />
    </svg>
  )
}

// ─── Export helper to build step array from job state ─────────────────────────

export function buildGongSteps(phase: 'idle' | 'collect' | 'extract' | 'organize' | 'done'): Step[] {
  const phases = ['idle','collect','extract','organize','done']
  const idx    = phases.indexOf(phase)

  return [
    { id: 'import',   label: 'Import Companies',     sub: 'HubSpot → DB',              status: idx > 0 ? 'done' : idx === 0 ? 'idle' : 'locked' },
    { id: 'collect',  label: 'Collect Call Links',   sub: 'Gong home page',             status: idx > 1 ? 'done' : idx === 1 ? 'running' : idx < 1 ? 'idle' : 'locked' },
    { id: 'extract',  label: 'Extract Transcripts',  sub: 'Open each call',             status: idx > 2 ? 'done' : idx === 2 ? 'running' : 'locked' },
    { id: 'organize', label: 'Organize Drive Folders',sub: 'Match companies',           status: idx > 3 ? 'done' : idx === 3 ? 'running' : 'locked' },
  ]
}
