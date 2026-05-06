/**
 * AnalysisService — local algorithmic Risk & Expansion analysis engine.
 *
 * Memory-efficient two-pass STREAMING design:
 *   - Uses readline + createReadStream — never loads the full file into memory.
 *   - Pass 1: stream once to collect spam thread IDs from the Thread ID + Text columns.
 *   - Pass 2: stream once to aggregate all metrics (counters, Maps, small arrays).
 *   - Safe for any file size; V8 heap only ever holds one CSV line at a time.
 *
 * Infinity values are capped before serialization (JSON.stringify(Infinity) === "null").
 */

import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { ulid } from 'ulid'
import { getDb } from '../db/database'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RepStats {
  name: string
  sent: number
  shareOfOutbound: number
  branch: string
}

export interface BranchStats {
  name: string
  total: number
  sent: number
  received: number
  sentRate: number
  inboundRatio: number        // capped at 99 so it survives JSON roundtrip
  reps: RepStats[]
  avgClaimTimeMinutes: number | null
}

export interface MonthlyPoint {
  label: string
  yearMonth: string
  count: number
  change: number | null
}

export interface ThemeStats {
  name: string
  count: number
  percentage: number
}

export interface QuoteStats {
  totalValue: number
  threadCount: number
  avg: number
  median: number
  top10: Array<{ amount: number; preview: string }>
}

export interface RiskFlag {
  severity: 'critical' | 'high' | 'medium'
  title: string
  description: string
  branch?: string
  metric?: string
}

export interface ExpansionSignal {
  title: string
  description: string
  metric?: string
  score: number
  positive: boolean
}

export interface AnalysisResult {
  id: string
  accountName: string
  analyzedAt: string
  csvRowCount: number
  dateRange: { start: string; end: string }
  totalMessages: number
  sentMessages: number
  receivedMessages: number
  sentRate: number
  receivedRate: number
  spamCount: number
  realMessages: number
  attachmentCount: number
  attachmentRate: number
  branches: BranchStats[]
  activeBranches: number
  topReps: RepStats[]
  themes: ThemeStats[]
  monthlyTrend: MonthlyPoint[]
  quotes: QuoteStats
  avgClaimTimeMinutes: number | null
  btmMessageCount: number
  btmHasRealContent: boolean
  riskFlags: RiskFlag[]
  expansionSignals: ExpansionSignal[]
  riskScore: number
  expansionScore: number
}

// ─── Spam patterns ────────────────────────────────────────────────────────────

const SPAM_PATTERNS: RegExp[] = [
  /google ads|facebook ads|limited.time offer/i,
  /promo code|discount code|\d+% off/i,
  /click here to unsubscribe|opt out|opt-out/i,
  /get a free|claim your free/i,
  /won a prize|congratulations you.ve been selected/i,
  /payday loan|bad credit|no credit check/i,
  /cryptocurrency|bitcoin|crypto investment/i,
  /make money from home|work from home opportunity/i,
  /doordash|grubhub|uber eats|food delivery/i,
  /legal action|lawsuit filed|court notice|attorney/i,
  /irs.*debt|tax debt relief/i,
  /car warranty|vehicle warranty extended/i,
  /donate.*campaign|campaign.*donate/i,
  /medical alert|medicare.*offer/i,
  /weight loss|lose \d+ pounds/i,
  /social security.*suspended|ssn.*issue/i,
  /bank account.*suspended|verify your account/i,
  /generic message for this group/i,
  /new website.*limited.time|we.ll cover the cost of/i,
  /roofing|solar panel|window replacement quote/i,
  /insurance rate|life insurance quote/i,
  /REPLY STOP to cancel|reply stop|text stop/i,
  /marketing agency|digital marketing/i,
  /debt collector|collection agency/i,
  /you.ve been approved for/i,
]

// ─── Theme patterns ───────────────────────────────────────────────────────────

const THEME_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'Order / Pricing Inquiry', re: /\bprice\b|quote|total|ticket|order|estimate|\bcost\b|how much|rate\b/i },
  { name: 'Product Inquiry',         re: /do you have|in stock|stock|available|carry|part number|model|brand/i },
  { name: 'Delivery / Pickup',       re: /deliver|pickup|pick.?up|driver|shipping|drop.?off|bring|eta\b/i },
  { name: 'Scheduling / Timing',     re: /\btoday\b|\btomorrow\b|monday|tuesday|wednesday|thursday|friday|schedule|what time|when\b/i },
  { name: 'Contact / Callback',      re: /call me|call.?back|reach me|\bemail\b|contact info|number is/i },
  { name: 'Account / Payment',       re: /invoice|balance|credit|\bcheck\b|\bpayment\b|\breceipt\b|\baccount\b|\bowe\b|statement/i },
  { name: 'Stock / Availability',    re: /in.?stock|out.?of.?stock|backordered|not available|when.*come in|restock/i },
]

