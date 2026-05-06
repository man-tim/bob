import { google } from 'googleapis'
import { ulid } from 'ulid'
import { getDb } from '../db/database'
import { registerJobHandler } from '../jobs/JobRunner'
import { JobQueue } from '../jobs/JobQueue'
import { AuthService } from '../auth/AuthService'
import {
  CALENDAR_SYNC_WINDOW_DAYS,
  CALENDAR_FILTER_KEYWORDS,
  COMPANY_MATCH_CONFIDENCE_THRESHOLD,
} from '@shared/constants'
import type { CalendarEvent, CalendarAttendee, Job } from '@shared/types'

// ─── Register job handler ─────────────────────────────────────────────────────

registerJobHandler('calendar_sync', handleCalendarSync)

async function handleCalendarSync(job: Job): Promise<void> {
  JobQueue.log(job.id, 'step', 'Fetching Google Calendar events...')
  try {
    const events = await CalendarService._fetchFromGoogle()
    JobQueue.log(job.id, 'step', 'Re-matching events to companies...')
    const { matched } = CalendarService.rematchAll()
    JobQueue.log(job.id, 'ok', `Synced ${events.length} events · matched ${matched} to companies`)
  } catch (err) {
    throw err
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Generic words that should not count as distinctive company identifiers
const MATCH_STOP_WORDS = new Set([
  'supply', 'supplies', 'corp', 'corporation', 'company', 'inc', 'llc', 'ltd',
  'group', 'services', 'service', 'solutions', 'solution', 'associates',
  'enterprises', 'enterprise', 'industries', 'industry', 'holdings', 'holding',
  'plumbing', 'heating', 'cooling', 'electric', 'electrical', 'construction',
  'contractors', 'contractor', 'management', 'and', 'the', 'pipe', 'piping',
  'systems', 'system', 'national', 'international', 'american', 'north', 'south',
  'east', 'west', 'united', 'properties', 'property', 'partners', 'partner',
])

function matchCompany(title: string, attendeeEmails: string[]): { id: string; confidence: number } | null {
  const db = getDb()
  const companies = db
    .prepare('SELECT id, name FROM companies ORDER BY name ASC')
    .all() as { id: string; name: string }[]

  const contacts = db
    .prepare('SELECT company_id, email FROM contacts WHERE email IS NOT NULL')
    .all() as { company_id: string; email: string }[]

  // 1. Attendee email match — highest confidence
  for (const email of attendeeEmails) {
    const contact = contacts.find(c => c.email.toLowerCase() === email.toLowerCase())
    if (contact) return { id: contact.company_id, confidence: 0.95 }
  }

  // Normalise: strip "X | " prefix, split camelCase, lower, strip punctuation
  const normalise = (s: string) => {
    const pipe = s.lastIndexOf('|')
    if (pipe >= 0) s = s.substring(pipe + 1)
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2')   // SouthernCarlson → Southern Carlson
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  }

  const target      = normalise(title)
  const targetTokens = new Set(target.split(/\s+/).filter(t => t.length > 2))

  let bestMatch: { id: string; confidence: number } | null = null

  for (const company of companies) {
    const name       = normalise(company.name)
    if (!name || !target) continue

    // 2. Full-name substring — company name contained in event title or vice versa
    if (name.length > 4 && (target.includes(name) || name.includes(target))) {
      const score = 0.88
      if (!bestMatch || score > bestMatch.confidence) bestMatch = { id: company.id, confidence: score }
      continue
    }

    // 3. Distinctive-token matching: only score tokens that are NOT generic stop words
    const allNameTokens   = name.split(/\s+/).filter(t => t.length > 2)
    const distinctiveTokens = allNameTokens.filter(t => !MATCH_STOP_WORDS.has(t) && t.length > 3)

    if (distinctiveTokens.length === 0) continue

    const matchedDistinctive = distinctiveTokens.filter(t => targetTokens.has(t))
    if (matchedDistinctive.length === 0) continue

    // Score = fraction of company's distinctive tokens present in the event title
    const score = (matchedDistinctive.length / distinctiveTokens.length) * 0.85
    if (score >= COMPANY_MATCH_CONFIDENCE_THRESHOLD && (!bestMatch || score > bestMatch.confidence)) {
      bestMatch = { id: company.id, confidence: score }
    }
  }

  return bestMatch ?? null
}

// ─── CalendarService ──────────────────────────────────────────────────────────

export const CalendarService = {
  async sync(): Promise<{ synced: number }> {
    const job = JobQueue.enqueue('calendar_sync', {}, 'user')
    return { synced: 0 }  // actual count returned asynchronously via job logs
  },

  async _fetchFromGoogle(): Promise<CalendarEvent[]> {
    const auth = await AuthService.getAuthClient()
    const calendar = google.calendar({ version: 'v3', auth })

    const now     = new Date()
    const timeMax = new Date(now.getTime() + CALENDAR_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000)

    const response = await calendar.events.list({
      calendarId:   'primary',
      timeMin:       now.toISOString(),
      timeMax:       timeMax.toISOString(),
      singleEvents:  true,
      orderBy:       'startTime',
      maxResults:    250,
    })

    const rawEvents = response.data.items ?? []
    const db = getDb()

    const upsert = db.prepare(`
      INSERT INTO calendar_events
        (id, google_event_id, calendar_id, title, start_at, end_at, company_id,
         match_confidence, attendees, description, meet_link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(google_event_id) DO UPDATE SET
        title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
        company_id = excluded.company_id, match_confidence = excluded.match_confidence,
        attendees = excluded.attendees, description = excluded.description,
        meet_link = excluded.meet_link, synced_at = datetime('now')
    `)

    const saved: CalendarEvent[] = []

    for (const ev of rawEvents) {
      // Only timed events (not all-day), no recurring
      if (!ev.start?.dateTime || ev.recurringEventId) continue

      const title = ev.summary ?? ''

      // Keyword filter
      const keywords = CALENDAR_FILTER_KEYWORDS
      const matches  = keywords.some(k => title.toLowerCase().includes(k))
      if (!matches) continue

      const attendees: CalendarAttendee[] = (ev.attendees ?? []).map(a => ({
        email:    a.email ?? '',
        name:     a.displayName ?? null,
        response: (a.responseStatus ?? 'needsAction') as CalendarAttendee['response'],
      }))

      const emails = attendees.map(a => a.email)
      const companyMatch = matchCompany(title, emails)

      const id = ulid()
      upsert.run(
        id,
        ev.id ?? '',
        'primary',
        title,
        ev.start.dateTime,
        ev.end?.dateTime ?? ev.start.dateTime,
        companyMatch?.id ?? null,
        companyMatch?.confidence ?? null,
        JSON.stringify(attendees),
        ev.description ?? null,
        ev.hangoutLink ?? null
      )

      const row = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id)
      if (row) saved.push(this._hydrate(row as Record<string, unknown>))
    }

    return saved
  },

  getUpcomingEvents(): CalendarEvent[] {
    const now = new Date().toISOString()
    const rows = getDb().prepare(`
      SELECT e.*, c.name as company_name, c.tier as company_tier, c.health_score as company_health
      FROM calendar_events e
      LEFT JOIN companies c ON c.id = e.company_id
      WHERE e.start_at >= ?
      ORDER BY e.start_at ASC
      LIMIT 100
    `).all(now) as Record<string, unknown>[]

    return rows.map(r => this._hydrate(r))
  },

  /** Re-run company matching on ALL future events so the latest algorithm applies to previously unmatched events. */
  rematchAll(): { matched: number } {
    const db  = getDb()
    const now = new Date().toISOString()
    const rows = db.prepare(`
      SELECT id, title, attendees FROM calendar_events
      WHERE start_at >= ?
    `).all(now) as Array<{ id: string; title: string; attendees: string }>

    let matched = 0
    for (const ev of rows) {
      const attendees: Array<{ email: string }> = JSON.parse(ev.attendees || '[]')
      const emails = attendees.map(a => a.email)
      const hit = matchCompany(ev.title, emails)
      if (hit) {
        db.prepare('UPDATE calendar_events SET company_id = ?, match_confidence = ? WHERE id = ?')
          .run(hit.id, hit.confidence, ev.id)
        matched++
      }
    }
    return { matched }
  },

  assignCompany(eventId: string, companyId: string): CalendarEvent {
    getDb().prepare(`
      UPDATE calendar_events
      SET company_id = ?, match_confidence = 1.0
      WHERE id = ?
    `).run(companyId, eventId)
    const row = getDb().prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId)
    return this._hydrate(row as Record<string, unknown>)
  },

  /**
   * Create a Google Calendar event and store it locally.
   * Returns the new google_event_id.
   */
  async createEvent(opts: {
    title: string
    description?: string
    startAt: string  // ISO-8601
    endAt?: string   // ISO-8601; defaults to startAt + 30min
    companyId?: string | null
  }): Promise<string> {
    const auth     = await AuthService.getAuthClient()
    const calendar = google.calendar({ version: 'v3', auth })

    const start = new Date(opts.startAt)
    const end   = opts.endAt ? new Date(opts.endAt) : new Date(start.getTime() + 30 * 60 * 1000)

    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary:     opts.title,
        description: opts.description ?? undefined,
        start: { dateTime: start.toISOString(), timeZone: 'UTC' },
        end:   { dateTime: end.toISOString(),   timeZone: 'UTC' },
      },
    })

    const googleEventId = res.data.id ?? ''

    // Persist locally
    const db = getDb()
    const id = ulid()
    db.prepare(`
      INSERT INTO calendar_events
        (id, google_event_id, calendar_id, title, start_at, end_at, company_id,
         match_confidence, attendees, description, meet_link)
      VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, '[]', ?, NULL)
      ON CONFLICT(google_event_id) DO NOTHING
    `).run(
      id, googleEventId, opts.title,
      start.toISOString(), end.toISOString(),
      opts.companyId ?? null,
      opts.companyId ? 1.0 : null,
      opts.description ?? null,
    )

    return googleEventId
  },

  /**
   * Delete a Google Calendar event by its google_event_id.
   */
  async deleteEvent(googleEventId: string): Promise<void> {
    try {
      const auth     = await AuthService.getAuthClient()
      const calendar = google.calendar({ version: 'v3', auth })
      await calendar.events.delete({ calendarId: 'primary', eventId: googleEventId })
    } catch { /* ignore 410 Gone */ }
    getDb().prepare('DELETE FROM calendar_events WHERE google_event_id = ?').run(googleEventId)
  },

  _hydrate(row: Record<string, unknown>): CalendarEvent {
    return {
      ...row,
      attendees: row['attendees'] ? JSON.parse(row['attendees'] as string) : [],
      company: row['company_name'] ? {
        id:           row['company_id'] as string,
        name:         row['company_name'] as string,
        tier:         row['company_tier'] as string,
        health_score: row['company_health'] as number | null,
      } : undefined,
    } as CalendarEvent
  },
}
