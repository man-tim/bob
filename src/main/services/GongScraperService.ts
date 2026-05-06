/* GongScraperService — Electron port of the Gong Transcript Exporter extension.
 * Mirrors background.js v15 exactly: same 3-step flow, same webhook, same scraping logic.
 * Chrome APIs replaced with Electron equivalents:
 *   chrome.windows.create   → new BrowserWindow({ show: false })
 *   chrome.scripting.executeScript → webContents.executeJavaScript
 *   chrome.storage.local    → userData JSON file
 *   chrome.alarms           → setTimeout / setInterval
 *   chrome.runtime.sendMessage → EventEmitter → IPC push
 */

import { BrowserWindow, app }       from 'electron'
import { EventEmitter }             from 'events'
import { join }                     from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { WebhookService }           from './WebhookService'
import { AuthService }              from '../auth/AuthService'
import { CompanyService }           from './CompanyService'
import { getDb }                    from '../db/database'
import { ulid }                     from 'ulid'
import { CallLogsService }          from './CallLogsService'

// ─── Constants (mirrors background.js) ────────────────────────────────────────

const GONG_HOME    = 'https://us-57015.app.gong.io/home'
const HUBSPOT_URL  = 'https://app.hubspot.com/contacts/8787210/objects/0-2/views/40948819/list?prefetch='
const PAGE_LOAD_WAIT_SEC  = 15
const BETWEEN_CALLS_SEC   = 5
const EXTRACT_TIMEOUT_SEC = 90
const TAB_OPEN_DELAY_MS   = 3000

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GongLog { msg: string; cls: string; ts: string }

export interface GongStatus {
  status: 'idle' | 'running' | 'step1Done' | 'step2Done' | 'step3Done' | 'allDone' | 'stopped' | 'prompting'
  extracted?:    number
  unfiledCount?: number
  sheetId?:      string
  sheetUrl?:     string
}

export interface ServiceConnectionState {
  connected:   boolean
  connectedAt: number | null
}

export interface ServicesStatus {
  hubspot: ServiceConnectionState
  gong:    ServiceConnectionState
}

export interface GongState {
  sheetId?:           string
  sheetUrl?:          string
  mainFolderUrl?:     string
  schedule?:          { active: boolean; mode: 'daily' | 'weekly' | 'custom'; days: number[]; hour: number; nextRun: number }
  unfiled?:           Array<{ id: string; name: string }>
  runAll?:            boolean
  recentTranscripts?: Array<{ title: string; driveFileId: string; driveUrl: string; callDate: string; companyName: string; callUrl?: string }>
  services?:          ServicesStatus
}

// ─── Persisted state (userData JSON) ──────────────────────────────────────────

const STATE_FILE   = join(app.getPath('userData'), 'gong-state.json')
const ACTIONS_FILE = join(app.getPath('userData'), 'actions-log.json')

const MAX_LOG_ENTRIES = 2000

function loadActionsLog(): GongLog[] {
  try {
    if (!existsSync(ACTIONS_FILE)) return []
    return JSON.parse(readFileSync(ACTIONS_FILE, 'utf-8')) as GongLog[]
  } catch { return [] }
}

function appendActionsLog(entry: GongLog): void {
  try {
    const existing = loadActionsLog()
    existing.push(entry)
    // Keep only the most recent entries to avoid unbounded growth
    const trimmed = existing.length > MAX_LOG_ENTRIES ? existing.slice(-MAX_LOG_ENTRIES) : existing
    writeFileSync(ACTIONS_FILE, JSON.stringify(trimmed), 'utf-8')
  } catch { /* ignore */ }
}

function loadState(): GongState {
  try {
    if (!existsSync(STATE_FILE)) return {}
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as GongState
  } catch { return {} }
}

function saveState(s: GongState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf-8')
}

// ─── Event emitter (listeners get logs + status updates) ──────────────────────

class GongEmitter extends EventEmitter {}
const emitter = new GongEmitter()

function pushLog(msg: string, cls: string = ''): void {
  const now  = new Date()
  let h = now.getHours(); const m = now.getMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12; if (h === 0) h = 12
  const ts = `${h}:${m < 10 ? '0' : ''}${m} ${ampm}`
  const entry: GongLog = { msg, cls, ts }
  emitter.emit('log', entry)
  appendActionsLog(entry)
}

function setUi(status: GongStatus['status'], extra: Partial<GongStatus> = {}): void {
  emitter.emit('status', { status, ...extra })
}

function defaultServicesStatus(): ServicesStatus {
  return {
    hubspot: { connected: false, connectedAt: null },
    gong:    { connected: false, connectedAt: null },
  }
}

function getServicesStatus(): ServicesStatus {
  const s = loadState()
  return s.services ?? defaultServicesStatus()
}

function setServiceConnected(service: 'hubspot' | 'gong', connected: boolean): void {
  const s   = loadState()
  const svs = s.services ?? defaultServicesStatus()
  svs[service] = { connected, connectedAt: connected ? Date.now() : null }
  saveState({ ...s, services: svs })
  emitter.emit('services-status', svs)
}

// ─── BrowserWindow helpers ────────────────────────────────────────────────────

function openHiddenWindow(url: string): Promise<BrowserWindow> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show:   false,
      width:  1280,
      height: 900,
      webPreferences: {
        nodeIntegration:   false,
        contextIsolation:  true,
        // allow the page to run normally
        webSecurity:       false,
      },
    })
    win.loadURL(url)
    resolve(win)
  })
}

function waitForLoad(win: BrowserWindow, timeoutMs = 30_000): Promise<boolean> {
  return new Promise(resolve => {
    if (win.isDestroyed()) { resolve(false); return }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(true) })
    win.webContents.once('did-fail-load',   () => { clearTimeout(timer); resolve(false) })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function safeClose(win: BrowserWindow | null): void {
  try { if (win && !win.isDestroyed()) win.close() } catch { /* ignore */ }
}

// ─── Abort controller (for stopping mid-run) ─────────────────────────────────

let abortFlag = false
let currentLoginWin: BrowserWindow | null = null

// Persistent HubSpot background window — kept alive so the session never expires
let hubspotBgWin: BrowserWindow | null = null

function getOrCreateHubspotWin(): BrowserWindow {
  if (hubspotBgWin && !hubspotBgWin.isDestroyed()) return hubspotBgWin
  // No partition — uses the default Electron session, which is the same session
  // where the Google OAuth popup ran. HubSpot's "Sign in with Google" flow will
  // find the existing Google session cookies and auto-SSO without a separate login.
  hubspotBgWin = new BrowserWindow({
    show: false, width: 3000, height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false },
  })
  hubspotBgWin.on('closed', () => { hubspotBgWin = null })
  return hubspotBgWin
}

function normalizeForMatch(s: string): string {
  const pipe = s.lastIndexOf('|')
  if (pipe >= 0) s = s.substring(pipe + 1)
  // Split camelCase BEFORE lowercasing (e.g. "SouthernCarlson" → "Southern Carlson")
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2')
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|co|company|supply|group|holdings|services|solutions|associates|enterprises|industries)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function autoMatchScore(fileName: string, companyName: string): number {
  const fn = normalizeForMatch(fileName)
  const cn = normalizeForMatch(companyName)
  if (!fn || !cn) return 0
  // Exact containment (both normalized)
  if (fn === cn) return 1.0
  if (fn.includes(cn) && cn.length > 4) return 0.85
  if (cn.includes(fn) && fn.length > 4) return 0.85
  const fnW = fn.split(' ').filter(w => w.length > 2)
  const cnW = cn.split(' ').filter(w => w.length > 2)
  if (!fnW.length || !cnW.length) return 0
  // Strict exact-token matching only — no substring-within-token
  const fnSet = new Set(fnW)
  // Count how many company name tokens appear exactly in the filename tokens
  const matchedCnTokens = cnW.filter(cw => fnSet.has(cw)).length
  // Require ALL company name tokens to appear for a confident match
  // (prevents "Southern" from matching "SouthernCarlson" as a token)
  if (matchedCnTokens === cnW.length && cnW.length > 0) {
    return 0.9  // all company tokens found in filename
  }
  // Partial match — use strict ratio
  const shared = cnW.filter(cw => fnSet.has(cw)).length
  return shared / Math.max(fnW.length, cnW.length)
}

function checkAbort(): boolean { return abortFlag }

// ─── Main service ─────────────────────────────────────────────────────────────

