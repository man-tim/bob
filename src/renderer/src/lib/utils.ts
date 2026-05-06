import clsx, { ClassValue } from 'clsx'

export { clsx }
export function cx(...inputs: ClassValue[]) { return clsx(inputs) }

// ─── Date & Time ──────────────────────────────────────────────────────────────

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export function formatDayHeading(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })
}

export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1)  return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)   return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30)    return `${days}d ago`
  return formatDate(iso)
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function groupByDay<T>(items: T[], getDate: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const day = new Date(getDate(item)).toDateString()
    if (!map.has(day)) map.set(day, [])
    map.get(day)!.push(item)
  }
  return map
}

// ─── Numbers & Currency ───────────────────────────────────────────────────────

export function formatARR(value: number | null): string {
  if (!value) return '—'
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000)     return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

export function formatHealthScore(score: number | null): string {
  if (score === null) return '—'
  return `${Math.round(score)}`
}

export function healthColor(score: number | null): string {
  if (score === null) return 'var(--color-text-muted)'
  if (score >= 70)    return 'var(--color-health-high)'
  if (score >= 40)    return 'var(--color-health-medium)'
  return 'var(--color-health-low)'
}

// ─── Strings ──────────────────────────────────────────────────────────────────

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('')
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str
}

export function pluralize(count: number, singular: string, plural = singular + 's'): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

// ─── Tier display ─────────────────────────────────────────────────────────────

export function tierLabel(tier: string): string {
  const map: Record<string, string> = {
    enterprise: 'Enterprise', mid_market: 'Mid-Market',
    smb: 'SMB', trial: 'Trial', churned: 'Churned',
  }
  return map[tier] ?? tier
}

export function tierColor(tier: string): string {
  const map: Record<string, string> = {
    enterprise: 'var(--color-tier-enterprise)',
    mid_market: 'var(--color-tier-mid-market)',
    smb:        'var(--color-tier-smb)',
    trial:      'var(--color-tier-trial)',
    churned:    'var(--color-tier-churned)',
  }
  return map[tier] ?? 'var(--color-text-muted)'
}

// ─── IPC result unwrap ────────────────────────────────────────────────────────

export function unwrap<T>(result: { ok: boolean; data?: T; error?: string }): T {
  if (!result.ok) throw new Error(result.error ?? 'IPC call failed')
  return result.data as T
}
