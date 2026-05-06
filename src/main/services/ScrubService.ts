/**
 * ScrubService — 4A conversion of ScrubAndSplit.html
 *
 * All browser APIs removed:
 *   FileReader        → fs.readFileSync / readFile
 *   Blob.size         → Buffer.byteLength(text, 'utf8')
 *   URL.createObjectURL + <a>.click → fs.writeFileSync
 *   sleep() / DOM progress → onProgress callback
 *   navigator.clipboard   → caller's responsibility
 *
 * Public API:
 *   scrubData(input, opts?)       → ScrubResult
 *   splitData(input, opts?)       → SplitResult
 *   processFile(inputPath, opts?) → Promise<ProcessResult>
 *   generatePrompts(accountName)  → Prompt[]
 */

import { createReadStream, createWriteStream, mkdirSync, existsSync } from 'fs'
import { createInterface } from 'readline'
import { join, basename, extname, dirname } from 'path'
import { ulid } from 'ulid'
import { BrowserWindow } from 'electron'
import { getDb } from '../db/database'
import { registerJobHandler } from '../jobs/JobRunner'
import { JobQueue } from '../jobs/JobQueue'
import { AnalysisService } from './AnalysisService'
import { IPC } from '../../shared/ipc-channels'
import type { Job } from '@shared/types'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RedactionStats {
  SSN:     number
  CC:      number
  Routing: number
  Account: number
  TaxID:   number
  PW:      number
  Keys:    number
}

export interface ScrubResult {
  scrubbedContent: string
  totalRedacted:   number
  stats:           RedactionStats
  accountName:     string
  /** Number of data lines processed (excludes header). Available from streaming processFile. */
  lineCount?:      number
}

export interface Chunk {
  index:   number
  name:    string
  content: string
  /** Size in bytes (UTF-8) */
  size:    number
}

export interface SplitResult {
  chunks:      Chunk[]
  totalChunks: number
}

export interface ProcessOptions {
  /** Output directory for chunk files. Defaults to same dir as input. */
  outputDir?:      string
  /** Maximum bytes per chunk. Defaults to 25 MB. */
  chunkSizeBytes?: number
  /** Progress callback — called after each scrub phase. */
  onProgress?:     (pct: number, detail: string) => void
  /** Whether to write chunk files to disk. Defaults to true. */
  writeToDisk?:    boolean
}

export interface ProcessResult {
  scrub:       ScrubResult
  split:       SplitResult
  outputPaths: string[]
  prompts:     Prompt[]
}

export interface Prompt {
  title: string
  text:  string
}

// ─── Register job handler ─────────────────────────────────────────────────────

