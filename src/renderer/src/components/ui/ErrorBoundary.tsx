import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props  { children: ReactNode }
interface State  { hasError: boolean; error: Error | null; info: ErrorInfo | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught render error:', error, info)
    this.setState({ info })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <div style={styles.iconWrap}>
            <AlertTriangle size={28} strokeWidth={1.5} style={{ color: '#DA5039' }} />
          </div>
          <h2 style={styles.heading}>Something went wrong</h2>
          <p style={styles.message}>
            {this.state.error?.message ?? 'An unexpected error occurred in this view.'}
          </p>
          {this.state.info && (
            <details style={styles.details}>
              <summary style={styles.summary}>Stack trace</summary>
              <pre style={styles.stack}>
                {this.state.error?.stack ?? this.state.info.componentStack}
              </pre>
            </details>
          )}
          <button
            style={styles.reloadBtn}
            onClick={() => this.setState({ hasError: false, error: null, info: null })}
          >
            <RefreshCw size={14} strokeWidth={2} />
            Try again
          </button>
        </div>
      </div>
    )
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    width:          '100%',
    height:         '100%',
    padding:        'var(--space-8)',
    background:     'var(--color-bg-base)',
  },
  card: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    gap:           'var(--space-4)',
    maxWidth:      480,
    padding:       'var(--space-8)',
    background:    'var(--color-bg-card)',
    border:        '1px solid var(--color-border)',
    borderRadius:  'var(--radius-xl)',
    textAlign:     'center' as never,
  },
  iconWrap: {
    width:          56,
    height:         56,
    borderRadius:   'var(--radius-full)',
    background:     'rgba(218, 80, 57, 0.1)',
    border:         '1px solid rgba(218, 80, 57, 0.2)',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
  },
  heading: {
    fontSize:   'var(--text-xl)',
    fontWeight: 'var(--weight-bold)' as never,
    color:      'var(--color-text-primary)',
    margin:     0,
  },
  message: {
    fontSize:  'var(--text-sm)',
    color:     'var(--color-text-secondary)',
    lineHeight: 1.5,
    margin:    0,
  },
  details: {
    width:     '100%',
    textAlign: 'left' as never,
  },
  summary: {
    fontSize:  'var(--text-xs)',
    color:     'var(--color-text-muted)',
    cursor:    'pointer',
    marginBottom: 8,
  },
  stack: {
    fontSize:          10,
    color:             'var(--color-text-muted)',
    background:        'var(--color-bg-base)',
    border:            '1px solid var(--color-border)',
    borderRadius:      'var(--radius-sm)',
    padding:           'var(--space-3)',
    overflow:          'auto',
    maxHeight:         180,
    whiteSpace:        'pre-wrap' as never,
    textAlign:         'left' as never,
    margin:            0,
    fontFamily:        'var(--font-mono)',
    userSelect:        'text' as never,
    WebkitUserSelect:  'text' as never,
    cursor:            'text',
  },
  reloadBtn: {
    display:      'flex',
    alignItems:   'center',
    gap:          6,
    padding:      '8px 20px',
    background:   'var(--color-teal-600)',
    color:        'white',
    border:       'none',
    borderRadius: 'var(--radius-md)',
    fontSize:     'var(--text-sm)',
    fontWeight:   'var(--weight-medium)' as never,
    cursor:       'pointer',
  },
}
