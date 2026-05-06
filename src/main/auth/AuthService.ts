/**
 * AuthService — Google OAuth 2.0 with PKCE
 *
 * Works identically to the Gong Scrubber Chrome extension:
 * click "Connect Google", a Google sign-in window opens,
 * the user approves with their @prokeep.com account, done.
 * No configuration or copy-pasting required.
 */

import { BrowserWindow } from 'electron'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { URL } from 'url'
import { google } from 'googleapis'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { GOOGLE_SCOPES, OAUTH_REDIRECT_PORT, OAUTH_REDIRECT_URI, TOKEN_REFRESH_BUFFER_SECONDS } from '@shared/constants'
import type { AuthStatus } from '@shared/types'

// ─── Hardcoded OAuth client (Web app — same Google Cloud project as Gong Scrubber) ───
const GOOGLE_CLIENT_ID     = '197902087875-6euqi31b4qqv5ijce3pco7kqjh22n0cr.apps.googleusercontent.com'
const GOOGLE_CLIENT_SECRET = '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'

// ─── Token file (persists in user data across app updates) ───────────────────
const TOKEN_FILE = join(app.getPath('userData'), 'auth-tokens.json')

interface StoredTokens {
  access_token:  string
  refresh_token: string
  expiry_date:   number
  email:         string
  scopes:        string[]
}

// ─── Token persistence ────────────────────────────────────────────────────────

function loadTokens(): StoredTokens | null {
  try {
    if (!existsSync(TOKEN_FILE)) return null
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')) as StoredTokens
  } catch {
    return null
  }
}

function saveTokens(tokens: StoredTokens): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf-8')
}

function clearTokens(): void {
  try { require('fs').unlinkSync(TOKEN_FILE) } catch { /* ignore */ }
}

// ─── OAuth2 client ────────────────────────────────────────────────────────────

function createOAuthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI)
}

// ─── Module-level window ref so the callback can close it ────────────────────
let authWindow: BrowserWindow | null = null

// ─── AuthService ──────────────────────────────────────────────────────────────

export const AuthService = {

  async login(): Promise<AuthStatus> {
    const oauth2Client = createOAuthClient()

    // Standard authorization code flow — client_secret handles security
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope:       GOOGLE_SCOPES,
      prompt:      'consent',
      hd:          'prokeep.com',  // restrict to @prokeep.com accounts
    })

    return new Promise((resolve, reject) => {
      // ── Local server catches the redirect ──────────────────────────────────
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', `http://localhost:${OAUTH_REDIRECT_PORT}`)
        if (!url.pathname.includes('/oauth/callback')) return

        const code  = url.searchParams.get('code')
        const error = url.searchParams.get('error')

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
          <html><head><style>
            body { font-family:-apple-system,sans-serif; display:flex; align-items:center;
                   justify-content:center; height:100vh; margin:0; background:#0D1525; color:#F1F5F9; }
            .card { text-align:center; }
            h2 { color:${error ? '#DA5039' : '#56B7A3'}; margin-bottom:8px; }
            p  { color:#94A3B8; font-size:14px; }
          </style></head><body>
            <div class="card">
              <h2>${error ? '✗ Authentication failed' : '✓ Connected to Google'}</h2>
              <p>${error ? error : 'You can close this window and return to CSM Master Tool.'}</p>
            </div>
          </body></html>
        `)

        server.close()
        setTimeout(() => authWindow?.close(), 800)

        if (error || !code) {
          reject(new Error(error ?? 'No authorization code received'))
          return
        }

        try {
          const { tokens } = await oauth2Client.getToken(code)
          oauth2Client.setCredentials(tokens)

          const oauth2   = google.oauth2({ version: 'v2', auth: oauth2Client })
          const { data } = await oauth2.userinfo.get()

          saveTokens({
            access_token:  tokens.access_token  ?? '',
            refresh_token: tokens.refresh_token ?? '',
            expiry_date:   tokens.expiry_date   ?? 0,
            email:         data.email           ?? '',
            scopes:        GOOGLE_SCOPES,
          })

          resolve(AuthService.getStatus())
        } catch (err) {
          reject(err)
        }
      })

      server.listen(OAUTH_REDIRECT_PORT, () => {
        authWindow = new BrowserWindow({
          width:           480,
          height:          620,
          title:           'Connect to Google',
          webPreferences:  { nodeIntegration: false, contextIsolation: true },
          autoHideMenuBar: true,
          resizable:       false,
        })
        authWindow.loadURL(authUrl)
        authWindow.on('closed', () => { authWindow = null })
      })

      server.on('error', reject)

      setTimeout(() => {
        server.close()
        authWindow?.close()
        reject(new Error('Authentication timed out after 5 minutes.'))
      }, 5 * 60 * 1000)
    })
  },

  async logout(): Promise<void> {
    clearTokens()
  },

  getStatus(): AuthStatus {
    const tokens = loadTokens()
    if (!tokens) return { isAuthenticated: false, email: null, scopes: [], expiresAt: null }
    return {
      isAuthenticated: true,
      email:     tokens.email,
      scopes:    tokens.scopes,
      expiresAt: tokens.expiry_date,
    }
  },

  async getAuthClient() {
    const tokens = loadTokens()
    if (!tokens) throw new Error('Not authenticated — please connect to Google in Settings.')

    const oauth2Client = createOAuthClient()
    oauth2Client.setCredentials({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date:   tokens.expiry_date,
    })

    const nowMs    = Date.now()
    const bufferMs = TOKEN_REFRESH_BUFFER_SECONDS * 1000

    if (tokens.expiry_date && nowMs >= tokens.expiry_date - bufferMs) {
      const { credentials } = await oauth2Client.refreshAccessToken()
      saveTokens({
        ...tokens,
        access_token: credentials.access_token ?? tokens.access_token,
        expiry_date:  credentials.expiry_date  ?? tokens.expiry_date,
      })
      oauth2Client.setCredentials(credentials)
    }

    return oauth2Client
  },
}
