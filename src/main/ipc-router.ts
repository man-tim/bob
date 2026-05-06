import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { appendFileSync, existsSync, writeFileSync } from 'fs'
import { getDb }          from './db/database'
import { FlyerService }    from './services/FlyerService'
import { AppSettings }     from './services/AppSettings'
import { IPC }             from '@shared/ipc-channels'
import { IpcResult }       from '@shared/types'
import { CompanyService }     from './services/CompanyService'
import { TranscriptService }  from './services/TranscriptService'
import { CalendarService }    from './services/CalendarService'
import { DriveService }       from './services/DriveService'
import { SearchIndexService } from './services/SearchIndexService'
import { ScrubService }       from './services/ScrubService'
import { AnalysisService }    from './services/AnalysisService'
import { followUpService }    from './services/FollowUpService'
import { GongService }        from './services/GongService'
import { GongScraperService } from './services/GongScraperService'
import { AuthService }        from './auth/AuthService'
import { JobQueue }           from './jobs/JobQueue'
import { google }             from 'googleapis'
import {
  getNotificationsEnabled,
  setNotificationsEnabled,
  setNotificationWindows,
} from './services/NotificationSchedulerService'
import { LocalAIService } from './services/LocalAIService'

// ─── Bridge GongScraperService events → renderer push events ─────────────────

