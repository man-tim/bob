/**
 * All IPC channel names used between main and renderer.
 * Organized by domain. Main→Renderer push events use the 'push:' prefix.
 */
export const IPC = {
  // ─── Auth ──────────────────────────────────────────────────────────────────
  AUTH_LOGIN:       'auth:login',
  AUTH_LOGOUT:      'auth:logout',
  AUTH_STATUS:      'auth:status',
  AUTH_GET_CONFIG:  'auth:get-config',   // → { clientId: string } | null
  AUTH_SAVE_CONFIG: 'auth:save-config',  // (clientId: string) → void

  // ─── Companies ─────────────────────────────────────────────────────────────
  COMPANIES_LIST:    'companies:list',
  COMPANIES_GET:     'companies:get',
  COMPANIES_DETAILS: 'companies:details',   // rich detail (CSM Copilot)
  COMPANIES_UPSERT:  'companies:upsert',
  COMPANIES_DELETE:  'companies:delete',
  COMPANIES_IMPORT:  'companies:import',    // triggers hubspot_import job

  // ─── Contacts ──────────────────────────────────────────────────────────────
  CONTACTS_LIST:   'contacts:list',         // by company_id
  CONTACTS_UPSERT: 'contacts:upsert',
  CONTACTS_DELETE: 'contacts:delete',

  // ─── Transcripts ───────────────────────────────────────────────────────────
  TRANSCRIPTS_LIST:        'transcripts:list',
  TRANSCRIPTS_GET:         'transcripts:get',
  TRANSCRIPTS_ASSIGN:      'transcripts:assign',    // manual company assignment
  TRANSCRIPTS_RUN_COLLECT: 'transcripts:run-collect',
  TRANSCRIPTS_RUN_EXTRACT: 'transcripts:run-extract',
  TRANSCRIPTS_RUN_ORGANIZE:'transcripts:run-organize',
  TRANSCRIPTS_RUN_ALL:     'transcripts:run-all',

  // ─── Calendar ──────────────────────────────────────────────────────────────
  CALENDAR_SYNC:   'calendar:sync',
  CALENDAR_EVENTS: 'calendar:events',
  CALENDAR_ASSIGN: 'calendar:assign',       // manual company assignment

  // ─── Jobs ──────────────────────────────────────────────────────────────────
  JOBS_LIST:   'jobs:list',
  JOBS_STOP:   'jobs:stop',
  JOBS_LOGS:   'jobs:logs',                 // get logs for a specific job

  // ─── Schedules ─────────────────────────────────────────────────────────────
  SCHEDULES_LIST:   'schedules:list',
  SCHEDULES_CREATE: 'schedules:create',
  SCHEDULES_UPDATE: 'schedules:update',
  SCHEDULES_DELETE: 'schedules:delete',

  // ─── Flyer Creator ─────────────────────────────────────────────────────────
  FLYER_TEMPLATES_LIST:   'flyer:templates-list',
  FLYER_TEMPLATES_SAVE:   'flyer:templates-save',
  FLYER_TEMPLATES_DELETE: 'flyer:templates-delete',
  FLYER_EXPORT_PDF:       'flyer:export-pdf',
  FLYER_EXPORT_BATCH:     'flyer:export-batch',
  FLYER_GENERATE:         'flyer:generate',
  FLYER_GENERATE_QR:      'flyer:generate-qr',
  FLYER_GET_TEMPLATE:     'flyer:get-template',  // (templateId) → { dataUrl: string } | null

  // ─── Scrub & Split ─────────────────────────────────────────────────────────
  SCRUB_UPLOAD:   'scrub:upload',
  SCRUB_PROCESS:  'scrub:process',
  SCRUB_EXPORT:   'scrub:export',
  SCRUB_JOBS:     'scrub:jobs',

  // ─── Gong / Book of Business ───────────────────────────────────────────────
  GONG_PROCESS_COMPANY: 'gong:process-company',    // processCompanyData(companyId)
  GONG_BOOK_OF_BUSINESS:'gong:book-of-business',   // generateBookOfBusiness()

  // ─── Gong Scraper (3-step pipeline) ────────────────────────────────────────
  GONG_SCRAPER_RUN_ALL:      'gong-scraper:run-all',
  GONG_SCRAPER_STEP1:        'gong-scraper:step1',
  GONG_SCRAPER_STEP2:        'gong-scraper:step2',
  GONG_SCRAPER_STEP3:        'gong-scraper:step3',
  GONG_SCRAPER_STOP:         'gong-scraper:stop',
  GONG_SCRAPER_RESET:        'gong-scraper:reset',
  GONG_SCRAPER_STATE:        'gong-scraper:state',
  GONG_SCRAPER_SET_SCHEDULE: 'gong-scraper:set-schedule',
  GONG_SCRAPER_CLR_SCHEDULE: 'gong-scraper:clear-schedule',
  GONG_SCRAPER_MOVE_FILE:    'gong-scraper:move-file',
  GONG_SCRAPER_FOCUS_LOGIN:  'gong-scraper:focus-login',
  GONG_SCRAPER_GET_LOG:      'gong-scraper:get-log',
  GONG_SCRAPER_CLEAR_LOG:    'gong-scraper:clear-log',
  GONG_SCRAPER_CLEAR_TRANSCRIPTS:  'gong-scraper:clear-transcripts',
  GONG_SCRAPER_FETCH_RECENT:       'gong-scraper:fetch-recent',
  GONG_SCRAPER_READ_FILE:          'gong-scraper:read-file',   // (fileId: string) → { text: string }

  // ─── Search ────────────────────────────────────────────────────────────────
  SEARCH_QUERY:         'search:query',
  SEARCH_GLOBAL:        'search:global',    // cross-entity: companies + transcripts + knowledge
  SEARCH_REBUILD_INDEX: 'search:rebuild-index',

  // ─── Settings ──────────────────────────────────────────────────────────────
  SETTINGS_SET:          'settings:set',          // ({ sheetUrl?: string }) → void
  COMPANIES_SYNC_SHEET:  'companies:sync-sheet',  // () → { synced: number }
  COMPANIES_MASTER_REFRESH: 'companies:master-refresh', // sync sheet + return { synced: number }
  QUICK_LINKS_GET:       'quick-links:get',        // () → QuickLink[]
  QUICK_LINKS_SET:       'quick-links:set',        // (links: QuickLink[]) → void
  PROMPTS_GET:           'prompts:get',            // () → SavedPrompt[]
  PROMPTS_SET:           'prompts:set',            // (prompts: SavedPrompt[]) → void
  SCRUB_RESET:           'scrub:reset',            // () → void
  COMPANIES_RESET:       'companies:reset',        // () → void
  CALENDAR_REMATCH:      'calendar:rematch',       // () → { matched: number }
  APP_MASTER_RESET:      'app:master-reset',       // () → void — wipes all data except auth & user prefs
  COMPANY_NOTES_LIST:    'company-notes:list',     // (companyId) → CompanyNote[]
  COMPANY_NOTES_ADD:     'company-notes:add',      // (companyId, content) → CompanyNote
  COMPANY_NOTES_DELETE:  'company-notes:delete',   // (noteId) → void

  // ─── Follow Ups ────────────────────────────────────────────────────────────
  FOLLOW_UPS_LIST:              'follow-ups:list',              // (companyId?) → FollowUp[]
  FOLLOW_UPS_CREATE:            'follow-ups:create',            // (data) → FollowUp
  FOLLOW_UPS_UPDATE:            'follow-ups:update',            // (id, patch) → FollowUp
  FOLLOW_UPS_DELETE:            'follow-ups:delete',            // (id) → void
  FOLLOW_UPS_PARSE_TRANSCRIPTS: 'follow-ups:parse-transcripts', // () → { created: number }

  // ─── Analysis (Risk & Expansion) ──────────────────────────────────────────
  ANALYSIS_RUN:             'analysis:run',              // (csvPath) → AnalysisResult
  ANALYSIS_GET:             'analysis:get',              // (accountName?) → AnalysisResult | null
  ANALYSIS_GET_FOR_COMPANY: 'analysis:get-for-company',  // (companyId) → AnalysisResult | null
  PUSH_ANALYSIS_DONE:       'push:analysis-done',        // AnalysisResult (broadcast after run)

  // ─── File System ───────────────────────────────────────────────────────────
  FS_OPEN_DIALOG:    'fs:open-dialog',
  FS_SAVE_DIALOG:    'fs:save-dialog',
  FS_WRITE_FILE:     'fs:write-file',
  FS_OPEN_EXTERNAL:  'fs:open-external',        // open file/folder in Finder/Explorer
  FS_READ_TEXT_FILE: 'fs:read-text-file',       // read a text file as UTF-8 string

  // ─── Services (HubSpot / Gong connection state) ────────────────────────────
  SERVICES_STATUS:           'services:status',           // () → ServicesStatus
  SERVICES_CONNECT_HUBSPOT:  'services:connect-hubspot',  // () → ServicesStatus
  SERVICES_CONNECT_GONG:     'services:connect-gong',     // () → ServicesStatus

  // ─── Push Events (main → renderer) ────────────────────────────────────────
  // These are sent via webContents.send(), not invoked
  PUSH_JOB_LOG:        'push:job-log',        // { jobId, log: JobLog }
  PUSH_JOB_STATUS:     'push:job-status',     // { jobId, status: JobStatus }
  PUSH_JOB_PROGRESS:   'push:job-progress',   // { jobId, step, total, label }
  PUSH_AUTH_CHANGED:   'push:auth-changed',   // AuthStatus
  PUSH_NOTIFY:         'push:notify',         // { title, body, level }
  PUSH_FLYER_PROGRESS: 'push:flyer-progress', // { done, total, filename }
  PUSH_GONG_LOG:       'push:gong-log',        // GongLog { msg, cls, ts }
  PUSH_GONG_STATUS:    'push:gong-status',     // GongStatus { status, ... }
  PUSH_GONG_MOVE:      'push:gong-move',       // move-complete signal
  PUSH_LOGIN_NEEDED:    'push:login-needed',    // { service: 'hubspot' | 'gong' }
  PUSH_LOGIN_DONE:      'push:login-done',      // { service: 'hubspot' | 'gong' }
  PUSH_SERVICES_STATUS: 'push:services-status', // ServicesStatus
  PUSH_APP_RESET:       'push:app-reset',        // broadcast after APP_MASTER_RESET completes
  PUSH_NAVIGATE:        'push:navigate',         // { path: string } — tray menu navigation

  // ─── App Updates ───────────────────────────────────────────────────────────
  APP_CHECK_UPDATES:    'app:check-for-updates', // () → { status: string }
  PUSH_UPDATE_STATUS:   'push:update-status',    // { status: 'checking'|'available'|'not-available'|'downloaded'|'error'; message?: string }

  // ─── Notification Settings ─────────────────────────────────────────────────
  NOTIFICATIONS_GET_SETTINGS: 'notifications:get-settings',   // () → { enabled: boolean; windowsMin: number[] }
  NOTIFICATIONS_SET_SETTINGS: 'notifications:set-settings',   // ({ enabled, windowsMin }) → void

  // ─── Analysis Popout ───────────────────────────────────────────────────────
  ANALYSIS_OPEN_POPOUT: 'analysis:open-popout',  // (type: 'risk'|'expansion') → void

  // ─── Feedback Logger (Developer Tool) ─────────────────────────────────────
  FEEDBACK_LOG: 'feedback:log',  // ({ tag, id, className, innerText, note }) → void

  // ─── Local AI (node-llama-cpp) ─────────────────────────────────────────────
  AI_STATUS:          'ai:status',          // () → AIStatus
  AI_DOWNLOAD:        'ai:download',        // () → void — starts background download
  AI_CANCEL_DOWNLOAD: 'ai:cancel-download', // () → void
  AI_DELETE_MODEL:    'ai:delete-model',    // () → void — deletes downloaded model file
  AI_COMPLETE:        'ai:complete',        // ({ requestId, prompt, systemPrompt? }) → { text }
  AI_LOAD:            'ai:load',            // () → void — eagerly load model into memory
  PUSH_AI_PROGRESS:   'push:ai-progress',  // { pct: number; mbDownloaded: number; mbTotal: number }
  PUSH_AI_CHUNK:      'push:ai-chunk',     // { requestId: string; chunk: string; done: boolean }
} as const

export type IpcChannel = typeof IPC[keyof typeof IPC]
