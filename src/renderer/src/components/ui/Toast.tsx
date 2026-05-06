import { useEffect }    from 'react'
import { X, CheckCircle, AlertTriangle, XCircle, Info } from 'lucide-react'
import { useUIStore }    from '../../store/ui.store'

// ─── Types ────────────────────────────────────────────────────────────────────

type ToastLevel = 'info' | 'ok' | 'warn' | 'error'

const ICON_MAP: Record<ToastLevel, React.ReactNode> = {
  info:  <Info        size={14} strokeWidth={2} />,
  ok:    <CheckCircle size={14} strokeWidth={2} />,
  warn:  <AlertTriangle size={14} strokeWidth={2} />,
  error: <XCircle    size={14} strokeWidth={2} />,
}

const ACCENT_MAP: Record<ToastLevel, string> = {
  info:  'var(--color-teal-500)',
  ok:    'var(--color-green-500)',
  warn:  '#F4B74E',
  error: '#DA5039',
}

const BG_MAP: Record<ToastLevel, string> = {
  info:  'rgba(86, 183, 163, 0.08)',
  ok:    'rgba(70, 156, 108, 0.08)',
  warn:  'rgba(244, 183, 78, 0.08)',
  error: 'rgba(218, 80, 57, 0.08)',
}

const BORDER_MAP: Record<ToastLevel, string> = {
  info:  'rgba(86, 183, 163, 0.25)',
  ok:    'rgba(70, 156, 108, 0.25)',
  warn:  'rgba(244, 183, 78, 0.25)',
  error: 'rgba(218, 80, 57, 0.25)',
}

// ─── Single Toast ─────────────────────────────────────────────────────────────

function ToastItem({ id, title, body, level }: {
  id:     string
  title:  string
  body?:  string
  level:  ToastLevel
}) {
  const dismiss = useUIStore(s => s.removeToast)
  const accent  = ACCENT_MAP[level]

  return (
    <div style={{
      ...styles.toast,
      background:  BG_MAP[level],
      border:      `1px solid ${BORDER_MAP[level]}`,
      borderLeft:  `3px solid ${accent}`,
      animation:   'toastIn 180ms ease-out',
    }}>
      {/* Icon */}
      <span style={{ color: accent, flexShrink: 0, marginTop: 1 }}>
        {ICON_MAP[level]}
      </span>

      {/* Content */}
      <div style={styles.content}>
        <span style={styles.title}>{title}</span>
        {body && <span style={styles.body}>{body}</span>}
      </div>

      {/* Dismiss */}
      <button style={styles.close} onClick={() => dismiss(id)} aria-label="Dismiss">
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  )
}

// ─── Toaster (rendered in App layout) ────────────────────────────────────────

export function Toaster() {
  const toasts = useUIStore(s => s.toasts)

  return (
    <>
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateX(24px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
      <div style={styles.container}>
        {toasts.map(t => (
          <ToastItem
            key={t.id}
            id={t.id}
            title={t.title}
            body={t.body}
            level={(t.level ?? 'info') as ToastLevel}
          />
        ))}
      </div>
    </>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    position:      'fixed',
    bottom:        'calc(var(--statusbar-height) + var(--space-4))',
    right:         'var(--space-4)',
    zIndex:        9999,
    display:       'flex',
    flexDirection: 'column',
    gap:           'var(--space-2)',
    pointerEvents: 'none' as never,
    alignItems:    'flex-end',
  },
  toast: {
    display:      'flex',
    alignItems:   'flex-start',
    gap:          'var(--space-3)',
    padding:      '10px 14px',
    borderRadius: 'var(--radius-lg)',
    boxShadow:    '0 4px 16px rgba(0,0,0,0.24)',
    maxWidth:     340,
    minWidth:     240,
    pointerEvents:'auto' as never,
    backdropFilter: 'blur(8px)',
  },
  content: {
    flex:          1,
    display:       'flex',
    flexDirection: 'column',
    gap:           2,
    minWidth:      0,
  },
  title: {
    fontSize:   'var(--text-sm)',
    fontWeight: 'var(--weight-semibold)' as never,
    color:      'var(--color-text-primary)',
    lineHeight: 1.3,
  },
  body: {
    fontSize:  'var(--text-xs)',
    color:     'var(--color-text-secondary)',
    lineHeight: 1.4,
  },
  close: {
    display:      'flex',
    alignItems:   'center',
    justifyContent:'center',
    background:   'transparent',
    border:       'none',
    color:        'var(--color-text-muted)',
    cursor:       'pointer',
    padding:      2,
    borderRadius: 'var(--radius-sm)',
    flexShrink:   0,
    marginTop:    -1,
  },
}