let gongBridgeRegistered = false
function ensureGongBridge(): void {
  if (gongBridgeRegistered) return
  gongBridgeRegistered = true
  function broadcast(channel: string, data: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, data)
    }
  }
  GongScraperService.on('log',             (e: unknown) => broadcast(IPC.PUSH_GONG_LOG,        e))
  GongScraperService.on('status',          (s: unknown) => broadcast(IPC.PUSH_GONG_STATUS,     s))
  GongScraperService.on('move-complete',   ()            => broadcast(IPC.PUSH_GONG_MOVE,       null))
  GongScraperService.on('login-needed',    (e: unknown) => broadcast(IPC.PUSH_LOGIN_NEEDED,    e))
  GongScraperService.on('login-done',      (e: unknown) => broadcast(IPC.PUSH_LOGIN_DONE,      e))
  GongScraperService.on('services-status', (s: unknown) => broadcast(IPC.PUSH_SERVICES_STATUS, s))
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function handle<T>(
  channel: string,
  fn: (...args: unknown[]) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await fn(...args)
      return { ok: true, data } satisfies IpcResult<T>
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[IPC] ${channel} error:`, error)
      return { ok: false, error } satisfies IpcResult<T>
    }
  })
}

// ─── Register all handlers ────────────────────────────────────────────────────

export function registerIpcHandlers(): void {

  // ── Auth ────────────────────────────────────────────────────────────────────
  handle(IPC.AUTH_LOGIN, async () => {
    const status = await AuthService.login()
    // After Google login, silently pre-warm HubSpot in the background.
    // The HubSpot window shares the default session (same as the Google OAuth popup),
    // so it finds the Google cookies and auto-completes SSO without user interaction.
    GongScraperService.preWarmHubSpot().catch(() => {})
    return status
  })
  handle(IPC.AUTH_LOGOUT, () => AuthService.logout())
  handle(IPC.AUTH_STATUS, () => AuthService.getStatus())

  // ── Companies ───────────────────────────────────────────────────────────────
  handle(IPC.COMPANIES_LIST,    (query)   => CompanyService.list(query as never))
  handle(IPC.COMPANIES_GET,     (id)      => CompanyService.get(id as string))
  handle(IPC.COMPANIES_DETAILS, (id)      => CompanyService.getDetails(id as string))
  handle(IPC.COMPANIES_UPSERT,  (company) => CompanyService.upsert(company as never))
  handle(IPC.COMPANIES_DELETE,  (id)      => CompanyService.delete(id as string))
  handle(IPC.COMPANIES_IMPORT,  ()        => JobQueue.enqueue('hubspot_import', {}, 'user'))

  // ── Contacts ────────────────────────────────────────────────────────────────
  handle(IPC.CONTACTS_LIST,   (companyId) => CompanyService.listContacts(companyId as string))
  handle(IPC.CONTACTS_UPSERT, (contact)   => CompanyService.upsertContact(contact as never))
  handle(IPC.CONTACTS_DELETE, (id)        => CompanyService.deleteContact(id as string))

  // ── Transcripts ─────────────────────────────────────────────────────────────
  handle(IPC.TRANSCRIPTS_LIST,   (query)           => TranscriptService.list(query as never))
  handle(IPC.TRANSCRIPTS_GET,    (id)               => TranscriptService.get(id as string))
  handle(IPC.TRANSCRIPTS_ASSIGN, (id, companyId)    => TranscriptService.assignCompany(id as string, companyId as string))
  handle(IPC.TRANSCRIPTS_RUN_ALL,()                 => TranscriptService.runAll())
  handle(IPC.TRANSCRIPTS_RUN_COLLECT,  ()           => JobQueue.enqueue('gong_collect',   {}, 'user'))
  handle(IPC.TRANSCRIPTS_RUN_ORGANIZE, ()           => JobQueue.enqueue('drive_organize', {}, 'user'))

  // ── Calendar ────────────────────────────────────────────────────────────────
  handle(IPC.CALENDAR_SYNC,   ()               => CalendarService.sync())
  handle(IPC.CALENDAR_EVENTS, ()               => CalendarService.getUpcomingEvents())
  handle(IPC.CALENDAR_ASSIGN, (id, companyId)  => CalendarService.assignCompany(id as string, companyId as string))

  // ── Jobs ────────────────────────────────────────────────────────────────────
  handle(IPC.JOBS_LIST, (query) => JobQueue.list(query as never))
  handle(IPC.JOBS_STOP, (id)    => JobQueue.cancel(id as string))
  handle(IPC.JOBS_LOGS, (jobId) => JobQueue.getLogs(jobId as string))

  // ── Schedules ───────────────────────────────────────────────────────────────
  handle(IPC.SCHEDULES_LIST,   ()         => CompanyService.listSchedules())
  handle(IPC.SCHEDULES_CREATE, (schedule) => CompanyService.createSchedule(schedule as never))
  handle(IPC.SCHEDULES_UPDATE, (schedule) => CompanyService.updateSchedule(schedule as never))
  handle(IPC.SCHEDULES_DELETE, (id)       => CompanyService.deleteSchedule(id as string))

  // ── Flyer ───────────────────────────────────────────────────────────────────
  handle(IPC.FLYER_TEMPLATES_LIST,   ()         => CompanyService.listFlyerTemplates())
  handle(IPC.FLYER_TEMPLATES_SAVE,   (template) => CompanyService.saveFlyerTemplate(template as never))
  handle(IPC.FLYER_TEMPLATES_DELETE, (id)       => CompanyService.deleteFlyerTemplate(id as string))
  handle(IPC.FLYER_GENERATE,    (input)          => FlyerService.generateFlyer(input as any))
  handle(IPC.FLYER_GENERATE_QR, (phone, keyword) => FlyerService.generateQr(phone as string, keyword as string))
  handle(IPC.FLYER_GET_TEMPLATE, (id) => {
    const dataUrl = FlyerService.getTemplateDataUrl(id as string)
    return dataUrl ? { dataUrl } : null
  })

  // ── Scrub & Split ───────────────────────────────────────────────────────────
  // SCRUB_UPLOAD: user picks a file path via native dialog, we register it
  handle(IPC.SCRUB_UPLOAD, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title:      'Select CSV file',
      filters:    [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    })
    if (canceled || !filePaths.length) return null

    const inputPath = filePaths[0]
    // Output goes next to the source file — no second dialog
    const outputDir = require('path').dirname(inputPath)

    const scrubJobId = ScrubService.enqueueFile(inputPath, outputDir)
    return { scrubJobId, inputPath, outputDir }
  })

  // SCRUB_PROCESS: kick off processing for an already-uploaded path (direct call)
  handle(IPC.SCRUB_PROCESS, async (inputPath, outputDir, chunkSizeBytes) => {
    const scrubJobId = ScrubService.enqueueFile(
      inputPath as string,
      outputDir as string | undefined,
      chunkSizeBytes as number | undefined
    )
    return { scrubJobId }
  })

  // SCRUB_EXPORT: return the list of scrub jobs (with output file paths)
  handle(IPC.SCRUB_JOBS, () => ScrubService.listJobs())

  // ── Gong / Book of Business ─────────────────────────────────────────────────
  handle(IPC.GONG_PROCESS_COMPANY,  (companyId) => GongService.processCompanyData(companyId as string))
  handle(IPC.GONG_BOOK_OF_BUSINESS, ()          => GongService.generateBookOfBusiness())

  // ── Search ──────────────────────────────────────────────────────────────────
  handle(IPC.SEARCH_QUERY,         (query, source) => SearchIndexService.search(query as string, source as never))
  handle(IPC.SEARCH_GLOBAL,        (query, limit)  => SearchIndexService.globalSearch(query as string, limit as number | undefined))
  handle(IPC.SEARCH_REBUILD_INDEX, ()              => SearchIndexService.rebuild())

  // ── File System ─────────────────────────────────────────────────────────────
  handle(IPC.FS_OPEN_DIALOG, (options) =>
    dialog.showOpenDialog(options as Electron.OpenDialogOptions)
  )
  handle(IPC.FS_SAVE_DIALOG, (options) =>
    dialog.showSaveDialog(options as Electron.SaveDialogOptions)
  )
  handle(IPC.FS_OPEN_EXTERNAL, (path) => {
    const p = path as string
    // Local absolute paths → openPath (opens in Finder/Explorer); URLs → openExternal
    if (p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p)) {
      return shell.openPath(p)
    }
    return shell.openExternal(p)
  })

  // Raw text file read — used by Flyer Creator CSV import
  ipcMain.handle(IPC.FS_READ_TEXT_FILE, async (_event, filePath: string) => {
    try {
      const { readFile } = await import('fs/promises')
      const text = await readFile(filePath, 'utf-8')
      return text
    } catch (err) {
      return ''
    }
  })

  // ── Analysis Popout window ────────────────────────────────────────────────
  handle(IPC.ANALYSIS_OPEN_POPOUT, async (type) => {
    const { join } = await import('path')
    const { app } = await import('electron')

    const win = new BrowserWindow({
      width:     1100,
      height:    750,
      minWidth:  800,
      minHeight: 500,
      title:     type === 'risk' ? 'Risk Analysis — Pop Out' : 'Expansion — Pop Out',
      backgroundColor: '#0D1525',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 12, y: 12 },
      webPreferences: {
        preload:          join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration:  false,
        sandbox:          false,
      },
    })

    const route = type === 'risk' ? '#/popout/risk' : '#/popout/expansion'
    if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${route}`)
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route.slice(1) })
    }

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return null
  })

  // ── Feedback Logger (dev tool) ────────────────────────────────────────────────
  // NOTE: uses ipcMain.handle directly (NOT the handle() wrapper) so the return
  // value is NOT double-wrapped. The renderer receives { ok, data/error } as-is.

  ipcMain.handle(IPC.FEEDBACK_LOG, async (_e, entry: {
    tag: string; id: string; className: string; innerText: string
    selectorPath: string; attributes: string; siblingContext: string; route: string
    note: string; timestamp: string
  }) => {
    const HEADER = '# B.O.B. UI Corrections Log\n\nPaste each entry below into a Claude prompt to fix UI issues.\n\n---\n\n'

    const block = [
      `## Correction — ${entry.timestamp}`,
      '',
      `**Note:** ${entry.note}`,
      '',
      '**Element:**',
      '```',
      `Route:     ${entry.route || '(unknown)'}`,
      `Tag:       ${entry.tag}${entry.id ? ` #${entry.id}` : ''}`,
      `Text:      ${entry.innerText ? `"${entry.innerText}"` : '(none)'}`,
      '',
      `Selector path:`,
      `  ${entry.selectorPath || '(none)'}`,
      '',
      ...(entry.attributes && entry.attributes !== '(none)' ? [
        `Attributes:`,
        `  ${entry.attributes}`,
        '',
      ] : []),
      ...(entry.siblingContext && entry.siblingContext !== '(only child)' && entry.siblingContext !== '(none)' ? [
        `Siblings (same tag in parent):`,
        `  ${entry.siblingContext}`,
        '',
      ] : []),
      ...(entry.className ? [
        `Classes:   ${entry.className.slice(0, 120)}${entry.className.length > 120 ? '…' : ''}`,
      ] : []),
      '```',
      '',
      '---',
      '',
    ].join('\n')

    // Try Desktop first, fall back to Documents if macOS TCC blocks Desktop access
    const candidateDirs: string[] = []
    try { candidateDirs.push(app.getPath('desktop'))   } catch { /* ignore */ }
    try { candidateDirs.push(app.getPath('documents'))  } catch { /* ignore */ }
    try { candidateDirs.push(app.getPath('userData'))   } catch { /* ignore */ }

    let lastError = 'No writable path found'
    for (const dir of candidateDirs) {
      try {
        const logPath = join(dir, 'claude-corrections-log.md')
        if (!existsSync(logPath)) {
          writeFileSync(logPath, HEADER, 'utf8')
        }
        appendFileSync(logPath, block, 'utf8')
        console.log('[FeedbackLog] Wrote correction to:', logPath)
        return { ok: true, data: { path: logPath } }
      } catch (err) {
        lastError = (err as Error).message
        console.warn('[FeedbackLog] write failed for', dir, '—', lastError)
      }
    }

    console.error('[FeedbackLog] All write paths failed:', lastError)
    return { ok: false, error: lastError }
  })

  // ── Local AI ─────────────────────────────────────────────────────────────────

  function broadcastAI(channel: string, data: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, data)
    }
  }

  handle(IPC.AI_STATUS, () => LocalAIService.getStatus())

  handle(IPC.AI_LOAD, async () => {
    await LocalAIService.ensureLoaded()
    return null
  })

  handle(IPC.AI_DOWNLOAD, async () => {
    // Fire-and-forget; progress sent via push events
    let lastMbTotal = 0
    LocalAIService.startDownload((pct, mbDownloaded, mbTotal) => {
      lastMbTotal = mbTotal
      broadcastAI(IPC.PUSH_AI_PROGRESS, { pct, mbDownloaded, mbTotal })
    }).then(() => {
      broadcastAI(IPC.PUSH_AI_PROGRESS, { pct: 100, mbDownloaded: lastMbTotal, mbTotal: lastMbTotal })
    }).catch((err: Error) => {
      console.warn('[LocalAI] download error:', err.message)
    })
    return null
  })

  handle(IPC.AI_CANCEL_DOWNLOAD, () => {
    LocalAIService.cancelDownload()
    return null
  })

  handle(IPC.AI_DELETE_MODEL, async () => {
    await LocalAIService.deleteModel()
    return null
  })

  ipcMain.handle(IPC.AI_COMPLETE, async (_event, opts: { requestId: string; prompt: string; systemPrompt?: string; maxTokens?: number }) => {
    try {
      const text = await LocalAIService.complete({
        ...opts,
        onChunk: (requestId, chunk, done) => {
          broadcastAI(IPC.PUSH_AI_CHUNK, { requestId, chunk, done })
        },
      })
      return { ok: true, data: { text } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Gong Scraper ────────────────────────────────────────────────────────────
  ensureGongBridge()

  ipcMain.handle(IPC.GONG_SCRAPER_RUN_ALL, async () => {
    GongScraperService.doRunAll().catch(console.error)
    return { ok: true, data: null }
  })
  ipcMain.handle(IPC.GONG_SCRAPER_STEP1, async () => {
    GongScraperService.doStep1().catch(console.error)
    return { ok: true, data: null }
  })
  ipcMain.handle(IPC.GONG_SCRAPER_STEP2, async () => {
    GongScraperService.doStep2().catch(console.error)
    return { ok: true, data: null }
  })
  ipcMain.handle(IPC.GONG_SCRAPER_STEP3, async () => {
    GongScraperService.doStep3().catch(console.error)
    return { ok: true, data: null }
  })
  ipcMain.handle(IPC.GONG_SCRAPER_STOP,  () => { GongScraperService.stop();  return { ok: true, data: null } })
  ipcMain.handle(IPC.GONG_SCRAPER_RESET, () => { GongScraperService.reset(); return { ok: true, data: null } })
  ipcMain.handle(IPC.GONG_SCRAPER_STATE, () => ({ ok: true, data: GongScraperService.getState() }))

  ipcMain.handle(IPC.GONG_SCRAPER_SET_SCHEDULE, (_e, mode: 'daily' | 'weekly' | 'custom', days: number[], hour: number) => {
    GongScraperService.setSchedule(mode, days, hour)
    return { ok: true, data: null }
  })
  ipcMain.handle(IPC.GONG_SCRAPER_CLR_SCHEDULE, () => {
    GongScraperService.clearSchedule()
    return { ok: true, data: null }
  })
  ipcMain.handle(IPC.GONG_SCRAPER_MOVE_FILE, (_e, fileId: string, companyName: string) => {
    GongScraperService.moveFile(fileId, companyName).catch(console.error)
    return { ok: true, data: null }
  })
  ipcMain.handle(IPC.GONG_SCRAPER_FOCUS_LOGIN, () => {
    GongScraperService.focusLoginWin()
    return { ok: true, data: null }
  })
  ipcMain.handle(IPC.GONG_SCRAPER_GET_LOG,   () => ({ ok: true, data: GongScraperService.getActionsLog() }))
  ipcMain.handle(IPC.GONG_SCRAPER_CLEAR_LOG, () => { GongScraperService.clearActionsLog(); return { ok: true, data: null } })
  ipcMain.handle(IPC.GONG_SCRAPER_CLEAR_TRANSCRIPTS, () => { GongScraperService.clearRecentTranscripts(); return { ok: true, data: null } })
  ipcMain.handle(IPC.GONG_SCRAPER_FETCH_RECENT, async () => {
    const transcripts = await GongScraperService.fetchRecentFromDrive()
    return { ok: true, data: transcripts }
  })

  ipcMain.handle(IPC.GONG_SCRAPER_READ_FILE, async (_e, fileId: string) => {
    try {
      const { google } = await import('googleapis')
      const auth = await AuthService.getAuthClient()
      const drive = google.drive({ version: 'v3', auth })
      // Try as plain text first (most transcripts are .txt files)
      try {
        const res = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'text' }
        ) as unknown as { data: string }
        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
        return { ok: true, data: { text: text.slice(0, 8000) } } // cap at 8k chars
      } catch {
        // Fallback: export as plain text (Google Docs)
        const expRes = await drive.files.export(
          { fileId, mimeType: 'text/plain' },
          { responseType: 'text' }
        ) as unknown as { data: string }
        const text = typeof expRes.data === 'string' ? expRes.data : ''
        return { ok: true, data: { text: text.slice(0, 8000) } }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg, data: { text: '' } }
    }
  })

  // ── Settings / Sheet URL ────────────────────────────────────────────────────
  handle(IPC.SETTINGS_SET, (data) => {
    const d = data as { sheetUrl?: string }
    if (d.sheetUrl !== undefined) {
      // Update sheetUrl in gong-state.json (same file GongScraperService uses)
      GongScraperService.updateSheetUrl(d.sheetUrl)
    }
    return null
  })

  // ── Companies: sync from Google Sheet ──────────────────────────────────────
  handle(IPC.COMPANIES_SYNC_SHEET, async () => {
    const state = GongScraperService.getState()
    if (!state.sheetId) throw new Error('No spreadsheet found. Run Step 1 first.')
    const auth   = await AuthService.getAuthClient()
    const sheets = google.sheets({ version: 'v4', auth })
    const res    = await sheets.spreadsheets.values.get({
      spreadsheetId: state.sheetId,
      // A2:P — Column A = HubSpot Link (index 0), Column B = Company Name (index 1)
      // Extending to P ensures we also catch the legacy column-16 URL if present.
      range:         'accounts!A2:P',
    })
    const rows = (res.data.values ?? []) as unknown[][]
    if (rows.length === 0) return { synced: 0 }
    CompanyService.bulkUpsertFromHubSpot(rows)
    const { total } = CompanyService.list({ pageSize: 1 })
    return { synced: total }
  })

  // ── Master Refresh — clear sheet-synced companies, then re-import from sheet ─
  handle(IPC.COMPANIES_MASTER_REFRESH, async () => {
    const state = GongScraperService.getState()
    if (!state.sheetId) throw new Error('No spreadsheet found. Run Step 1 first.')
    const auth   = await AuthService.getAuthClient()
    const sheets = google.sheets({ version: 'v4', auth })
    const res    = await sheets.spreadsheets.values.get({
      spreadsheetId: state.sheetId,
      // A2:P — Column A = HubSpot Link (index 0), Column B = Company Name (index 1).
      // HubSpot URLs now live in Column A so they survive every sheet read-back.
      range:         'accounts!A2:P',
    })
    const rows = (res.data.values ?? []) as unknown[][]
    // Snapshot any scraped HubSpot URLs that exist in the DB — safety net for
    // companies whose rows pre-date the Column A layout change.
    const hubspotUrls = CompanyService.getHubspotUrlsByName()
    CompanyService.clearAllFromSheet()
    if (rows.length === 0) return { synced: 0 }
    CompanyService.bulkUpsertFromHubSpot(rows)
    // Restore URLs for any company that still didn't get one (legacy rows).
    CompanyService.restoreHubspotUrls(hubspotUrls)
    const { total } = CompanyService.list({ pageSize: 1 })
    return { synced: total }
  })

  // ── Quick Links ─────────────────────────────────────────────────────────────
  handle(IPC.QUICK_LINKS_GET, ()      => AppSettings.getQuickLinks())
  handle(IPC.QUICK_LINKS_SET, (links) => AppSettings.setQuickLinks(links as never))
  handle(IPC.PROMPTS_GET,     ()      => AppSettings.getSavedPrompts())
  handle(IPC.PROMPTS_SET,     (prompts) => AppSettings.setSavedPrompts(prompts as never))

  // ── Scrub reset ─────────────────────────────────────────────────────────────
  handle(IPC.SCRUB_RESET, () => { ScrubService.clearAllJobs(); return null })

  // ── Companies reset ─────────────────────────────────────────────────────────
  handle(IPC.COMPANIES_RESET, () => { CompanyService.clearAll(); return null })

  // ── App-wide Master Reset ─────────────────────────────────────────────────
  // Wipes all operational data while preserving auth, user preferences (quick
  // links, saved prompts), and flyer templates.  Services stay connected.
  handle(IPC.APP_MASTER_RESET, () => {
    const db = getDb()
    db.transaction(() => {
      // Order matters — children before parents where FK constraints exist,
      // but CASCADE deletes handle most of it automatically.
      db.prepare('DELETE FROM calendar_events').run()
      db.prepare('DELETE FROM speaker_turns').run()
      db.prepare('DELETE FROM transcripts').run()
      db.prepare('DELETE FROM company_notes').run()
      db.prepare('DELETE FROM contacts').run()
      db.prepare('DELETE FROM companies').run()
      db.prepare('DELETE FROM scrub_jobs').run()
      db.prepare('DELETE FROM processed_urls').run()
      db.prepare('DELETE FROM job_logs').run()
      db.prepare('DELETE FROM jobs').run()
      db.prepare('DELETE FROM schedules').run()
      db.prepare('DELETE FROM company_analyses').run()
      db.prepare('DELETE FROM follow_ups').run()
      // knowledge_pages, flyer_templates, quick_links, saved_prompts untouched
    })()

    // Reset GongScraper state file (sheetId, recentTranscripts, schedule, etc.)
    GongScraperService.reset()
    // Clear the persistent actions log file
    GongScraperService.clearActionsLog()

    // Broadcast to all renderer windows so they can clear their in-memory state
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.PUSH_APP_RESET, null)
    }

    return null
  })

  // ── Calendar rematch ─────────────────────────────────────────────────────────
  handle(IPC.CALENDAR_REMATCH, () => CalendarService.rematchAll())

  // ── Company Notes ────────────────────────────────────────────────────────────
  handle(IPC.COMPANY_NOTES_LIST,   (companyId) => CompanyService.getNotes(companyId as string))
  handle(IPC.COMPANY_NOTES_ADD,    (companyId, content) => CompanyService.addNote(companyId as string, content as string))
  handle(IPC.COMPANY_NOTES_DELETE, (noteId) => { CompanyService.deleteNote(noteId as string); return null })

  // ── Analysis (Risk & Expansion) ──────────────────────────────────────────
  handle(IPC.ANALYSIS_RUN, async (csvPath) => {
    const result = await AnalysisService.analyzeFile(csvPath as string)
    return result
  })
  handle(IPC.ANALYSIS_GET, (accountName) => {
    if (accountName) return AnalysisService.getAnalysisForAccount(accountName as string)
    return AnalysisService.getLatestAnalysis()
  })
  handle(IPC.ANALYSIS_GET_FOR_COMPANY, (companyId) =>
    AnalysisService.getAnalysisForCompany(companyId as string)
  )

  // ── Follow Ups ───────────────────────────────────────────────────────────────
  handle(IPC.FOLLOW_UPS_LIST, (companyId) =>
    followUpService.list(companyId as string | null | undefined)
  )
  handle(IPC.FOLLOW_UPS_CREATE, (data) =>
    followUpService.create(data as Parameters<typeof followUpService.create>[0])
  )
  handle(IPC.FOLLOW_UPS_UPDATE, (id, patch) =>
    followUpService.update(id as string, patch as Parameters<typeof followUpService.update>[1])
  )
  handle(IPC.FOLLOW_UPS_DELETE, (id) => { followUpService.delete(id as string); return null })
  handle(IPC.FOLLOW_UPS_PARSE_TRANSCRIPTS, () => followUpService.parseTranscripts())

  // ── Notification Settings ─────────────────────────────────────────────────
  handle(IPC.NOTIFICATIONS_GET_SETTINGS, () => {
    const db = getDb()
    const windowsRow = db.prepare("SELECT value FROM app_settings WHERE key = 'notification_windows_min'").get() as { value: string } | undefined
    return {
      enabled:    getNotificationsEnabled(),
      windowsMin: windowsRow ? JSON.parse(windowsRow.value) as number[] : [24 * 60, 60, 0],
    }
  })
  handle(IPC.NOTIFICATIONS_SET_SETTINGS, (settings) => {
    const s = settings as { enabled?: boolean; windowsMin?: number[] }
    if (s.enabled !== undefined) setNotificationsEnabled(s.enabled)
    if (s.windowsMin)            setNotificationWindows(s.windowsMin)
    return null
  })

  // ── Services status (HubSpot / Gong) ──────────────────────────────────────
  handle(IPC.SERVICES_STATUS,          () => GongScraperService.getServicesStatus())
  handle(IPC.SERVICES_CONNECT_HUBSPOT, () => GongScraperService.connectHubSpot())
  handle(IPC.SERVICES_CONNECT_GONG,    () => GongScraperService.connectGong())

  console.log('[IPC] All handlers registered')
}
