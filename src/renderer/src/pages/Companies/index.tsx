import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, RefreshCw, Database, ChevronRight, Trash2 } from 'lucide-react'
import { Button, TierBadge, HealthBadge, Card } from '../../components/ui'
import { DataGrid, Pagination } from '../../components/ui'
import { useCompaniesStore } from '../../store/companies.store'
import { useUIStore } from '../../store/ui.store'
import { formatARR } from '../../lib/utils'
import { gongScraperApi, masterRefreshApi, companiesResetApi, fsApi } from '../../lib/ipc'
import type { Company, CompanyTier } from '@shared/types'
import type { Column } from '../../components/ui/DataGrid'

const TIER_OPTIONS: { value: CompanyTier | ''; label: string }[] = [
  { value: '',            label: 'All Tiers' },
  { value: 'enterprise',  label: 'Enterprise' },
  { value: 'mid_market',  label: 'Mid-Market' },
  { value: 'smb',         label: 'SMB' },
  { value: 'trial',       label: 'Trial' },
  { value: 'churned',     label: 'Churned' },
]

const CELL = { fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }
const MUTED = { fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }

// ─── My Health Grade ──────────────────────────────────────────────────────────
type HealthGrade = 'great' | 'good' | 'neutral' | 'risky' | ''

const HEALTH_GRADE_OPTIONS: { value: HealthGrade; label: string; color: string; bg: string }[] = [
  { value: '',        label: '— Not set',  color: 'var(--color-text-muted)',     bg: 'transparent' },
  { value: 'great',  label: '🟢 Great',   color: '#16a34a',                     bg: 'rgba(22,163,74,0.1)' },
  { value: 'good',   label: '🔵 Good',    color: '#2563eb',                     bg: 'rgba(37,99,235,0.1)' },
  { value: 'neutral',label: '🟡 Neutral', color: '#ca8a04',                     bg: 'rgba(202,138,4,0.1)' },
  { value: 'risky',  label: '🔴 Risky',   color: '#dc2626',                     bg: 'rgba(220,38,38,0.1)' },
]

const GRADES_KEY = 'company-health-grades'

function loadGrades(): Record<string, HealthGrade> {
  try { return JSON.parse(localStorage.getItem(GRADES_KEY) ?? '{}') } catch { return {} }
}
function saveGrades(g: Record<string, HealthGrade>) {
  localStorage.setItem(GRADES_KEY, JSON.stringify(g))
}

// ─── Columns ──────────────────────────────────────────────────────────────────