// ─── Dollar regex ─────────────────────────────────────────────────────────────

const DOLLAR_RE = /\$\s*[\d,]+\.?\d{0,2}/g

/**
 * Patterns that indicate a dollar amount is NOT a sales quote — e.g. past-due
 * balances, collections, penalties, refunds, regulatory fines.  When any of
 * these match the message text we skip that amount for quote-facilitation stats.
 */
const QUOTE_EXCLUSION_RE = /past.?due|balance.?due|overdue|collection agency|amount.?owed|outstanding.?balance|regulatory|notice of violation|penalty|your.?refund|reimburse|credit.?memo|statement.?balance|invoice.?due|payment.?due|you.?owe/i

// ─── CSV row parser ───────────────────────────────────────────────────────────

function parseCSVRow(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      cells.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function parseMonthKey(sentAt: string): string | null {
  const iso = sentAt.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}`
  // "Thu, Feb 19, 2026, 7:28 PM"
  const named = sentAt.match(/(\w+)\s+(\d+),\s+(\d{4})/)
  if (named) {
    const MONTHS: Record<string, string> = {
      Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
      Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'
    }
    const m = MONTHS[named[1]]
    if (m) return `${named[3]}-${m}`
  }
  return null
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  const LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${LABELS[parseInt(m) - 1]} ${y}`
}

function parseDollarAmount(s: string): number {
  return parseFloat(s.replace(/[\$,\s]/g, '')) || 0
}

// ─── US geography lookups (for branch-name filtering) ────────────────────────

const US_STATE_ABBR = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
])

const US_STATE_FULL = new Set([
  'ALABAMA','ALASKA','ARIZONA','ARKANSAS','CALIFORNIA','COLORADO','CONNECTICUT',
  'DELAWARE','FLORIDA','GEORGIA','HAWAII','IDAHO','ILLINOIS','INDIANA','IOWA',
  'KANSAS','KENTUCKY','LOUISIANA','MAINE','MARYLAND','MASSACHUSETTS','MICHIGAN',
  'MINNESOTA','MISSISSIPPI','MISSOURI','MONTANA','NEBRASKA','NEVADA',
  'NEW HAMPSHIRE','NEW JERSEY','NEW MEXICO','NEW YORK','NORTH CAROLINA',
  'NORTH DAKOTA','OHIO','OKLAHOMA','OREGON','PENNSYLVANIA','RHODE ISLAND',
  'SOUTH CAROLINA','SOUTH DAKOTA','TENNESSEE','TEXAS','UTAH','VERMONT',
  'VIRGINIA','WASHINGTON','WEST VIRGINIA','WISCONSIN','WYOMING',
])

/**
 * Return true only when the Group Name looks like a real branch/location name.
 *
 * Blueprint's CSV stores the thread/conversation name in Group Name for EVERY
 * thread type — including 1:1 chats whose names are dates, state codes, zip
 * codes, address fragments, or message text.  This guard rejects all of those.
 *
 * Rejected patterns
 * ─────────────────
 *  • Empty / whitespace-only
 *  • Bare year numbers        (2025, 2026 …)
 *  • Short date strings       ("Feb 27", "Mar 5", "Jul 17")
 *  • Starts with non-letter/non-digit  ("& flame sensor A", "#group")
 *  • US state abbreviations alone      ("IL", "CA", "GA", "ID")
 *  • US state full name alone          ("Illinois", "California")
 *  • State + zip (with optional extra) ("IL 60618", "ID 83402 4", "Illinois 60803")
 *  • Bare zip code                     ("60618")
 *  • Contains comma                    ("IL 60070,Fri", "reply STOP.,Tue")
 *  • Contains ? or !                   (message text)
 *  • Day-of-week abbreviation anywhere ("Tue", "Fri" …)
 *  • Contains digits mixed with slashes/dashes (order/ref numbers)
 *  • Ends with a single uppercase letter word ("President A", "backhoes A")
 *  • Pure numeric string
 *  • Longer than 50 characters
 *  • Six or more words
 */
