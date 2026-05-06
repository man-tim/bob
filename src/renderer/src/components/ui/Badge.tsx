import { tierLabel, tierColor } from '../../lib/utils'
import type { CompanyTier } from '@shared/types'

type BadgeVariant = 'teal' | 'gold' | 'green' | 'red' | 'gray' | 'custom'

interface BadgeProps {
  label:     string
  variant?:  BadgeVariant
  color?:    string          // used when variant='custom'
  dot?:      boolean
  style?:    React.CSSProperties
}

const BG: Record<BadgeVariant, string> = {
  teal:   'var(--color-teal-muted)',
  gold:   'var(--color-gold-muted)',
  green:  'var(--color-green-muted)',
  red:    'var(--color-red-muted)',
  gray:   'rgba(255,255,255,0.06)',
  custom: 'transparent',
}

const FG: Record<BadgeVariant, string> = {
  teal:   'var(--color-teal-400)',
  gold:   'var(--color-gold-500)',
  green:  'var(--color-green-400)',
  red:    'var(--color-red-400)',
  gray:   'var(--color-text-muted)',
  custom: 'inherit',
}

export function Badge({ label, variant = 'gray', color, dot, style }: BadgeProps) {
  const fg = variant === 'custom' ? (color ?? 'inherit') : FG[variant]
  const bg = variant === 'custom'
    ? `${color ?? 'currentColor'}18`
    : BG[variant]

  return (
    <span style={{
      display:      'inline-flex',
      alignItems:   'center',
      gap:          4,
      padding:      '2px 8px',
      borderRadius: 'var(--radius-full)',
      fontSize:     'var(--text-xs)',
      fontWeight:   'var(--weight-semibold)' as never,
      background:   bg,
      color:        fg,
      whiteSpace:   'nowrap',
      ...style,
    }}>
      {dot && (
        <span style={{
          width: 5, height: 5,
          borderRadius: '50%',
          background: fg,
          flexShrink: 0,
        }} />
      )}
      {label}
    </span>
  )
}

// ─── Convenience: Tier Badge ──────────────────────────────────────────────────

export function TierBadge({ tier }: { tier: CompanyTier }) {
  const color = tierColor(tier)
  return <Badge label={tierLabel(tier)} variant="custom" color={color} />
}

// ─── Convenience: Health Score Badge ─────────────────────────────────────────

export function HealthBadge({ score }: { score: number | null }) {
  if (score === null) return <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>—</span>
  const variant: BadgeVariant = score >= 70 ? 'green' : score >= 40 ? 'gold' : 'red'
  return <Badge label={`${Math.round(score)}`} variant={variant} dot />
}

// ─── Convenience: Job Status Badge ───────────────────────────────────────────

const JOB_STATUS_VARIANT: Record<string, BadgeVariant> = {
  pending:   'gray',
  running:   'teal',
  completed: 'green',
  failed:    'red',
  cancelled: 'gray',
  paused:    'gold',
}

export function JobStatusBadge({ status }: { status: string }) {
  return <Badge label={status} variant={JOB_STATUS_VARIANT[status] ?? 'gray'} dot />
}