export const GongScraperService = {

  on:  emitter.on.bind(emitter),
  off: emitter.off.bind(emitter),

  getState(): GongState { return loadState() },
  getActionsLog(): GongLog[] { return loadActionsLog() },
  clearActionsLog(): void { try { writeFileSync(ACTIONS_FILE, '[]', 'utf-8') } catch { /* ignore */ } },

  updateSheetUrl(sheetUrl: string): void {
    saveState({ ...loadState(), sheetUrl })
  },

  focusLoginWin(): void {
    if (currentLoginWin && !currentLoginWin.isDestroyed()) {
      currentLoginWin.restore()
      currentLoginWin.focus()
    }
  },

  /**
   * Pre-warm HubSpot session after Google login completes.
   * Opens a hidden HubSpot window in the default session (same as Google OAuth),
   * auto-clicks "Continue with Google" if the login page appears, and waits for
   * the SSO to complete. Run this in the background — no need to await.
   */
  async preWarmHubSpot(): Promise<void> {
    try {
      const win = getOrCreateHubspotWin()
      win.loadURL(HUBSPOT_URL)
      const deadline = Date.now() + 60_000   // 60-second budget
      const HS_LOGIN = `(function(){var u=window.location.href;return u.indexOf('/login')>-1||u.indexOf('hs-login')>-1||u.indexOf('/signup')>-1;})()`
      const HS_READY = `(function(){try{return document.querySelector('table')!=null||document.querySelector('[class*="navMenu"],[class*="main-nav"]')!=null;}catch(e){return false;}})()`
      // Auto-click "Continue with Google" on the HubSpot login page
      const CLICK_GOOGLE = `(function(){
        var btns=document.querySelectorAll('a,button,[role="button"]');
        for(var i=0;i<btns.length;i++){
          var t=(btns[i].textContent||'').trim().toLowerCase();
          if(t.indexOf('google')!==-1){btns[i].click();return true;}
        }
        return false;
      })()`

      await sleep(4000)   // let page start loading
      let ready = false
      while (!ready && Date.now() < deadline) {
        await sleep(2000)
        try {
          const onLogin = await win.webContents.executeJavaScript(HS_LOGIN)
          if (onLogin) {
            await win.webContents.executeJavaScript(CLICK_GOOGLE)
            await sleep(3000)   // wait for SSO redirect
          }
          ready = await win.webContents.executeJavaScript(HS_READY)
        } catch { /* navigating */ }
      }
      if (ready) setServiceConnected('hubspot', true)
      try { if (!win.isDestroyed()) win.hide() } catch { /* ignore */ }
    } catch { /* pre-warm is best-effort */ }
  },

  // ── STEP 1: Create sheet + Drive folders + HubSpot import ─────────────────

  async doStep1(): Promise<void> {
    abortFlag = false
    pushLog('=== STEP 1: SETUP ===', 'log-step')
    setUi('running')

    try {
      await AuthService.getAuthClient()
      pushLog('Google account connected.', 'log-ok')
    } catch {
      pushLog('Google sign-in required. Please connect Google in Settings.', 'log-err')
      setUi('idle')
      return
    }

    const state = loadState()
    let sheetId = state.sheetId

    // Derive a friendly user name from the auth email for per-user naming
    let userName = 'User'
    try {
      const status = AuthService.getStatus()
      if (status.email) {
        const prefix = status.email.split('@')[0]
        userName = prefix.split(/[._-]/).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      }
    } catch { /* ignore */ }

    if (!sheetId) {
      // ── Search Google Drive for a spreadsheet from a prior session ────────────
      // This prevents duplicates when local state is cleared or on a new install.
      pushLog('Searching Drive for existing spreadsheet...', 'log-data')
      try {
        const { google } = await import('googleapis')
        const auth  = await AuthService.getAuthClient()
        const drive = google.drive({ version: 'v3', auth })
        const found = await drive.files.list({
          q: "mimeType='application/vnd.google-apps.spreadsheet' and (name contains 'Master Account Spreadsheet') and trashed=false",
          fields: 'files(id, name, webViewLink)',
          pageSize: 10,
          orderBy: 'modifiedTime desc',
        })
        if (found.data.files && found.data.files.length > 0) {
          const f = found.data.files[0]
          sheetId = f.id!
          const sheetUrl = f.webViewLink ?? `https://docs.google.com/spreadsheets/d/${sheetId}`
          saveState({ ...loadState(), sheetId, sheetUrl })
          emitter.emit('sheet-created', { sheetId, sheetUrl })
          pushLog(`Found existing spreadsheet: "${f.name}"`, 'log-ok')
          pushLog('Link: ' + sheetUrl, 'log-data')
        }
      } catch (e) {
        pushLog('Drive search warning: ' + (e as Error).message, 'log-warn')
      }
    }

    if (!sheetId) {
      // Nothing found in Drive — create a fresh one via the webhook
      pushLog('Creating new spreadsheet...', 'log-data')
      const r = await WebhookService.call({ action: 'createSheet' })
      if (!r || r['status'] !== 'ok') {
        pushLog('Failed: ' + (r['message'] || r['raw'] || 'no response'), 'log-err')
        setUi('idle')
        return
      }
      pushLog('Spreadsheet created.', 'log-ok')
      pushLog('Link: ' + r['sheetUrl'], 'log-data')
      sheetId = r['sheetId'] as string
      saveState({ ...loadState(), sheetId, sheetUrl: r['sheetUrl'] as string })
      emitter.emit('sheet-created', { sheetId, sheetUrl: r['sheetUrl'] })

      // Rename the new spreadsheet to include the user's name
      try {
        const { google } = await import('googleapis')
        const auth   = await AuthService.getAuthClient()
        const sheets = google.sheets({ version: 'v4', auth })
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: { requests: [{ updateSpreadsheetProperties: {
            properties: { title: `${userName}'s Master Account Spreadsheet` },
            fields: 'title',
          } }] },
        })
        pushLog(`Spreadsheet renamed to "${userName}'s Master Account Spreadsheet".`, 'log-ok')
      } catch (e) {
        pushLog('Could not rename spreadsheet: ' + (e as Error).message, 'log-warn')
      }
    } else {
      pushLog('Using existing spreadsheet.', 'log-data')
    }

    await this._ensureHubSpotHeader(sheetId)
    await this._ensureDriveFolders(sheetId, userName)
    await this._scrapeHubSpot(sheetId)
  },

  /**
   * Ensures Column A of the master spreadsheet has the header "HubSpot Link".
   * With this layout Column A = HubSpot URL, Column B = Company Name.
   * HubSpot URLs are written to row[0] during scraping so they land in Column A
   * and are included when the sheet is later read back via accounts!A2:O.
   */
  async _ensureHubSpotHeader(sheetId: string): Promise<void> {
    try {
      const { google } = await import('googleapis')
      const auth   = await AuthService.getAuthClient()
      const sheets = google.sheets({ version: 'v4', auth })

      // Check both the 'accounts' named sheet and Sheet1 fallback
      for (const sheetName of ['accounts', 'Sheet1']) {
        try {
          const check = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: `${sheetName}!A1`,
          })
          const existing = (check.data.values?.[0]?.[0] ?? '').toString().trim()
          if (existing === 'HubSpot Link') {
            pushLog(`Sheet header already set: A1 = "HubSpot Link" (${sheetName}).`, 'log-data')
            return
          }
          // Set A1 = "HubSpot Link"
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: `${sheetName}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values: [['HubSpot Link']] },
          })
          pushLog(`Set A1 = "HubSpot Link" on ${sheetName} — Column A will hold HubSpot URLs, Column B company names.`, 'log-ok')
          return
        } catch { continue }
      }
    } catch (e) {
      pushLog('Could not update sheet header: ' + (e as Error).message, 'log-warn')
    }
  },

  /**
   * Keep the spreadsheet's Settings tab "Main folder" row in sync with the
   * actual folder URL we're using. The Apps Script reads this to know where
   * to save transcripts — if it's stale the Drive API returns 404 for every call.
   */
  async _syncSettingsTab(sheetId: string, mainFolderUrl: string): Promise<void> {
    try {
      const { google } = await import('googleapis')
      const auth   = await AuthService.getAuthClient()
      const sheets = google.sheets({ version: 'v4', auth })
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'Settings!A1:B10',
      })
      const rows = res.data.values ?? []
      let targetRow = -1
      for (let i = 0; i < rows.length; i++) {
        const key = String(rows[i]?.[0] ?? '').trim().toLowerCase()
        if (key.includes('main folder')) { targetRow = i + 1; break }
      }
      if (targetRow === -1) return   // no Settings tab or no "Main folder" row
      const current = String(rows[targetRow - 1]?.[1] ?? '').trim()
      if (current === mainFolderUrl) return   // already correct — nothing to do
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `Settings!B${targetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[mainFolderUrl]] },
      })
      pushLog('  Settings tab updated with current Drive folder URL.', 'log-data')
    } catch { /* best-effort — don't break scraping flow */ }
  },

  async _ensureDriveFolders(sheetId: string, userName = 'User'): Promise<void> {
    const { google } = await import('googleapis')
    const auth  = await AuthService.getAuthClient()
    const drive = google.drive({ version: 'v3', auth })

    // ── 1. Check if we already have a folder saved in state ──────────────────
    const savedUrl = loadState().mainFolderUrl
    if (savedUrl) {
      try {
        const folderId = savedUrl.split('/folders/')[1]?.split('?')[0] || savedUrl.split('/').pop()!
        const meta = await drive.files.get({ fileId: folderId, fields: 'id, trashed' })
        if (!meta.data.trashed) {
          pushLog('Drive folder already exists — reusing.', 'log-ok')
          pushLog('  ' + savedUrl, 'log-data')
          // Ensure the Apps Script's Settings tab is in sync (prevents Drive 404 on saveTranscript)
          await this._syncSettingsTab(sheetId, savedUrl)
          return
        }
      } catch { /* folder was deleted or inaccessible — fall through */ }
    }

    // ── 2. Search Google Drive by name in case state was cleared ─────────────
    // We search for both the renamed name and the original "Gong Uploads" name.
    pushLog('Searching Drive for existing Gong folder...', 'log-data')
    try {
      const q = [
        `mimeType='application/vnd.google-apps.folder'`,
        `and (name contains 'Gong Transcripts' or name='Gong Uploads')`,
        `and trashed=false`,
      ].join(' ')
      const found = await drive.files.list({
        q,
        fields: 'files(id, name, webViewLink)',
        pageSize: 10,
        orderBy: 'modifiedTime desc',
      })
      if (found.data.files && found.data.files.length > 0) {
        const f = found.data.files[0]
        const mainFolderUrl = f.webViewLink ?? `https://drive.google.com/drive/folders/${f.id}`
        saveState({ ...loadState(), mainFolderUrl })
        pushLog(`Found existing Drive folder: "${f.name}"`, 'log-ok')
        pushLog('  ' + mainFolderUrl, 'log-data')
        // Sync the Settings tab so the Apps Script uses this folder
        await this._syncSettingsTab(sheetId, mainFolderUrl)
        return
      }
    } catch (e) {
      pushLog('Drive search warning: ' + (e as Error).message, 'log-warn')
    }

    // ── 3. Nothing found — create fresh folders via webhook ───────────────────
    pushLog('Creating Drive folders...', 'log-data')
    const r = await WebhookService.call({ action: 'createDriveFolders', sheetId })
    if (r && r['status'] === 'ok') {
      pushLog('Drive folders ready.', 'log-ok')
      pushLog('  Gong Uploads: '  + r['mainFolderUrl'],    'log-data')
      pushLog('  Archive: '       + r['archiveFolderUrl'], 'log-data')
      // Rename the new folder to the per-user name
      try {
        const folderUrl = r['mainFolderUrl'] as string
        const folderId  = folderUrl.split('/folders/')[1]?.split('?')[0] || folderUrl.split('/').pop()!
        await drive.files.update({ fileId: folderId, requestBody: { name: `${userName}'s Gong Transcripts` } })
        pushLog(`Gong folder renamed to "${userName}'s Gong Transcripts".`, 'log-ok')
      } catch (e) {
        pushLog('Could not rename folder: ' + (e as Error).message, 'log-warn')
      }
      saveState({ ...loadState(), mainFolderUrl: r['mainFolderUrl'] as string })
    } else {
      pushLog('Drive folders: ' + (r?.['message'] || r?.['raw'] || 'failed'), 'log-err')
    }
  },

  async _scrapeHubSpot(sheetId: string): Promise<void> {
    pushLog('Opening HubSpot to import companies...', 'log-data')
    // Re-use persistent window to keep session alive between runs
    const win = getOrCreateHubspotWin()
    try {
      win.loadURL(HUBSPOT_URL)
      pushLog('HubSpot window opened — waiting for contacts table (log in if prompted, up to 3 min)...', 'log-data')
      currentLoginWin = win

      const TABLE_CHECK = `(function(){try{var t=document.querySelector('table');return !!(t&&t.querySelectorAll('tbody tr').length>0);}catch(e){return false;}})()`
      const HS_LOGIN   = `(function(){var u=window.location.href;return u.indexOf('/login')>-1||u.indexOf('hs-login')>-1||u.indexOf('/signup')>-1;})()`
      const deadline   = Date.now() + 180_000
      let tableReady   = false
      let loginShown   = false
      while (!tableReady && Date.now() < deadline) {
        if (checkAbort()) break
        await sleep(2000)
        try {
          const onLogin = await win.webContents.executeJavaScript(HS_LOGIN)
          if (onLogin && !loginShown) {
            loginShown = true
            emitter.emit('login-needed', { service: 'hubspot' })
            pushLog('HubSpot login detected — please log in, then the scraper will continue automatically.', 'log-warn')
          } else if (!onLogin && loginShown) {
            loginShown = false
            emitter.emit('login-done', { service: 'hubspot' })
          }
          if (!onLogin) tableReady = await win.webContents.executeJavaScript(TABLE_CHECK)
        } catch { /* navigating */ }
      }
      currentLoginWin = null
      if (loginShown) { emitter.emit('login-done', { service: 'hubspot' }) }
      if (!tableReady) {
        pushLog('HubSpot contacts table never appeared. Make sure you are logged into HubSpot.', 'log-err')
        try { if (!win.isDestroyed()) win.hide() } catch { /* ignore */ }
        await this._finishStep1(sheetId)
        return
      }
      pushLog('HubSpot contacts list ready. Scraping...', 'log-ok')
      // Zoom the window way out so ALL columns are in the viewport — HubSpot
      // only renders columns that are visible, so a narrow window misses the
      // rightmost ones (e.g. "Potential Locations" and beyond).
      try {
        win.webContents.setZoomFactor(0.25)
        pushLog('  Zoomed out to 25% to capture all columns...', 'log-data')
      } catch { /* ignore */ }
      await sleep(2000) // give HubSpot time to rerender at the new zoom level

      // Inject hubspot.js logic (adapted — returns data instead of sendMessage)
      const HUBSPOT_SCRIPT = `
        new Promise(function(resolve) {
          (function() {
            var LOG = '[GONG-HS] ';
            var TOTAL_COLS = 16;
            var COL_MAP = {
              'company name':1,'name':1,'last contacted':2,
              'subscription renewal date':3,'renewal date':3,'arr':4,
              'company owner':5,'owner':5,'phone number':6,'phone':6,
              'last activity date':7,'city':8,'country/region':9,'country':9,
              'pk account tier':10,'account tier':10,'subscribed locations':11,
              'potential locations':12,'subscription state':13,
              'primary industry':14,'industry':14
            };
            function getText(el){var t=(el.textContent||'').trim();t=t.replace(/\\s*Preview\\s*$/,'');t=t.replace(/\\n/g,' ').replace(/\\s+/g,' ').trim();return t;}
            function matchHeader(raw){var h=raw.toLowerCase().trim();h=h.replace(/\\s*(ascending|descending|asc|desc|sort|press to)\\s*/gi,'').trim();h=h.replace(/\\s*\\([a-z]{2,4}\\)\\s*/gi,'').trim();h=h.replace(/\\s+/g,' ');if(COL_MAP[h]!==undefined)return COL_MAP[h];for(var key in COL_MAP){if(h.indexOf(key)!==-1)return COL_MAP[key];if(key.length>3&&key.indexOf(h)!==-1)return COL_MAP[key];}return -1;}
            function waitForTable(cb,n){if(n>180){cb(null);return;}var t=document.querySelector('table');if(t&&t.querySelectorAll('tbody tr').length>0){setTimeout(function(){cb(t);},2000);}else{setTimeout(function(){waitForTable(cb,(n||0)+1);},1000);}}
            function buildMapping(table){var ths=table.querySelectorAll('thead th,thead td');if(ths.length===0){var fr=table.querySelector('tr');if(fr)ths=fr.querySelectorAll('th,td');}var map=[];var names=[];for(var i=0;i<ths.length;i++){var txt=getText(ths[i]);names.push(txt||'(empty)');if(!txt)continue;var idx=matchHeader(txt);if(idx>=0)map.push({from:i,to:idx});}var row1=table.querySelector('tbody tr');var cc=row1?row1.querySelectorAll('td').length:0;map._dbg={hc:ths.length,cc:cc,names:names,mc:map.length};return map;}
            function collectRows(table,map,seen){var trs=table.querySelectorAll('tbody tr');var added=[];for(var r=0;r<trs.length;r++){var tds=trs[r].querySelectorAll('td');if(tds.length<2)continue;var row=[];for(var c=0;c<TOTAL_COLS;c++)row.push('');var name='';for(var m=0;m<map.length;m++){if(map[m].from<tds.length){var v=getText(tds[map[m].from]);row[map[m].to]=v;if(map[m].to===1)name=v;}}var anchor=trs[r].querySelector('a[href*="/company/"]')||trs[r].querySelector('a[href*="/record/0-2/"]')||trs[r].querySelector('a[href*="/record/"]');if(!anchor){var allLinks=trs[r].querySelectorAll('a[href]');for(var li=0;li<allLinks.length;li++){var ah=allLinks[li].href||'';if(ah.indexOf('hubspot.com')!==-1&&(ah.indexOf('/record/')!==-1||ah.indexOf('/company/')!==-1)){anchor=allLinks[li];break;}}}if(anchor){var ah2=anchor.href||'';if(ah2.indexOf('hubspot.com')!==-1){row[0]=ah2;row[15]=ah2;}}if(name&&!seen[name]){seen[name]=true;added.push(row);}}return added;}
            function getScrollTargets(table){var targets=[document.documentElement,document.body];var el=table.parentElement;for(var d=0;d<15&&el;d++){var s=window.getComputedStyle(el);var ov=(s.overflow||'')+(s.overflowY||'');if(/auto|scroll|hidden/.test(ov)&&el.scrollHeight>el.clientHeight+20)targets.push(el);el=el.parentElement;}return targets;}
            function scrollAndCollect(table,map,callback){var seen={};var all=[];var targets=getScrollTargets(table);var step=0;var maxSteps=200;var stable=0;var prev=0;for(var i=0;i<targets.length;i++)targets[i].scrollTop=0;window.scrollTo(0,0);function tick(){step++;var added=collectRows(table,map,seen);if(added.length>0){all=all.concat(added);stable=0;}if(all.length===prev)stable++;else{prev=all.length;stable=0;}if(stable>=15||step>=maxSteps){callback(all);return;}for(var s=0;s<targets.length;s++)targets[s].scrollTop+=150;window.scrollBy(0,150);setTimeout(tick,400);}setTimeout(tick,800);}
            function findNext(){var btns=document.querySelectorAll("button,a,[role='button']");for(var i=0;i<btns.length;i++){var t=(btns[i].textContent||'').trim();if(t!=='Next')continue;if(btns[i].disabled||btns[i].getAttribute('aria-disabled')==='true')return null;var p=btns[i].parentElement;for(var d=0;d<6&&p;d++){var pt=p.textContent||'';if(pt.indexOf('per page')!==-1||pt.indexOf('Prev')!==-1)return btns[i];p=p.parentElement;}}return null;}
            waitForTable(function(table){
              if(!table){resolve({rows:[],hasNext:false,error:'No table'});return;}
              var map=buildMapping(table);
              scrollAndCollect(table,map,function(rows){
                var next=findNext();
                var has=!!next;
                var dbg=map._dbg||{};dbg.collected=rows.length;
                resolve({rows:rows,hasNext:has,debug:dbg});
                if(next)setTimeout(function(){next.click();},1000);
              });
            });
          })();
        })
      `

      const allRows: unknown[][] = []
      let   page = 0

      while (true) {
        if (checkAbort()) break
        page++
        pushLog(`  Scraping company list (page ${page})...`, 'log-data')

        let result: { rows: unknown[][]; hasNext: boolean; debug?: Record<string, unknown>; error?: string }
        try {
          result = await win.webContents.executeJavaScript(HUBSPOT_SCRIPT) as typeof result
        } catch (e) {
          pushLog('  Scrape error: ' + (e as Error).message, 'log-err')
          break
        }

        if (result.error) {
          pushLog('  ' + result.error, 'log-err')
          break
        }

        if (page === 1 && result.debug?.['names']) {
          pushLog('  Headers: ' + (result.debug['names'] as string[]).join(', '), 'log-data')
        }

        allRows.push(...(result.rows || []))
        pushLog(`  Page ${page}: ${result.rows?.length || 0} companies (${allRows.length} total)`, 'log-data')

        if (!result.hasNext) break
        pushLog('  Loading next page...', 'log-data')
        await sleep(7000) // wait for HubSpot to paginate
      }

      // Restore zoom before hiding the window
      try { win.webContents.setZoomFactor(1.0) } catch { /* ignore */ }
      // Hide (don't close) to preserve the session for next run
      try { if (!win.isDestroyed()) win.hide() } catch { /* ignore */ }

      if (allRows.length > 0) {
        pushLog('HubSpot scrape complete. ' + allRows.length + ' companies.', 'log-ok')

        // Upsert into local DB so Companies tab is populated immediately
        pushLog('Saving companies to local database...', 'log-data')
        try {
          CompanyService.bulkUpsertFromHubSpot(allRows)
          pushLog('Companies saved to local database.', 'log-ok')
        } catch (dbErr) {
          pushLog('DB save warning: ' + (dbErr as Error).message, 'log-warn')
        }

        pushLog('Sending to spreadsheet...', 'log-data')
        const r = await WebhookService.call({ action: 'populateAccounts', sheetId, rows: allRows })
        if (r && r['status'] === 'ok') pushLog('Added ' + r['added'] + ' companies.', 'log-ok')
        else pushLog('Failed: ' + (r['message'] || r['raw'] || ''), 'log-err')

        // Write HubSpot URLs explicitly into Column A (A2:A{n+1}) using Sheets API
        // The webhook may not populate Column A; this guarantees it
        try {
          const { google } = await import('googleapis')
          const auth2   = await AuthService.getAuthClient()
          const sheets2 = google.sheets({ version: 'v4', auth: auth2 })
          const urlValues = allRows.map(row => [(row as unknown[])[0] || ''])
          // Try 'accounts' sheet, fall back to 'Sheet1'
          for (const sheetName of ['accounts', 'Sheet1']) {
            try {
              await sheets2.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `${sheetName}!A2:A${allRows.length + 1}`,
                valueInputOption: 'RAW',
                requestBody: { values: urlValues },
              })
              pushLog(`HubSpot URLs written to Column A (${sheetName}!A2:A${allRows.length + 1}).`, 'log-ok')
              break
            } catch { continue }
          }
        } catch (e) {
          pushLog('Could not write Column A URLs: ' + (e as Error).message, 'log-warn')
        }
      } else {
        pushLog('No companies found. Make sure you are logged into HubSpot.', 'log-warn')
      }

    } catch (err) {
      pushLog('HubSpot error: ' + (err as Error).message, 'log-err')
      try { if (!win.isDestroyed()) win.hide() } catch { /* ignore */ }
    }

    await this._finishStep1(sheetId)
  },

  async _finishStep1(sheetId: string): Promise<void> {
    pushLog('', '')
    pushLog('Step 1 complete.', 'log-ok')
    const s = loadState()
    if (s.mainFolderUrl) pushLog('Your Gong Uploads folder: ' + s.mainFolderUrl, 'log-ok')

    // Create Call_Logs tab early so it's ready when transcripts arrive
    try {
      await CallLogsService.ensureTab(sheetId)
      pushLog('Call_Logs tab ready.', 'log-data')
    } catch { /* best-effort */ }

    if (s.runAll) {
      setUi('step1Done', { sheetId, sheetUrl: s.sheetUrl })
      await this.doStep2()
    } else {
      setUi('step1Done', { sheetId, sheetUrl: s.sheetUrl })
    }
  },

  // ── STEP 2: Scrape Gong transcripts ───────────────────────────────────────

  async doStep2(): Promise<void> {
    abortFlag = false
    const s = loadState()
    if (!s.runAll) { /* logs cleared in UI already */ }
    pushLog('=== STEP 2: SCRAPING TRANSCRIPTS ===', 'log-step')
    setUi('running')

    try { await AuthService.getAuthClient() }
    catch {
      pushLog('Google sign-in required.', 'log-err')
      setUi('idle')
      return
    }

    let state = loadState()
    // Recover sheetId from sheetUrl if it's missing (e.g. after app reset with saved state)
    if (!state.sheetId && state.sheetUrl) {
      const m = state.sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
      if (m?.[1]) { saveState({ ...state, sheetId: m[1] }); state = loadState() }
    }
    if (!state.sheetId) {
      pushLog('Run Step 1 first.', 'log-err')
      setUi('idle')
      return
    }

    // Re-ensure Drive folders using the same idempotent check as Step 1
    // (checks state → searches Drive by name → only creates if truly absent)
    await this._ensureDriveFolders(state.sheetId)

    // Archive old files
    pushLog('Archiving old transcripts...', 'log-data')
    try {
      const ar = await WebhookService.call({ action: 'archive', sheetId: state.sheetId })
      if (ar && (ar['archived'] as number) > 0) pushLog('Archived ' + ar['archived'] + ' old file(s).', 'log-data')
    } catch { pushLog('Archive skipped (error).', 'log-warn') }

    if (checkAbort()) { setUi('stopped'); return }

    // Open Gong home
    pushLog('Opening Gong...', 'log-data')
    let bgWin: BrowserWindow | null = null
    try {
      bgWin = new BrowserWindow({
        show: false, width: 1280, height: 900,
        webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, partition: 'persist:gong' },
      })
      bgWin.loadURL(GONG_HOME)
      pushLog('Waiting for Gong to load (log in if prompted, up to 3 min)...', 'log-data')
      currentLoginWin = bgWin

      const GONG_LOGIN = `(function(){var u=window.location.href;return u.indexOf('/login')>-1||u.indexOf('sso')>-1||u.indexOf('auth0')>-1;})()`
      const GONG_READY = `(function(){return document.querySelectorAll('a[href*="/call/"]').length>0||document.querySelector('[class*="homeFeed"],[class*="calls"]')!=null;})()`
      const gongDeadline = Date.now() + 180_000
      let gongReady   = false
      let gongLogin   = false
      while (!gongReady && Date.now() < gongDeadline) {
        if (checkAbort()) break
        await sleep(2000)
        try {
          const onLogin = await bgWin.webContents.executeJavaScript(GONG_LOGIN)
          if (onLogin && !gongLogin) {
            gongLogin = true
            emitter.emit('login-needed', { service: 'gong' })
            pushLog('Gong login detected — please log in, then the scraper will continue automatically.', 'log-warn')
          } else if (!onLogin && gongLogin) {
            gongLogin = false
            emitter.emit('login-done', { service: 'gong' })
            setServiceConnected('gong', true)
          }
          if (!onLogin) gongReady = await bgWin.webContents.executeJavaScript(GONG_READY)
        } catch { /* navigating */ }
      }
      currentLoginWin = null
      if (gongLogin) { emitter.emit('login-done', { service: 'gong' }) }
      // If we never hit a login screen, the persisted session was already valid
      if (gongReady && !gongLogin) setServiceConnected('gong', true)
      if (!gongReady) {
        pushLog('Gong home page never loaded. Make sure you are logged into Gong.', 'log-err')
        safeClose(bgWin); setUi('idle'); return
      }
      pushLog('Gong loaded. Waiting for call list to populate...', 'log-step')

      // Wait separately for actual call links to appear — the page layout (homeFeed class)
      // can load before the call list renders, causing an immediate 0-link result.
      const CALLS_PRESENT  = `document.querySelectorAll('a[href*="/call"]').length`
      const callsDeadline  = Date.now() + 90_000   // up to 90s for feed to render
      let   callCount      = 0
      while (callCount === 0 && Date.now() < callsDeadline) {
        if (checkAbort()) break
        await sleep(2000)
        try { callCount = await bgWin.webContents.executeJavaScript(CALLS_PRESENT) } catch { /* navigating */ }
      }

      if (callCount === 0) {
        pushLog('No call links appeared after waiting. Make sure your Gong home page shows recent calls.', 'log-err')
        safeClose(bgWin)
        await this._finishStep2(0, 0, 0)
        return
      }

      pushLog(`Call list ready (${callCount} link(s) visible). Collecting...`, 'log-data')
      await sleep(1500)

      // Collect call links — mirrors collect.js
      const COLLECT_SCRIPT = `
        (function() {
          var links = [];
          var seen = {};
          var anchors = document.querySelectorAll('a');
          for (var i = 0; i < anchors.length; i++) {
            var href = anchors[i].href || '';
            if (!href) continue;
            if (href.indexOf('gong.io') !== -1 &&
                (/\\/call[\\/\\?#]/.test(href) || /call-notes/.test(href) || /call-id/.test(href))) {
              if (!seen[href]) { seen[href] = true; links.push(href); }
            }
          }
          return links;
        })()
      `

      const rawLinks: string[] = await bgWin.webContents.executeJavaScript(COLLECT_SCRIPT)
      pushLog(rawLinks.length + ' call link(s) collected.', 'log-data')

      // Filter already-processed URLs
      const processedState = loadState()
      const processed: Record<string, number> = (processedState as Record<string, unknown>)['processed'] as Record<string, number> || {}
      const newLinks = rawLinks.filter(url => !processed[url])
      const skipped  = rawLinks.length - newLinks.length

      if (skipped > 0) pushLog('Skipping ' + skipped + ' already exported.', 'log-data')

      if (newLinks.length === 0) {
        pushLog('All calls already exported.', 'log-ok')
        safeClose(bgWin)
        await this._finishStep2(0, 0, skipped)
        return
      }

      pushLog(newLinks.length + ' new call(s) to process.', 'log-ok')
      pushLog('Processing calls one by one in the same window...', 'log-data')

      // Sequential extraction: reuse bgWin to navigate to each call, extract, repeat.
      // This is more reliable than opening many hidden windows simultaneously.
      let okCount = 0; let failCount = 0; let skipCount = 0

      const EXTRACT_SCRIPT = `
        new Promise(function(resolve) {
          (function() {
            function clickTranscriptTab() {
              var allElements = document.querySelectorAll('*');
              var candidates = [];
              for (var i = 0; i < allElements.length; i++) {
                var el = allElements[i];
                var directText = '';
                for (var c = 0; c < el.childNodes.length; c++) {
                  if (el.childNodes[c].nodeType === 3) directText += el.childNodes[c].textContent;
                }
                directText = directText.trim();
                if (directText.toLowerCase() === 'transcript') candidates.push(el);
              }
              for (var j = 0; j < candidates.length; j++) {
                candidates[j].click();
                if (candidates[j].parentElement) candidates[j].parentElement.click();
              }
              if (candidates.length === 0) {
                var links = document.querySelectorAll("a,button,[role='tab'],[class*='tab']");
                for (var k = 0; k < links.length; k++) {
                  if ((links[k].textContent||'').trim().toLowerCase().indexOf('transcript') !== -1) { links[k].click(); break; }
                }
              }
            }
            function findTranscriptContainer() {
              var selectors = ['[class*="transcript"]','[class*="Transcript"]','[id*="transcript"]','[data-testid*="transcript"]'];
              var best = null; var bestLen = 0;
              for (var s = 0; s < selectors.length; s++) {
                var els = document.querySelectorAll(selectors[s]);
                for (var e = 0; e < els.length; e++) {
                  var text = els[e].innerText || '';
                  if (text.length > bestLen && /\\d{1,2}:\\d{2}/.test(text)) { best = els[e]; bestLen = text.length; }
                }
              }
              if (best && bestLen > 100) return best;
              var allDivs = document.querySelectorAll('div');
              for (var d = 0; d < allDivs.length; d++) {
                var div = allDivs[d]; var txt = div.innerText || '';
                if (txt.length > 200 && /\\d{1,2}:\\d{2}/.test(txt)) {
                  var bodyLen = (document.body.innerText||'').length;
                  if (bodyLen > 0 && txt.length < bodyLen * 0.9 && txt.length > bestLen) { best = div; bestLen = txt.length; }
                }
              }
              return best;
            }
            function getCallMetadata() {
              var rawTitle = document.title || 'Unknown Call';
              var gongTitle = rawTitle.replace(/\\s*[-|]\\s*Gong\\s*$/i, '').trim();
              var account = '';
              // PRIMARY: Gong page titles are "Call Title | Company Name - Gong" — most reliable source
              if (rawTitle.indexOf('|') !== -1) {
                var piped = rawTitle.split('|').pop().trim();
                piped = piped.replace(/\\s*[-\\u2013]\\s*Gong\\s*$/i, '').trim();
                if (piped && piped.length > 1) account = piped;
              }
              // SECONDARY: DOM selectors (Gong may render company name in subtitle/account elements)
              if (!account) {
                var domSelectors = [
                  '[data-testid*="account"]','[data-testid*="company"]',
                  '[class*="account-name"]','[class*="AccountName"]','[class*="accountName"]',
                  '[class*="company-name"]','[class*="CompanyName"]','[class*="call-account"]',
                  '[class*="call-subtitle"] span','[class*="CallSubtitle"] span',
                ];
                for (var si = 0; si < domSelectors.length; si++) {
                  var cEl = document.querySelector(domSelectors[si]);
                  if (cEl) { var ct = cEl.textContent.trim(); if (ct && ct.length > 1 && ct.length < 120) { account = ct; break; } }
                }
              }
              var callDate = '';
              var dateEl = document.querySelector('[data-testid*="date"],[class*="call-date"],time[datetime]');
              if (dateEl) callDate = dateEl.getAttribute('datetime') || dateEl.textContent.trim();
              if (!callDate) { var bm = (document.body.innerText||'').match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+\\d{4})/i); if (bm) callDate = bm[1]; }
              var participants = [];
              var pEls = document.querySelectorAll('[class*="participant"],[class*="Participant"],[data-testid*="participant"]');
              for (var i = 0; i < pEls.length; i++) { var n = pEls[i].textContent.trim(); if (n && n.length < 60) participants.push(n); }
              return { callTitle: rawTitle, gongTitle: gongTitle, url: window.location.href, account: account, callDate: callDate, participants: participants };
            }
            function parseTranscript(rawText) {
              var lines = rawText.split('\\n'); var turns = [];
              var pureTimeRe = /^\\s*(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*$/;
              var hasTimeRe = /(\\d{1,2}:\\d{2}(?::\\d{2})?)/;
              var timeLines = [];
              for (var i = 0; i < lines.length; i++) { if (hasTimeRe.test(lines[i])) timeLines.push(i); }
              if (timeLines.length === 0) { var full = rawText.replace(/\\s+/g,' ').trim(); if (full.length > 0) turns.push({speaker:'Unknown',time:'',text:full}); return turns; }
              for (var t = 0; t < timeLines.length; t++) {
                var tIdx = timeLines[t]; var tLine = lines[tIdx].trim(); var speaker = ''; var time = '';
                var tMatch = tLine.match(hasTimeRe); time = tMatch ? tMatch[1] : '';
                if (pureTimeRe.test(tLine)) { if (tIdx > 0) { var prev = lines[tIdx-1].trim(); if (prev.length > 0 && prev.length < 60 && /[a-zA-Z]/.test(prev) && !hasTimeRe.test(prev)) speaker = prev; } }
                else { var rem = tLine.replace(hasTimeRe,'').trim(); if (rem.length > 0 && rem.length < 60) speaker = rem; }
                var bodyStart = tIdx+1; var bodyEnd = lines.length;
                if (t+1 < timeLines.length) { var nextT = timeLines[t+1]; if (pureTimeRe.test(lines[nextT].trim()) && nextT > 0) { var bn = lines[nextT-1].trim(); if (bn.length > 0 && bn.length < 60 && /[a-zA-Z]/.test(bn) && !hasTimeRe.test(bn)) bodyEnd = nextT-1; else bodyEnd = nextT; } else { bodyEnd = nextT; } }
                var bodyParts = []; for (var b = bodyStart; b < bodyEnd; b++) { var bl = lines[b].trim(); if (bl.length > 0) bodyParts.push(bl); }
                var bodyText = bodyParts.join(' ').replace(/\\s+/g,' ').trim();
                if (bodyText.length > 0) turns.push({speaker: speaker||'Unknown', time: time, text: bodyText});
              }
              return turns;
            }
            clickTranscriptTab();
            var attempts = 0; var clickedAgain = false;
            var iv = setInterval(function() {
              attempts++;
              var container = findTranscriptContainer();
              if (container) {
                clearInterval(iv);
                var target = container;
                var p = container.parentElement; var d = 0;
                while (p && d < 5) { if (p.scrollHeight > p.clientHeight + 50) { target = p; break; } p = p.parentElement; d++; }
                var prev = 0; var stable = 0; var iter = 0;
                var sv = setInterval(function() {
                  target.scrollTop = target.scrollHeight;
                  iter++;
                  if (target.scrollHeight === prev) stable++; else stable = 0;
                  prev = target.scrollHeight;
                  if (stable >= 3 || iter >= 80) {
                    clearInterval(sv);
                    target.scrollTop = 0;
                    setTimeout(function() {
                      var refreshed = findTranscriptContainer() || container;
                      var rawText = refreshed.innerText || '';
                      if (rawText.length < 50) { resolve({error:'Transcript too short ('+rawText.length+' chars).'}); return; }
                      var transcript = parseTranscript(rawText);
                      if (transcript.length === 0) { resolve({error:'0 turns parsed from '+rawText.length+' chars.'}); return; }
                      var meta = getCallMetadata();
                      var speakerSet = {};
                      for (var sp = 0; sp < transcript.length; sp++) { if (transcript[sp].speaker && transcript[sp].speaker !== 'Unknown') speakerSet[transcript[sp].speaker] = true; }
                      var speakers = Object.keys(speakerSet);
                      resolve({ lineCount: transcript.length, callTitle: meta.callTitle, gongTitle: meta.gongTitle, url: meta.url, account: meta.account, callDate: meta.callDate, participants: meta.participants, speakers: speakers, transcript: transcript });
                    }, 500);
                  }
                }, 800);
                return;
              }
              if (!clickedAgain && attempts === 5) { clickedAgain = true; clickTranscriptTab(); }
              if (attempts === 10) clickTranscriptTab();
              if (attempts >= 20) { clearInterval(iv); resolve({error:'No transcript container found.'}); }
            }, 2000);
          })();
        })
      `

      // Sequential: navigate bgWin to each call URL one at a time
      for (let i = 0; i < newLinks.length; i++) {
        if (checkAbort()) break
        const url = newLinks[i]
        pushLog(`[${i + 1}/${newLinks.length}] Navigating to call...`, 'log-step')

        try {
          // Navigate the existing window to this call page
          bgWin.loadURL(url)
          const loaded = await waitForLoad(bgWin, 30_000)
          if (!loaded) {
            pushLog('  Page failed to load, skipping.', 'log-warn'); failCount++
            await sleep(BETWEEN_CALLS_SEC * 1000)
            continue
          }
          // Give the page time to render dynamic content
          await sleep(PAGE_LOAD_WAIT_SEC * 1000)

          const data = await Promise.race([
            bgWin.webContents.executeJavaScript(EXTRACT_SCRIPT),
            sleep(EXTRACT_TIMEOUT_SEC * 1000).then(() => null),
          ]) as Record<string, unknown> | null

          if (!data) {
            pushLog('  TIMEOUT.', 'log-warn'); failCount++
          } else if (data['error']) {
            pushLog('  FAILED: ' + data['error'], 'log-err'); failCount++
          } else {
            // Send to Drive via webhook
            const state2 = loadState()
            const payload: Record<string, unknown> = {
              ...data,
              sheetId: state2.sheetId,
              action: 'saveTranscript',
            }
            const sr = await WebhookService.call(payload)
            let isDuplicate = false
            if (sr['status'] === 'duplicate') isDuplicate = true

            if (isDuplicate) {
              pushLog('  Already in Drive.', 'log-data')
              skipCount++
            } else if (sr['status'] === 'ok' || sr['status'] === 'success' || sr['fileName']) {
              pushLog(`  ${data['lineCount']} lines${data['account'] ? ' (' + data['account'] + ')' : ''}`, 'log-ok')
              pushLog('  Sent to Drive.', 'log-ok')

              // ── Log to Call_Logs Google Sheet (best-effort, fire-and-forget) ──
              if (state2.sheetId && sr['fileId']) {
                const fileId      = sr['fileId'] as string
                const docUrl      = `https://docs.google.com/document/d/${fileId}/edit`
                const txLines     = data['transcript'] as Array<{speaker:string;text:string}> | undefined
                const txSample    = txLines ? txLines.map(l => l.text).join(' ').slice(0, 400) : ''
                const callTypeDet = CallLogsService.detectCallType(
                  (data['callTitle'] as string) || (data['gongTitle'] as string) || '',
                  txSample,
                )
                CallLogsService.appendRow(state2.sheetId, {
                  companyName:    (data['account'] as string) || 'Unknown',
                  callDate:       (data['callDate'] as string) || new Date().toISOString(),
                  callType:       callTypeDet,
                  transcriptUrl:  docUrl,
                  transcriptLines: txLines,
                  transcriptText:  txSample,
                }).catch(err => pushLog('  Call_Logs warning: ' + (err as Error).message, 'log-warn'))
              }

              // Mark as processed
              const s2 = loadState()
              const proc = (s2 as Record<string, unknown>)['processed'] as Record<string, number> || {}
              proc[url] = Date.now()
              saveState({ ...s2, processed: proc } as GongState)
              okCount++
              // Save transcript to local DB and fuzzy-match to a company
              try {
                const db = getDb()
                const txId       = ulid()
                const callTitle  = (data['gongTitle'] as string) || (data['callTitle'] as string) || 'Untitled'
                const accountStr = (data['account'] as string) || ''
                const driveFileId = (sr['fileId'] as string) || null
                const callDateStr = (data['callDate'] as string) || new Date().toISOString()
                // Match company — exact name first, fuzzy fallback
                let companyId: string | null = null
                let companyMatchName = ''
                if (accountStr) {
                  const companyNames: Array<{id:string;name:string}> = db.prepare('SELECT id, name FROM companies ORDER BY name').all() as Array<{id:string;name:string}>
                  // Exact match (case-insensitive)
                  const exactMatch = companyNames.find(co => co.name.toLowerCase() === accountStr.toLowerCase())
                  if (exactMatch) {
                    companyId = exactMatch.id
                    companyMatchName = exactMatch.name
                  } else {
                    // Fuzzy fallback
                    let bestScore = 0
                    for (const co of companyNames) {
                      const score = autoMatchScore(accountStr, co.name)
                      if (score > bestScore) { bestScore = score; companyId = co.id; companyMatchName = co.name }
                    }
                    if (bestScore < 0.60) { companyId = null; companyMatchName = '' }
                  }
                }
                db.prepare(`
                  INSERT INTO transcripts (id, company_id, gong_call_url, call_title, called_at, drive_file_id, match_status, processed_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                  ON CONFLICT(gong_call_url) DO UPDATE SET
                    call_title = excluded.call_title,
                    company_id = excluded.company_id,
                    drive_file_id = excluded.drive_file_id,
                    match_status = excluded.match_status,
                    updated_at = datetime('now')
                `).run(txId, companyId, url, callTitle, callDateStr, driveFileId, companyId ? 'matched' : 'unmatched')
                // Accumulate all transcripts from this run (prepend newest)
                const driveUrl = driveFileId ? `https://drive.google.com/file/d/${driveFileId}/view` : ''
                const recent = loadState().recentTranscripts || []
                const newEntry = { title: callTitle, driveFileId: driveFileId || '', driveUrl, callUrl: url, callDate: callDateStr, companyName: companyMatchName || accountStr }
                // Deduplicate by callUrl, then sort newest-first, cap at 25
                const merged = [newEntry, ...recent.filter(r => r.callUrl !== url)]
                merged.sort((a, b) => {
                  const da = new Date(a.callDate).getTime() || 0
                  const db2 = new Date(b.callDate).getTime() || 0
                  return db2 - da
                })
                const updated = merged.slice(0, 25)
                saveState({ ...loadState(), recentTranscripts: updated })
              } catch (dbErr) {
                pushLog('  DB save warning: ' + (dbErr as Error).message, 'log-warn')
              }
            } else {
              pushLog('  Error: ' + (sr['message'] || JSON.stringify(sr).slice(0, 80)), 'log-err')
              failCount++
            }
          }
        } catch (e) {
          pushLog('  Error: ' + (e as Error).message, 'log-err'); failCount++
        }

        await sleep(BETWEEN_CALLS_SEC * 1000)
      }

      safeClose(bgWin)
      await this._finishStep2(okCount, failCount, skipCount)

    } catch (err) {
      pushLog('Step 2 error: ' + (err as Error).message, 'log-err')
      safeClose(bgWin)
      setUi('idle')
    }
  },

  async _finishStep2(ok: number, fail: number, skip: number): Promise<void> {
    pushLog('', '')
    pushLog('=== SCRAPE COMPLETE ===', 'log-step')
    pushLog('Successful: ' + ok, 'log-ok')
    if (fail > 0) pushLog('Failed: '  + fail, 'log-err')
    if (skip > 0) pushLog('Skipped: ' + skip, 'log-data')
    const s = loadState()
    if (s.mainFolderUrl) pushLog('Your transcripts: ' + s.mainFolderUrl, 'log-ok')

    if (s.runAll) {
      setUi('step2Done', { extracted: ok })
      await this.doStep3()
    } else {
      setUi('step2Done', { extracted: ok })
    }
  },

  // ── STEP 3: Organize files into company folders ────────────────────────────

  async doStep3(): Promise<void> {
    abortFlag = false
    pushLog('=== STEP 3: ORGANIZING ===', 'log-step')
    setUi('running')

    try { await AuthService.getAuthClient() }
    catch { pushLog('Google sign-in required.', 'log-err'); setUi('idle'); return }

    let state = loadState()
    // Recover sheetId from sheetUrl if it's missing (e.g. after app reset with saved state)
    if (!state.sheetId && state.sheetUrl) {
      const m = state.sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
      if (m?.[1]) { saveState({ ...state, sheetId: m[1] }); state = loadState() }
    }
    if (!state.sheetId) { pushLog('Run Step 1 first.', 'log-err'); setUi('idle'); return }
    const sid = state.sheetId

    pushLog('Cleaning up...', 'log-data')
    const cl = await WebhookService.call({ action: 'cleanup', sheetId: sid })
    if (cl['deleted'] && (cl['deleted'] as number) > 0) pushLog('  Removed ' + cl['deleted'] + ' invalid folder(s).', 'log-data')

    pushLog('Creating company folders (this may take a minute)...', 'log-data')
    const cr = await WebhookService.call({ action: 'createFolders', sheetId: sid })
    if (!cr || cr['status'] === 'error') {
      pushLog('Error: ' + (cr['message'] || 'no response'), 'log-err')
      setUi('idle'); return
    }
    if (cr['created'] && (cr['created'] as number) > 0) pushLog('  Created ' + cr['created'] + ' new folder(s).', 'log-ok')
    if (cr['skipped'] && (cr['skipped'] as number) > 0) pushLog('  ' + cr['skipped'] + ' already existed.', 'log-data')

    pushLog('Sorting files into folders...', 'log-data')
    const sf = await WebhookService.call({ action: 'sortFiles', sheetId: sid })
    if (!sf || sf['status'] === 'error') {
      pushLog('Error: ' + (sf['message'] || 'no response'), 'log-err')
      setUi('idle'); return
    }

    pushLog('Scanned ' + (sf['scanned'] || 0) + ' file(s).', 'log-data')
    if ((sf['sorted'] as number) > 0) {
      pushLog('Sorted ' + sf['sorted'] + ' file(s).', 'log-ok')
      const details = sf['details'] as string[] || []
      for (const d of details.slice(0, 5)) pushLog('  ' + d, 'log-data')
    }

    const unfiled = sf['unfiledFiles'] as Array<{ id: string; name: string }> || []

    // Auto-assign unfiled files by fuzzy-matching filenames to company names
    let remaining = unfiled
    if (unfiled.length > 0) {
      try {
        const companyNames = CompanyService.getNames()
        const autoAssigned: Array<{ id: string; name: string; company: string }> = []
        remaining = []
        for (const f of unfiled) {
          let bestScore = 0
          let bestName  = ''
          for (const cn of companyNames) {
            const score = autoMatchScore(f.name, cn)
            if (score > bestScore) { bestScore = score; bestName = cn }
          }
          if (bestScore >= 0.45 && bestName) {
            autoAssigned.push({ ...f, company: bestName })
          } else {
            remaining.push(f)
          }
        }
        if (autoAssigned.length > 0) {
          pushLog(`Auto-assigning ${autoAssigned.length} file(s) by name match...`, 'log-data')
          for (const a of autoAssigned) {
            pushLog(`  "${a.name}" → "${a.company}"`, 'log-ok')
            await WebhookService.call({ action: 'moveFile', fileId: a.id, companyName: a.company, sheetId: sid })
          }
        }
      } catch (e) {
        pushLog('Auto-assign error: ' + (e as Error).message, 'log-warn')
        remaining = unfiled
      }
    }

    if (remaining.length > 0) {
      pushLog(`Moving ${remaining.length} unfiled file(s) to Miscellaneous folder...`, 'log-data')
      let miscCount = 0
      for (const f of remaining) {
        try {
          await WebhookService.call({ action: 'moveFile', fileId: f.id, companyName: 'Miscellaneous (No Company Name)', sheetId: sid })
          miscCount++
        } catch { /* ignore individual failures */ }
      }
      if (miscCount > 0) pushLog(`Moved ${miscCount} file(s) to "Miscellaneous (No Company Name)".`, 'log-ok')
      remaining = []
    }

    if (remaining.length > 0) {
      pushLog('', '')
      pushLog(remaining.length + ' file(s) need a company name.', 'log-warn')
      saveState({ ...loadState(), unfiled: remaining })
      setUi('prompting', { unfiledCount: remaining.length })
    } else {
      // ── Call_Logs reconciliation (backfill any Drive transcripts not yet logged) ──
      const s2pre = loadState()
      if (s2pre.sheetId && s2pre.mainFolderUrl) {
        try {
          await CallLogsService.reconcile(
            s2pre.sheetId,
            s2pre.mainFolderUrl,
            (msg) => pushLog(msg, 'log-data'),
          )
        } catch (reconcileErr) {
          pushLog('Call_Logs reconcile error: ' + (reconcileErr as Error).message, 'log-warn')
        }
      }

      pushLog('', '')
      pushLog('Organization complete.', 'log-ok')
      const s2 = loadState()
      if (s2.mainFolderUrl) pushLog('Your transcripts: ' + s2.mainFolderUrl, 'log-ok')
      saveState({ ...s2, unfiled: [], runAll: false })

      if (s2.runAll) {
        pushLog('', '')
        pushLog('=== ALL PROCESSES COMPLETE ===', 'log-step')
        setUi('allDone')
      } else {
        setUi('step3Done')
      }
    }
  },

  // ── Move unfiled file to a company folder ─────────────────────────────────

  async moveFile(fileId: string, companyName: string): Promise<void> {
    const state = loadState()
    pushLog('  Moving to "' + companyName + '"...', 'log-data')
    const r = await WebhookService.call({ action: 'moveFile', fileId, companyName, sheetId: state.sheetId || '' })
    if (r['movedTo']) pushLog('  Moved to ' + r['movedTo'] + '.', 'log-ok')
    else              pushLog('  Move error: ' + (r['message'] || ''), 'log-err')
    emitter.emit('move-complete')
  },

  // ── Run all 3 steps ────────────────────────────────────────────────────────

  async doRunAll(): Promise<void> {
    saveState({ ...loadState(), runAll: true })
    await this.doStep1()
  },

  // ── Stop ──────────────────────────────────────────────────────────────────

  stop(): void {
    abortFlag = true
    saveState({})
    pushLog('Stopped and reset.', 'log-warn')
    setUi('idle')
  },

  // ── Reset ─────────────────────────────────────────────────────────────────

  reset(): void {
    abortFlag = true
    saveState({})
    pushLog('', '')
    setUi('idle')
    emitter.emit('reset')
  },

  // ── Schedule ──────────────────────────────────────────────────────────────
  // mode: 'daily' = every day, 'weekly' = one day/week, 'custom' = selected days

  setSchedule(mode: 'daily' | 'weekly' | 'custom', days: number[], hour: number): void {
    const effectiveDays = mode === 'daily' ? [0,1,2,3,4,5,6] : days
    const nextRun = this._calcNextRun(effectiveDays, hour)
    const state   = loadState()
    saveState({ ...state, schedule: { active: true, mode, days: effectiveDays, hour, nextRun } })
    emitter.emit('schedule-changed', { active: true, mode, days: effectiveDays, hour, nextRun })
  },

  clearSchedule(): void {
    const state = loadState()
    saveState({ ...state, schedule: { active: false, mode: 'weekly', days: [], hour: 0, nextRun: 0 } })
    emitter.emit('schedule-changed', { active: false })
  },

  _calcNextRun(days: number[], hour: number): number {
    if (days.length === 0) return Date.now() + 7 * 24 * 60 * 60 * 1000
    const now    = new Date()
    let   minMs  = Infinity
    for (const day of days) {
      const t  = new Date(now)
      t.setHours(hour, 0, 0, 0)
      let du = day - now.getDay()
      if (du < 0) du += 7
      if (du === 0 && now.getHours() >= hour) du = 7
      t.setDate(t.getDate() + du)
      if (t.getTime() < minMs) minMs = t.getTime()
    }
    return minMs
  },

  clearRecentTranscripts(): void {
    saveState({ ...loadState(), recentTranscripts: [] })
  },

  /**
   * Fetch the most recent 25 transcript files from Google Drive.
   * Checks the main Gong folder and one level of subfolders so files
   * moved by Step 3 into company folders are still included.
   * Merges with and updates the persisted recentTranscripts list.
   */
  async fetchRecentFromDrive(): Promise<GongState['recentTranscripts']> {
    const state = loadState()
    const mainFolderUrl = state.mainFolderUrl
    if (!mainFolderUrl) return state.recentTranscripts || []

    try {
      const { google } = await import('googleapis')
      const auth  = await AuthService.getAuthClient()
      const drive = google.drive({ version: 'v3', auth })

      const folderId = mainFolderUrl.split('/folders/')[1]?.split('?')[0] || mainFolderUrl.split('/').pop()!

      // Collect folder IDs to search: main folder + immediate subfolders
      const folderIds: string[] = [folderId]
      try {
        const subRes = await drive.files.list({
          q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id)',
          pageSize: 50,
        })
        for (const f of subRes.data.files || []) {
          if (f.id) folderIds.push(f.id)
        }
      } catch { /* best-effort */ }

      // Build query: files in any of these folders, not trashed, not folders
      const parentClauses = folderIds.map(id => `'${id}' in parents`).join(' or ')
      const q = `mimeType!='application/vnd.google-apps.folder' and trashed=false and (${parentClauses})`

      const res = await drive.files.list({
        q,
        fields: 'files(id, name, webViewLink, createdTime, modifiedTime)',
        orderBy: 'modifiedTime desc',
        pageSize: 25,
      })

      const driveFiles = res.data.files || []
      if (driveFiles.length === 0) return state.recentTranscripts || []

      // Build drive-sourced entries — use existing state + DB to preserve callUrl
      const existing = state.recentTranscripts || []
      const existingByFileId: Record<string, typeof existing[0]> = {}
      const existingByTitle: Record<string, typeof existing[0]> = {}
      for (const e of existing) {
        if (e.driveFileId) existingByFileId[e.driveFileId] = e
        if (e.title) existingByTitle[e.title.toLowerCase()] = e
      }

      // DB is the ground truth for gong_call_url — query by drive_file_id and call_title
      const dbUrlsByFileId: Record<string, string> = {}
      const dbUrlsByTitle:  Record<string, string> = {}
      const dbCompanyByFileId: Record<string, string> = {}
      try {
        const db = getDb()
        const rows = db.prepare(
          `SELECT drive_file_id, gong_call_url, call_title,
                  (SELECT name FROM companies WHERE id = transcripts.company_id) AS company_name
           FROM transcripts
           WHERE gong_call_url IS NOT NULL AND gong_call_url != ''`
        ).all() as Array<{ drive_file_id: string | null; gong_call_url: string; call_title: string; company_name: string | null }>
        for (const row of rows) {
          if (row.drive_file_id) {
            dbUrlsByFileId[row.drive_file_id] = row.gong_call_url
            if (row.company_name) dbCompanyByFileId[row.drive_file_id] = row.company_name
          }
          if (row.call_title) dbUrlsByTitle[row.call_title.toLowerCase()] = row.gong_call_url
        }
      } catch { /* DB not ready — skip */ }

      const driveEntries: GongState['recentTranscripts'] = driveFiles.map(f => {
        // Primary match by driveFileId (state then DB), fallback by title (case-insensitive)
        const existingEntry = (f.id ? existingByFileId[f.id] : undefined)
          ?? (f.name ? existingByTitle[f.name.toLowerCase()] : undefined)
        const callUrl = existingEntry?.callUrl
          ?? (f.id  ? dbUrlsByFileId[f.id]  : undefined)
          ?? (f.name ? dbUrlsByTitle[f.name.toLowerCase()] : undefined)
        const companyName = existingEntry?.companyName
          || (f.id ? dbCompanyByFileId[f.id] : '')
          || ''
        return {
          title:       f.name || 'Unknown',
          driveFileId: f.id || '',
          driveUrl:    f.webViewLink || (f.id ? `https://drive.google.com/file/d/${f.id}/view` : ''),
          callDate:    f.createdTime || f.modifiedTime || '',
          companyName,
          callUrl,
        }
      })

      // Merge: Drive entries are authoritative for files in Drive; keep state-only entries
      const driveFileIdSet = new Set(driveFiles.map(f => f.id).filter(Boolean))
      const stateOnlyEntries = existing.filter(e => !driveFileIdSet.has(e.driveFileId))
      const merged = [...driveEntries, ...stateOnlyEntries]
      merged.sort((a, b) => {
        const da = new Date(a.callDate).getTime() || 0
        const db2 = new Date(b.callDate).getTime() || 0
        return db2 - da
      })
      const updated = merged.slice(0, 25)
      saveState({ ...loadState(), recentTranscripts: updated })
      return updated
    } catch {
      // If Drive fetch fails, fall back to persisted state
      return state.recentTranscripts || []
    }
  },

  getLogs(): GongLog[] { return [] }, // logs live in-memory via EventEmitter

  getUnfiled(): Array<{ id: string; name: string }> {
    return loadState().unfiled || []
  },

  // ── Services status ────────────────────────────────────────────────────────

  getServicesStatus(): ServicesStatus {
    return getServicesStatus()
  },

  /**
   * Explicitly connect HubSpot — shows the HubSpot window visibly so the user
   * can log in if needed, then saves connected state.
   */
  async connectHubSpot(): Promise<ServicesStatus> {
    try {
      const win = getOrCreateHubspotWin()
      win.loadURL(HUBSPOT_URL)
      win.show()
      win.focus()
      currentLoginWin = win

      const TABLE_CHECK = `(function(){try{var t=document.querySelector('table');return !!(t&&t.querySelectorAll('tbody tr').length>0);}catch(e){return false;}})()`
      const HS_LOGIN   = `(function(){var u=window.location.href;return u.indexOf('/login')>-1||u.indexOf('hs-login')>-1||u.indexOf('/signup')>-1;})()`
      const CLICK_GOOGLE = `(function(){var btns=document.querySelectorAll('a,button,[role="button"]');for(var i=0;i<btns.length;i++){var t=(btns[i].textContent||'').trim().toLowerCase();if(t.indexOf('google')!==-1){btns[i].click();return true;}}return false;})()`

      const deadline = Date.now() + 300_000  // 5 minutes for manual login
      let tableReady = false
      while (!tableReady && Date.now() < deadline) {
        await sleep(2000)
        try {
          const onLogin = await win.webContents.executeJavaScript(HS_LOGIN)
          if (onLogin) {
            // Try auto-SSO first; if it fails the user sees the window and can log in
            await win.webContents.executeJavaScript(CLICK_GOOGLE).catch(() => {})
          } else {
            tableReady = await win.webContents.executeJavaScript(TABLE_CHECK)
          }
        } catch { /* navigating */ }
      }
      currentLoginWin = null
      if (tableReady) {
        setServiceConnected('hubspot', true)
        try { if (!win.isDestroyed()) win.close() } catch { /* ignore */ }
      }
    } catch { /* best-effort */ }
    return getServicesStatus()
  },

  /**
   * Explicitly connect Gong — shows the Gong window (persist:gong session) so the
   * user can log in, then saves connected state.
   */
  async connectGong(): Promise<ServicesStatus> {
    let win: BrowserWindow | null = null
    try {
      win = new BrowserWindow({
        show: true, width: 1280, height: 900,
        webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, partition: 'persist:gong' },
      })
      win.focus()
      win.loadURL(GONG_HOME)
      currentLoginWin = win

      const GONG_LOGIN = `(function(){var u=window.location.href;return u.indexOf('/login')>-1||u.indexOf('sso')>-1||u.indexOf('auth0')>-1;})()`
      const GONG_READY = `(function(){return document.querySelectorAll('a[href*="/call/"]').length>0||document.querySelector('[class*="homeFeed"],[class*="calls"]')!=null;})()`

      const deadline = Date.now() + 300_000  // 5 minutes
      let gongReady = false
      while (!gongReady && Date.now() < deadline) {
        await sleep(2000)
        try {
          const onLogin = await win.webContents.executeJavaScript(GONG_LOGIN)
          if (!onLogin) gongReady = await win.webContents.executeJavaScript(GONG_READY)
        } catch { /* navigating */ }
      }
      currentLoginWin = null
      if (gongReady) {
        setServiceConnected('gong', true)
        safeClose(win)
      }
    } catch { /* best-effort */ }
    return getServicesStatus()
  },
}

// ─── Check schedule on interval ───────────────────────────────────────────────

setInterval(() => {
  const s = loadState()
  if (!s.schedule?.active) return
  if (Date.now() >= s.schedule.nextRun) {
    pushLog('=== SCHEDULED RUN ===', 'log-step')
    // Recalculate next run using the days array
    const next = GongScraperService._calcNextRun(s.schedule.days ?? [], s.schedule.hour)
    saveState({ ...loadState(), schedule: { ...s.schedule, nextRun: next } })
    GongScraperService.doStep2().catch(console.error)
  }
}, 60_000)
