import { useRef, useEffect }                       from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'

export interface Column<T> {
  key:         string
  header:      string
  width?:      string | number
  sortable?:   boolean
  stickyLast?: boolean   // pin to right edge
  stickyFirst?: boolean  // pin to left edge
  sortValue?:  (row: T) => string | number  // custom extractor for client-side sort
  render:      (row: T, index: number) => React.ReactNode
}

interface DataGridProps<T> {
  columns:    Column<T>[]
  rows:       T[]
  rowKey:     (row: T) => string
  onRowClick?:(row: T) => void
  sortBy?:    string
  sortDir?:   'asc' | 'desc'
  onSort?:    (key: string) => void
  emptyText?:  string
  loading?:   boolean
  style?:     React.CSSProperties
  stickyHeader?: boolean
}

// ─── Reflective border wrapper ────────────────────────────────────────────────
//
// iOS 26-style "liquid metal" edge effect.
//
// BORDER: a warm gradient (bright top/bottom edges, dim middle) shifts its
// Y-position as you scroll, creating a parallax metallic sheen.
//
// EDGE FADES: semi-opaque gradient overlays appear at the top edge when content
// is scrolled down, and at the bottom edge when more content is below. These are
// the most visibly obvious part of the iOS-style scroll indicator.
//
// PERFORMANCE: all animations use direct DOM style mutation — no setState,
// no re-renders triggered by scroll.

const reflectiveWrapperStyle: React.CSSProperties = {
  ['--scroll-offset' as string]: '0',    // unitless px number, updated by onScroll
  position:       'relative',           // needed for the absolute edge-shadow overlays
  padding:          1,
  borderRadius:     'var(--radius-lg)',
  // Bright top/bottom edges taper toward a dim midpoint — gradient is 400% tall
  // so the midpoint region is mostly transparent, making the edges the star.
  background: [
    'linear-gradient(to bottom,',
    '  rgba(255,255,255,0.20) 0%,',
    '  rgba(255,255,255,0.07) 6%,',
    '  rgba(255,244,227,0.02) 20%,',
    '  transparent 40%,',
    '  rgba(255,244,227,0.02) 60%,',
    '  rgba(255,255,255,0.07) 90%,',
    '  rgba(255,255,255,0.20) 100%)',
  ].join(''),
  backgroundSize:   '100% 400%',
  // --scroll-offset is a unitless number (e.g. "200"), stored as a custom property.
  // Multiplying a unitless number by 0 produces 0, so this is actually valid only
  // if we treat it as a dimensionless factor. The trick: we wrap it in a px calc:
  //   calc(50% - (var(--scroll-offset) * 1px) * 0.18)
  // This converts the unitless number to px first, then scales it.
  backgroundPosition: 'calc(0%) calc(50% - var(--scroll-offset) * 0.18px)',
  boxShadow: [
    'inset 0  1px 0 rgba(255,255,255,0.16)',
    'inset 0 -1px 0 rgba(255,255,255,0.06)',
    '0 0 0 1px var(--color-border)',
    '0 2px 8px rgba(0,0,0,0.22)',
  ].join(', '),
}

