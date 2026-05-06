import { useEffect, useRef } from 'react'
import type { JobLog, LogLevel } from '@shared/types'

const LEVEL_COLOR: Record<LogLevel, string> = {
  ok:    'var(--color-log-ok)',
  warn:  'var(--color-log-warn)',
  error: 'var(--color-log-error)',
  step:  'var(--color-log-step)',
  data:  'var(--color-log-data)',
  info:  'var(--color-log-info)',
}

const LEVEL_PREFIX: Record<LogLevel, string> = {
  ok:    '✓',
  warn:  '⚠',
  error: '✗',
  step:  '→',
  data:  '·',
  info:  ' ',
}

interface LogStreamProps {
  logs:      JobLog[]
  maxHeight?: number | string
  style?:    React.CSSProperties
}

export function LogStream({ logs, maxHeight = 320, style }: LogStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new logs arrive — but only if already at bottom
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (isAtBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  if (!logs.length) {
    return (
      <div style={{ ...styles.container, maxHeight, ...style }}>
        <span style={styles.empty}>No log entries yet.</span>
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ ...styles.container, maxHeight, ...style }}>
      {logs.map(entry => (
        <LogLine key={entry.id} entry={entry} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

function LogLine({ entry }: { entry: JobLog }) {
  const color  = LEVEL_COLOR[entry.level]
  const prefix = LEVEL_PREFIX[entry.level]
  const time   = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false })

  return (
    <div style={styles.line}>
      <span style={styles.time}>{time}</span>
      <span style={{ ...styles.prefix, color }}>{prefix}</span>
      <span style={{ ...styles.message, color: entry.level === 'info' ? 'var(--color-text-secondary)' : color }}>
        {entry.message}
      </span>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    overflowY:    'auto',
    background:   'var(--color-bg-base)',
    borderRadius: 'var(--radius-md)',
    border:       '1px solid var(--color-border)',
    padding:      'var(--space-2) 0',
    fontFamily:   'var(--font-mono)',
    fontSize:     'var(--text-xs)',
  },
  line: {
    display:    'flex',
    alignItems: 'baseline',
    gap:        'var(--space-2)',
    padding:    '2px var(--space-3)',
  },
  time: {
    color:      'var(--color-text-disabled)',
    flexShrink: 0,
    fontSize:   10,
  },
  prefix: {
    flexShrink: 0,
    width:      10,
    textAlign:  'center',
  },
  message: {
    flex:      1,
    wordBreak: 'break-word',
    lineHeight: 1.5,
  },
  empty: {
    display:   'block',
    padding:   'var(--space-4)',
    color:     'var(--color-text-muted)',
    fontSize:  'var(--text-xs)',
    fontFamily:'var(--font-mono)',
  },
}
