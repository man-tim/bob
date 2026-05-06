/**
 * CallLogsService — Appends a summary row to the "Call_Logs" tab of the
 * master Google Sheet every time a new transcript is saved to Drive.
 *
 * Columns (A–F):
 *   A  Call_ID          e.g. CALL-01HRXYZ…
 *   B  Date             YYYY-MM-DD
 *   C  Company_Name     Account name from Gong / fuzzy match
 *   D  Call_Type        Discovery / Demo / Renewal / QBR / Check-in / Other
 *   E  Transcript_URL   Google Doc / Drive URL
 *   F  AI_Summary       2-3 sentence summary (LocalAI if available, else extractive)
 */

import { google } from 'googleapis'
import { ulid }   from 'ulid'
import { AuthService } from '../auth/AuthService'
import { LocalAIService } from './LocalAIService'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CallLogRow {
  companyName:    string
  callDate:       string        // ISO string or YYYY-MM-DD
  callType?:      string
  transcriptUrl:  string
  /** Parsed transcript lines from the Gong scraper */
  transcriptLines?: Array<{ speaker: string; text: string }>
  /** Raw transcript string (fallback if lines not available) */
  transcriptText?: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SHEET_NAME = 'Call_Logs'

const HEADERS = ['Call_ID', 'Date', 'Company_Name', 'Call_Type', 'Transcript_URL', 'AI_Summary']

const CALL_TYPE_KEYWORDS: Array<{ type: string; terms: string[] }> = [
  { type: 'Discovery',  terms: ['discovery', 'intro', 'introduction', 'first call', 'meet', 'explore'] },
  { type: 'Demo',       terms: ['demo', 'demonstration', 'product walkthrough', 'platform walk'] },
  { type: 'Renewal',   terms: ['renewal', 'renew', 'contract review', 'pricing review'] },
  { type: 'QBR',       terms: ['qbr', 'quarterly', 'business review', 'strategy review'] },
  { type: 'Onboarding',terms: ['onboarding', 'kickoff', 'kick-off', 'implementation', 'setup'] },
  { type: 'Check-in',  terms: ['check-in', 'check in', 'catch up', 'catchup', 'follow up', 'followup'] },
  { type: 'Support',   terms: ['support', 'issue', 'problem', 'troubleshoot', 'escalation'] },
]

function detectCallType(title: string, text: string): string {
  const haystack = (title + ' ' + text.slice(0, 500)).toLowerCase()
  for (const { type, terms } of CALL_TYPE_KEYWORDS) {
    if (terms.some(t => haystack.includes(t))) return type
  }
  return 'Other'
}

function toDate(iso: string): string {
  try {
    return iso.slice(0, 10) || new Date().toISOString().slice(0, 10)
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

/**
 * Extractive summary: take first 3 non-trivial speaker turns and join them.
 * Used when LocalAI is unavailable.
 */
function extractiveSummary(lines: Array<{ speaker: string; text: string }> | undefined, raw: string | undefined): string {
  if (lines && lines.length > 0) {
    const meaningful = lines.filter(l => l.text && l.text.trim().length > 40).slice(0, 4)
    if (meaningful.length > 0) {
      return meaningful.map(l => l.text.trim()).join(' ').slice(0, 400) + (meaningful.length >= 4 ? '…' : '')
    }
  }
  if (raw) return raw.trim().slice(0, 400) + (raw.length > 400 ? '…' : '')
  return 'No transcript content available.'
}

/**
 * Generate a 2-3 sentence summary using LocalAI if ready, else extractive fallback.
 */
async function generateSummary(
  companyName: string,
  callType: string,
  lines: Array<{ speaker: string; text: string }> | undefined,
  rawText: string | undefined,
): Promise<string> {
  try {
    if (LocalAIService.getStatus().loadState === 'ready') {
      // Build a compact transcript excerpt (first ~800 chars of text)
      const excerpt = lines
        ? lines.map(l => `${l.speaker}: ${l.text}`).join('\n').slice(0, 900)
        : (rawText ?? '').slice(0, 900)

      const prompt = `Summarize this ${callType} call with ${companyName} in 2-3 sentences. Focus on the main topic, key decisions or pain points, and next steps.\n\nTranscript excerpt:\n${excerpt}`
      const result = await LocalAIService.complete({
        requestId:    `call-log-${ulid()}`,
        prompt,
        systemPrompt: 'You are a B2B customer success assistant. Write concise, factual call summaries. Plain text only, no markdown.',
        maxTokens:    180,
        onChunk:      () => {},          // no streaming needed here
      })
      return result.trim() || extractiveSummary(lines, rawText)
    }
  } catch { /* fall through to extractive */ }

  return extractiveSummary(lines, rawText)
}

// ─── Service ─────────────────────────────────────────────────────────────────

export const CallLogsService = {
  /**
   * Ensure the Call_Logs tab exists. Creates it with a header row if missing.
   * Returns the sheet title (always 'Call_Logs') for use in A1 notation.
   */
  async ensureTab(spreadsheetId: string): Promise<void> {
    const auth   = await AuthService.getAuthClient()
    const sheets = google.sheets({ version: 'v4', auth })

    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' })
    const sheetList = meta.data.sheets ?? []
    const exists = sheetList.some(s => s.properties?.title === SHEET_NAME)

    if (!exists) {
      // Add the tab
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: { title: SHEET_NAME },
            },
          }],
        },
      })
      // Write header row
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_NAME}!A1:F1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADERS] },
      })
    }
  },

  /**
   * Append one row to Call_Logs for a newly saved transcript.
   */
  async appendRow(spreadsheetId: string, row: CallLogRow): Promise<void> {
    try {
      await this.ensureTab(spreadsheetId)

      const auth   = await AuthService.getAuthClient()
      const sheets = google.sheets({ version: 'v4', auth })

      const callId   = `CALL-${ulid()}`
      const date     = toDate(row.callDate)
      const callType = row.callType ?? detectCallType('', '')
      const summary  = await generateSummary(row.companyName, callType, row.transcriptLines, row.transcriptText)

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range:            `${SHEET_NAME}!A:F`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[callId, date, row.companyName, callType, row.transcriptUrl, summary]],
        },
      })
    } catch (err) {
      console.warn('[CallLogs] appendRow failed:', (err as Error).message)
    }
  },

  /**
   * Return all Transcript_URL values currently logged in Call_Logs.
   * Used during reconciliation to find missing transcripts.
   */
  async getLoggedUrls(spreadsheetId: string): Promise<Set<string>> {
    try {
      await this.ensureTab(spreadsheetId)

      const auth   = await AuthService.getAuthClient()
      const sheets = google.sheets({ version: 'v4', auth })

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEET_NAME}!E:E`,   // Column E = Transcript_URL
      })

      const urls = new Set<string>()
      for (const row of res.data.values ?? []) {
        if (row[0] && typeof row[0] === 'string' && row[0].startsWith('http')) {
          urls.add(row[0].trim())
        }
      }
      return urls
    } catch {
      return new Set()
    }
  },

  /**
   * Reconcile Call_Logs against what's actually in Google Drive.
   *
   * 1. Fetch all logged Transcript_URLs from Call_Logs.
   * 2. List all Google Doc files in the main Gong Drive folder + subfolders.
   * 3. For any Drive file whose URL isn't in Call_Logs, fetch its content
   *    and backfill a new row.
   *
   * This is called at the end of Step 3 ("Organize").
   */
  async reconcile(spreadsheetId: string, mainFolderUrl: string, onProgress: (msg: string) => void): Promise<number> {
    onProgress('Call_Logs: checking for missing transcript rows...')

    try {
      const auth  = await AuthService.getAuthClient()
      const drive = google.drive({ version: 'v3', auth })

      // ── Get already-logged URLs ──────────────────────────────────────────
      const loggedUrls = await this.getLoggedUrls(spreadsheetId)

      // ── Collect Drive folder IDs to search ───────────────────────────────
      const folderId = mainFolderUrl.split('/folders/')[1]?.split('?')[0]
        || mainFolderUrl.split('/').pop()!

      const folderIds: string[] = [folderId]
      try {
        const subRes = await drive.files.list({
          q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id)',
          pageSize: 100,
        })
        for (const f of subRes.data.files ?? []) {
          if (f.id) folderIds.push(f.id)
        }
      } catch { /* best-effort */ }

      // ── List Google Docs in those folders ────────────────────────────────
      const parentClauses = folderIds.map(id => `'${id}' in parents`).join(' or ')
      const q = `(mimeType='application/vnd.google-apps.document' or mimeType='text/plain') and trashed=false and (${parentClauses})`

      const listRes = await drive.files.list({
        q,
        fields: 'files(id, name, createdTime, webViewLink, mimeType)',
        pageSize: 200,
      })

      const driveFiles = listRes.data.files ?? []
      onProgress(`Call_Logs: found ${driveFiles.length} transcript(s) in Drive.`)

      // ── Identify missing ones ─────────────────────────────────────────────
      const missing = driveFiles.filter(f => {
        const docUrl  = `https://docs.google.com/document/d/${f.id}/edit`
        const viewUrl = f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`
        return !loggedUrls.has(docUrl) && !loggedUrls.has(viewUrl)
      })

      if (missing.length === 0) {
        onProgress('Call_Logs: all transcripts already logged. ✓')
        return 0
      }

      onProgress(`Call_Logs: backfilling ${missing.length} missing transcript(s)...`)

      const docs = google.docs({ version: 'v1', auth })
      let backfilled = 0

      for (const f of missing) {
        try {
          // Read the file content — Google Doc vs plain text
          let rawText = ''
          if (f.mimeType === 'text/plain') {
            // For .txt files, download the content directly
            const mediaRes = await drive.files.get(
              { fileId: f.id!, alt: 'media' },
              { responseType: 'text' }
            ) as unknown as { data: string }
            rawText = typeof mediaRes.data === 'string' ? mediaRes.data : ''
          } else {
            // For Google Docs
            const docRes = await docs.documents.get({ documentId: f.id! })
            rawText = extractDocText(docRes.data)
          }
          const lines   = parseDocTranscript(rawText)

          // Infer company name from file name (format: "CompanyName — YYYY-MM-DD" or similar)
          const companyName = inferCompanyFromFilename(f.name ?? '')
          const callDate    = f.createdTime ?? new Date().toISOString()
          const callType    = detectCallType(f.name ?? '', rawText)
          const docUrl      = `https://docs.google.com/document/d/${f.id}/edit`

          await this.appendRow(spreadsheetId, {
            companyName,
            callDate,
            callType,
            transcriptUrl:   docUrl,
            transcriptLines: lines,
            transcriptText:  rawText,
          })

          backfilled++
          onProgress(`  Backfilled: ${f.name}`)
        } catch (err) {
          onProgress(`  Skipped (error): ${f.name} — ${(err as Error).message}`)
        }
      }

      onProgress(`Call_Logs: backfill complete. ${backfilled} row(s) added. ✓`)
      return backfilled
    } catch (err) {
      onProgress(`Call_Logs: reconciliation error — ${(err as Error).message}`)
      return 0
    }
  },

  /**
   * Detect call type from a title string (used when appending from Step 2).
   */
  detectCallType(title: string, transcriptSample = ''): string {
    return detectCallType(title, transcriptSample)
  },
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/** Extract plain text from a Google Docs API document object */
function extractDocText(doc: import('googleapis').docs_v1.Schema$Document): string {
  try {
    const parts: string[] = []
    for (const el of doc.body?.content ?? []) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements ?? []) {
          if (pe.textRun?.content) parts.push(pe.textRun.content)
        }
      }
    }
    return parts.join('').trim()
  } catch {
    return ''
  }
}

/** Parse "Speaker: text" lines from extracted doc text */
function parseDocTranscript(text: string): Array<{ speaker: string; text: string }> {
  return text.split('\n')
    .map(line => {
      const m = line.match(/^([^:]{1,40}):\s+(.+)$/)
      return m ? { speaker: m[1].trim(), text: m[2].trim() } : null
    })
    .filter((x): x is { speaker: string; text: string } => x !== null)
}

/** Extract company name from a filename like "Acme Corp — 2024-01-15" */
function inferCompanyFromFilename(name: string): string {
  const parts = name.split(/[—\-–|_]/)
  const candidate = parts[0]?.trim() ?? name
  // Remove common suffixes like date strings
  return candidate.replace(/\s*\d{4}-\d{2}-\d{2}.*$/, '').trim() || name
}
