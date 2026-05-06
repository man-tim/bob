import { ulid } from 'ulid'
import { getDb } from '../db/database'
import { registerJobHandler } from '../jobs/JobRunner'
import { JobQueue }           from '../jobs/JobQueue'
import type {
  Company, Contact, Transcript, CalendarEvent,
  CompanyListQuery, PaginatedResult,
  Schedule, FlyerTemplate, Job,
} from '@shared/types'

// ─── HubSpot import job handler ───────────────────────────────────────────────
// Registered here so CompanyService owns all company-data ingestion.
// Production implementation would use the HubSpot REST API (portal 8787210).

registerJobHandler('hubspot_import', async (job: Job) => {
  JobQueue.log(job.id, 'step', 'Starting HubSpot import…')
  JobQueue.log(job.id, 'info', `Target portal: ${process.env.HUBSPOT_PORTAL_ID ?? '8787210'}`)

  // ── Authentication check ──────────────────────────────────────────────────
  if (!process.env.HUBSPOT_API_KEY && !process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
    JobQueue.log(job.id, 'warn', 'No HubSpot credentials found in environment. Set HUBSPOT_API_KEY or HUBSPOT_PRIVATE_APP_TOKEN.')
    JobQueue.log(job.id, 'warn', 'Skipping import — add credentials and re-run.')
    return
  }

  // ── Placeholder for real import logic ─────────────────────────────────────
  // TODO: implement HubSpot CRM API call
  //   1. GET /crm/v3/objects/companies (paginate with `after` cursor)
  //   2. GET /crm/v3/objects/contacts (paginate, associate to companies)
  //   3. Upsert via CompanyService.upsert() + CompanyService.upsertContact()
  //   Reference: https://developers.hubspot.com/docs/api/crm/companies

  JobQueue.log(job.id, 'warn', 'HubSpot import stub — live API integration pending.')

  const db    = getDb()
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM companies').get() as { cnt: number }).cnt
  JobQueue.log(job.id, 'ok', `Import complete — ${count} companies currently in database.`)
})

// ─── Company Detail (CSM Copilot) ─────────────────────────────────────────────

export interface CompanyDetail {
  company:           Company
  contacts:          Contact[]
  transcripts:       Array<Transcript & { action_items: string[] | null }>
  upcomingEvents:    CalendarEvent[]
  callCount:         number
  lastCallAt:        string | null
  avgSentiment:      number | null
  recentActionItems: string[]
  speakers:          string[]
  driveFolder:       { id: string; url: string } | null
}

// ─── Global Search ────────────────────────────────────────────────────────────

export interface GlobalSearchResult {
  type:      'company' | 'transcript' | 'knowledge'
  id:        string
  title:     string
  subtitle?: string
  snippet?:  string
  score:     number
  url?:      string       // knowledge pages
  companyId?: string      // transcripts
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now() { return new Date().toISOString() }

// ─── Company CRUD ─────────────────────────────────────────────────────────────

export const CompanyService = {
  getNames(): string[] {
    const db = getDb()
    return (db.prepare('SELECT name FROM companies ORDER BY name').all() as Array<{name:string}>).map(r => r.name)
  },

  list(query: CompanyListQuery = {}): PaginatedResult<Company> {
    const db = getDb()
    const {
      search, tier, csmOwner,
      page = 1, pageSize = 50,
      sortBy = 'name', sortDir = 'asc',
    } = query

    const allowed = ['name','tier','arr','health_score','csm_owner','created_at','last_contacted','renewal_date','last_activity_date','city','country','subscribed_locations','potential_locations','subscription_state','phone','opportunity_locations']
    const isComputed = sortBy === 'opportunity_locations'
    const col = isComputed
      ? '(CAST(COALESCE(potential_locations,"0") AS INTEGER) - CAST(COALESCE(subscribed_locations,"0") AS INTEGER))'
      : (allowed.includes(sortBy) ? sortBy : 'name')
    const dir = sortDir === 'desc' ? 'DESC' : 'ASC'

    const conditions: string[] = []
    const params: unknown[] = []

    if (search) {
      conditions.push('(name LIKE ? OR industry LIKE ? OR csm_owner LIKE ?)')
      const like = `%${search}%`
      params.push(like, like, like)
    }
    if (tier)      { conditions.push('tier = ?');       params.push(tier) }
    if (csmOwner)  { conditions.push('csm_owner = ?');  params.push(csmOwner) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM companies ${where}`)
      .get(...params) as { cnt: number }).cnt

    const offset = (page - 1) * pageSize
    const items = db.prepare(
      `SELECT * FROM companies ${where} ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset) as Company[]

    return { items, total, page, pageSize }
  },

  get(id: string): Company | null {
    return getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id) as Company | null
  },