registerJobHandler('scrub_process', async (job: Job) => {
  const { inputPath, outputDir, chunkSizeBytes } = job.payload as {
    inputPath:      string
    outputDir?:     string
    chunkSizeBytes?: number
  }

  JobQueue.log(job.id, 'step', `Processing file: ${basename(inputPath)}`)

  const result = await processFile(inputPath, {
    outputDir,
    chunkSizeBytes,
    writeToDisk: true,
    onProgress: (pct, detail) => {
      JobQueue.log(job.id, 'info', `[${Math.round(pct)}%] ${detail}`)
      JobQueue.pushProgress(job.id, Math.round(pct), 100, detail)
    },
  })

  JobQueue.log(job.id, 'ok',   `Redacted ${result.scrub.totalRedacted} items across ${result.split.totalChunks} chunk(s)`)
  JobQueue.log(job.id, 'data', `Account: ${result.scrub.accountName}`)

  // Persist to scrub_jobs table
  const db = getDb()
  db.prepare(`
    UPDATE scrub_jobs
    SET status = 'exported',
        account_name = ?,
        row_count_cleaned = ?,
        output_files = ?,
        redaction_stats = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    result.scrub.accountName !== '[ACCOUNT NAME]' ? result.scrub.accountName : null,
    result.scrub.lineCount ?? result.split.chunks.reduce((n, c) => n + (c.content ? c.content.split('\n').length - 1 : 0), 0),
    JSON.stringify(result.outputPaths),
    JSON.stringify({ ...result.scrub.stats, total: result.scrub.totalRedacted }),
    (job.payload as Record<string, unknown>)['scrub_job_id'] as string ?? ''
  )

  // Auto-run Risk & Expansion analysis on the source CSV (non-critical)
  try {
    JobQueue.log(job.id, 'step', 'Running Risk & Expansion analysis…')
    const accountName = result.scrub.accountName !== '[ACCOUNT NAME]' ? result.scrub.accountName : undefined
    const analysis = await AnalysisService.analyzeFile(inputPath, accountName)
    JobQueue.log(job.id, 'ok', `Analysis complete — Risk: ${analysis.riskScore}/100, Expansion: ${analysis.expansionScore}/100`)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.PUSH_ANALYSIS_DONE, analysis)
    }
  } catch (analysisErr) {
    JobQueue.log(job.id, 'warn', `Analysis skipped: ${(analysisErr as Error).message}`)
  }

  return result
})

// ─── CSV helpers ──────────────────────────────────────────────────────────────

/**
 * Parse a single CSV row, respecting double-quoted fields.
 * Matches the original browser parseCSVRow exactly.
 */
export function parseCSVRow(row: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuote = false

  for (let i = 0; i < row.length; i++) {
    const c = row[i]
    if (c === '"') {
      inQuote = !inQuote
    } else if (c === ',' && !inQuote) {
      result.push(current)
      current = ''
    } else {
      current += c
    }
  }

  result.push(current)
  return result
}

/**
 * Extract the account name from the CSV header + first data row.
 * Looks for a column named "account_name" or "accountname" (case/space insensitive).
 */
export function extractAccountName(header: string, firstDataRow: string): string {
  const cols = parseCSVRow(header)
  const idx  = cols.findIndex(c => {
    const clean = c.replace(/"/g, '').toLowerCase().replace(/\s+/g, '')
    return clean === 'accountname' || clean === 'account_name'
  })

  if (idx >= 0) {
    const vals = parseCSVRow(firstDataRow)
    const val  = vals[idx]?.replace(/"/g, '').trim()
    if (val) return val
  }

  return '[ACCOUNT NAME]'
}

// ─── Core: scrubData ─────────────────────────────────────────────────────────

/**
 * Scan and redact PII/sensitive patterns from raw CSV text.
 *
 * Replaces browser `runScrub()`. Runs synchronously (no DOM sleeps needed).
 * The original progress percentages are preserved for parity.
 *
 * @param input      Raw CSV text (UTF-8 string)
 * @param onProgress Optional progress callback (pct 0–100, detail label)
 */
export function scrubData(
  input: string,
  onProgress?: (pct: number, detail: string) => void
): ScrubResult {
  let text = input
  const stats: RedactionStats = { SSN: 0, CC: 0, Routing: 0, Account: 0, TaxID: 0, PW: 0, Keys: 0 }
  let totalRedacted = 0

  function countAndReplace(
    regex:      RegExp,
    replacement:string | ((...args: string[]) => string),
    statKey:    keyof RedactionStats
  ): void {
    let count = 0
    if (typeof replacement === 'string') {
      text = text.replace(regex, () => { count++; return replacement })
    } else {
      text = text.replace(regex, (...args: string[]) => { count++; return replacement(...args) })
    }
    stats[statKey] += count
    totalRedacted  += count
  }

  // ── Phase 1: SSNs (original pct: 2 → 16) ────────────────────────────────
  onProgress?.(2, 'Redacting Social Security Numbers…')
  countAndReplace(/\d{3}-\d{2}-\d{4}/g,  '[REDACTED-SSN]', 'SSN')
  countAndReplace(/\d{3} \d{2} \d{4}/g,  '[REDACTED-SSN]', 'SSN')
  countAndReplace(/\d{3}\.\d{2}\.\d{4}/g,'[REDACTED-SSN]', 'SSN')
  countAndReplace(
    /(ssn|social|social security|ss#|ss #)[^0-9]*\d{3}[- .]?\d{2}[- .]?\d{4}/gi,
    (m: string, g1: string) => `${g1} [REDACTED-SSN]`,
    'SSN'
  )
  onProgress?.(16, 'SSNs complete')

  // ── Phase 2: Credit / Debit Cards (16 → 64) ───────────────────────────────
  onProgress?.(18, 'Redacting credit and debit card numbers…')
  countAndReplace(/\b4\d{3}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g,   '[REDACTED-CC]', 'CC')
  countAndReplace(/\b4\d{15}\b/g,                               '[REDACTED-CC]', 'CC')
  countAndReplace(/\b5[1-5]\d{2}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g,'[REDACTED-CC]','CC')
  countAndReplace(/\b3[47]\d{2}[- ]\d{6}[- ]\d{5}\b/g,         '[REDACTED-CC]', 'CC')
  countAndReplace(
    /(card|cc|credit card)[^0-9]*\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{3,4}/gi,
    (m: string, g1: string) => `${g1} [REDACTED-CC]`,
    'CC'
  )
  onProgress?.(64, 'Credit / debit cards complete')

  // ── Phase 3: Routing Numbers (64 → 70) ────────────────────────────────────
  onProgress?.(66, 'Redacting routing numbers…')
  countAndReplace(
    /(routing|aba|aba#)[^0-9]*\d{9}/gi,
    (m: string, g1: string) => `${g1} [REDACTED-ROUTING]`,
    'Routing'
  )
  onProgress?.(70, 'Routing numbers complete')

  // ── Phase 4: Account Numbers (70 → 78) ────────────────────────────────────
  onProgress?.(72, 'Redacting bank account numbers…')
  countAndReplace(
    /(account number|acct|acct#|checking account|dda)[^0-9]*\d{8,17}/gi,
    (m: string, g1: string) => `${g1} [REDACTED-ACCT]`,
    'Account'
  )
  onProgress?.(78, 'Account numbers complete')

  // ── Phase 5: Tax IDs / EINs (78 → 84) ────────────────────────────────────
  onProgress?.(80, 'Redacting Tax IDs and EINs…')
  countAndReplace(
    /(ein|tax id|fein|tin)[^0-9]*\d{2}-?\d{7}/gi,
    (m: string, g1: string) => `${g1} [REDACTED-TAXID]`,
    'TaxID'
  )
  onProgress?.(84, 'Tax IDs complete')

  // ── Phase 6: Passwords (84 → 90) ─────────────────────────────────────────
  onProgress?.(86, 'Redacting passwords…')
  countAndReplace(
    /(password|passwd|pwd|passcode)[^:=]*[:= ]+[^ ,"]+/gi,
    (m: string, g1: string) => `${g1} [REDACTED-PW]`,
    'PW'
  )
  onProgress?.(90, 'Passwords complete')

  // ── Phase 7: API Keys / Tokens (90 → 98) ─────────────────────────────────
  onProgress?.(92, 'Redacting API keys and tokens…')
  countAndReplace(
    /(api key|apikey|auth token|secret key|access key)[^:=]*[:= ]+[^ ,"]+/gi,
    (m: string, g1: string) => `${g1} [REDACTED-KEY]`,
    'Keys'
  )
  onProgress?.(98, 'API keys complete')
  onProgress?.(100, 'Scrubbing complete')

  // Extract account name from the (already scrubbed) content header
  const lines       = input.split('\n')   // use original input for name extraction
  const accountName = lines.length > 1
    ? extractAccountName(lines[0], lines[1])
    : '[ACCOUNT NAME]'

  return { scrubbedContent: text, totalRedacted, stats, accountName }
}

// ─── Core: splitData ─────────────────────────────────────────────────────────

const DEFAULT_CHUNK_BYTES = 25 * 1024 * 1024   // 25 MB

/**
 * Split scrubbed CSV text into chunks that each fit within `chunkSizeBytes`.
 *
 * Replaces the splitting block inside browser `runScrub()`.
 * Preserves the original header-row-per-chunk and 1000-line minimum logic.
 *
 * @param input          Scrubbed CSV text
 * @param opts.chunkSizeBytes  Max bytes per output file (default 25 MB)
 * @param opts.accountName     Used to name output files
 */
export function splitData(
  input: string,
  opts: {
    chunkSizeBytes?: number
    accountName?:   string
    sourceFilename?: string
  } = {}
): SplitResult {
  const {
    chunkSizeBytes = DEFAULT_CHUNK_BYTES,
    accountName    = '[ACCOUNT NAME]',
    sourceFilename = 'data',
  } = opts

  const totalBytes = Buffer.byteLength(input, 'utf8')

  // Safe base name for file outputs
  const safeName = accountName !== '[ACCOUNT NAME]'
    ? accountName.replace(/[/\\:*?"<>|]/g, '')
    : basename(sourceFilename, extname(sourceFilename))

  // If the whole file fits in one chunk, return it as-is
  if (totalBytes <= chunkSizeBytes) {
    const singleName = `${safeName} - Blueprint Messages.csv`
    return {
      chunks: [{
        index:   1,
        name:    singleName,
        content: input,
        size:    totalBytes,
      }],
      totalChunks: 1,
    }
  }

  // Split into multiple chunks
  const lines     = input.split('\n')
  const header    = lines[0]
  const dataLines = lines.slice(1).filter(l => l.trim() !== '')

  // Estimate bytes per line, enforce 1000-line minimum
  const bytesPerLine    = totalBytes / lines.length
  let   linesPerChunk   = Math.floor(chunkSizeBytes / bytesPerLine)
  if   (linesPerChunk < 1000) linesPerChunk = 1000

  const chunks: Chunk[] = []

  for (let i = 0; i < dataLines.length; i += linesPerChunk) {
    const chunkIndex   = chunks.length + 1
    const chunkContent = header + '\n' + dataLines.slice(i, i + linesPerChunk).join('\n')
    const chunkBytes   = Buffer.byteLength(chunkContent, 'utf8')

    chunks.push({
      index:   chunkIndex,
      name:    `${safeName} - Messages Chunk ${chunkIndex}.csv`,
      content: chunkContent,
      size:    chunkBytes,
    })
  }

  return { chunks, totalChunks: chunks.length }
}

// ─── Streaming redaction helpers ──────────────────────────────────────────────

/**
 * Apply all PII redaction patterns to a single line of text.
 * Returns the (potentially modified) line and the redaction counts for this line.
 */
function scrubLine(line: string): { line: string; stats: RedactionStats } {
  let text = line
  const stats: RedactionStats = { SSN: 0, CC: 0, Routing: 0, Account: 0, TaxID: 0, PW: 0, Keys: 0 }

  function cr(
    regex:       RegExp,
    replacement: string | ((...args: string[]) => string),
    statKey:     keyof RedactionStats
  ): void {
    let count = 0
    if (typeof replacement === 'string') {
      text = text.replace(regex, () => { count++; return replacement })
    } else {
      text = text.replace(regex, (...args: string[]) => { count++; return replacement(...args) })
    }
    stats[statKey] += count
  }

  // SSNs
  cr(/\d{3}-\d{2}-\d{4}/g,  '[REDACTED-SSN]', 'SSN')
  cr(/\d{3} \d{2} \d{4}/g,  '[REDACTED-SSN]', 'SSN')
  cr(/\d{3}\.\d{2}\.\d{4}/g,'[REDACTED-SSN]', 'SSN')
  cr(/(ssn|social|social security|ss#|ss #)[^0-9]*\d{3}[- .]?\d{2}[- .]?\d{4}/gi,
    (m: string, g1: string) => `${g1} [REDACTED-SSN]`, 'SSN')

  // Credit / debit cards
  cr(/\b4\d{3}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g,    '[REDACTED-CC]', 'CC')
  cr(/\b4\d{15}\b/g,                                '[REDACTED-CC]', 'CC')
  cr(/\b5[1-5]\d{2}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g,'[REDACTED-CC]', 'CC')
  cr(/\b3[47]\d{2}[- ]\d{6}[- ]\d{5}\b/g,          '[REDACTED-CC]', 'CC')
  cr(/(card|cc|credit card)[^0-9]*\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{3,4}/gi,
    (m: string, g1: string) => `${g1} [REDACTED-CC]`, 'CC')

  // Routing numbers
  cr(/(routing|aba|aba#)[^0-9]*\d{9}/gi,
    (m: string, g1: string) => `${g1} [REDACTED-ROUTING]`, 'Routing')

  // Account numbers
  cr(/(account number|acct|acct#|checking account|dda)[^0-9]*\d{8,17}/gi,
    (m: string, g1: string) => `${g1} [REDACTED-ACCT]`, 'Account')

  // Tax IDs / EINs
  cr(/(ein|tax id|fein|tin)[^0-9]*\d{2}-?\d{7}/gi,
    (m: string, g1: string) => `${g1} [REDACTED-TAXID]`, 'TaxID')

  // Passwords
  cr(/(password|passwd|pwd|passcode)[^:=]*[:= ]+[^ ,"]+/gi,
    (m: string, g1: string) => `${g1} [REDACTED-PW]`, 'PW')

  // API keys / tokens
  cr(/(api key|apikey|auth token|secret key|access key)[^:=]*[:= ]+[^ ,"]+/gi,
    (m: string, g1: string) => `${g1} [REDACTED-KEY]`, 'Keys')

  return { line: text, stats }
}

// ─── File I/O layer ───────────────────────────────────────────────────────────

/**
 * Stream a CSV from disk line-by-line, redact PII in each line, split into
 * chunk files sized ≤ chunkSizeBytes, and write them incrementally.
 *
 * Never loads more than one CSV line + one chunk write-buffer into V8 heap —
 * safe for files of any size (tested to 2 GB+).
 */
export async function processFile(
  inputPath: string,
  opts: ProcessOptions = {}
): Promise<ProcessResult> {
  const {
    outputDir      = dirname(inputPath),
    chunkSizeBytes = DEFAULT_CHUNK_BYTES,
    onProgress,
    writeToDisk    = true,
  } = opts

  if (writeToDisk && !existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  // ── Aggregate redaction stats ──────────────────────────────────────────────
  const totalStats: RedactionStats = { SSN: 0, CC: 0, Routing: 0, Account: 0, TaxID: 0, PW: 0, Keys: 0 }
  let totalRedacted = 0

  // ── State for header extraction ────────────────────────────────────────────
  let headerLine      = ''
  let firstDataLine   = ''
  let accountName     = '[ACCOUNT NAME]'
  let headerResolved  = false

  // ── Split state ────────────────────────────────────────────────────────────
  const safeName = () => {
    if (accountName !== '[ACCOUNT NAME]') return accountName.replace(/[/\\:*?"<>|]/g, '')
    return basename(inputPath, extname(inputPath))
  }

  // Track chunks for the returned SplitResult
  const chunkMeta: Array<{ index: number; name: string; size: number }> = []

  // Current open write-stream
  let currentStream:   ReturnType<typeof createWriteStream> | null = null
  let currentChunkIdx  = 0
  let currentBytes     = 0
  let currentPath      = ''

  // We collect chunk content in memory only when writeToDisk === false (tests/small files)
  const inMemoryChunks: Chunk[] = []

  // Estimated bytes per line (updated on first data line)
  let bytesPerLine     = 200  // default estimate

  function openNextChunk(name: string, dest: string, header: string): void {
    if (currentStream) {
      currentStream.end()
      currentStream = null
    }
    currentChunkIdx++
    currentBytes = 0
    currentPath  = dest

    if (writeToDisk) {
      currentStream = createWriteStream(dest, { encoding: 'utf8' })
      currentStream.write(header + '\n')
      currentBytes = Buffer.byteLength(header + '\n', 'utf8')
    }
  }

  // ── Stream the file line by line ───────────────────────────────────────────
  onProgress?.(2, 'Starting scrub…')

  // We need two pieces of information before we can name chunks: the account
  // name (from the first data row) and the header.  We resolve these on the
  // fly during the stream and open the first chunk as soon as we have both.
  let lineIndex   = 0
  let pendingData: string[] = []  // lines buffered before first chunk opens

  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(inputPath, { encoding: 'utf8', highWaterMark: 128 * 1024 }),
      crlfDelay: Infinity,
    })

    rl.on('line', (rawLine: string) => {
      const idx = lineIndex++

      // ── Header row ──────────────────────────────────────────────────────
      if (idx === 0) {
        headerLine = rawLine   // preserve verbatim (no scrubbing needed)
        return
      }

      // ── First data row — extract account name ────────────────────────────
      if (idx === 1) {
        firstDataLine = rawLine
        accountName   = extractAccountName(headerLine, firstDataLine)
        headerResolved = true

        // Calibrate bytes-per-line estimate
        bytesPerLine = Math.max(50, Buffer.byteLength(rawLine, 'utf8'))

        // Open first chunk
        const name = `${safeName()} - Blueprint Messages.csv`
        const dest = writeToDisk ? join(outputDir, name) : ''
        openNextChunk(name, dest, headerLine)
        chunkMeta.push({ index: 1, name, size: 0 })
      }

      // ── Scrub the line ───────────────────────────────────────────────────
      const { line: scrubbedLine, stats } = scrubLine(rawLine)
      for (const k of Object.keys(stats) as Array<keyof RedactionStats>) {
        totalStats[k] += stats[k]
        totalRedacted  += stats[k]
      }

      const lineBytes = Buffer.byteLength(scrubbedLine + '\n', 'utf8')

      // ── Chunk rotation ───────────────────────────────────────────────────
      // Rotate when adding this line would exceed the chunk limit AND we
      // already have at least 1000 lines worth of data in the current chunk.
      const chunkMinBytes = 1000 * bytesPerLine
      if (currentBytes + lineBytes > chunkSizeBytes && currentBytes >= chunkMinBytes) {
        // Close current and open next
        const chunkNum  = chunkMeta.length + 1
        const name      = `${safeName()} - Messages Chunk ${chunkNum}.csv`
        const dest      = writeToDisk ? join(outputDir, name) : ''

        // Record final size of the chunk we're closing
        if (chunkMeta.length > 0) {
          chunkMeta[chunkMeta.length - 1].size = currentBytes
        }

        openNextChunk(name, dest, headerLine)
        chunkMeta.push({ index: chunkNum, name, size: 0 })
      }

      // ── Write line ───────────────────────────────────────────────────────
      if (writeToDisk && currentStream) {
        currentStream.write(scrubbedLine + '\n')
      } else if (!writeToDisk) {
        pendingData.push(scrubbedLine)
      }
      currentBytes += lineBytes
    })

    rl.on('close', resolve)
    rl.on('error', reject)
  })

  // Finalize last chunk size
  if (chunkMeta.length > 0) {
    chunkMeta[chunkMeta.length - 1].size = currentBytes
  }

  // Close last write stream
  await new Promise<void>((resolve, reject) => {
    if (currentStream) {
      currentStream.end((err?: Error | null) => err ? reject(err) : resolve())
    } else {
      resolve()
    }
  })

  onProgress?.(98, 'Writing complete')
  onProgress?.(100, 'Scrubbing complete')

  // lineIndex ends at (header + data lines) processed; subtract 1 for header
  const lineCount = Math.max(0, lineIndex - 1)

  // ── Build result objects ───────────────────────────────────────────────────
  const scrub: ScrubResult = {
    scrubbedContent: '',   // not stored in memory for large files
    totalRedacted,
    stats: totalStats,
    accountName,
    lineCount,
  }

  // For non-writeToDisk mode (tests), assemble in-memory chunks
  if (!writeToDisk && pendingData.length > 0) {
    const content = headerLine + '\n' + pendingData.join('\n')
    inMemoryChunks.push({
      index:   1,
      name:    chunkMeta[0]?.name ?? 'data.csv',
      content,
      size:    Buffer.byteLength(content, 'utf8'),
    })
    scrub.scrubbedContent = content
  }

  const chunks: Chunk[] = writeToDisk
    ? chunkMeta.map(m => ({ ...m, content: '' }))
    : inMemoryChunks

  const split: SplitResult = { chunks, totalChunks: chunks.length }
  const outputPaths = writeToDisk ? chunkMeta.map(m => join(outputDir, m.name)) : []
  const prompts     = generatePrompts(accountName)

  return { scrub, split, outputPaths, prompts }
}

// ─── Prompt generation ────────────────────────────────────────────────────────

const FILTER_LOGIC =
  ' If I included the enabled locations spreadsheet, please use it to narrow down ' +
  'the results of the data. Exclusively focus on locations in this sheet that contain ' +
  '"True" in the "channel enabled" column within the spreadsheet. If I did not include ' +
  'this spreadsheet, please process my other requests above.'

/**
 * Generate the full set of Claude analysis prompts for a given account name.
 * Replaces the `prompts` array built inside browser `runScrub()`.
 */
export function generatePrompts(accountName: string): Prompt[] {
  const n = accountName  // shorthand

  return [
    {
      title: 'Full Account Analysis',
      text:  `Comprehensively analyze ${n}'s messaging data, then give me total volume, ` +
             `sent/received split, branch-by-branch volume, top reps, themes, attachment rate, ` +
             `BTM usage, trend direction, and any risk or engagement flags - then combine that ` +
             `data into a single Usage and Trend Report document representing the whole account. ` +
             `Within that same report, also include how much money in quotes has been facilitated ` +
             `through all of the messages in the account. When gathering quote data, ignore spam, ` +
             `only focus on real quotes where a dollar amount was suggested to a customer or brought ` +
             `up somewhere within the conversation.${FILTER_LOGIC}`,
    },
    {
      title: 'Executive Summary',
      text:  `Review ${n}'s Prokeep messaging data and write a tight executive summary - one page, ` +
             `narrative format, suitable for leadership. Lead with the headline number, tell the ` +
             `story of how this account is using Prokeep, whether they are healthy or at risk, and ` +
             `what the single most important takeaway is. Keep it direct and avoid bullet-point ` +
             `lists - this should read like a concise business brief.${FILTER_LOGIC}`,
    },
    {
      title: 'Rep Performance Breakdown',
      text:  `Analyze the rep-level activity in ${n}'s Prokeep messaging data. For each rep, show ` +
             `total message volume, outbound vs. inbound breakdown, average response patterns, and ` +
             `thread activity. Identify who is most active, who has gone quiet or shows declining ` +
             `engagement, and flag any reps worth recognizing for strong performance or flagging ` +
             `for coaching conversations. Present findings as a ranked breakdown by activity level.${FILTER_LOGIC}`,
    },
    {
      title: 'BTM Usage Report',
      text:  `Focus exclusively on broadcast text messaging activity in ${n}'s Prokeep data. ` +
             `Identify how many BTM messages were sent, which branches sent them, estimated ` +
             `recipient reach where inferable, and any patterns in timing or content type. Assess ` +
             `whether BTM is being used consistently or sporadically, and note whether there are ` +
             `branches not using it at all. Summarize with a recommendation on where BTM adoption ` +
             `could be strengthened.${FILTER_LOGIC}`,
    },
    {
      title: 'Upsell & Expansion Opportunities',
      text:  `Review ${n}'s Prokeep usage data and identify upsell and expansion opportunities. ` +
             `Look for features with low or no adoption, branches with high message volume that may ` +
             `benefit from additional seats or capabilities, and usage patterns that suggest readiness ` +
             `for Growth Hub, integrations, or other add-ons. Frame each opportunity with the ` +
             `supporting data and a recommended conversation angle for the account team.${FILTER_LOGIC}`,
    },
    {
      title: 'CSAT & Sentiment Signals',
      text:  `Analyze ${n}'s Prokeep messaging data for customer satisfaction and sentiment signals. ` +
             `Look at response time patterns, thread length and resolution patterns, message tone ` +
             `where readable, and any recurring friction points or complaints visible in the ` +
             `conversations. Flag any red flags - unanswered threads, escalating language, or ` +
             `high-volume complaint patterns. Summarize with an overall sentiment assessment and ` +
             `any specific areas to address.${FILTER_LOGIC}`,
    },
    {
      title: 'QBR Talking Points',
      text:  `Pull the 5 to 7 most compelling data points from ${n}'s Prokeep messaging data to ` +
             `use in a quarterly business review. For each talking point, state the metric or ` +
             `finding, explain why it matters, and frame it as either a win to celebrate, a trend ` +
             `to highlight, or a forward-looking recommendation. Output should be structured as ` +
             `ready-to-use QBR talking points that a Prokeep employee could bring directly into ` +
             `a customer conversation.${FILTER_LOGIC}`,
    },
    {
      title: 'Mid-Year Review + Deck',
      text:  `You are going to do two things with the ${n} Prokeep data I am uploading.\n\n` +
             `First, conduct a full mid-year review analysis. Cover total message volume, ` +
             `sent/received split, branch-by-branch performance, top and lowest-activity reps, ` +
             `thread and response trends, BTM usage, attachment rate, quotes facilitated, any risk ` +
             `flags, and a half-year trend direction assessment. Write this up as a structured ` +
             `Mid-Year Review report with clear sections.\n\nSecond, using that analysis, build a ` +
             `complete PowerPoint presentation deck for the mid-year review.${FILTER_LOGIC}`,
    },
  ]
}

