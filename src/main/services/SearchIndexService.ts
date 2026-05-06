import fs   from 'fs'
import path from 'path'
import { app } from 'electron'
import Fuse from 'fuse.js'
import { ulid } from 'ulid'
import { getDb } from '../db/database'
import { registerJobHandler } from '../jobs/JobRunner'
import { JobQueue } from '../jobs/JobQueue'
import {
  FUSE_THRESHOLD, FUSE_DISTANCE,
  SEARCH_CACHE_SIZE, SEARCH_MIN_CHARS,
} from '@shared/constants'
import type { KnowledgePage, Job } from '@shared/types'
import type { GlobalSearchResult } from './CompanyService'

// ─── Knowledge page seeding ───────────────────────────────────────────────────

function getDataDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'data')
    : path.join(app.getAppPath(), 'resources', 'data')
}

interface RawPage {
  id?:         string
  title:       string
  url:         string
  content:     string
  section?:    string | null
  lastUpdated: string
}

function seedKnowledgePages(jobId: string): number {
  const db      = getDb()
  const dataDir = getDataDir()
  const files: Array<{ path: string; source: 'internal' | 'customer' }> = [
    { path: path.join(dataDir, 'internal.json'), source: 'internal' },
    { path: path.join(dataDir, 'customer.json'), source: 'customer' },
  ]

  const upsert = db.prepare(`
    INSERT INTO knowledge_pages (id, source, title, url, content, section, last_updated, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(url) DO UPDATE SET
      title       = excluded.title,
      content     = excluded.content,
      section     = excluded.section,
      last_updated= excluded.last_updated,
      indexed_at  = datetime('now')
  `)

  let total = 0
  const insertAll = db.transaction(() => {
    for (const { path: filePath, source } of files) {
      if (!fs.existsSync(filePath)) {
        JobQueue.log(jobId, 'warn', `Knowledge data file not found: ${filePath}`)
        continue
      }

      const raw    = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RawPage[]
      JobQueue.log(jobId, 'info', `Seeding ${raw.length} ${source} pages…`)

      for (const page of raw) {
        upsert.run(
          page.id ?? ulid(),
          source,
          page.title,
          page.url,
          page.content,
          page.section ?? null,
          page.lastUpdated,
        )
        total++
      }
    }
  })

  insertAll()
  return total
}

// ─── Register job handler ─────────────────────────────────────────────────────

registerJobHandler('index_rebuild', async (job: Job) => {
  JobQueue.log(job.id, 'step', 'Seeding knowledge pages from source data…')
  const seeded = seedKnowledgePages(job.id)
  JobQueue.log(job.id, 'ok', `Seeded ${seeded} knowledge pages`)

  JobQueue.log(job.id, 'step', 'Rebuilding Fuse.js search indexes…')
  SearchIndexService.rebuild()

  const db = getDb()
  const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_pages').get() as { cnt: number }
  JobQueue.log(job.id, 'ok', `Search index ready — ${cnt} pages indexed`)
})

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  item: KnowledgePage
  score: number
  highlights: { title: string; snippet: string }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const _cache = new Map<string, SearchResult[]>()

function cacheSet(key: string, value: SearchResult[]): void {
  if (_cache.size >= SEARCH_CACHE_SIZE) {
    // FIFO eviction
    const firstKey = _cache.keys().next().value
    if (firstKey) _cache.delete(firstKey)
  }
  _cache.set(key, value)
}

// ─── Fuse instances ───────────────────────────────────────────────────────────

let _internalIndex: Fuse<KnowledgePage> | null = null
let _customerIndex: Fuse<KnowledgePage> | null = null

const FUSE_OPTIONS: Fuse.IFuseOptions<KnowledgePage> = {
  keys: [
    { name: 'title',   weight: 0.45 },
    { name: 'content', weight: 0.40 },
    { name: 'section', weight: 0.15 },
  ],
  threshold:         FUSE_THRESHOLD,
  distance:          FUSE_DISTANCE,
  minMatchCharLength: SEARCH_MIN_CHARS,
  includeScore:      true,
  includeMatches:    true,
}

// ─── Highlight helper ─────────────────────────────────────────────────────────

