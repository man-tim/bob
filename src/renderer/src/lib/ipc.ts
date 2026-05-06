/**
 * Type-safe IPC wrappers for the renderer.
 * All calls return IpcResult<T> — always check result.ok.
 */
import { IPC } from '@shared/ipc-channels'
import type {
  IpcResult, Company, Contact, Transcript, CalendarEvent,
  Job, JobLog, Schedule, FlyerTemplate, AuthStatus,
  PaginatedResult, CompanyListQuery, ListQuery,
} from '@shared/types'

// Access the contextBridge API injected by the preload script
const electron = window.electron

async function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return electron.invoke<IpcResult<T>>(channel as never, ...args)
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  login:      () => invoke<AuthStatus>(IPC.AUTH_LOGIN),
  logout:     () => invoke<void>(IPC.AUTH_LOGOUT),
  getStatus:  () => invoke<AuthStatus>(IPC.AUTH_STATUS),
  getConfig:  () => invoke<{ clientId: string } | null>(IPC.AUTH_GET_CONFIG),
  saveConfig: (clientId: string) => invoke<void>(IPC.AUTH_SAVE_CONFIG, clientId),
}

// ─── Companies ────────────────────────────────────────────────────────────────

export interface CompanyDetail {
  company:           Company
  contacts:          Contact[]
  transcripts:       Array<Transcript & { action_items: string[] | null }>
  upcomingEvents:    CalendarEvent[]
  callCount:         number
  lastCallAt:        string | null
  avgSentiment:      number | null
  recentActionItems: string[]
  speakers:          string[]
  driveFolder:       { id: string; url: string } | null
}

