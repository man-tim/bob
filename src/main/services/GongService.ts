/**
 * GongService.ts
 *
 * Node.js conversion of the Gong Transcript Exporter Chrome extension
 * (gong-scraper / background.js + extract.js + APPS_SCRIPT_CODE.js).
 *
 * Four concerns:
 *   1. Company fuzzy matching  — ported from APPS_SCRIPT_CODE.js (superior algorithm)
 *   2. Transcript parsing      — ported from extract.js (DOM-free)
 *   3. Drive integration       — orchestrates DriveService (replaces Apps Script webhook)
 *   4. CRM data aggregation    — processCompanyData() + generateBookOfBusiness()
 *
 * Required exports: processCompanyData(), generateBookOfBusiness()
 *
 * Job handler implementations (handleExtractJob, handleOrganizeJob) are exported
 * for TranscriptService to register — keeping TranscriptService as the single
 * registration point and avoiding circular imports.
 */

import { ulid } from 'ulid'
import { getDb } from '../db/database'
import { DriveService } from './DriveService'
import { DRIVE_ARCHIVE_DAYS } from '@shared/constants'
import type { Company, Transcript, Job } from '@shared/types'

// ─── Output types ──────────────────────────────────────────────────────────────

export interface ParsedTurn {
  speaker:          string
  timeStr:          string
  timestampSeconds: number
  text:             string
  sequence:         number
}

export interface ParsedTranscript {
  turns:     ParsedTurn[]
  speakers:  string[]    // unique, non-Unknown
  lineCount: number
}

export interface TranscriptFileMeta {
  callTitle:  string
  account:    string
  callDate:   string   // YYYY-MM-DD
  callUrl:    string
  speakers:   string[]
}

export interface CompanyData {
  company:           Company
  callCount:         number
  lastCallAt:        string | null
  avgSentiment:      number | null
  speakers:          string[]
  recentActionItems: string[]
  driveFolder:       { id: string; url: string } | null
  transcripts:       Array<Pick<Transcript,
    'id' | 'call_title' | 'called_at' | 'match_status' | 'sentiment_score' | 'drive_file_id'>>
}

export interface BookOfBusinessEntry extends CompanyData {
  contacts:        Array<{ name: string; email: string | null; title: string | null; role: string }>
  engagementScore: number   // 0–100 composite metric
}

export interface BookOfBusiness {
  generatedAt:    string
  totalCompanies: number
  totalCalls:     number
  entries:        BookOfBusinessEntry[]
}

// ─── 1. FUZZY COMPANY MATCHING ────────────────────────────────────────────────
//
// Ported from APPS_SCRIPT_CODE.js `findCompanyMatch()` + `norm()` + `cleanForMatch()`.
// Substantially better than the basic token overlap in the original TranscriptService stub.
//
// Algorithm priority:
//   1. Exact normalized match
//   2. Company name fully contained in call text (strong signal)
//   3. Call text fully contained in company name
//   4. Word-level matching — handles 2-char abbreviations + substring for long words