function makeColumns(
  onOpen: (id: string) => void,
  grades: Record<string, HealthGrade>,
  setGrade: (id: string, g: HealthGrade) => void,
): Column<Company>[] {
  return [
    // ── My Health Grade — sticky first column ─────────────────────────────────
    {
      key: 'my_health_grade', header: 'My Health Grade', width: 155, stickyFirst: true,
      render: row => {
        const grade = grades[row.id] ?? ''
        const opt   = HEALTH_GRADE_OPTIONS.find(o => o.value === grade) ?? HEALTH_GRADE_OPTIONS[0]
        return (
          <select
            value={grade}
            onClick={e => e.stopPropagation()}
            onChange={e => { e.stopPropagation(); setGrade(row.id, e.target.value as HealthGrade) }}
            style={{
              fontSize: 'var(--text-xs)',
              padding: '2px 6px',
              borderRadius: 'var(--radius-sm)',
              border: `1px solid ${opt.color === 'var(--color-text-muted)' ? 'var(--color-border)' : opt.color}`,
              background: opt.bg,
              color: opt.color,
              cursor: 'pointer',
              outline: 'none',
              width: 125,
            }}
          >
            {HEALTH_GRADE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )
      },
    },
    {
      key: 'name', header: 'Company Name', sortable: true,
      render: row => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div>
            <div style={{ fontWeight: 'var(--weight-medium)' as never, color: 'var(--color-text-primary)' }}>
              {row.name}
            </div>
            {row.industry && (
              <div style={MUTED}>{row.industry}</div>
            )}
          </div>
          <button
            title="Copy company name"
            onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(row.name) }}
            style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 2, borderRadius: 3, opacity: 0.5 }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
              <path d="M10.5 1.5H3.5a1 1 0 00-1 1v9h1v-9h7v-1zm2 2h-7a1 1 0 00-1 1v9a1 1 0 001 1h7a1 1 0 001-1v-9a1 1 0 00-1-1zm0 10h-7v-9h7v9z"/>
            </svg>
          </button>
        </div>
      ),
    },
    {
      key: 'hubspot_url', header: 'HubSpot', width: 100,
      render: row => row.hubspot_url ? (
        <button
          style={{
            background: 'none', border: 'none', padding: 0,
            color: 'var(--color-teal-400)', fontSize: 'var(--text-xs)',
            cursor: 'pointer', textDecoration: 'underline', fontWeight: 500,
          }}
          onClick={e => { e.stopPropagation(); fsApi.openExternal(row.hubspot_url!) }}
          title="Open HubSpot profile"
        >
          (HubSpot Link)
        </button>
      ) : <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>—</span>,
    },
    {
      key: 'last_contacted', header: 'Last Contacted', width: 130, sortable: true,
      render: row => (
        <span style={MUTED}>{row.last_contacted ?? '—'}</span>
      ),
    },
    {
      key: 'renewal_date', header: 'Renewal Date', width: 120, sortable: true,
      render: row => (
        <span style={MUTED}>{row.renewal_date ?? '—'}</span>
      ),
    },
    {
      key: 'arr', header: 'ARR', width: 100, sortable: true,
      render: row => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>
          {formatARR(row.arr)}
        </span>
      ),
    },
    {
      key: 'csm_owner', header: 'Company Owner', width: 150, sortable: true,
      render: row => (
        <span style={row.csm_owner ? CELL : MUTED}>{row.csm_owner ?? '—'}</span>
      ),
    },
    {
      key: 'phone', header: 'Phone Number', width: 130, sortable: true,
      render: row => (
        <span style={row.phone ? CELL : MUTED}>{row.phone ?? '—'}</span>
      ),
    },
    {
      key: 'last_activity_date', header: 'Last Activity', width: 120, sortable: true,
      render: row => (
        <span style={MUTED}>{row.last_activity_date ?? '—'}</span>
      ),
    },
    {
      key: 'city', header: 'City', width: 110, sortable: true,
      render: row => (
        <span style={row.city ? CELL : MUTED}>{row.city ?? '—'}</span>
      ),
    },
    {
      key: 'country', header: 'Country/Region', width: 130, sortable: true,
      render: row => (
        <span style={row.country ? CELL : MUTED}>{row.country ?? '—'}</span>
      ),
    },
    {
      key: 'tier', header: 'PK Account Tier', width: 130, sortable: true,
      render: row => <TierBadge tier={row.tier} />,
    },
    {
      key: 'subscribed_locations', header: 'Subscribed Locations', width: 160, sortable: true,
      render: row => (
        <span style={row.subscribed_locations ? CELL : MUTED}>{row.subscribed_locations ?? '—'}</span>
      ),
    },
    {
      key: 'potential_locations', header: 'Potential Locations', width: 160, sortable: true,
      render: row => (
        <span style={row.potential_locations ? CELL : MUTED}>{row.potential_locations ?? '—'}</span>
      ),
    },
    {
      key: 'subscription_state', header: 'Subscription State', width: 150, sortable: true,
      render: row => (
        <span style={row.subscription_state ? CELL : MUTED}>{row.subscription_state ?? '—'}</span>
      ),
    },
    {
      key: 'health_score', header: 'Health', width: 80, sortable: true,
      render: row => <HealthBadge score={row.health_score} />,
    },
    {
      key: 'opportunity_locations', header: 'Opportunity Locations', width: 170, sortable: true,
      sortValue: (row) => {
        const sub = parseInt((row.subscribed_locations as string) ?? '0', 10) || 0
        const pot = parseInt((row.potential_locations  as string) ?? '0', 10) || 0
        return pot - sub
      },
      render: row => {
        const sub = parseInt(row.subscribed_locations ?? '0', 10) || 0
        const pot = parseInt(row.potential_locations  ?? '0', 10) || 0
        const opp = pot - sub
        if (isNaN(opp) || (pot === 0 && sub === 0)) return <span style={MUTED}>—</span>
        return (
          <span style={{ ...CELL, fontWeight: opp > 0 ? 600 : undefined, color: opp > 0 ? 'var(--color-teal-400)' : 'var(--color-text-muted)' }}>
            {opp > 0 ? `+${opp}` : opp}
          </span>
        )
      },
    },
    {
      key: 'id', header: '', width: 40, stickyLast: true,
      render: row => (
        <button
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none',
            color: 'var(--color-text-muted)', cursor: 'pointer', padding: 4,
          }}
          onClick={e => { e.stopPropagation(); onOpen(row.id) }}
          title="Open in CSM Copilot"
        >
          <ChevronRight size={14} strokeWidth={2} />
        </button>
      ),
    },
  ]
}