export const companiesApi = {
  list:    (query?: CompanyListQuery)                          => invoke<PaginatedResult<Company>>(IPC.COMPANIES_LIST, query),
  get:     (id: string)                                        => invoke<Company>(IPC.COMPANIES_GET, id),
  details: (id: string)                                        => invoke<CompanyDetail>(IPC.COMPANIES_DETAILS, id),
  upsert:  (data: Partial<Company> & { name: string })         => invoke<Company>(IPC.COMPANIES_UPSERT, data),
  delete:  (id: string)                                        => invoke<void>(IPC.COMPANIES_DELETE, id),
  import:  ()                                                  => invoke<{ jobId: string }>(IPC.COMPANIES_IMPORT),
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
export const contactsApi = {
  list:   (companyId: string)                          => invoke<Contact[]>(IPC.CONTACTS_LIST, companyId),
  upsert: (data: Partial<Contact> & { company_id: string; name: string }) =>
    invoke<Contact>(IPC.CONTACTS_UPSERT, data),
  delete: (id: string)                                 => invoke<void>(IPC.CONTACTS_DELETE, id),
}

// ─── Transcripts ──────────────────────────────────────────────────────────────
export const transcriptsApi = {
  list:    (query?: ListQuery & { matchStatus?: string; companyId?: string }) =>
    invoke<PaginatedResult<Transcript>>(IPC.TRANSCRIPTS_LIST, query),
  get:     (id: string)                          => invoke<Transcript>(IPC.TRANSCRIPTS_GET, id),
  assign:  (id: string, companyId: string)       => invoke<Transcript>(IPC.TRANSCRIPTS_ASSIGN, id, companyId),
  runAll:  ()                                    => invoke<{ collectJobId: string }>(IPC.TRANSCRIPTS_RUN_ALL),
  collect: ()                                    => invoke<Job>(IPC.TRANSCRIPTS_RUN_COLLECT),
  organize:()                                    => invoke<Job>(IPC.TRANSCRIPTS_RUN_ORGANIZE),
}

// ─── Calendar ─────────────────────────────────────────────────────────────────
export const calendarApi = {
  sync:   ()                             => invoke<{ synced: number }>(IPC.CALENDAR_SYNC),
  events: ()                             => invoke<CalendarEvent[]>(IPC.CALENDAR_EVENTS),
  assign: (id: string, companyId: string)=> invoke<CalendarEvent>(IPC.CALENDAR_ASSIGN, id, companyId),
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────
export const jobsApi = {
  list: (opts?: { status?: string; type?: string }) => invoke<Job[]>(IPC.JOBS_LIST, opts),
  stop: (id: string)                                => invoke<void>(IPC.JOBS_STOP, id),
  logs: (jobId: string)                             => invoke<JobLog[]>(IPC.JOBS_LOGS, jobId),
}

// ─── Schedules ────────────────────────────────────────────────────────────────
export const schedulesApi = {
  list:   ()                    => invoke<Schedule[]>(IPC.SCHEDULES_LIST),
  create: (s: Partial<Schedule>)=> invoke<Schedule>(IPC.SCHEDULES_CREATE, s),
  update: (s: Partial<Schedule> & { id: string }) => invoke<Schedule>(IPC.SCHEDULES_UPDATE, s),
  delete: (id: string)          => invoke<void>(IPC.SCHEDULES_DELETE, id),
}

// ─── Scrub & Split ────────────────────────────────────────────────────────────

export interface ScrubUploadResult {
  scrubJobId: string
  inputPath:  string
  outputDir:  string | undefined
}

export interface ScrubJobRecord {
  id:                  string
  source_filename:     string
  source_path:         string
  row_count_original:  number | null
  row_count_cleaned:   number | null
  status:              string
  output_files:        string | null   // JSON array
  redaction_stats:     string | null   // JSON: {SSN,CC,Routing,Account,TaxID,PW,Keys,total}
  account_name:        string | null   // extracted from filename after scrub completes
  created_at:          string
  updated_at:          string
}

export const scrubApi = {
  /**
   * Opens native file + output-folder dialogs, then enqueues a scrub_process job.
   * Returns null if the user cancelled.
   */
  upload:   ()                                          => invoke<ScrubUploadResult | null>(IPC.SCRUB_UPLOAD),

  /**
   * Enqueue scrubbing for a known file path (headless / programmatic use).
   */
  process:  (inputPath: string, outputDir?: string, chunkSizeBytes?: number) =>
    invoke<{ scrubJobId: string }>(IPC.SCRUB_PROCESS, inputPath, outputDir, chunkSizeBytes),

  /**
   * Fetch all scrub job records (with output file paths).
   */
  listJobs: ()                                          => invoke<ScrubJobRecord[]>(IPC.SCRUB_JOBS),
}

// ─── Flyer ────────────────────────────────────────────────────────────────────

export interface FlyerLocation {
  name:     string
  phone:    string
  message?: string
}

export interface ElementPosition { x: number; y: number; w: number; h: number }
export interface ElementLayout {
  logo:  ElementPosition
  logo2: ElementPosition
  phone: ElementPosition
  qr:    ElementPosition
}

export interface FlyerGenerateInput {
  templateId:     'btm' | 'blue' | 'trucking'
  logoPath:       string | null
  locations:      FlyerLocation[]
  defaultKeyword: string
  outputDir:      string
  companyName?:   string
  layout?:        ElementLayout
}

export interface FlyerGenerateResult {
  files:   string[]
  zipPath: string | null
  errors:  string[]
}

// ─── Quick Links ─────────────────────────────────────────────────────────────

export interface QuickLink {
  url:    string
  label:  string
  sub?:   string
  color:  string
}

export const settingsApi = {
  setSheetUrl: (sheetUrl: string) => invoke<void>(IPC.SETTINGS_SET, { sheetUrl }),
  syncSheet:   ()                 => invoke<{ synced: number }>(IPC.COMPANIES_SYNC_SHEET),
}

export const quickLinksApi = {
  get: ()                       => invoke<QuickLink[]>(IPC.QUICK_LINKS_GET),
  set: (links: QuickLink[])     => invoke<void>(IPC.QUICK_LINKS_SET, links),
}

export const flyerApi = {
  list:       ()                                              => invoke<FlyerTemplate[]>(IPC.FLYER_TEMPLATES_LIST),
  save:       (t: Partial<FlyerTemplate> & { name: string }) => invoke<FlyerTemplate>(IPC.FLYER_TEMPLATES_SAVE, t),
  delete:     (id: string)                                   => invoke<void>(IPC.FLYER_TEMPLATES_DELETE, id),
  generate:   (input: FlyerGenerateInput)                    => invoke<FlyerGenerateResult>(IPC.FLYER_GENERATE, input),
  generateQr: (phone: string, keyword: string)               => invoke<{ dataUrl: string }>(IPC.FLYER_GENERATE_QR, phone, keyword),
  getTemplate: (id: string) => invoke<{ dataUrl: string } | null>(IPC.FLYER_GET_TEMPLATE, id),
}

// ─── Actions Log ──────────────────────────────────────────────────────────────

export interface ActionsLogEntry { msg: string; cls: string; ts: string }

export const actionsLogApi = {
  get:   ()  => invoke<ActionsLogEntry[]>(IPC.GONG_SCRAPER_GET_LOG),
  clear: ()  => invoke<null>(IPC.GONG_SCRAPER_CLEAR_LOG),
}

export const masterRefreshApi = {
  refresh: () => invoke<{ synced: number }>(IPC.COMPANIES_MASTER_REFRESH),
}

// ─── Prompt Library ───────────────────────────────────────────────────────────

export interface SavedPrompt { id: string; title: string; text: string }

export const promptsApi = {
  get: ()                        => invoke<SavedPrompt[]>(IPC.PROMPTS_GET),
  set: (prompts: SavedPrompt[]) => invoke<void>(IPC.PROMPTS_SET, prompts),
}

// ─── Services (HubSpot / Gong) ───────────────────────────────────────────────

export interface ServiceConnectionState {
  connected:   boolean
  connectedAt: number | null
}

export interface ServicesStatus {
  hubspot: ServiceConnectionState
  gong:    ServiceConnectionState
}

export const servicesApi = {
  getStatus:      () => invoke<ServicesStatus>(IPC.SERVICES_STATUS),
  connectHubSpot: () => invoke<ServicesStatus>(IPC.SERVICES_CONNECT_HUBSPOT),
  connectGong:    () => invoke<ServicesStatus>(IPC.SERVICES_CONNECT_GONG),
}

export const scrubResetApi      = { reset:   () => invoke<null>(IPC.SCRUB_RESET) }
export const companiesResetApi  = { reset:   () => invoke<null>(IPC.COMPANIES_RESET) }
export const calendarRematchApi = { rematch: () => invoke<{ matched: number }>(IPC.CALENDAR_REMATCH) }
export const appMasterResetApi  = { reset:   () => invoke<null>(IPC.APP_MASTER_RESET) }

// ─── Analysis (Risk & Expansion) ─────────────────────────────────────────────

export const analysisApi = {
  run:            (csvPath: string)      => invoke<unknown>(IPC.ANALYSIS_RUN, csvPath),
  getLatest:      ()                     => invoke<unknown>(IPC.ANALYSIS_GET),
  getForCompany:  (companyId: string)    => invoke<unknown>(IPC.ANALYSIS_GET_FOR_COMPANY, companyId),
}

export interface CompanyNote { id: string; company_id: string; content: string; created_at: string }
export const companyNotesApi = {
  list:   (companyId: string)                  => invoke<CompanyNote[]>(IPC.COMPANY_NOTES_LIST, companyId),
  add:    (companyId: string, content: string) => invoke<CompanyNote>(IPC.COMPANY_NOTES_ADD, companyId, content),
  delete: (noteId: string)                     => invoke<null>(IPC.COMPANY_NOTES_DELETE, noteId),
}

// ─── Gong / Book of Business ──────────────────────────────────────────────────

// Mirror of GongService types (kept lean — only what the renderer needs)
export interface DriveFolder {
  id:  string
  url: string
}

export interface CompanyDataSummary {
  company:           { id: string; name: string; tier: string; arr: number | null; health_score: number | null }
  callCount:         number
  lastCallAt:        string | null
  avgSentiment:      number | null
  speakers:          string[]
  recentActionItems: string[]
  driveFolder:       DriveFolder | null
}

export interface BookOfBusinessEntry extends CompanyDataSummary {
  contacts:        Array<{ name: string; email: string | null; title: string | null; role: string }>
  engagementScore: number
}

export interface BookOfBusiness {
  generatedAt:    string
  totalCompanies: number
  totalCalls:     number
  entries:        BookOfBusinessEntry[]
}

export const gongApi = {
  processCompany:    (companyId: string)  => invoke<CompanyDataSummary>(IPC.GONG_PROCESS_COMPANY, companyId),
  bookOfBusiness:    ()                   => invoke<BookOfBusiness>(IPC.GONG_BOOK_OF_BUSINESS),
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface GlobalSearchResult {
  type:      'company' | 'transcript' | 'knowledge'
  id:        string
  title:     string
  subtitle?: string
  snippet?:  string
  score:     number
  url?:      string
  companyId?: string
}

export const searchApi = {
  query:   (query: string, source?: 'internal' | 'customer' | 'all') =>
    invoke<Array<{ item: { id: string; title: string; url: string; content: string; section: string | null }; score: number; highlights: { title: string; snippet: string } }>>(IPC.SEARCH_QUERY, query, source ?? 'all'),
  global:  (query: string, limit?: number) =>
    invoke<GlobalSearchResult[]>(IPC.SEARCH_GLOBAL, query, limit),
  rebuild: () => invoke<void>(IPC.SEARCH_REBUILD_INDEX),
}

// ─── File System ─────────────────────────────────────────────────────────────

export interface OpenDialogOptions {
  title?:      string
  defaultPath?: string
  filters?:    Array<{ name: string; extensions: string[] }>
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory'>
}

export interface OpenDialogResult {
  canceled:  boolean
  filePaths: string[]
}

export const fsApi = {
  /** Show a native open-file or open-folder dialog */
  openDialog:   (opts: OpenDialogOptions) =>
    invoke<OpenDialogResult>(IPC.FS_OPEN_DIALOG, opts),
  /** Show a native save dialog */
  saveDialog:   (opts: Omit<OpenDialogOptions, 'properties'>) =>
    invoke<{ canceled: boolean; filePath?: string }>(IPC.FS_SAVE_DIALOG, opts),
  /** Open a file path or URL in the default system handler (Finder / browser) */
  openExternal: (path: string) =>
    invoke<void>(IPC.FS_OPEN_EXTERNAL, path),
}

// ─── Push subscriptions ───────────────────────────────────────────────────────
export const push = {
  onJobLog:        (cb: (payload: { jobId: string; log: JobLog }) => void) =>
    electron.on(IPC.PUSH_JOB_LOG as never, cb as never),
  onJobStatus:     (cb: (payload: { jobId: string; status: string }) => void) =>
    electron.on(IPC.PUSH_JOB_STATUS as never, cb as never),
  onJobProgress:   (cb: (payload: { jobId: string; step: number; total: number; label: string }) => void) =>
    electron.on(IPC.PUSH_JOB_PROGRESS as never, cb as never),
  onAuthChanged:   (cb: (status: AuthStatus) => void) =>
    electron.on(IPC.PUSH_AUTH_CHANGED as never, cb as never),
  onNotify:        (cb: (payload: { title: string; body: string; level: string }) => void) =>
    electron.on(IPC.PUSH_NOTIFY as never, cb as never),
  onFlyerProgress: (cb: (payload: { done: number; total: number; filename: string }) => void) =>
    electron.on(IPC.PUSH_FLYER_PROGRESS as never, cb as never),
  onGongLog:    (cb: (log: { msg: string; cls: string; ts: string }) => void) =>
    electron.on(IPC.PUSH_GONG_LOG    as never, cb as never),
  onGongStatus: (cb: (status: { status: string; extracted?: number; unfiledCount?: number; sheetId?: string; sheetUrl?: string }) => void) =>
    electron.on(IPC.PUSH_GONG_STATUS as never, cb as never),
  onGongMove:   (cb: () => void) =>
    electron.on(IPC.PUSH_GONG_MOVE   as never, cb as never),
  onLoginNeeded: (cb: (payload: { service: 'hubspot' | 'gong' }) => void) =>
    electron.on(IPC.PUSH_LOGIN_NEEDED as never, cb as never),
  onLoginDone:   (cb: (payload: { service: 'hubspot' | 'gong' }) => void) =>
    electron.on(IPC.PUSH_LOGIN_DONE   as never, cb as never),
  onServicesStatus: (cb: (status: ServicesStatus) => void) =>
    electron.on(IPC.PUSH_SERVICES_STATUS as never, cb as never),
  onAppReset: (cb: () => void) =>
    electron.on(IPC.PUSH_APP_RESET as never, cb as never),
  onAnalysisDone: (cb: (result: unknown) => void) =>
    electron.on(IPC.PUSH_ANALYSIS_DONE as never, cb as never),
  onNavigate: (cb: (payload: { path: string }) => void) =>
    electron.on(IPC.PUSH_NAVIGATE as never, cb as never),
  onUpdateStatus: (cb: (payload: { status: string; message?: string }) => void) =>
    electron.on(IPC.PUSH_UPDATE_STATUS as never, cb as never),
}

// ─── App Updates ─────────────────────────────────────────────────────────────
export const appApi = {
  checkForUpdates: () => invoke<{ status: string; message?: string }>(IPC.APP_CHECK_UPDATES),
}

// ─── Follow Ups ───────────────────────────────────────────────────────────────

export interface FollowUp {
  id: string
  company_id: string | null
  company_name: string
  description: string
  source: 'manual' | 'transcript'
  source_url: string | null
  due_date: string | null
  calendar_event_id: string | null
  google_task_id: string | null
  google_calendar_event_id: string | null
  notified_at: string | null
  status: 'open' | 'done' | 'dismissed'
  created_at: string
  updated_at: string
}

export interface CreateFollowUpInput {
  company_id?: string | null
  company_name: string
  description: string
  source?: 'manual' | 'transcript'
  source_url?: string | null
  due_date?: string | null
  calendar_event_id?: string | null
}

export const followUpsApi = {
  list:             (companyId?: string | null) => invoke<FollowUp[]>(IPC.FOLLOW_UPS_LIST, companyId),
  create:           (data: CreateFollowUpInput) => invoke<FollowUp>(IPC.FOLLOW_UPS_CREATE, data),
  update:           (id: string, patch: { description?: string; status?: 'open' | 'done' | 'dismissed'; due_date?: string | null }) =>
    invoke<FollowUp>(IPC.FOLLOW_UPS_UPDATE, id, patch),
  delete:           (id: string)                => invoke<null>(IPC.FOLLOW_UPS_DELETE, id),
  parseTranscripts: ()                          => invoke<{ created: number }>(IPC.FOLLOW_UPS_PARSE_TRANSCRIPTS),
}

// ─── Gong Scraper ─────────────────────────────────────────────────────────────
export const gongScraperApi = {
  runAll:       () => invoke<null>(IPC.GONG_SCRAPER_RUN_ALL),
  step1:        () => invoke<null>(IPC.GONG_SCRAPER_STEP1),
  step2:        () => invoke<null>(IPC.GONG_SCRAPER_STEP2),
  step3:        () => invoke<null>(IPC.GONG_SCRAPER_STEP3),
  stop:         () => invoke<null>(IPC.GONG_SCRAPER_STOP),
  reset:        () => invoke<null>(IPC.GONG_SCRAPER_RESET),
  getState:     () => invoke<{ sheetId?: string; sheetUrl?: string; mainFolderUrl?: string; schedule?: { active: boolean; mode: 'daily' | 'weekly' | 'custom'; days: number[]; hour: number; nextRun: number }; unfiled?: Array<{ id: string; name: string }>; recentTranscripts?: Array<{ title: string; driveFileId: string; driveUrl: string; callDate: string; companyName: string; callUrl?: string }> }>(IPC.GONG_SCRAPER_STATE),
  setSchedule:  (mode: 'daily' | 'weekly' | 'custom', days: number[], hour: number) => invoke<null>(IPC.GONG_SCRAPER_SET_SCHEDULE, mode, days, hour),
  clearSchedule:() => invoke<null>(IPC.GONG_SCRAPER_CLR_SCHEDULE),
  moveFile:     (fileId: string, companyName: string) => invoke<null>(IPC.GONG_SCRAPER_MOVE_FILE, fileId, companyName),
  focusLoginWin: () => invoke<null>(IPC.GONG_SCRAPER_FOCUS_LOGIN),
  clearTranscripts: () => invoke<null>(IPC.GONG_SCRAPER_CLEAR_TRANSCRIPTS),
  fetchRecent:      () => invoke<Array<{ title: string; driveFileId: string; driveUrl: string; callDate: string; companyName: string; callUrl?: string }>>(IPC.GONG_SCRAPER_FETCH_RECENT),
  readFile:         (fileId: string) => invoke<{ text: string }>(IPC.GONG_SCRAPER_READ_FILE, fileId),
}

// ─── Notification Settings ─────────────────────────────────────────────────────
export interface NotificationSettings {
  enabled:    boolean
  windowsMin: number[]
}

export const notificationsApi = {
  getSettings: ()                               => invoke<NotificationSettings>(IPC.NOTIFICATIONS_GET_SETTINGS),
  setSettings: (s: Partial<NotificationSettings>) => invoke<null>(IPC.NOTIFICATIONS_SET_SETTINGS, s),
}

// ─── Analysis Popout ──────────────────────────────────────────────────────────
export const analysisPopoutApi = {
  open: (type: 'risk' | 'expansion') => invoke<null>(IPC.ANALYSIS_OPEN_POPOUT, type),
}

// ─── Feedback Logger ──────────────────────────────────────────────────────────
export const feedbackApi = {
  log: (entry: {
    tag: string; id: string; className: string; innerText: string
    selectorPath: string; attributes: string; siblingContext: string; route: string
    note: string; timestamp: string
  }) => invoke<{ path: string }>(IPC.FEEDBACK_LOG, entry),
}

// ─── Local AI ─────────────────────────────────────────────────────────────────

export interface AIStatus {
  downloaded:    boolean
  loadState:     'idle' | 'loading' | 'ready' | 'error'
  loadError:     string | null
  downloadState: 'idle' | 'downloading' | 'done' | 'error' | 'cancelled'
  downloadPct:   number
  mbDownloaded:  number
  mbTotal:       number
}

export const localAiApi = {
  getStatus:      () => invoke<AIStatus>(IPC.AI_STATUS),
  load:           () => invoke<null>(IPC.AI_LOAD),
  startDownload:  () => invoke<null>(IPC.AI_DOWNLOAD),
  cancelDownload: () => invoke<null>(IPC.AI_CANCEL_DOWNLOAD),
  deleteModel:    () => invoke<null>(IPC.AI_DELETE_MODEL),
  complete: (opts: { requestId: string; prompt: string; systemPrompt?: string; maxTokens?: number }) =>
    invoke<{ text: string }>(IPC.AI_COMPLETE, opts),
}

// push subscriptions for AI
Object.assign(push, {
  onAiProgress: (cb: (p: { pct: number; mbDownloaded: number; mbTotal: number }) => void) =>
    electron.on(IPC.PUSH_AI_PROGRESS as never, cb as never),
  onAiChunk: (cb: (p: { requestId: string; chunk: string; done: boolean }) => void) =>
    electron.on(IPC.PUSH_AI_CHUNK as never, cb as never),
})
