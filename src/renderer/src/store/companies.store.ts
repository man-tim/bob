import { create } from 'zustand'
import { companiesApi } from '../lib/ipc'
import type { Company, CompanyListQuery, PaginatedResult } from '@shared/types'

interface CompaniesStore {
  result:   PaginatedResult<Company> | null
  query:    CompanyListQuery
  loading:  boolean
  selected: Company | null

  fetch:      (query?: CompanyListQuery) => Promise<void>
  setQuery:   (patch: Partial<CompanyListQuery>) => void
  setSelected:(company: Company | null) => void
  upsert:     (data: Partial<Company> & { name: string }) => Promise<Company | null>
  remove:     (id: string) => Promise<void>
  importFromHubSpot: () => Promise<string | null>   // returns jobId
}

export const useCompaniesStore = create<CompaniesStore>((set, get) => ({
  result:   null,
  query:    { page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc' },
  loading:  false,
  selected: null,

  async fetch(query) {
    const q = query ?? get().query
    set({ loading: true, query: q })
    try {
      const result = await companiesApi.list(q)
      if (result.ok) set({ result: result.data })
    } finally {
      set({ loading: false })
    }
  },

  setQuery(patch) {
    // Only reset to page 1 for filter/sort changes — not when paginating
    const next = { ...get().query, ...patch }
    if (!('page' in patch)) next.page = 1
    set({ query: next })
    get().fetch(next)
  },

  setSelected(company) { set({ selected: company }) },

  async upsert(data) {
    const result = await companiesApi.upsert(data)
    if (result.ok) {
      await get().fetch()
      return result.data
    }
    return null
  },

  async remove(id) {
    await companiesApi.delete(id)
    await get().fetch()
    if (get().selected?.id === id) set({ selected: null })
  },

  async importFromHubSpot() {
    const result = await companiesApi.import()
    return result.ok ? (result.data as { jobId?: string })?.jobId ?? null : null
  },
}))