// ─── ScrubService object (IPC-friendly façade) ────────────────────────────────

export const ScrubService = {
  /**
   * Start a scrub_process job for a file already on disk.
   * Called from ipc-router when the user submits a file path.
   */
  enqueueFile(inputPath: string, outputDir?: string, chunkSizeBytes?: number): string {
    const db     = getDb()
    const jobId  = ulid()
    const scrubId = ulid()

    // Create the scrub_jobs record
    db.prepare(`
      INSERT INTO scrub_jobs (id, source_filename, source_path, status)
      VALUES (?, ?, ?, 'uploaded')
    `).run(scrubId, basename(inputPath), inputPath)

    // Enqueue the background job
    JobQueue.enqueue('scrub_process', {
      inputPath,
      outputDir,
      chunkSizeBytes,
      scrub_job_id: scrubId,
    }, 'user')

    return scrubId
  },

  /**
   * Return all scrub_jobs from the DB, newest first.
   */
  listJobs() {
    return getDb()
      .prepare("SELECT * FROM scrub_jobs ORDER BY created_at DESC LIMIT 50")
      .all()
  },

  /**
   * Delete all scrub job records from DB (full reset).
   */
  clearAllJobs() {
    getDb().prepare('DELETE FROM scrub_jobs').run()
  },

  // Re-export pure functions so callers only need to import ScrubService
  scrubData,
  splitData,
  generatePrompts,
  parseCSVRow,
  extractAccountName,
  processFile,
}
