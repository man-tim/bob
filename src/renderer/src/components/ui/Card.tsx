interface CardProps {
  children:  React.ReactNode
  title?:    string
  subtitle?: string
  action?:   React.ReactNode
  padding?:  boolean
  style?:    React.CSSProperties
  onClick?:  () => void
}

export function Card({ children, title, subtitle, action, padding = true, style, onClick }: CardProps) {
  return (
    <div
      onClick={onClick}
      style={{
        background:   'var(--color-bg-surface)',
        border:       '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        overflow:     'hidden',
        cursor:       onClick ? 'pointer' : undefined,
        transition:   onClick ? 'border-color var(--transition-fast)' : undefined,
        ...style,
      }}
    >
      {(title || action) && (
        <div style={{
          display:       'flex',
          alignItems:    'center',
          justifyContent:'space-between',
          padding:       'var(--space-4) var(--space-5)',
          borderBottom:  children ? '1px solid var(--color-border)' : undefined,
        }}>
          <div>
            {title && (
              <h3 style={{
                fontSize:   'var(--text-sm)',
                fontWeight: 'var(--weight-semibold)' as never,
                color:      'var(--color-text-primary)',
              }}>{title}</h3>
            )}
            {subtitle && (
              <p style={{
                fontSize: 'var(--text-xs)',
                color:    'var(--color-text-muted)',
                marginTop: 2,
              }}>{subtitle}</p>
            )}
          </div>
          {action && <div>{action}</div>}
        </div>
      )}
      <div style={padding ? { padding: 'var(--space-5)' } : undefined}>
        {children}
      </div>
    </div>
  )
}

// ─── Stat card ────────────────────────────────────────────────────────────────

interface StatCardProps {
  label:    string
  value:    string | number
  sub?:     string
  icon?:    React.ReactNode
  accent?:  string
  trend?:   'up' | 'down' | 'flat'
}

export function StatCard({ label, value, sub, icon, accent }: StatCardProps) {
  return (
    <div style={{
      background:   'var(--color-bg-surface)',
      border:       '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      padding:      'var(--space-5)',
      display:      'flex',
      flexDirection:'column',
      gap:          'var(--space-3)',
    }}>
      <div style={{
        display:       'flex',
        alignItems:    'center',
        justifyContent:'space-between',
      }}>
        <span style={{
          fontSize:  'var(--text-xs)',
          fontWeight:'var(--weight-semibold)' as never,
          color:     'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>{label}</span>
        {icon && (
          <span style={{ color: accent ?? 'var(--color-text-muted)', opacity: 0.7 }}>
            {icon}
          </span>
        )}
      </div>
      <div>
        <span style={{
          fontSize:   'var(--text-3xl)',
          fontWeight: 'var(--weight-bold)' as never,
          color:      accent ?? 'var(--color-text-primary)',
          lineHeight: 1,
        }}>{value}</span>
        {sub && (
          <p style={{
            fontSize:  'var(--text-xs)',
            color:     'var(--color-text-muted)',
            marginTop: 'var(--space-1)',
          }}>{sub}</p>
        )}
      </div>
    </div>
  )
}
