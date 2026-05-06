import { randomUUID } from 'crypto'
import { getDb } from '../db/database'
import { TasksService } from './TasksService'
import { CalendarService } from './CalendarService'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FollowUp {
  id: string
  company_id: string | null
  company_name: string
  description: string
  source: 'manual' | 'transcript'
  source_url: string | null
  due_date: string | null
  calendar_event_id: string | null
  google_task_id: string | null
  google_calendar_event_id: string | null
  notified_at: string | null
  status: 'open' | 'done' | 'dismissed'
  created_at: string
  updated_at: string
}

export interface CreateFollowUpInput {
  company_id?: string | null
  company_name: string
  description: string
  source?: 'manual' | 'transcript'
  source_url?: string | null
  due_date?: string | null
  calendar_event_id?: string | null
}

export interface UpdateFollowUpInput {
  description?: string
  status?: 'open' | 'done' | 'dismissed'
  due_date?: string | null
  calendar_event_id?: string | null
}

// ─── Regex patterns ported from csmtool/Intelligence.gs ───────────────────────

// CSM commitment signals
const CSM_PATTERNS: RegExp[] = [
  /\bi'?ll\s+(send|get|check|look\s+into|follow\s+up|reach\s+out|set\s+up|schedule|share|pull|grab|connect|loop\s+in|put\s+together|have\s+that|make\s+sure|find\s+out|look\s+that\s+up|take\s+a\s+look)\b/i,
  /\blet\s+me\s+(follow\s+up|check|look\s+into|find\s+out|get\s+back|reach\s+out|dig\s+into|send\s+you|pull\s+that|grab\s+that)\b/i,
  /\bgoing\s+to\s+(work\s+with|reach\s+out|check\s+on|follow\s+up|send|share|look\s+into|schedule|set\s+up)\b/i,
  /\bi\s+will\s+(send|get|check|follow\s+up|reach\s+out|set\s+up|schedule|share|look\s+into|make\s+sure)\b/i,
  /\bwe'?ll\s+(send|get|check|follow\s+up|reach\s+out|set\s+up|schedule|share|look\s+into|make\s+sure)\b/i,
  /\bi\s+can\s+(send|get|check|follow\s+up|reach\s+out|set\s+up|schedule|share|look\s+into|make\s+sure)\b/i,
]

// Phrases to filter out (false positives)
const EXCLUDE_PATTERNS: RegExp[] = [
  /i'?ll\s+(talk\s+to\s+you\s+(soon|later)|let\s+you\s+go|see\s+you|let\s+you\s+know\s+if\s+I\s+need|be\s+in\s+touch\s+soon)/i,
  /i'?ll\s+let\s+you\s+go/i,
  /i'?ll\s+see\s+you/i,
  /i'?ll\s+talk\s+to\s+you/i,
  /talk\s+to\s+you\s+(soon|later|next\s+time)/i,
  /have\s+a\s+(good|great|nice)\s+(day|week|weekend)/i,
]

// Minimum length for a follow-up line to be useful
const MIN_LINE_LENGTH = 20
const MAX_LINE_LENGTH = 300

/**
 * Extract CSM follow-up commitments from a transcript string.
 * Returns an array of description strings (deduplicated).
 */