function buildHighlight(
  page: KnowledgePage,
  matches: readonly Fuse.FuseResultMatch[] = []
): { title: string; snippet: string } {
  const titleMatch   = matches.find(m => m.key === 'title')
  const contentMatch = matches.find(m => m.key === 'content')

  // Simple mark-injection without HTML — return plain strings with <<marks>>
  // The renderer can replace <<...>> with <mark> tags after HTML-escaping
  let title   = page.title
  let snippet = ''

  if (contentMatch?.indices?.length) {
    const bestIdx = contentMatch.indices[0]
    const start   = Math.max(0, bestIdx[0] - 80)
    const end     = Math.min(page.content.length, bestIdx[1] + 120)
    snippet = (start > 0 ? '…' : '') + page.content.slice(start, end) + (end < page.content.length ? '…' : '')
  } else {
    snippet = page.content.slice(0, 160) + (page.content.length > 160 ? '…' : '')
  }

  return { title, snippet }
}

// ─── SearchIndexService ───────────────────────────────────────────────────────

export const SearchIndexService = {

  // Seed knowledge_pages from bundled JSON if table is empty
  seedKnowledge(): void {
    const db = getDb()
    const count = (db.prepare('SELECT COUNT(*) as n FROM knowledge_pages').get() as { n: number }).n
    if (count > 0) return // already seeded

    const dataDir = app.isPackaged
      ? path.join(process.resourcesPath, 'resources', 'data')
      : path.join(__dirname, '../../../resources/data')

    const insert = db.prepare(
      `INSERT OR IGNORE INTO knowledge_pages (id, source, title, url, content, section, last_updated)
       VALUES (@id, @source, @title, @url, @content, @section, @last_updated)`
    )

    for (const source of ['internal', 'customer'] as const) {
      try {
        const file = path.join(dataDir, `${source}.json`)
        const pages = JSON.parse(fs.readFileSync(file, 'utf-8')) as Array<{
          id: string; title: string; url: string; content: string;
          section?: string; lastUpdated?: string
        }>
        const batch = db.transaction(() => {
          for (const p of pages) {
            insert.run({
              id:           p.id,
              source,
              title:        p.title,
              url:          p.url,
              content:      p.content,
              section:      p.section ?? null,
              last_updated: p.lastUpdated ?? new Date().toISOString().slice(0, 10),
            })
          }
        })
        batch()
        console.log(`[Search] Seeded ${pages.length} ${source} pages`)
      } catch (e) {
        console.error(`[Search] Failed to seed ${source}:`, e)
      }
    }

    this.rebuild()
  },

  rebuild(): void {
    const db = getDb()
    const allPages = db
      .prepare('SELECT * FROM knowledge_pages')
      .all() as KnowledgePage[]

    const internal = allPages.filter(p => p.source === 'internal')
    const customer = allPages.filter(p => p.source === 'customer')

    _internalIndex = new Fuse(internal, FUSE_OPTIONS)
    _customerIndex = new Fuse(customer, FUSE_OPTIONS)
    _cache.clear()

    console.log(`[Search] Indexes rebuilt — internal: ${internal.length}, customer: ${customer.length}`)
  },

  _ensureIndexes(): void {
    if (!_internalIndex || !_customerIndex) this.rebuild()
  },

  search(query: string, source: 'internal' | 'customer' | 'all' = 'all'): SearchResult[] {
    // Empty query: return all items (used by Knowledge Assistant to browse)
    if (!query || query.length < SEARCH_MIN_CHARS) {
      this._ensureIndexes()
      const db = getDb()
      const rows = db.prepare(
        source === 'all'
          ? 'SELECT * FROM knowledge_pages ORDER BY section, title'
          : 'SELECT * FROM knowledge_pages WHERE source = ? ORDER BY section, title'
      ).all(...(source === 'all' ? [] : [source])) as KnowledgePage[]
      return rows.map(item => ({ item, score: 100, highlights: { title: item.title, snippet: item.content.slice(0, 160) } }))
    }

    const cacheKey = `${source}:${query}`
    const cached   = _cache.get(cacheKey)
    if (cached) return cached

    this._ensureIndexes()

    const indexes: Fuse<KnowledgePage>[] = []
    if (source === 'internal' || source === 'all') indexes.push(_internalIndex!)
    if (source === 'customer' || source === 'all') indexes.push(_customerIndex!)

    const results: SearchResult[] = []

    for (const index of indexes) {
      const fuseResults = index.search(query, { limit: 20 })
      for (const r of fuseResults) {
        results.push({
          item:       r.item,
          score:      Math.round((1 - (r.score ?? 0)) * 100),
          highlights: buildHighlight(r.item, r.matches),
        })
      }
    }

    // Sort by score descending, deduplicate by URL
    const seen = new Set<string>()
    const deduped = results
      .sort((a, b) => b.score - a.score)
      .filter(r => {
        if (seen.has(r.item.url)) return false
        seen.add(r.item.url)
        return true
      })
      .slice(0, 30)

    cacheSet(cacheKey, deduped)
    return deduped
  },

  /**
   * Cross-entity global search: companies + transcripts + knowledge pages.
   * Returns a unified, ranked result list for the CSM Copilot search bar.
   */
  globalSearch(query: string, limit = 20): GlobalSearchResult[] {
    if (!query || query.trim().length < SEARCH_MIN_CHARS) return []

    const q   = query.trim().toLowerCase()
    const db  = getDb()
    const out: GlobalSearchResult[] = []

    // ── Companies ──────────────────────────────────────────────────────────────
    const companies = db.prepare(`
      SELECT id, name, tier, industry, csm_owner, notes
      FROM companies
      WHERE name LIKE ? OR industry LIKE ? OR csm_owner LIKE ? OR notes LIKE ?
      LIMIT 10
    `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`) as Array<{
      id: string; name: string; tier: string;
      industry: string | null; csm_owner: string | null; notes: string | null
    }>

    for (const c of companies) {
      // Simple relevance: exact name match scores highest
      const nameNorm = c.name.toLowerCase()
      const score = nameNorm === q ? 95
        : nameNorm.startsWith(q) ? 85
        : nameNorm.includes(q)  ? 70
        : 55

      out.push({
        type:     'company',
        id:       c.id,
        title:    c.name,
        subtitle: [c.tier, c.industry, c.csm_owner].filter(Boolean).join(' · '),
        snippet:  c.notes ? c.notes.slice(0, 120) : undefined,
        score,
      })
    }

    // ── Transcripts ────────────────────────────────────────────────────────────
    const transcripts = db.prepare(`
      SELECT t.id, t.call_title, t.called_at, t.summary, t.action_items,
             t.company_id, c.name AS company_name
      FROM transcripts t
      LEFT JOIN companies c ON c.id = t.company_id
      WHERE t.call_title LIKE ? OR t.summary LIKE ? OR t.action_items LIKE ?
      ORDER BY t.called_at DESC
      LIMIT 10
    `).all(`%${q}%`, `%${q}%`, `%${q}%`) as Array<{
      id: string; call_title: string | null; called_at: string;
      summary: string | null; action_items: string | null;
      company_id: string | null; company_name: string | null
    }>

    for (const t of transcripts) {
      const title    = t.call_title ?? 'Untitled call'
      const titleNorm = title.toLowerCase()
      const score    = titleNorm.includes(q) ? 72 : 50

      let snippet: string | undefined
      if (t.summary) {
        snippet = t.summary.slice(0, 120)
      } else if (t.action_items) {
        const items = JSON.parse(t.action_items) as string[]
        snippet = items[0]
      }

      out.push({
        type:      'transcript',
        id:        t.id,
        title,
        subtitle:  t.company_name
          ? `${t.company_name} · ${new Date(t.called_at).toLocaleDateString()}`
          : new Date(t.called_at).toLocaleDateString(),
        snippet,
        score,
        companyId: t.company_id ?? undefined,
      })
    }

    // ── Knowledge pages ────────────────────────────────────────────────────────
    const knowledgeResults = this.search(query, 'all').slice(0, 8)
    for (const r of knowledgeResults) {
      out.push({
        type:     'knowledge',
        id:       r.item.id,
        title:    r.item.title,
        subtitle: r.item.section ?? r.item.source,
        snippet:  r.highlights.snippet,
        score:    Math.round(r.score * 0.9),  // slight down-weight vs CRM data
        url:      r.item.url,
      })
    }

    // Sort by score, dedup by id+type, trim to limit
    const seen = new Set<string>()
    return out
      .sort((a, b) => b.score - a.score)
      .filter(r => {
        const key = `${r.type}:${r.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, limit)
  },
}