export function Companies() {
  const navigate    = useNavigate()
  const addToast    = useUIStore(s => s.addToast)
  const { result, query, loading, fetch, setQuery } = useCompaniesStore()
  const [search,    setSearch]    = useState('')
  const [syncing,   setSyncing]   = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [grades,       setGrades]       = useState<Record<string, HealthGrade>>(loadGrades)
  const [localSortKey, setLocalSortKey] = useState<string | null>(null)
  const [localSortDir, setLocalSortDir] = useState<'asc' | 'desc'>('asc')

  const setGrade = useCallback((id: string, g: HealthGrade) => {
    setGrades(prev => {
      const next = { ...prev, [id]: g }
      saveGrades(next)
      return next
    })
  }, [])

  const COLUMNS = makeColumns((id) => navigate(`/companies/${id}`), grades, setGrade)

  useEffect(() => { fetch() }, [])

  async function handleRefresh() {
    setSyncing(true)
    const r = await masterRefreshApi.refresh()
    setSyncing(false)
    if (r.ok) {
      addToast({ title: `Synced ${r.data.synced} companies from spreadsheet`, level: 'ok' })
      fetch({ page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc' })
    } else {
      addToast({ title: 'Sync failed', body: r.error, level: 'error' })
      fetch()
    }
  }

  async function handleReset() {
    if (!confirm('This will remove ALL companies from the app. You can re-import them from the spreadsheet with Refresh. Continue?')) return
    setResetting(true)
    await companiesResetApi.reset()
    setResetting(false)
    addToast({ title: 'Companies cleared', level: 'ok' })
    fetch({ page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc' })
  }

  function handleScrubCompanies() {
    setScrubbing(true)
    gongScraperApi.step1().then(() => setScrubbing(false))
    addToast({ title: 'Step 1 started', body: 'Check the Gong Scrubber page for progress.', level: 'info' })
  }

  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    setSearch(val)
    // Auto-clear the filter the moment the field is emptied
    if (!val) setQuery({ search: undefined })
  }
  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    setQuery({ search: search || undefined })
  }
  function handleClearSearch() {
    setSearch('')
    setQuery({ search: undefined })
  }
  function handleSort(key: string) {
    // Check if this column has a custom sortValue (client-side sort)
    const col = COLUMNS.find(c => c.key === key)
    if (col?.sortValue) {
      const nextDir = localSortKey === key && localSortDir === 'asc' ? 'desc' : 'asc'
      setLocalSortKey(key)
      setLocalSortDir(nextDir)
      return
    }
    // Server-side sort — clear any active local sort
    setLocalSortKey(null)
    const nextDir = query.sortBy === key && query.sortDir === 'asc' ? 'desc' : 'asc'
    setQuery({ sortBy: key, sortDir: nextDir })
  }

  // Apply client-side sort when a computed column is selected
  const displayRows = (() => {
    const base = result?.items ?? []
    if (!localSortKey) return base
    const col = COLUMNS.find(c => c.key === localSortKey)
    if (!col?.sortValue) return base
    const fn = col.sortValue
    return [...base].sort((a, b) => {
      const va = fn(a)
      const vb = fn(b)
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return localSortDir === 'asc' ? cmp : -cmp
    })
  })()

  return (
    <div className="page animate-fade-in">
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Companies</h1>
          <p className="page-subtitle">
            {query.search
              ? `${result?.total ?? 0} result${result?.total !== 1 ? 's' : ''} for "${query.search}" — `
              : result ? `${result.total.toLocaleString()} companies` : 'Master Book of Business'}
            {query.search && (
              <button onClick={handleClearSearch} style={{ color: 'var(--color-teal-400)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'inherit', padding: 0, textDecoration: 'underline' }}>
                clear filter
              </button>
            )}
          </p>
        </div>
        <div className="flex gap-3">
          <Button data-help="Reset Companies: removes all company records from the app's local database. Your Google Sheet is unaffected. Re-import with Refresh afterward." variant="ghost" size="sm" icon={<Trash2 size={14} />} loading={resetting} onClick={handleReset}>
            Reset Companies
          </Button>
          <Button data-help="Scrub Companies: opens HubSpot in the background, scrapes your full company list, and syncs it into the Master Spreadsheet and local database." variant="primary" size="sm" icon={<Database size={14} />} loading={scrubbing} onClick={handleScrubCompanies}>
            Scrub Companies / Create Master Spreadsheet
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 'var(--space-3)', marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
        <form onSubmit={submitSearch} style={{ flex: 1, minWidth: 200, maxWidth: 360, display: 'flex', gap: 'var(--space-2)' }}>
          <div style={{ flex: 1, position: 'relative' }} data-help="Search: type a company name to filter the list. Clearing the field automatically removes the filter.">
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)' }} />
            <input
              className="input input-sm"
              style={{ paddingLeft: 32 }}
              placeholder="Search companies…"
              value={search}
              onChange={handleSearch}
            />
          </div>
          <Button type="submit" variant="secondary" size="sm">Search</Button>
        </form>

        <select
          data-help="Tier filter: filter companies by their account tier — Enterprise, Mid-Market, SMB, Trial, or Churned."
          className="input input-sm select"
          style={{ width: 140 }}
          value={query.tier ?? ''}
          onChange={e => setQuery({ tier: (e.target.value as CompanyTier) || undefined })}
        >
          {TIER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <Button
          data-help="Refresh: pulls the latest company data from your Master Spreadsheet in Google Drive."
          variant="ghost" size="sm"
          icon={<RefreshCw size={13} />}
          loading={syncing || loading}
          onClick={handleRefresh}
        >
          Refresh
        </Button>
      </div>

      {/* Table */}
      <Card padding={false} style={{ overflow: 'hidden' }}>
        <DataGrid
          columns={COLUMNS}
          rows={displayRows}
          rowKey={r => r.id}
          loading={loading}
          sortBy={localSortKey ?? query.sortBy}
          sortDir={localSortKey ? localSortDir : (query.sortDir as 'asc' | 'desc')}
          onSort={handleSort}
          onRowClick={row => navigate(`/companies/${row.id}`)}
          emptyText="No companies found. Click 'Scrub Companies' to import from HubSpot."
          stickyHeader
          style={{ maxHeight: 'calc(100vh - 260px)' }}
        />
        {result && result.total > (query.pageSize ?? 50) && (
          <Pagination
            page={query.page ?? 1}
            pageSize={query.pageSize ?? 50}
            total={result.total}
            onChange={page => setQuery({ page })}
          />
        )}
      </Card>
    </div>
  )
}