  upsert(data: Partial<Company> & { name: string }): Company {
    const db = getDb()
    const id = data.id ?? ulid()
    const existing = data.id ? this.get(data.id) : null

    if (existing) {
      db.prepare(`
        UPDATE companies SET
          name = ?, hubspot_id = ?, tier = ?, health_score = ?, arr = ?,
          industry = ?, csm_owner = ?, website = ?, notes = ?,
          phone = ?, city = ?, country = ?, last_contacted = ?, renewal_date = ?,
          last_activity_date = ?, subscribed_locations = ?, potential_locations = ?,
          subscription_state = ?, hubspot_url = COALESCE(?, hubspot_url),
          hubspot_synced_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        data.name || existing.name, data.hubspot_id ?? existing.hubspot_id,
        data.tier ?? existing.tier, data.health_score ?? existing.health_score,
        data.arr ?? existing.arr, data.industry ?? existing.industry,
        data.csm_owner ?? existing.csm_owner, data.website ?? existing.website,
        data.notes ?? existing.notes,
        data.phone ?? existing.phone, data.city ?? existing.city,
        data.country ?? existing.country, data.last_contacted ?? existing.last_contacted,
        data.renewal_date ?? existing.renewal_date,
        data.last_activity_date ?? existing.last_activity_date,
        data.subscribed_locations ?? existing.subscribed_locations,
        data.potential_locations ?? existing.potential_locations,
        data.subscription_state ?? existing.subscription_state,
        data.hubspot_url ?? null,
        data.hubspot_synced_at ?? existing.hubspot_synced_at,
        now(), id
      )
    } else {
      db.prepare(`
        INSERT INTO companies (id, name, hubspot_id, tier, health_score, arr, industry,
          csm_owner, website, notes, phone, city, country, last_contacted, renewal_date,
          last_activity_date, subscribed_locations, potential_locations, subscription_state,
          hubspot_url, hubspot_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, data.name, data.hubspot_id ?? null,
        data.tier ?? 'smb', data.health_score ?? null, data.arr ?? null,
        data.industry ?? null, data.csm_owner ?? null, data.website ?? null,
        data.notes ?? null, data.phone ?? null, data.city ?? null,
        data.country ?? null, data.last_contacted ?? null, data.renewal_date ?? null,
        data.last_activity_date ?? null, data.subscribed_locations ?? null,
        data.potential_locations ?? null, data.subscription_state ?? null,
        data.hubspot_url ?? null, data.hubspot_synced_at ?? null
      )
    }
    return this.get(id)!
  },

  // ─── HubSpot row bulk upsert ──────────────────────────────────────────────
  // Accepts the raw 15-element rows scraped from the HubSpot contacts list.
  // Column mapping (index → field) matches hubspot.js COL_MAP:
  //   [1]=name [2]=last_contacted [3]=renewal_date [4]=arr [5]=csm_owner
  //   [6]=phone [7]=last_activity_date [8]=city [9]=country [10]=tier
  //   [11]=subscribed_locations [12]=potential_locations [13]=subscription_state
  //   [14]=industry
  bulkUpsertFromHubSpot(rows: unknown[][]): void {
    const db = getDb()
    const TIER_MAP: Record<string, string> = {
      'enterprise':  'enterprise',
      'mid-market':  'mid_market',
      'mid_market':  'mid_market',
      'smb':         'smb',
      'trial':       'trial',
      'churned':     'churned',
    }
    const syncedAt = new Date().toISOString()

    // Since companies has no UNIQUE on name, we upsert by name match instead.
    // Use a two-step: check for existing by name, then update or insert.
    const findByName = db.prepare('SELECT id FROM companies WHERE name = ? LIMIT 1')
    const updateByName = db.prepare(`
      UPDATE companies SET
        tier = ?, arr = ?, csm_owner = ?, phone = ?, city = ?, country = ?,
        last_contacted = ?, renewal_date = ?, last_activity_date = ?,
        subscribed_locations = ?, potential_locations = ?, subscription_state = ?,
        industry = ?, hubspot_url = COALESCE(?, hubspot_url), hubspot_synced_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
    const insertNew = db.prepare(`
      INSERT INTO companies
        (id, name, tier, arr, csm_owner, phone, city, country,
         last_contacted, renewal_date, last_activity_date,
         subscribed_locations, potential_locations, subscription_state,
         industry, hubspot_url, hubspot_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const batch = db.transaction(() => {
      for (const row of rows) {
        const r = row as string[]
        const name = (r[1] || '').trim()
        if (!name) continue

        const rawTier = (r[10] || '').toLowerCase().trim()
        const tier    = TIER_MAP[rawTier] ?? 'smb'
        const arr     = r[4] ? parseFloat(String(r[4]).replace(/[$,]/g, '')) || null : null
        // Column A (r[0]) is the canonical HubSpot URL column — written there during
        // scraping AND fetched when reading accounts!A2:O from the sheet.
        // r[15] is kept as a fallback for rows written before this layout change.
        const hubspotUrl = (r[0] as string) || (r[15] as string) || null

        const existing = findByName.get(name) as { id: string } | undefined
        if (existing) {
          updateByName.run(
            tier, arr, r[5] || null, r[6] || null, r[8] || null, r[9] || null,
            r[2] || null, r[3] || null, r[7] || null,
            r[11] || null, r[12] || null, r[13] || null,
            r[14] || null, hubspotUrl, syncedAt,
            existing.id
          )
        } else {
          insertNew.run(
            ulid(), name, tier, arr, r[5] || null, r[6] || null,
            r[8] || null, r[9] || null,
            r[2] || null, r[3] || null, r[7] || null,
            r[11] || null, r[12] || null, r[13] || null,
            r[14] || null, hubspotUrl, syncedAt
          )
        }
      }
    })
    batch()
  },

  delete(id: string): void {
    getDb().prepare('DELETE FROM companies WHERE id = ?').run(id)
  },

  clearAllFromSheet(): void {
    // Deletes all companies that were synced from the spreadsheet (hubspot_synced_at is set).
    // Manually added companies (no hubspot_synced_at) are preserved.
    getDb().prepare('DELETE FROM companies WHERE hubspot_synced_at IS NOT NULL').run()
  },

  /** Snapshot scraped HubSpot URLs keyed by company name, before a clear+reimport cycle. */
  getHubspotUrlsByName(): Record<string, string> {
    const rows = getDb()
      .prepare('SELECT name, hubspot_url FROM companies WHERE hubspot_url IS NOT NULL')
      .all() as { name: string; hubspot_url: string }[]
    return Object.fromEntries(rows.map(r => [r.name, r.hubspot_url]))
  },

  /** After reimporting from the spreadsheet, put scraped URLs back on any row that has none. */
  restoreHubspotUrls(urlMap: Record<string, string>): void {
    const db = getDb()
    const update = db.prepare(
      'UPDATE companies SET hubspot_url = ? WHERE name = ? AND (hubspot_url IS NULL OR hubspot_url = "")'
    )
    const batch = db.transaction(() => {
      for (const [name, url] of Object.entries(urlMap)) {
        update.run(url, name)
      }
    })
    batch()
  },

  clearAll(): void {
    // Full reset — deletes ALL companies regardless of source.
    getDb().prepare('DELETE FROM companies').run()
  },

  // ─── Company Notes ─────────────────────────────────────────────────────────

  getNotes(companyId: string): Array<{ id: string; company_id: string; content: string; created_at: string }> {
    return getDb()
      .prepare('SELECT * FROM company_notes WHERE company_id = ? ORDER BY created_at ASC')
      .all(companyId) as Array<{ id: string; company_id: string; content: string; created_at: string }>
  },

  addNote(companyId: string, content: string): { id: string; company_id: string; content: string; created_at: string } {
    const id = ulid()
    getDb().prepare(
      'INSERT INTO company_notes (id, company_id, content) VALUES (?, ?, ?)'
    ).run(id, companyId, content)
    return getDb().prepare('SELECT * FROM company_notes WHERE id = ?').get(id) as { id: string; company_id: string; content: string; created_at: string }
  },

  deleteNote(noteId: string): void {
    getDb().prepare('DELETE FROM company_notes WHERE id = ?').run(noteId)
  },

  getDetails(id: string): CompanyDetail | null {
    const db = getDb()

    const company = this.get(id)
    if (!company) return null

    const contacts = this.listContacts(id)

    // Transcripts — most recent 15, with action_items parsed
    const rawTranscripts = db.prepare(`
      SELECT * FROM transcripts
      WHERE company_id = ?
      ORDER BY called_at DESC
      LIMIT 15
    `).all(id) as Array<Record<string, unknown>>

    const transcripts = rawTranscripts.map(r => ({
      ...r,
      action_items: r['action_items']
        ? JSON.parse(r['action_items'] as string)
        : null,
    })) as Array<Transcript & { action_items: string[] | null }>

    // Upcoming calendar events for this company
    const now = new Date().toISOString()
    const rawEvents = db.prepare(`
      SELECT * FROM calendar_events
      WHERE company_id = ? AND start_at >= ?
      ORDER BY start_at ASC
      LIMIT 10
    `).all(id, now) as Array<Record<string, unknown>>

    const upcomingEvents: CalendarEvent[] = rawEvents.map(r => ({
      ...r,
      attendees: r['attendees'] ? JSON.parse(r['attendees'] as string) : [],
    })) as CalendarEvent[]

    // Aggregate stats
    const callCount = (db.prepare(
      'SELECT COUNT(*) as cnt FROM transcripts WHERE company_id = ?'
    ).get(id) as { cnt: number }).cnt

    const lastRow = db.prepare(
      'SELECT called_at FROM transcripts WHERE company_id = ? ORDER BY called_at DESC LIMIT 1'
    ).get(id) as { called_at: string } | undefined

    const sentRow = db.prepare(`
      SELECT AVG(sentiment_score) as avg_sent
      FROM transcripts
      WHERE company_id = ? AND sentiment_score IS NOT NULL
    `).get(id) as { avg_sent: number | null }

    // Recent action items (last 5 calls)
    const aiRows = db.prepare(`
      SELECT action_items FROM transcripts
      WHERE company_id = ? AND action_items IS NOT NULL
      ORDER BY called_at DESC
      LIMIT 5
    `).all(id) as Array<{ action_items: string }>

    const recentActionItems = aiRows
      .flatMap(r => JSON.parse(r.action_items) as string[])
      .slice(0, 10)

    // Unique speakers (last 10 calls)
    const recentTxIds = rawTranscripts.slice(0, 10).map(t => t['id'] as string)
    const speakers: string[] = recentTxIds.length > 0
      ? (db.prepare(`
          SELECT DISTINCT speaker_name FROM speaker_turns
          WHERE transcript_id IN (${recentTxIds.map(() => '?').join(',')})
        `).all(...recentTxIds) as Array<{ speaker_name: string }>)
        .map(r => r.speaker_name)
      : []

    // Drive folder link
    const driveFolder = company.drive_folder_id
      ? { id: company.drive_folder_id, url: `https://drive.google.com/drive/folders/${company.drive_folder_id}` }
      : null

    return {
      company,
      contacts,
      transcripts,
      upcomingEvents,
      callCount,
      lastCallAt:        lastRow?.called_at ?? null,
      avgSentiment:      sentRow?.avg_sent ?? null,
      recentActionItems,
      speakers,
      driveFolder,
    }
  },

  // ─── Contacts ───────────────────────────────────────────────────────────────

  listContacts(companyId: string): Contact[] {
    return getDb()
      .prepare('SELECT * FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, name ASC')
      .all(companyId) as Contact[]
  },

  upsertContact(data: Partial<Contact> & { company_id: string; name: string }): Contact {
    const db = getDb()
    const id = data.id ?? ulid()
    const existing = data.id
      ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(data.id) as Contact | null
      : null

    if (existing) {
      db.prepare(`
        UPDATE contacts SET name = ?, email = ?, phone = ?, title = ?, role = ?,
          is_primary = ?, hubspot_contact_id = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `).run(
        data.name, data.email ?? existing.email, data.phone ?? existing.phone,
        data.title ?? existing.title, data.role ?? existing.role,
        data.is_primary ? 1 : 0, data.hubspot_contact_id ?? existing.hubspot_contact_id,
        data.notes ?? existing.notes, now(), id
      )
    } else {
      db.prepare(`
        INSERT INTO contacts (id, company_id, name, email, phone, title, role,
          is_primary, hubspot_contact_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, data.company_id, data.name, data.email ?? null, data.phone ?? null,
        data.title ?? null, data.role ?? 'unknown', data.is_primary ? 1 : 0,
        data.hubspot_contact_id ?? null, data.notes ?? null
      )
    }
    return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Contact
  },

  deleteContact(id: string): void {
    getDb().prepare('DELETE FROM contacts WHERE id = ?').run(id)
  },

  // ─── Schedules (delegated from ipc-router) ──────────────────────────────────

  listSchedules(): Schedule[] {
    return getDb().prepare('SELECT * FROM schedules ORDER BY name ASC').all() as Schedule[]
  },

  createSchedule(data: Omit<Schedule, 'id' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at'>): Schedule {
    const id = ulid()
    getDb().prepare(`
      INSERT INTO schedules (id, name, job_type, cron_expression, job_payload, is_active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.job_type, data.cron_expression,
      data.job_payload ? JSON.stringify(data.job_payload) : null,
      data.is_active ? 1 : 0
    )
    return getDb().prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Schedule
  },

  updateSchedule(data: Partial<Schedule> & { id: string }): Schedule {
    getDb().prepare(`
      UPDATE schedules SET name = COALESCE(?, name), cron_expression = COALESCE(?, cron_expression),
        job_payload = COALESCE(?, job_payload), is_active = COALESCE(?, is_active), updated_at = ?
      WHERE id = ?
    `).run(
      data.name ?? null, data.cron_expression ?? null,
      data.job_payload ? JSON.stringify(data.job_payload) : null,
      data.is_active !== undefined ? (data.is_active ? 1 : 0) : null,
      now(), data.id
    )
    return getDb().prepare('SELECT * FROM schedules WHERE id = ?').get(data.id) as Schedule
  },

  deleteSchedule(id: string): void {
    getDb().prepare('DELETE FROM schedules WHERE id = ?').run(id)
  },

  // ─── Flyer Templates (delegated from ipc-router) ───────────────────────────

  listFlyerTemplates(): FlyerTemplate[] {
    const rows = getDb()
      .prepare('SELECT * FROM flyer_templates ORDER BY updated_at DESC')
      .all() as Record<string, unknown>[]
    return rows.map(r => ({
      ...r,
      elements:      JSON.parse(r['elements'] as string ?? '[]'),
      data_bindings: JSON.parse(r['data_bindings'] as string ?? '{}'),
    })) as FlyerTemplate[]
  },

  saveFlyerTemplate(data: Partial<FlyerTemplate> & { name: string }): FlyerTemplate {
    const db = getDb()
    const id = data.id ?? ulid()
    const existing = data.id
      ? db.prepare('SELECT * FROM flyer_templates WHERE id = ?').get(data.id)
      : null

    if (existing) {
      db.prepare(`
        UPDATE flyer_templates SET name = ?, page_size = ?, page_width_px = ?,
          page_height_px = ?, elements = ?, data_bindings = ?, updated_at = ?
        WHERE id = ?
      `).run(
        data.name, data.page_size ?? 'letter', data.page_width_px ?? 816,
        data.page_height_px ?? 1056,
        JSON.stringify(data.elements ?? []), JSON.stringify(data.data_bindings ?? {}),
        now(), id
      )
    } else {
      db.prepare(`
        INSERT INTO flyer_templates (id, name, page_size, page_width_px, page_height_px, elements, data_bindings)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, data.name, data.page_size ?? 'letter', data.page_width_px ?? 816,
        data.page_height_px ?? 1056,
        JSON.stringify(data.elements ?? []), JSON.stringify(data.data_bindings ?? {})
      )
    }
    return this.listFlyerTemplates().find(t => t.id === id)!
  },

  deleteFlyerTemplate(id: string): void {
    getDb().prepare('DELETE FROM flyer_templates WHERE id = ?').run(id)
  },
}