function isValidBranchName(name: string): boolean {
  if (!name || !name.trim()) return false

  const t     = name.trim()
  const clean = t.replace(/[.,;:!?'"]+$/, '').trim()  // strip trailing punctuation
  const up    = clean.toUpperCase()
  const words = clean.split(/\s+/)

  // Must start with a letter or digit
  if (/^[^A-Za-z0-9]/.test(t)) return false

  // Pure year 2000–2099
  if (/^\d{4}$/.test(clean) && +clean >= 2000 && +clean <= 2099) return false

  // Short date: "Feb 27", "Mar 5", "Jul 17"
  if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2}$/i.test(clean)) return false

  // Pure number (includes bare zip codes)
  if (/^\d+$/.test(clean)) return false

  // Contains a comma → address / message fragment
  if (t.includes(',')) return false

  // Sentence punctuation anywhere → message text
  if (/[?!]/.test(t)) return false

  // Day-of-week abbreviation anywhere
  if (/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i.test(t)) return false

  // Bare US state abbreviation ("IL", "CA", "GA", "ID")
  if (US_STATE_ABBR.has(up)) return false

  // Bare US state full name ("Illinois", "California", "Idaho")
  if (US_STATE_FULL.has(up)) return false

  // State (abbr or full) + 5-digit zip, with optional trailing tokens
  // catches: "IL 60618", "ID 83402 4", "Illinois 60803", "IL 60618."
  const stateZipMatch = clean.match(/^([A-Za-z]{2,}(?:\s+[A-Za-z]+)?)\s+(\d{5})(\b.*)?$/)
  if (stateZipMatch) {
    const candidate = stateZipMatch[1].toUpperCase()
    if (US_STATE_ABBR.has(candidate) || US_STATE_FULL.has(candidate)) return false
  }

  // Anything ending with a 5-digit zip (e.g., "Illinois 60803")
  if (/\s\d{5}(\s+\S+)*$/.test(clean)) return false

  // Ends with a lone single uppercase letter — grade/code suffix artifact
  // catches: "President A", "backhoes A", "& flame sensor A", "repair or replace A"
  if (words.length >= 2 && /^[A-Z]$/.test(words[words.length - 1])) return false

  // Too long to be a location name
  if (t.length > 50) return false

  // Too many words → message text snippet
  if (t.split(/\s+/).length > 5) return false

  return true
}

/** Cap Infinity / NaN before JSON serialization to avoid JSON.stringify → null */
function safeRatio(n: number): number {
  if (!isFinite(n) || isNaN(n)) return 99
  return Math.round(n * 10) / 10
}

function safeNum(n: number | null | undefined): number {
  if (n === null || n === undefined || isNaN(n as number)) return 0
  if (!isFinite(n as number)) return 0
  return n as number
}

// ─── Line streaming helper ────────────────────────────────────────────────────

/**
 * Stream a file line-by-line using readline + createReadStream.
 * The file is NEVER fully loaded into memory — V8 only sees one line at a time.
 * Calls onLine(rawLine, lineIndex) for every non-empty line; lineIndex 0 = header.
 */
function streamFileLines(
  filePath: string,
  onLine: (line: string, lineIndex: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let idx = 0
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 128 * 1024 }),
      crlfDelay: Infinity,   // treat \r\n as a single newline
    })
    rl.on('line', rawLine => {
      const line = rawLine.trim()
      if (line) onLine(line, idx++)
    })
    rl.on('close', resolve)
    rl.on('error', reject)
  })
}

// ─── Column index builder ─────────────────────────────────────────────────────

function buildColMap(headerLine: string) {
  const headers = parseCSVRow(headerLine)
  const hi = (name: string) =>
    headers.findIndex(
      h => h.trim().toLowerCase().replace(/\s+/g, '_') === name.toLowerCase().replace(/\s+/g, '_')
    )
  const COL = {
    accountName:       hi('Account Name'),
    groupName:         2 as number,   // Column C always contains branch/group/location names
    threadType:        hi('Thread Type'),
    messageStatus:     hi('Message Status'),
    sentAt:            hi('Sent At'),
    sentAtInTimezone:  hi('Sent At In Timezone'),
    text:              hi('Text'),
    senderName:        hi('Sender Name'),
    senderContactType: hi('Sender Contact Type'),
    threadId:          hi('Thread ID'),
    hasAttachment:     hi('Has Attachment'),
    claimTime:         hi('Claim Time'),
  }
  const get = (cells: string[], i: number) => i >= 0 ? (cells[i] || '').trim() : ''
  return { COL, get }
}

// ─── Main Analysis (async, streaming) ────────────────────────────────────────

