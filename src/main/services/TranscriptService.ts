import { ulid } from 'ulid'
import { getDb } from '../db/database'
import { JobQueue } from '../jobs/JobQueue'
import { registerJobHandler } from '../jobs/JobRunner'
import { GongService } from './GongService'
import type { Transcript, SpeakerTurn, ListQuery, PaginatedResult, Job } from '@shared/types'
import { COMPANY_MATCH_CONFIDENCE_THRESHOLD } from '@shared/constants'

// ─── Register job handlers ────────────────────────────────────────────────────

registerJobHandler('gong_collect', async (job: Job) => {
  // Puppeteer integration point: navigate Gong home, collect call links,
  // filter against processed_urls, enqueue a gong_extract child job per new link.
  //
  // Puppeteer scaffold (wire up when browser automation is ready):
  //
  //   const browser = await puppeteer.launch({ userDataDir: getPuppeteerProfile() })
  //   const page    = await browser.newPage()
  //   await page.goto(GONG_HOME_URL, { waitUntil: 'networkidle2' })
  //   const links   = await page.$$eval('a[href*="/call"]', els => els.map(a => a.href))
  //   const db      = getDb()
  //   for (const url of links) {
  //     if (!db.prepare('SELECT url FROM processed_urls WHERE url = ?').get(url)) {
  //       JobQueue.enqueue('gong_extract', { url }, 'dependency', job.id)
  //     }
  //   }
  //   await browser.close()

  JobQueue.log(job.id, 'step', 'Collecting Gong call links...')
  JobQueue.log(job.id, 'warn', 'Puppeteer integration pending — no links collected')
})

registerJobHandler('gong_extract', async (job: Job) => {
  const log = (level: string, msg: string) => JobQueue.log(job.id, level as never, msg)
  const url = (job.payload as { url?: string })?.url ?? 'unknown'
  log('step', `Extracting transcript: ${url}`)
  await GongService.handleExtractJob(job, log)
})

registerJobHandler('drive_organize', async (job: Job) => {
  const log = (level: string, msg: string) => JobQueue.log(job.id, level as never, msg)
  log('step', 'Organizing Drive folders...')
  await GongService.handleOrganizeJob(job, log)
})

// ─── TranscriptService ────────────────────────────────────────────────────────

export const TranscriptService = {
  list(query: ListQuery & { matchStatus?: string; companyId?: string } = {}): PaginatedResult<Transcript> {
    const db = getDb()
    const { search, matchStatus, companyId, page = 1, pageSize = 50 } = query

    const conditions: string[] = []
    const params: unknown[] = []

    if (search) {
      conditions.push('(t.call_title LIKE ? OR t.gong_call_url LIKE ?)')
      const like = `%${search}%`
      params.push(like, like)
    }
    if (matchStatus) { conditions.push('t.match_status = ?'); params.push(matchStatus) }
    if (companyId)   { conditions.push('t.company_id = ?');   params.push(companyId) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const total = (db.prepare(
      `SELECT COUNT(*) as cnt FROM transcripts t ${where}`
    ).get(...params) as { cnt: number }).cnt

    const offset = (page - 1) * pageSize
    const rows = db.prepare(`
      SELECT t.*, c.name as company_name, c.tier as company_tier
      FROM transcripts t
      LEFT JOIN companies c ON c.id = t.company_id
      ${where}
      ORDER BY t.called_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset) as Record<string, unknown>[]

    const items: Transcript[] = rows.map(r => ({
      ...r,
      action_items: r['action_items'] ? JSON.parse(r['action_items'] as string) : null,
      company: r['company_name'] ? {
        id: r['company_id'] as string,
        name: r['company_name'] as string,
        tier: r['company_tier'] as string,
      } : undefined,
    })) as Transcript[]

    return { items, total, page, pageSize }
  },

  get(id: string): Transcript | null {
    const db = getDb()
    const row = db.prepare('SELECT * FROM transcripts WHERE id = ?').get(id) as Record<string, unknown> | null
    if (!row) return null

    const turns = db.prepare(
      'SELECT * FROM speaker_turns WHERE transcript_id = ? ORDER BY sequence ASC'
    ).all(id) as SpeakerTurn[]

    return {
      ...row,
      action_items:  row['action_items'] ? JSON.parse(row['action_items'] as string) : null,
      speaker_turns: turns,
    } as Transcript
  },

  insert(data: Omit<Transcript, 'id' | 'created_at' | 'updated_at' | 'processed_at'>): Transcript {
    const db = getDb()
    const id = ulid()

    db.prepare(`
      INSERT OR IGNORE INTO transcripts
        (id, company_id, gong_call_url, call_title, called_at, duration_seconds,
         match_status, summary, action_items, sentiment_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, data.company_id ?? null, data.gong_call_url, data.call_title ?? null,
      data.called_at, data.duration_seconds ?? null, data.match_status ?? 'unmatched',
      data.summary ?? null,
      data.action_items ? JSON.stringify(data.action_items) : null,
      data.sentiment_score ?? null
    )

    if (data.speaker_turns?.length) {
      const insertTurn = db.prepare(`
        INSERT INTO speaker_turns (id, transcript_id, speaker_name, timestamp_seconds, text, sequence)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      for (const turn of data.speaker_turns) {
        insertTurn.run(ulid(), id, turn.speaker_name, turn.timestamp_seconds, turn.text, turn.sequence)
      }
    }

    return this.get(id)!
  },

  assignCompany(transcriptId: string, companyId: string): Transcript {
    getDb().prepare(`
      UPDATE transcripts
      SET company_id = ?, match_status = 'matched', updated_at = datetime('now')
      WHERE id = ?
    `).run(companyId, transcriptId)
    return this.get(transcriptId)!
  },

  /**
   * Fuzzy-match a call title/account string against all companies in the DB.
   * Delegates to GongService.findBestCompany which uses the full multi-pass
   * algorithm ported from the original Gong extension (exact, containment,
   * word-level, abbreviation, and substring matching).
   */
  findBestCompanyMatch(callTitle: string): string | null {
    return GongService.findBestCompany(callTitle)?.id ?? null
  },

  /** Kicks off the full 3-phase pipeline as sequential jobs */
  runAll(): { collectJobId: string } {
    const job = JobQueue.enqueue('gong_collect', {}, 'user')
    return { collectJobId: job.id }
  },
}
