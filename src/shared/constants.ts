// ─── Google OAuth ─────────────────────────────────────────────────────────────
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
]

export const OAUTH_REDIRECT_PORT = 9004
export const OAUTH_REDIRECT_URI  = `http://localhost:${OAUTH_REDIRECT_PORT}/oauth/callback`

// ─── Gong ─────────────────────────────────────────────────────────────────────
export const GONG_BASE_URL   = 'https://us-57015.app.gong.io'
export const GONG_HOME_URL   = `${GONG_BASE_URL}/home`

// ─── HubSpot ──────────────────────────────────────────────────────────────────
export const HUBSPOT_PORTAL_ID      = '8787210'
export const HUBSPOT_COMPANIES_URL  = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/objects/0-2/views/all/list`

// ─── Google Drive ─────────────────────────────────────────────────────────────
export const DRIVE_ROOT_FOLDER_NAME    = 'Gong Uploads'
export const DRIVE_ARCHIVE_FOLDER_NAME = 'Archive'
export const DRIVE_ARCHIVE_DAYS        = 14

// ─── Job Queue ────────────────────────────────────────────────────────────────
export const JOB_CONCURRENCY_LIMIT = 2
export const JOB_CONCURRENCY_BY_TYPE: Record<string, number> = {
  hubspot_import: 1,
  gong_collect:   1,
  gong_extract:   3,
  drive_organize: 1,
  calendar_sync:  1,
  index_rebuild:  1,
  scrub_process:  2,
}

export const JOB_RETRY_LIMITS: Record<string, number> = {
  hubspot_import: 2,
  gong_collect:   1,
  gong_extract:   2,
  drive_organize: 2,
  calendar_sync:  1,
  index_rebuild:  0,
  scrub_process:  0,
}

// ─── Token Refresh ────────────────────────────────────────────────────────────
export const TOKEN_REFRESH_BUFFER_SECONDS = 120

// ─── Calendar Sync ────────────────────────────────────────────────────────────
export const CALENDAR_SYNC_WINDOW_DAYS = 90
export const CALENDAR_SYNC_THROTTLE_MS = 5 * 60 * 1000   // 5 minutes
export const CALENDAR_FILTER_KEYWORDS  = ['prokeep', 'call', 'demo', 'onboarding', 'qbr', 'review', 'check-in', 'checkin', 'follow', 'training', 'kickoff', 'launch', 'meeting']

// ─── Company Matching ─────────────────────────────────────────────────────────
export const COMPANY_MATCH_CONFIDENCE_THRESHOLD = 0.45

// ─── Search ───────────────────────────────────────────────────────────────────
export const SEARCH_CACHE_SIZE         = 100
export const SEARCH_DEBOUNCE_MS        = 200
export const SEARCH_MIN_CHARS          = 2
export const FUSE_THRESHOLD            = 0.35
export const FUSE_DISTANCE             = 200

// ─── Log Stream ───────────────────────────────────────────────────────────────
export const MAX_LOG_ENTRIES = 500

// ─── App ──────────────────────────────────────────────────────────────────────
export const APP_NAME    = 'CSM Master Tool'
export const DB_FILENAME = 'csm-master-tool.db'