export async function analyzeFilePath(
  filePath: string,
  accountNameOverride?: string,
): Promise<AnalysisResult> {

  // ── Pass 1: read header + collect spam thread IDs ────────────────────────
  // We only parse Thread ID and Text columns here — very cheap per-line cost.
  let COL: ReturnType<typeof buildColMap>['COL'] | null = null
  let get: ReturnType<typeof buildColMap>['get'] = () => ''
  const spamThreadIds = new Set<string>()
  let csvRowCount = 0

  await streamFileLines(filePath, (line, idx) => {
    if (idx === 0) {
      // Header row — build column map
      const m = buildColMap(line)
      COL = m.COL
      get = m.get
      return
    }
    if (!COL) return
    csvRowCount++
    const cells = parseCSVRow(line)
    const tid   = get(cells, COL.threadId)
    const text  = get(cells, COL.text)
    if (tid && text && SPAM_PATTERNS.some(re => re.test(text))) spamThreadIds.add(tid)
  })

  if (!COL) throw new Error('CSV appears to be empty or missing a header row')

  const C  = COL   // non-null alias for Pass 2
  const g  = get

  // ── Pass 2: aggregate metrics (streaming, never loads full file) ──────────
  let accountName = accountNameOverride || ''
  let totalMessages = 0, sentMessages = 0, receivedMessages = 0, attachmentCount = 0
  let btmMessageCount = 0, btmHasRealContent = false
  let spamCount = 0
  let firstDate = '', lastDate = ''

  type BranchAgg = { total: number; sent: number; received: number; reps: Map<string, number>; claimTimes: number[] }
  const branchAgg    = new Map<string, BranchAgg>()
  const monthlyMap   = new Map<string, number>()
  const themeCounts  = new Array<number>(THEME_PATTERNS.length).fill(0)
  const threadQuotes = new Map<string, { amount: number; preview: string }>()
  const allClaimTimes: number[] = []
  const globalRepAgg = new Map<string, { sent: number; branch: string }>()

  await streamFileLines(filePath, (line, idx) => {
    if (idx === 0) return  // skip header — already processed in Pass 1

    const cells = parseCSVRow(line)

    // Extract account name from first real data row
    if (!accountName && C.accountName >= 0) accountName = g(cells, C.accountName)

    const groupName  = g(cells, C.groupName)
    const threadType = g(cells, C.threadType)
    const msgStatus  = g(cells, C.messageStatus)
    const text       = g(cells, C.text)
    const tid        = g(cells, C.threadId)
    const sentAtRaw  = g(cells, C.sentAt) || g(cells, C.sentAtInTimezone)

    // ── BTM / Broadcasts channel ────────────────────────────────────────────
    const isBtm = groupName.toLowerCase().includes('broadcast') ||
                  threadType.toLowerCase() === 'broadcast'
    if (isBtm) {
      btmMessageCount++
      if (text.length > 5 && !SPAM_PATTERNS.some(re => re.test(text))) btmHasRealContent = true
      return
    }

    // ── Spam filter ──────────────────────────────────────────────────────────
    if (tid && spamThreadIds.has(tid)) { spamCount++; return }

    // ── Real message aggregation ─────────────────────────────────────────────
    totalMessages++
    const isSent     = msgStatus === 'sent'
    const isReceived = msgStatus === 'received'
    if (isSent)     sentMessages++
    if (isReceived) receivedMessages++
    if (g(cells, C.hasAttachment) === '1') attachmentCount++

    // Date range
    if (sentAtRaw) {
      if (!firstDate || sentAtRaw < firstDate) firstDate = sentAtRaw
      if (!lastDate  || sentAtRaw > lastDate)  lastDate  = sentAtRaw
    }

    // Monthly trend
    const mk = parseMonthKey(sentAtRaw)
    if (mk) monthlyMap.set(mk, (monthlyMap.get(mk) || 0) + 1)

    // Branch aggregation — only rows whose Group Name looks like a real location.
    // Dates ("Feb 27"), years ("2025"), and message text snippets are filtered out.
    const bname = isValidBranchName(groupName) ? groupName : ''
    if (bname && !branchAgg.has(bname)) {
      branchAgg.set(bname, { total: 0, sent: 0, received: 0, reps: new Map(), claimTimes: [] })
    }
    const b = bname ? branchAgg.get(bname) : undefined
    if (b) {
      b.total++
      if (isSent)     b.sent++
      if (isReceived) b.received++
    }

    // Claim time
    const ct = parseInt(g(cells, C.claimTime), 10)
    if (!isNaN(ct) && ct >= 0 && ct < 50000) {
      allClaimTimes.push(ct)
      if (b) b.claimTimes.push(ct)
    }

    // Rep stats (staff senders only)
    const senderType = g(cells, C.senderContactType)
    const senderName = g(cells, C.senderName)
    if (isSent && (senderType === 'user' || senderType === '')) {
      if (b) b.reps.set(senderName, (b.reps.get(senderName) || 0) + 1)
      if (!globalRepAgg.has(senderName)) globalRepAgg.set(senderName, { sent: 0, branch: bname || '' })
      globalRepAgg.get(senderName)!.sent++
    }

    // Theme detection
    if (text) {
      for (let t = 0; t < THEME_PATTERNS.length; t++) {
        if (THEME_PATTERNS[t].re.test(text)) { themeCounts[t]++; break }
      }
    }

    // Quote detection (dollar amounts per thread)
    // Skip messages that are clearly about collections, past-due balances,
    // penalties, refunds, or other non-sales dollar amounts.
    if (text && tid && !QUOTE_EXCLUSION_RE.test(text)) {
      const matches = text.match(DOLLAR_RE)
      if (matches) {
        const amounts = matches.map(m => parseDollarAmount(m)).filter(n => n > 0 && n < 1_000_000)
        if (amounts.length > 0) {
          const maxAmt = Math.max(...amounts)
          const existing = threadQuotes.get(tid)
          if (!existing || maxAmt > existing.amount) {
            threadQuotes.set(tid, { amount: maxAmt, preview: text.slice(0, 80) })
          }
        }
      }
    }
  })

  accountName = accountName || accountNameOverride || 'Unknown Account'

  // ── Month span ────────────────────────────────────────────────────────────
  const monthCount = Math.max(monthlyMap.size, 1)

  // ── Branches ──────────────────────────────────────────────────────────────
  const branches: BranchStats[] = []
  for (const [name, agg] of branchAgg) {
    const repList: RepStats[] = [...agg.reps.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([rName, cnt]) => ({
        name:            rName,
        sent:            cnt,
        shareOfOutbound: agg.sent > 0 ? cnt / agg.sent : 0,
        branch:          name,
      }))
    const avgClaim = agg.claimTimes.length > 0
      ? Math.round(agg.claimTimes.reduce((a, b) => a + b, 0) / agg.claimTimes.length)
      : null

    // Cap inboundRatio before it can become Infinity
    const rawRatio = agg.sent > 0 ? agg.received / agg.sent : 99
    branches.push({
      name,
      total:    agg.total,
      sent:     agg.sent,
      received: agg.received,
      sentRate: agg.total > 0 ? agg.sent / agg.total : 0,
      inboundRatio: safeRatio(rawRatio),
      reps: repList,
      avgClaimTimeMinutes: avgClaim,
    })
  }
  branches.sort((a, b) => b.total - a.total)
  const activeBranches = branches.filter(b => b.total > 0).length

  // ── Top reps ──────────────────────────────────────────────────────────────
  const topReps: RepStats[] = [...globalRepAgg.entries()]
    .sort((a, b) => b[1].sent - a[1].sent)
    .slice(0, 10)
    .map(([name, data]) => ({
      name,
      sent:            data.sent,
      branch:          data.branch,
      shareOfOutbound: sentMessages > 0 ? data.sent / sentMessages : 0,
    }))

  // ── Themes ────────────────────────────────────────────────────────────────
  const themes: ThemeStats[] = THEME_PATTERNS.map((t, i) => ({
    name:       t.name,
    count:      themeCounts[i],
    percentage: totalMessages > 0 ? (themeCounts[i] / totalMessages) * 100 : 0,
  })).sort((a, b) => b.count - a.count)

  // ── Monthly trend ─────────────────────────────────────────────────────────
  const sortedMonths = [...monthlyMap.keys()].sort()
  const monthlyTrend: MonthlyPoint[] = sortedMonths.map((ym, idx) => {
    const count = monthlyMap.get(ym) || 0
    const prev  = idx > 0 ? (monthlyMap.get(sortedMonths[idx - 1]) || 0) : null
    const change = prev !== null && prev > 0 ? ((count - prev) / prev) * 100 : null
    return { yearMonth: ym, label: monthLabel(ym), count, change }
  })

  // ── Quote stats ───────────────────────────────────────────────────────────
  const allQuotes = [...threadQuotes.values()].sort((a, b) => b.amount - a.amount)
  const qAmounts  = allQuotes.map(q => q.amount)
  const totalQuoteValue = qAmounts.reduce((a, b) => a + b, 0)
  const avgQuote  = qAmounts.length > 0 ? totalQuoteValue / qAmounts.length : 0
  const sorted    = [...qAmounts].sort((a, b) => a - b)
  const medianQuote = sorted.length > 0
    ? sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)]
    : 0
  const quotes: QuoteStats = {
    totalValue:  Math.round(totalQuoteValue * 100) / 100,
    threadCount: allQuotes.length,
    avg:         Math.round(avgQuote * 100) / 100,
    median:      Math.round(medianQuote * 100) / 100,
    top10:       allQuotes.slice(0, 10).map(q => ({ amount: q.amount, preview: q.preview })),
  }

  // ── Response time ─────────────────────────────────────────────────────────
  const avgClaimTimeMinutes = allClaimTimes.length > 0
    ? Math.round(allClaimTimes.reduce((a, b) => a + b, 0) / allClaimTimes.length)
    : null

  // ── Derived rates ─────────────────────────────────────────────────────────
  const sentRate       = totalMessages > 0 ? safeNum(sentMessages / totalMessages) : 0
  const receivedRate   = totalMessages > 0 ? safeNum(receivedMessages / totalMessages) : 0
  const attachmentRate = totalMessages > 0 ? safeNum(attachmentCount / totalMessages) : 0
  const avgMonthlyMsgs = safeNum(totalMessages / monthCount)

  // ── Risk flags ────────────────────────────────────────────────────────────
  const riskFlags: RiskFlag[] = []

  // ── Low outbound branches — consolidated into one flag (top 5 worst) ─────
  const lowOutboundRiskBranches = branches
    .filter(b => (b.sent / monthCount) < 2 && b.total >= 5)
    .slice(0, 5)
  if (lowOutboundRiskBranches.length === 1) {
    const b = lowOutboundRiskBranches[0]
    const outPerMonth = b.sent / monthCount
    riskFlags.push({
      severity:    'critical',
      title:       `${b.name} — Critically Low Outbound Activity`,
      description: `Only ${b.sent} outbound messages over ${monthCount} months (${outPerMonth.toFixed(1)}/month). Staff are receiving but rarely initiating — customers may perceive this channel as one-way or unreliable.`,
      branch:      b.name,
      metric:      `${b.sent} sent / ${monthCount} months`,
    })
  } else if (lowOutboundRiskBranches.length > 1) {
    const branchList = lowOutboundRiskBranches.map(b => b.name).join(', ')
    riskFlags.push({
      severity:    'critical',
      title:       `Low Outbound Activity — ${lowOutboundRiskBranches.length} Branches`,
      description: `${branchList} show critically low outbound messaging. Staff are receiving but rarely initiating — customers may perceive this channel as one-way or unreliable.`,
      metric:      lowOutboundRiskBranches.map(b => `${b.name}: ${(b.sent / monthCount).toFixed(1)}/mo`).join(' · '),
    })
  }

  // ── Heavy inbound-skew branches — consolidated into one flag (top 5) ──────
  const highSkewBranches = branches
    .filter(b => b.inboundRatio > 4 && b.sent > 5)
    .slice(0, 5)
  if (highSkewBranches.length === 1) {
    const b = highSkewBranches[0]
    riskFlags.push({
      severity:    'high',
      title:       `${b.name} — Heavy Inbound Skew (${b.inboundRatio.toFixed(1)}:1)`,
      description: `Receiving ${b.received} messages vs only ${b.sent} sent — a ${b.inboundRatio.toFixed(1)}:1 ratio. Reps are primarily responding rather than initiating conversations.`,
      branch:      b.name,
      metric:      `${b.inboundRatio.toFixed(1)}:1 inbound ratio`,
    })
  } else if (highSkewBranches.length > 1) {
    const branchList = highSkewBranches.map(b => b.name).join(', ')
    riskFlags.push({
      severity:    'high',
      title:       `Heavy Inbound Skew — ${highSkewBranches.length} Branches`,
      description: `${branchList} show high inbound-to-outbound ratios. Reps are primarily responding rather than initiating — proactive outreach coaching could significantly improve engagement.`,
      metric:      highSkewBranches.map(b => `${b.name}: ${b.inboundRatio.toFixed(1)}:1`).join(' · '),
    })
  }

  // ── Volume dips ───────────────────────────────────────────────────────────
  for (let i = 1; i < monthlyTrend.length; i++) {
    const pt = monthlyTrend[i]
    if (pt.change !== null && pt.change < -40 && monthlyTrend[i - 1].count > 30) {
      riskFlags.push({
        severity:    'high',
        title:       `${pt.label} Volume Dip (${Math.abs(pt.change).toFixed(0)}% drop)`,
        description: `Message volume dropped ${Math.abs(pt.change).toFixed(0)}% from ${monthlyTrend[i - 1].label} (${monthlyTrend[i - 1].count}) to ${pt.label} (${pt.count}). Warrants investigation — seasonal, staffing, or usage gap.`,
        metric:      `${Math.abs(pt.change).toFixed(0)}% month-over-month drop`,
      })
    }
  }

  // ── BTM adoption gap ──────────────────────────────────────────────────────
  if (!btmHasRealContent) {
    riskFlags.push({
      severity:    'medium',
      title:       'No Active BTM Campaigns Detected',
      description: `Broadcast text messaging shows ${btmMessageCount > 0 ? 'only placeholder records' : 'no activity'}. BTM is a significant adoption lever for promotions, announcements, and customer re-engagement.`,
      metric:      `${btmMessageCount} BTM records, 0 real campaigns`,
    })
  }

  const severityOrder = { critical: 0, high: 1, medium: 2 }
  riskFlags.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
  // Cap to 5 risk flags maximum
  riskFlags.splice(5)

  let riskScore = 0
  for (const f of riskFlags) {
    if (f.severity === 'critical')    riskScore += 30
    else if (f.severity === 'high')   riskScore += 18
    else                              riskScore += 8
  }
  riskScore = Math.min(100, riskScore)

  // ── Expansion signals ─────────────────────────────────────────────────────
  const expansionSignals: ExpansionSignal[] = []

  if (attachmentRate >= 0.20) {
    expansionSignals.push({
      title:       'Deep Platform Integration — High Attachment Rate',
      description: `${(attachmentRate * 100).toFixed(1)}% of messages include attachments. Prokeep is deeply embedded in daily workflows — a strong foundation for growth conversations.`,
      metric:      `${(attachmentRate * 100).toFixed(1)}% attachment rate`,
      score:       25, positive: true,
    })
  } else if (attachmentRate >= 0.10) {
    expansionSignals.push({
      title:       'Moderate Attachment Usage — Growth Potential',
      description: `${(attachmentRate * 100).toFixed(1)}% attachment rate indicates partial workflow integration. Coaching on document and photo sharing could increase stickiness.`,
      metric:      `${(attachmentRate * 100).toFixed(1)}% attachment rate`,
      score:       12, positive: true,
    })
  }

  if (quotes.totalValue >= 50000) {
    expansionSignals.push({
      title:       'Significant Revenue Facilitation',
      description: `$${quotes.totalValue.toLocaleString()} in quote activity across ${quotes.threadCount} threads (avg $${quotes.avg.toLocaleString()}). Prokeep is actively supporting revenue-generating conversations.`,
      metric:      `$${quotes.totalValue.toLocaleString()} facilitated`,
      score:       25, positive: true,
    })
  } else if (quotes.totalValue > 0) {
    expansionSignals.push({
      title:       'Quote Facilitation Activity',
      description: `$${quotes.totalValue.toLocaleString()} in quote activity across ${quotes.threadCount} threads. Opportunity to increase revenue-generating conversation volume.`,
      metric:      `$${quotes.totalValue.toLocaleString()} facilitated`,
      score:       12, positive: true,
    })
  }

  const strongBranches = branches.filter(b => b.sentRate >= 0.40 && b.total >= 30).slice(0, 5)
  if (strongBranches.length > 0) {
    const topNames = strongBranches.map(b => b.name)
    expansionSignals.push({
      title:       `Best-Practice Branch${strongBranches.length > 1 ? 'es' : ''}: ${topNames.join(', ')}`,
      description: `${topNames.slice(0, 3).join(strongBranches.length > 2 ? ', ' : ' and ')}${strongBranches.length > 3 ? ` and ${strongBranches.length - 3} more` : ''} demonstrate a healthy outbound engagement model. Use ${strongBranches.length === 1 ? 'this branch' : 'these branches'} as an internal case study for coaching underperforming locations.`,
      metric:      strongBranches.map(b => `${b.name}: ${(b.sentRate * 100).toFixed(0)}% outbound`).join(' · '),
      score:       15, positive: true,
    })
  }

  if (!btmHasRealContent) {
    expansionSignals.push({
      title:       'BTM Campaign Opportunity',
      description: 'No broadcast text messaging campaigns in use. BTM enables mass customer outreach for promotions, seasonal alerts, price updates, and re-engagement — a high-leverage, low-effort growth channel.',
      metric:      '0 active BTM campaigns',
      score:       15, positive: false,
    })
  }

  const lowOutboundBranches = branches.filter(b => b.sentRate < 0.25 && b.total >= 20).slice(0, 5)
  if (lowOutboundBranches.length > 0) {
    const topLow = lowOutboundBranches.map(b => b.name)
    expansionSignals.push({
      title:       `Proactive Outreach Opportunity — ${lowOutboundBranches.length === 1 ? topLow[0] : `${lowOutboundBranches.length} Branches`}`,
      description: `${topLow.join(', ')} ${lowOutboundBranches.length === 1 ? 'is' : 'are'} heavily inbound-skewed. Coaching on proactive messaging could significantly increase revenue impact at these locations.`,
      metric:      lowOutboundBranches.map(b => `${b.name}: ${(b.sentRate * 100).toFixed(0)}% outbound`).join(' · '),
      score:       10, positive: false,
    })
  }

  // Cap to 5 expansion signals maximum (keep highest-scoring)
  expansionSignals.sort((a, b) => b.score - a.score)
  expansionSignals.splice(5)

  const expansionScore = Math.min(100, expansionSignals.reduce((s, x) => s + x.score, 0))

  return {
    id:              ulid(),
    accountName,
    analyzedAt:      new Date().toISOString(),
    csvRowCount,
    dateRange:       { start: lastDate, end: firstDate },
    totalMessages,
    sentMessages,
    receivedMessages,
    sentRate,
    receivedRate,
    spamCount,
    realMessages:    totalMessages,
    attachmentCount,
    attachmentRate,
    branches,
    activeBranches,
    topReps,
    themes,
    monthlyTrend,
    quotes,
    avgClaimTimeMinutes,
    btmMessageCount,
    btmHasRealContent,
    riskFlags,
    expansionSignals,
    riskScore,
    expansionScore,
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export function saveAnalysis(result: AnalysisResult, companyId?: string | null): void {
  const db = getDb()
  let resolvedCompanyId = companyId ?? null
  if (!resolvedCompanyId) {
    const co = db.prepare(
      'SELECT id FROM companies WHERE LOWER(name) = LOWER(?)'
    ).get(result.accountName) as { id: string } | undefined
    resolvedCompanyId = co?.id ?? null
  }

  db.prepare(`
    INSERT INTO company_analyses (id, company_id, account_name, analyzed_at, risk_data, expansion_data, raw_stats, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account_name) DO UPDATE SET
      company_id      = excluded.company_id,
      analyzed_at     = excluded.analyzed_at,
      risk_data       = excluded.risk_data,
      expansion_data  = excluded.expansion_data,
      raw_stats       = excluded.raw_stats,
      updated_at      = datetime('now')
  `).run(
    result.id,
    resolvedCompanyId,
    result.accountName,
    result.analyzedAt,
    JSON.stringify({ riskFlags: result.riskFlags, riskScore: result.riskScore }),
    JSON.stringify({ expansionSignals: result.expansionSignals, expansionScore: result.expansionScore }),
    JSON.stringify(result),
  )
}

export function getLatestAnalysis(): AnalysisResult | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT raw_stats FROM company_analyses ORDER BY analyzed_at DESC LIMIT 1'
  ).get() as { raw_stats: string } | undefined
  return row ? JSON.parse(row.raw_stats) as AnalysisResult : null
}

export function getAnalysisForCompany(companyId: string): AnalysisResult | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT raw_stats FROM company_analyses WHERE company_id = ? ORDER BY analyzed_at DESC LIMIT 1'
  ).get(companyId) as { raw_stats: string } | undefined
  return row ? JSON.parse(row.raw_stats) as AnalysisResult : null
}

export function getAnalysisForAccount(accountName: string): AnalysisResult | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT raw_stats FROM company_analyses WHERE LOWER(account_name) = LOWER(?) ORDER BY analyzed_at DESC LIMIT 1'
  ).get(accountName) as { raw_stats: string } | undefined
  return row ? JSON.parse(row.raw_stats) as AnalysisResult : null
}

export const AnalysisService = {
  analyzeFilePath,
  saveAnalysis,
  getLatestAnalysis,
  getAnalysisForCompany,
  getAnalysisForAccount,

  /** Async: streams the file with readline (no readFileSync — safe for large CSVs) */
  async analyzeFile(filePath: string, accountNameOverride?: string): Promise<AnalysisResult> {
    const result = await analyzeFilePath(filePath, accountNameOverride)
    saveAnalysis(result)
    return result
  },
}