export function DataGrid<T>({
  columns, rows, rowKey, onRowClick,
  sortBy, sortDir, onSort,
  emptyText = 'No data', loading, style,
  stickyHeader = false,
}: DataGridProps<T>) {
  const wrapperRef   = useRef<HTMLDivElement>(null)
  const scrollRef    = useRef<HTMLDivElement>(null)
  const topShadowRef = useRef<HTMLDivElement>(null)
  const botShadowRef = useRef<HTMLDivElement>(null)

  // After rows load/change, check if the table is tall enough to scroll and
  // prime the bottom-shadow opacity accordingly.
  useEffect(() => {
    const el = scrollRef.current
    const bot = botShadowRef.current
    if (!el || !bot) return
    // requestAnimationFrame ensures layout is settled before we measure
    requestAnimationFrame(() => {
      const canScroll = el.scrollHeight > el.clientHeight + 2
      bot.style.opacity = canScroll ? '1' : '0'
    })
  }, [rows, loading])

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el  = e.currentTarget
    const top = el.scrollTop
    const max = el.scrollHeight - el.clientHeight

    // 1. Reflective border parallax — store unitless number so calc can use it
    //    as "N * 1px" (see backgroundPosition in reflectiveWrapperStyle)
    wrapperRef.current?.style.setProperty('--scroll-offset', `${top}`)

    // 2. Edge shadows — fade in over the first/last 48px of scroll travel
    const FADE_PX = 48
    if (topShadowRef.current) {
      topShadowRef.current.style.opacity = String(Math.min(1, top / FADE_PX))
    }
    if (botShadowRef.current) {
      botShadowRef.current.style.opacity = String(Math.min(1, (max - top) / FADE_PX))
    }
  }

  // Shared style for the gradient edge overlays
  const edgeShadowBase: React.CSSProperties = {
    position: 'absolute',
    left: 1, right: 1,
    height: 48,
    pointerEvents: 'none',
    zIndex: 10,
    transition: 'opacity 120ms ease',
  }

  return (
    <div ref={wrapperRef} style={reflectiveWrapperStyle}>

      {/* ── Top scroll-edge fade ── */}
      <div
        ref={topShadowRef}
        style={{
          ...edgeShadowBase,
          top: 1,
          borderRadius: 'calc(var(--radius-lg) - 2px) calc(var(--radius-lg) - 2px) 0 0',
          background: 'linear-gradient(to bottom, var(--color-bg-surface) 0%, transparent 100%)',
          opacity: 0,
        }}
      />

      {/* ── Bottom scroll-edge fade ── */}
      <div
        ref={botShadowRef}
        style={{
          ...edgeShadowBase,
          bottom: 1,
          borderRadius: '0 0 calc(var(--radius-lg) - 2px) calc(var(--radius-lg) - 2px)',
          background: 'linear-gradient(to top, var(--color-bg-surface) 0%, transparent 100%)',
          opacity: 0,
        }}
      />

      {/* ── Scrollable table ── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          overflowX: 'auto',
          overflowY: stickyHeader ? 'auto' : undefined,
          borderRadius: 'calc(var(--radius-lg) - 2px)',
          background: 'var(--color-bg-surface)',
          ...style,
        }}
      >
        <table className="data-table" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              {columns.map(col => {
                const isLast  = col.stickyLast
                const isFirst = col.stickyFirst
                return (
                  <th
                    key={col.key}
                    style={{
                      width: col.width,
                      cursor: col.sortable ? 'pointer' : undefined,
                      ...(stickyHeader ? {
                        position: 'sticky', top: 0, zIndex: (isLast || isFirst) ? 3 : 2,
                        background: 'var(--color-bg-surface)',
                        boxShadow: 'inset 0 -1px 0 var(--color-border)',
                      } : {}),
                      ...(isLast ? {
                        position: 'sticky', right: 0,
                        zIndex: stickyHeader ? 3 : 2,
                        background: 'var(--color-bg-surface)',
                        boxShadow: '-2px 0 6px rgba(0,0,0,0.12)',
                      } : {}),
                      ...(isFirst ? {
                        position: 'sticky', left: 0,
                        zIndex: stickyHeader ? 3 : 2,
                        background: 'var(--color-bg-surface)',
                        boxShadow: '2px 0 6px rgba(0,0,0,0.12)',
                      } : {}),
                    }}
                    onClick={() => col.sortable && onSort?.(col.key)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {col.header}
                      {col.sortable && (
                        <SortIcon active={sortBy === col.key} dir={sortBy === col.key ? sortDir : undefined} />
                      )}
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--color-text-muted)' }}>
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--color-text-muted)' }}>
                  {emptyText}
                </td>
              </tr>
            ) : rows.map((row, i) => (
              <tr key={rowKey(row)} onClick={() => onRowClick?.(row)}>
                {columns.map(col => {
                  const isLast  = col.stickyLast
                  const isFirst = col.stickyFirst
                  return (
                    <td
                      key={col.key}
                      style={
                        isLast ? {
                          position: 'sticky', right: 0, zIndex: 1,
                          background: 'var(--color-bg-surface)',
                          boxShadow: '-2px 0 6px rgba(0,0,0,0.12)',
                        } : isFirst ? {
                          position: 'sticky', left: 0, zIndex: 1,
                          background: 'var(--color-bg-surface)',
                          boxShadow: '2px 0 6px rgba(0,0,0,0.12)',
                        } : undefined
                      }
                    >
                      {col.render(row, i)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SortIcon({ active, dir }: { active: boolean; dir?: 'asc' | 'desc' }) {
  const color = active ? 'var(--color-teal-500)' : 'var(--color-text-disabled)'
  if (!active) return <ChevronsUpDown size={11} color={color} />
  return dir === 'asc'
    ? <ChevronUp   size={11} color={color} />
    : <ChevronDown size={11} color={color} />
}

// ─── Pagination bar ───────────────────────────────────────────────────────────

interface PaginationProps {
  page:     number
  pageSize: number
  total:    number
  onChange: (page: number) => void
}

export function Pagination({ page, pageSize, total, onChange }: PaginationProps) {
  const totalPages = Math.ceil(total / pageSize)
  const start      = (page - 1) * pageSize + 1
  const end        = Math.min(page * pageSize, total)

  if (totalPages <= 1) return null

  return (
    <div style={{
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'space-between',
      padding:        'var(--space-3) var(--space-4)',
      borderTop:      '1px solid var(--color-border)',
      fontSize:       'var(--text-xs)',
      color:          'var(--color-text-muted)',
    }}>
      <span>{start}–{end} of {total.toLocaleString()}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        <PageBtn label="←" disabled={page <= 1}            onClick={() => onChange(page - 1)} />
        <PageBtn label={`${page} / ${totalPages}`} disabled onClick={() => {}} />
        <PageBtn label="→" disabled={page >= totalPages}   onClick={() => onChange(page + 1)} />
      </div>
    </div>
  )
}

function PageBtn({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding:      '3px 8px',
        borderRadius: 'var(--radius-sm)',
        border:       '1px solid var(--color-border)',
        background:   'var(--color-bg-elevated)',
        color:        disabled ? 'var(--color-text-disabled)' : 'var(--color-text-secondary)',
        fontSize:     'var(--text-xs)',
        cursor:       disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  )
}