export function extractFollowUps(transcriptText: string): string[] {
  const lines = transcriptText.split('\n')
  const results: string[] = []
  const seen = new Set<string>()

  for (const raw of lines) {
    const line = raw.trim()
    if (line.length < MIN_LINE_LENGTH || line.length > MAX_LINE_LENGTH) continue

    // Skip timestamp/speaker dividers like "0:32 | Rep Name"
    if (/^\d+:\d{2}\s*\|/.test(line)) continue

    const lower = line.toLowerCase()

    // Check exclusions first
    if (EXCLUDE_PATTERNS.some(p => p.test(lower))) continue

    // Check for CSM commitment
    if (CSM_PATTERNS.some(p => p.test(lower))) {
      // Normalize whitespace
      const normalized = line.replace(/\s+/g, ' ').trim()
      // Deduplicate by lowercase key
      const key = normalized.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        results.push(normalized)
      }
    }
  }

  return results
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class FollowUpService {

  list(companyId?: string | null): FollowUp[] {
    const db = getDb()
    if (companyId) {
      return db.prepare(
        'SELECT * FROM follow_ups WHERE company_id = ? ORDER BY created_at DESC'
      ).all(companyId) as FollowUp[]
    }
    return db.prepare(
      'SELECT * FROM follow_ups ORDER BY created_at DESC'
    ).all() as FollowUp[]
  }

  create(input: CreateFollowUpInput): FollowUp {
    const db = getDb()
    const id = randomUUID()
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO follow_ups
        (id, company_id, company_name, description, source, source_url, due_date, calendar_event_id, status, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      id,
      input.company_id ?? null,
      input.company_name,
      input.description,
      input.source ?? 'manual',
      input.source_url ?? null,
      input.due_date ?? null,
      input.calendar_event_id ?? null,
      now,
      now,
    )

    // Push to Google Tasks + Calendar asynchronously (best-effort)
    if (input.due_date) {
      this._syncToGoogle(id, input).catch(err =>
        console.warn('[FollowUp] Google sync failed:', err?.message ?? err)
      )
    }

    return this.getById(id)!
  }

  /** Fire-and-forget: push a new follow-up to Google Tasks and optionally Calendar. */
  private async _syncToGoogle(followUpId: string, input: CreateFollowUpInput): Promise<void> {
    const db = getDb()
    const taskTitle = `[${input.company_name}] ${input.description}`
    const dueIso = input.due_date ? new Date(input.due_date).toISOString() : undefined
    const notes   = [
      input.description,
      input.source_url ? `Gong Call: ${input.source_url}` : '',
    ].filter(Boolean).join('\n\n')

    // 1. Google Task
    let taskId: string | null = null
    try {
      taskId = await TasksService.createTask({ title: taskTitle, notes, due: dueIso })
    } catch (err) {
      console.warn('[FollowUp] createTask failed:', err)
    }

    // 2. Calendar event — use user-picked time if provided, else default to 9am
    let calEventId: string | null = null
    if (input.due_date) {
      try {
        // "YYYY-MM-DDTHH:MM" → parse as local time; "YYYY-MM-DD" → 9am UTC fallback
        const startAt = input.due_date.includes('T')
          ? new Date(input.due_date).toISOString()
          : `${input.due_date.substring(0, 10)}T09:00:00.000Z`
        calEventId = await CalendarService.createEvent({
          title:     `Follow-up: ${taskTitle}`,
          description: notes,
          startAt,
          companyId: input.company_id ?? undefined,
        })
      } catch (err) {
        console.warn('[FollowUp] createEvent failed:', err)
      }
    }

    // Persist IDs
    if (taskId || calEventId) {
      db.prepare(`
        UPDATE follow_ups SET google_task_id = ?, google_calendar_event_id = ? WHERE id = ?
      `).run(taskId, calEventId, followUpId)
    }
  }

  update(id: string, patch: UpdateFollowUpInput): FollowUp {
    const db = getDb()
    const now = new Date().toISOString()
    const fields: string[] = []
    const values: unknown[] = []

    if (patch.description !== undefined) { fields.push('description = ?'); values.push(patch.description) }
    if (patch.status !== undefined)      { fields.push('status = ?');      values.push(patch.status) }
    if (patch.due_date !== undefined)    { fields.push('due_date = ?');    values.push(patch.due_date) }
    if (patch.calendar_event_id !== undefined) { fields.push('calendar_event_id = ?'); values.push(patch.calendar_event_id) }

    fields.push('updated_at = ?')
    values.push(now)
    values.push(id)

    db.prepare(`UPDATE follow_ups SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const updated = this.getById(id)!

    // Best-effort: complete the Google Task when marked done
    if (patch.status === 'done' && updated.google_task_id) {
      TasksService.completeTask(updated.google_task_id).catch(err =>
        console.warn('[FollowUp] completeTask failed:', err?.message ?? err)
      )
    }

    return updated
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM follow_ups WHERE id = ?').run(id)
  }

  getById(id: string): FollowUp | null {
    return (getDb().prepare('SELECT * FROM follow_ups WHERE id = ?').get(id) as FollowUp) ?? null
  }

  /**
   * Scan recent transcripts stored in the DB, extract follow-ups,
   * and create FollowUp records for any new ones found.
   */
  parseTranscripts(): { created: number } {
    const db = getDb()
    // Get all transcripts that have speaker_turns
    const transcripts = db.prepare(`
      SELECT t.id, t.call_title, t.gong_call_url, t.company_id,
             c.name as company_name
      FROM transcripts t
      LEFT JOIN companies c ON c.id = t.company_id
      ORDER BY t.called_at DESC
      LIMIT 50
    `).all() as Array<{
      id: string
      call_title: string | null
      gong_call_url: string
      company_id: string | null
      company_name: string | null
    }>

    let created = 0

    for (const tx of transcripts) {
      // Get all speaker turns for this transcript as a combined text
      const turns = db.prepare(`
        SELECT speaker_name, text FROM speaker_turns
        WHERE transcript_id = ?
        ORDER BY sequence ASC
      `).all(tx.id) as Array<{ speaker_name: string; text: string }>

      if (turns.length === 0) continue

      const fullText = turns.map(t => t.text).join('\n')
      const items = extractFollowUps(fullText)

      for (const desc of items) {
        // Check if already exists (same description + same source_url)
        const existing = db.prepare(
          'SELECT id FROM follow_ups WHERE description = ? AND source_url = ?'
        ).get(desc, tx.gong_call_url)

        if (existing) continue

        this.create({
          company_id:   tx.company_id ?? null,
          company_name: tx.company_name ?? tx.call_title ?? 'Unknown',
          description:  desc,
          source:       'transcript',
          source_url:   tx.gong_call_url,
        })
        created++
      }
    }

    return { created }
  }
}

export const followUpService = new FollowUpService()