/** Strip punctuation, noise words, extra whitespace. Mirrors Apps Script `norm()`. */
export function normalizeCompanyName(s: string): string {
  if (!s) return ''
  return s
    .toLowerCase()
    .replace(/[,.'"\-\/\\()&+]/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|co|company|the|of|and)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Strip Gong/Prokeep noise and meeting-type words from call titles before matching. */
function cleanForMatch(s: string): string {
  if (!s) return ''
  return s
    .replace(/\bgong\b/gi, '')
    .replace(/\bprokeep\b/gi, '')
    .replace(/\b(weekly|annual|business review|follow.?up|integration|setup|call|meeting|qbr|demo|onboarding)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

/**
 * Fuzzy-match `text` against a list of companies.
 * Returns the best match or null when no confident match is found.
 */
export function matchCompany(
  text: string,
  companies: Array<{ id: string; name: string }>
): { id: string; name: string } | null {
  if (!text || !companies.length) return null

  const tn = normalizeCompanyName(cleanForMatch(text))
  if (!tn) return null

  let best: { id: string; name: string } | null = null
  let bestScore = 0

  for (const company of companies) {
    const cn = normalizeCompanyName(company.name)
    if (!cn) continue

    // 1. Exact
    if (tn === cn) return company

    // 2. Company name contained in call text
    if (tn.includes(cn) && cn.length > 2) {
      const score = cn.length * 100
      if (score > bestScore) { bestScore = score; best = company }
      continue
    }

    // 3. Call text contained in company name
    if (cn.includes(tn) && tn.length > 3) {
      const score = tn.length * 50
      if (score > bestScore) { bestScore = score; best = company }
      continue
    }

    // 4. Word-level matching
    const cWords = unique(cn.split(' ').filter(w => w.length >= 2))
    const tWords = tn.split(' ')
    let hits = 0

    for (const cw of cWords) {
      for (const tw of tWords) {
        if (cw === tw) { hits++; break }
        // Substring match for longer words (> 4 chars)
        if (cw.length > 4 && tw.length > 4 && (cw.includes(tw) || tw.includes(cw))) {
          hits++; break
        }
      }
    }

    // Thresholds: 1-word → exact (handled above); 2-word → need both; 3+ → 50%, min 2
    const minHits = cWords.length <= 1 ? 1
      : cWords.length === 2 ? 2
      : Math.max(2, Math.ceil(cWords.length * 0.5))

    if (hits >= minHits) {
      const score = hits * 10 + cn.length
      if (score > bestScore) { bestScore = score; best = company }
    }
  }

  return best
}

/**
 * Match `text` against all companies in the SQLite DB.
 * Convenience wrapper used by job handlers.
 */
export function findBestCompany(text: string): { id: string; name: string } | null {
  const companies = getDb()
    .prepare('SELECT id, name FROM companies ORDER BY name ASC')
    .all() as { id: string; name: string }[]
  return matchCompany(text, companies)
}

// ─── 2. TRANSCRIPT PARSING ────────────────────────────────────────────────────
//
// Ported from extract.js `parseTranscript()`.
// Input: raw innerText scraped from a Gong call page (no DOM required).
// Handles Gong's timestamp-anchored format:
//
//   Speaker Name           ← optional: line before a pure-timestamp line
//   MM:SS                  ← timestamp (pure, or inline "Speaker MM:SS")
//   Body text...

/** Convert "M:SS" or "H:MM:SS" to seconds. */
export function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map(Number)
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

/** Parse raw Gong transcript text into structured speaker turns. */
export function parseGongTranscript(rawText: string): ParsedTranscript {
  const lines       = rawText.split('\n')
  const turns: ParsedTurn[] = []
  const pureTimeRe  = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*$/
  const hasTimeRe   = /(\d{1,2}:\d{2}(?::\d{2})?)/

  const timeLineIdxs: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (hasTimeRe.test(lines[i])) timeLineIdxs.push(i)
  }

  // Degenerate: no timestamps → single unstructured turn
  if (timeLineIdxs.length === 0) {
    const full = rawText.replace(/\s+/g, ' ').trim()
    if (full) turns.push({ speaker: 'Unknown', timeStr: '', timestampSeconds: 0, text: full, sequence: 0 })
    return { turns, speakers: [], lineCount: turns.length }
  }

  for (let t = 0; t < timeLineIdxs.length; t++) {
    const tIdx  = timeLineIdxs[t]
    const tLine = lines[tIdx].trim()
    const tMatch = tLine.match(hasTimeRe)
    const timeStr = tMatch ? tMatch[1] : ''
    let speaker = ''

    if (pureTimeRe.test(tLine)) {
      // Speaker name is the line immediately before the timestamp
      if (tIdx > 0) {
        const prev = lines[tIdx - 1].trim()
        if (prev.length > 0 && prev.length < 60 && /[a-zA-Z]/.test(prev) && !hasTimeRe.test(prev)) {
          speaker = prev
        }
      }
    } else {
      // Inline: "Speaker Name MM:SS" → strip time, take the rest
      const rem = tLine.replace(hasTimeRe, '').trim()
      if (rem.length > 0 && rem.length < 60) speaker = rem
    }

    // Body: lines from tIdx+1 up to (but not including) the next turn's speaker line
    const bodyStart = tIdx + 1
    let bodyEnd = lines.length
    if (t + 1 < timeLineIdxs.length) {
      const nextT = timeLineIdxs[t + 1]
      if (pureTimeRe.test(lines[nextT].trim()) && nextT > 0) {
        const beforeNext = lines[nextT - 1].trim()
        if (beforeNext.length > 0 && beforeNext.length < 60
          && /[a-zA-Z]/.test(beforeNext) && !hasTimeRe.test(beforeNext)) {
          bodyEnd = nextT - 1
        } else {
          bodyEnd = nextT
        }
      } else {
        bodyEnd = nextT
      }
    }

    const bodyParts: string[] = []
    for (let b = bodyStart; b < bodyEnd; b++) {
      const bl = lines[b].trim()
      if (bl) bodyParts.push(bl)
    }
    const text = bodyParts.join(' ').replace(/\s+/g, ' ').trim()

    if (text) {
      turns.push({
        speaker:          speaker || 'Unknown',
        timeStr,
        timestampSeconds: parseTimestamp(timeStr),
        text,
        sequence:         turns.length,
      })
    }
  }

  const speakers = unique(turns.map(t => t.speaker).filter(s => s && s !== 'Unknown'))
  return { turns, speakers, lineCount: turns.length }
}

// ─── 3. TRANSCRIPT FILE FORMATTING ───────────────────────────────────────────
//
// Mirrors the `.txt` file format written by `doSaveTranscript()` in Apps Script.
// This is what gets uploaded to Google Drive.

/** Format a transcript into the canonical `.txt` file content. */
export function formatTranscriptFile(meta: TranscriptFileMeta, turns: ParsedTurn[]): string {
  const NL = '\r\n'
  let out = `${meta.callTitle}${NL}`
  if (meta.account)          out += `Account: ${meta.account}${NL}`
  out += `Date: ${meta.callDate}${NL}`
  out += `URL: ${meta.callUrl}${NL}`
  if (meta.speakers.length)  out += `Speakers: ${meta.speakers.join(', ')}${NL}`
  out += `${NL}========================================${NL}${NL}`
  for (const turn of turns) {
    out += `${turn.speaker}: "${turn.text}"${NL}${NL}`
  }
  return out
}

/** Build the Drive filename — mirrors Apps Script naming convention. */
export function buildTranscriptFilename(callTitle: string, callDate: string): string {
  const safeTitle = callTitle
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const dateStr = callDate.match(/(\d{4}-\d{2}-\d{2})/)?.[1]
    ?? new Date().toISOString().slice(0, 10)
  return `${safeTitle} - ${dateStr}.txt`
}

// ─── 4. DRIVE INTEGRATION ─────────────────────────────────────────────────────
//
// Replaces the Apps Script webhook. Uses DriveService (googleapis) directly.
// Folder structure: "Gong Uploads" / "Company Name" / "Call Title - YYYY-MM-DD.txt"

/** Ensure `Gong Uploads/{companyName}/` exists; return both folder IDs. */
export async function ensureCompanyDriveFolder(
  companyName: string
): Promise<{ rootId: string; companyFolderId: string }> {
  const { rootId } = await DriveService.ensureRootFolders()
  const companyFolderId = await DriveService.ensureFolder(companyName, rootId)
  return { rootId, companyFolderId }
}

/**
 * Upload a formatted transcript to Drive.
 * Returns the Drive file ID, folder ID, and filename.
 */
export async function saveTranscriptToDrive(
  meta: TranscriptFileMeta,
  turns: ParsedTurn[],
  companyName: string
): Promise<{ fileId: string; folderId: string; filename: string }> {
  const { companyFolderId } = await ensureCompanyDriveFolder(companyName)
  const content  = formatTranscriptFile(meta, turns)
  const filename = buildTranscriptFilename(meta.callTitle, meta.callDate)
  const file     = await DriveService.uploadTranscript(content, filename, companyFolderId)
  return { fileId: file.id, folderId: companyFolderId, filename }
}

/**
 * Scan all matched transcripts that lack a drive_file_id and upload them.
 * Archive files in the root Gong Uploads folder older than DRIVE_ARCHIVE_DAYS.
 *
 * Mirrors Step 3 (`doStep3` / `doSortFiles` / `doArchive`) from the extension.
 */
export async function organizeTranscripts(
  jobLog: (level: string, msg: string) => void
): Promise<{ uploaded: number; archived: number; unmatched: number }> {
  const db = getDb()

  // ── Upload matched transcripts not yet on Drive ───────────────────────────
  let uploaded = 0
  const toUpload = db.prepare(`
    SELECT t.id, t.call_title, t.called_at, t.gong_call_url, t.company_id,
           c.name as company_name
    FROM   transcripts t
    JOIN   companies   c ON c.id = t.company_id
    WHERE  t.match_status = 'matched' AND t.drive_file_id IS NULL
    LIMIT  100
  `).all() as Array<Record<string, unknown>>

  for (const row of toUpload) {
    try {
      const turns = db.prepare(`
        SELECT speaker_name, timestamp_seconds, text, sequence
        FROM   speaker_turns
        WHERE  transcript_id = ?
        ORDER  BY sequence ASC
      `).all(row['id'] as string) as Array<{
        speaker_name: string; timestamp_seconds: number; text: string; sequence: number
      }>

      const parsedTurns: ParsedTurn[] = turns.map(t => ({
        speaker:          t.speaker_name || 'Unknown',
        timeStr:          '',
        timestampSeconds: t.timestamp_seconds ?? 0,
        text:             t.text ?? '',
        sequence:         t.sequence ?? 0,
      }))

      const speakers = unique(parsedTurns.map(t => t.speaker).filter(s => s !== 'Unknown'))
      const dateStr  = (row['called_at'] as string)?.slice(0, 10)
        ?? new Date().toISOString().slice(0, 10)
      const companyName = String(row['company_name'] ?? 'Unfiled')

      const { fileId, folderId, filename } = await saveTranscriptToDrive(
        {
          callTitle: String(row['call_title'] ?? 'Unknown Call'),
          account:   companyName,
          callDate:  dateStr,
          callUrl:   String(row['gong_call_url'] ?? ''),
          speakers,
        },
        parsedTurns,
        companyName
      )

      db.prepare(`
        UPDATE transcripts
        SET    drive_file_id = ?, drive_folder_id = ?, updated_at = datetime('now')
        WHERE  id = ?
      `).run(fileId, folderId, row['id'] as string)

      db.prepare(`
        UPDATE companies
        SET    drive_folder_id = ?, updated_at = datetime('now')
        WHERE  id = ? AND drive_folder_id IS NULL
      `).run(folderId, row['company_id'] as string)

      uploaded++
      jobLog('ok', `Uploaded: ${filename}`)
    } catch (err) {
      jobLog('warn', `Upload failed for "${row['call_title']}": ${(err as Error).message}`)
    }
  }

  // ── Archive old root-level files ──────────────────────────────────────────
  let archived = 0
  try {
    const { rootId, archiveId } = await DriveService.ensureRootFolders()
    const drive   = await DriveService._drive()
    const cutoff  = new Date()
    cutoff.setDate(cutoff.getDate() - DRIVE_ARCHIVE_DAYS)

    const oldFiles = await drive.files.list({
      q: [
        `'${rootId}' in parents`,
        "mimeType != 'application/vnd.google-apps.folder'",
        `createdTime < '${cutoff.toISOString()}'`,
        'trashed = false',
      ].join(' and '),
      fields: 'files(id,name,parents)',
      spaces: 'drive',
    })

    for (const file of oldFiles.data.files ?? []) {
      await DriveService.moveFile(file.id!, archiveId, rootId)
      archived++
    }
    if (archived > 0) jobLog('data', `Archived ${archived} old file(s)`)
  } catch (err) {
    jobLog('warn', `Archive step failed: ${(err as Error).message}`)
  }

  const unmatched = (db.prepare(
    `SELECT COUNT(*) as cnt FROM transcripts WHERE match_status = 'unmatched'`
  ).get() as { cnt: number }).cnt

  return { uploaded, archived, unmatched }
}

// ─── 5. processCompanyData() ──────────────────────────────────────────────────
//
// Aggregates a company's full engagement profile from SQLite:
// transcript count, sentiment average, unique speakers, action items, Drive folder.
// No external API calls — all data is local.

export function processCompanyData(companyId: string): CompanyData {
  const db = getDb()

  const company = db.prepare(
    'SELECT * FROM companies WHERE id = ?'
  ).get(companyId) as Company | null
  if (!company) throw new Error(`Company not found: ${companyId}`)

  const transcripts = db.prepare(`
    SELECT id, call_title, called_at, match_status, sentiment_score, drive_file_id
    FROM   transcripts
    WHERE  company_id = ?
    ORDER  BY called_at DESC
    LIMIT  200
  `).all(companyId) as Array<Pick<Transcript,
    'id' | 'call_title' | 'called_at' | 'match_status' | 'sentiment_score' | 'drive_file_id'>>

  // Average sentiment (null if no scored transcripts)
  const sentiments = transcripts
    .map(t => t.sentiment_score)
    .filter((s): s is number => s != null)
  const avgSentiment = sentiments.length
    ? sentiments.reduce((a, b) => a + b, 0) / sentiments.length
    : null

  // Unique speakers from the 20 most recent calls
  const recentIds = transcripts.slice(0, 20).map(t => t.id)
  let speakers: string[] = []
  if (recentIds.length) {
    const placeholders = recentIds.map(() => '?').join(',')
    speakers = (db.prepare(`
      SELECT DISTINCT speaker_name
      FROM   speaker_turns
      WHERE  transcript_id IN (${placeholders})
        AND  speaker_name != 'Unknown'
    `).all(...recentIds) as { speaker_name: string }[]).map(r => r.speaker_name)
  }

  // Action items from the 5 most recent calls
  const recentAiIds = transcripts.slice(0, 5).map(t => t.id)
  let recentActionItems: string[] = []
  if (recentAiIds.length) {
    const placeholders = recentAiIds.map(() => '?').join(',')
    recentActionItems = (db.prepare(`
      SELECT action_items
      FROM   transcripts
      WHERE  id IN (${placeholders}) AND action_items IS NOT NULL
    `).all(...recentAiIds) as { action_items: string }[])
      .flatMap(r => { try { return JSON.parse(r.action_items) as string[] } catch { return [] } })
  }

  const driveFolder = company.drive_folder_id
    ? { id: company.drive_folder_id, url: `https://drive.google.com/drive/folders/${company.drive_folder_id}` }
    : null

  return {
    company,
    callCount:         transcripts.length,
    lastCallAt:        transcripts[0]?.called_at ?? null,
    avgSentiment,
    speakers,
    recentActionItems,
    driveFolder,
    transcripts,
  }
}

// ─── 6. generateBookOfBusiness() ─────────────────────────────────────────────
//
// Compiles a full Book of Business report for all companies.
// Sorted by engagement score (recency × volume × sentiment).

function computeEngagementScore(data: CompanyData): number {
  // Recency  (0–40 pts): last call within 30 days → 40, 60 → 20, 90 → 10, older → 0
  // Volume   (0–30 pts): ≥8 calls → 30, ≥4 → 20, ≥1 → 10
  // Sentiment(0–20 pts): avg > 0.3 → 20, > 0 → 10, null/neg → 0
  // Drive    (0–10 pts): folder exists → 10
  let score = 0

  if (data.lastCallAt) {
    const daysSince = (Date.now() - new Date(data.lastCallAt).getTime()) / 86_400_000
    if      (daysSince <= 30) score += 40
    else if (daysSince <= 60) score += 20
    else if (daysSince <= 90) score += 10
  }

  if      (data.callCount >= 8) score += 30
  else if (data.callCount >= 4) score += 20
  else if (data.callCount >= 1) score += 10

  if (data.avgSentiment != null) {
    if      (data.avgSentiment > 0.3) score += 20
    else if (data.avgSentiment > 0)   score += 10
  }

  if (data.driveFolder) score += 10

  return Math.min(score, 100)
}

export function generateBookOfBusiness(): BookOfBusiness {
  const db = getDb()

  const allCompanies = db.prepare(
    'SELECT id FROM companies ORDER BY name ASC'
  ).all() as { id: string }[]

  const entries: BookOfBusinessEntry[] = []
  let totalCalls = 0

  for (const { id } of allCompanies) {
    const data = processCompanyData(id)

    const contacts = db.prepare(`
      SELECT name, email, title, role
      FROM   contacts
      WHERE  company_id = ?
      ORDER  BY is_primary DESC, name ASC
    `).all(id) as Array<{ name: string; email: string | null; title: string | null; role: string }>

    const engagementScore = computeEngagementScore(data)
    totalCalls += data.callCount

    entries.push({ ...data, contacts, engagementScore })
  }

  // Primary sort: engagement score desc. Secondary: company name asc.
  entries.sort((a, b) =>
    b.engagementScore - a.engagementScore
    || a.company.name.localeCompare(b.company.name)
  )

  return {
    generatedAt:    new Date().toISOString(),
    totalCompanies: allCompanies.length,
    totalCalls,
    entries,
  }
}

// ─── 7. JOB HANDLER IMPLEMENTATIONS ──────────────────────────────────────────
//
// Exported for TranscriptService to register (avoids circular imports).
// `gong_collect` remains a Puppeteer stub — real scraping is not included here.

/**
 * gong_extract handler.
 *
 * Expected payload (produced by the Puppeteer gong_collect step):
 *   { url, callTitle, account?, callDate?, rawTranscript, speakers? }
 *
 * Parses the raw transcript text, inserts into DB, fuzzy-matches to a company,
 * uploads to Drive, and marks the URL as processed.
 */
export async function handleExtractJob(
  job: Job,
  log: (level: string, msg: string) => void
): Promise<void> {
  const payload = (job.payload ?? {}) as {
    url:           string
    callTitle?:    string
    account?:      string
    callDate?:     string
    rawTranscript?: string
    speakers?:     string[]
  }

  const { url, callTitle = 'Unknown Call', account, callDate, rawTranscript, speakers = [] } = payload

  if (!rawTranscript || rawTranscript.length < 50) {
    log('warn', 'rawTranscript missing — Puppeteer integration required to supply transcript text')
    return
  }

  // Already processed?
  const db = getDb()
  if (db.prepare('SELECT url FROM processed_urls WHERE url = ?').get(url)) {
    log('data', `Already processed: ${url}`)
    return
  }
  if (db.prepare('SELECT id FROM transcripts WHERE gong_call_url = ?').get(url)) {
    db.prepare('INSERT OR IGNORE INTO processed_urls (url, job_id) VALUES (?, ?)').run(url, job.id)
    log('data', `Transcript already in DB: ${url}`)
    return
  }

  // Parse
  const parsed     = parseGongTranscript(rawTranscript)
  const allSpeakers = unique([...speakers, ...parsed.speakers])
  log('info', `Parsed ${parsed.lineCount} turn(s). Speakers: ${allSpeakers.join(', ') || 'none'}`)

  // Fuzzy-match to a company
  const matchSources = [account, callTitle].filter(Boolean) as string[]
  let company: { id: string; name: string } | null = null
  for (const src of matchSources) {
    company = findBestCompany(src)
    if (company) break
  }
  log(company ? 'ok' : 'warn', company
    ? `Matched to company: ${company.name}`
    : `No company match for "${callTitle}" — saved as unmatched`
  )

  const dateStr = callDate?.match(/(\d{4}-\d{2}-\d{2})/)?.[1]
    ?? new Date().toISOString().slice(0, 10)
  const transcriptId = ulid()

  // Insert transcript
  db.prepare(`
    INSERT INTO transcripts
      (id, company_id, gong_call_url, call_title, called_at, match_status, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    transcriptId,
    company?.id ?? null,
    url,
    callTitle,
    dateStr,
    company ? 'matched' : 'unmatched'
  )

  // Insert speaker turns
  const insertTurn = db.prepare(`
    INSERT INTO speaker_turns
      (id, transcript_id, speaker_name, timestamp_seconds, text, sequence)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const turn of parsed.turns) {
    insertTurn.run(ulid(), transcriptId, turn.speaker, turn.timestampSeconds, turn.text, turn.sequence)
  }

  // Mark URL processed
  db.prepare('INSERT OR IGNORE INTO processed_urls (url, job_id) VALUES (?, ?)').run(url, job.id)

  // Upload to Drive (non-fatal if it fails — drive_organize can retry)
  if (company) {
    try {
      const { fileId, folderId } = await saveTranscriptToDrive(
        {
          callTitle,
          account:  company.name,
          callDate: dateStr,
          callUrl:  url,
          speakers: allSpeakers,
        },
        parsed.turns,
        company.name
      )
      db.prepare(`
        UPDATE transcripts
        SET    drive_file_id = ?, drive_folder_id = ?, updated_at = datetime('now')
        WHERE  id = ?
      `).run(fileId, folderId, transcriptId)
      log('ok', `Uploaded to Drive: ${folderId}`)
    } catch (err) {
      log('warn', `Drive upload failed (will retry via organize): ${(err as Error).message}`)
    }
  }
}

/**
 * drive_organize handler.
 * Uploads matched transcripts missing Drive files and archives old ones.
 */
export async function handleOrganizeJob(
  job: Job,
  log: (level: string, msg: string) => void
): Promise<void> {
  const result = await organizeTranscripts(log)
  log('ok', [
    `Organize complete:`,
    `${result.uploaded} uploaded`,
    `${result.archived} archived`,
    `${result.unmatched} unmatched`,
  ].join(' | '))
}

// ─── GongService façade ────────────────────────────────────────────────────────

export const GongService = {
  // Matching
  matchCompany,
  findBestCompany,
  normalizeCompanyName,

  // Parsing
  parseGongTranscript,
  parseTimestamp,

  // Formatting
  formatTranscriptFile,
  buildTranscriptFilename,

  // Drive
  ensureCompanyDriveFolder,
  saveTranscriptToDrive,
  organizeTranscripts,

  // CRM aggregation — required exports
  processCompanyData,
  generateBookOfBusiness,

  // Job handler implementations (registered in TranscriptService)
  handleExtractJob,
  handleOrganizeJob,
}
