import { Loader2 } from 'lucide-react'
import { cx } from '../../lib/utils'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size    = 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:  Variant
  size?:     Size
  loading?:  boolean
  icon?:     React.ReactNode
  iconRight?:React.ReactNode
}

export function Button({
  variant  = 'secondary',
  size     = 'md',
  loading  = false,
  icon,
  iconRight,
  children,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading

  const base: React.CSSProperties = {
    display:        'inline-flex',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '6px',
    borderRadius:   'var(--radius-md)',
    fontFamily:     'var(--font-sans)',
    fontWeight:     'var(--weight-medium)' as never,
    cursor:         isDisabled ? 'not-allowed' : 'pointer',
    opacity:        isDisabled ? 0.5 : 1,
    border:         'none',
    transition:     'background var(--transition-fast), opacity var(--transition-fast)',
    whiteSpace:     'nowrap',
    userSelect:     'none',
  }

  const sizes: Record<Size, React.CSSProperties> = {
    sm: { fontSize: 'var(--text-xs)', padding: '4px 10px', height: 28 },
    md: { fontSize: 'var(--text-sm)', padding: '6px 14px', height: 34 },
    lg: { fontSize: 'var(--text-base)',padding:'8px 20px', height: 40 },
  }

  const variants: Record<Variant, React.CSSProperties> = {
    primary:   { background: 'var(--color-teal-600)',  color: 'white' },
    secondary: { background: 'var(--color-bg-elevated)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' },
    ghost:     { background: 'transparent', color: 'var(--color-text-secondary)' },
    danger:    { background: 'var(--color-red-muted)', color: 'var(--color-red-400)', border: '1px solid rgba(218,80,57,0.3)' },
  }

  return (
    <button
      disabled={isDisabled}
      style={{ ...base, ...sizes[size], ...variants[variant], ...style }}
      {...props}
    >
      {loading ? <Loader2 size={13} style={{ animation: 'spin 800ms linear infinite' }} /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  )
}
