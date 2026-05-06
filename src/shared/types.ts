// ─── Core Entities ────────────────────────────────────────────────────────────

export type CompanyTier = 'enterprise' | 'mid_market' | 'smb' | 'trial' | 'churned'

export interface Company {
  id: string
  name: string
  hubspot_id: string | null
  drive_folder_id: string | null
  tier: CompanyTier
  health_score: number | null  // 0–100
  arr: number | null
  industry: string | null
  csm_owner: string | null
  phone: string | null
  city: string | null
  country: string | null
  last_contacted: string | null
  renewal_date: string | null
  last_activity_date: string | null
  subscribed_locations: string | null
  potential_locations: string | null
  subscription_state: string | null
  website: string | null
  notes: string | null
  hubspot_url: string | null
  hubspot_synced_at: string | null
  created_at: string
  updated_at: string
}

export type ContactRole = 'champion' | 'economic_buyer' | 'user' | 'blocker' | 'unknown'

export interface Contact {
  id: string
  company_id: string
  name: string
  email: string | null
  phone: string | null
  title: string | null
  role: ContactRole
  is_primary: boolean
  hubspot_contact_id: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export type TranscriptMatchStatus = 'matched' | 'unmatched' | 'archived'

export interface SpeakerTurn {
  id: string
  transcript_id: string
  speaker_name: string
  timestamp_seconds: number
  text: string
  sequence: number
}

export interface Transcript {
  id: string
  company_id: string | null
  gong_call_url: string
  call_title: string | null
  called_at: string
  duration_seconds: number | null
  drive_file_id: string | null
  drive_folder_id: string | null
  match_status: TranscriptMatchStatus
  summary: string | null
  action_items: string[] | null
  sentiment_score: number | null  // -1.0 to 1.0
  processed_at: string
  created_at: string
  updated_at: string
  // Joined fields
  speaker_turns?: SpeakerTurn[]
  company?: Pick<Company, 'id' | 'name' | 'tier'>
}

export interface CalendarAttendee {
  email: string
  name: string | null
  response: 'accepted' | 'declined' | 'tentative' | 'needsAction'
}

export interface CalendarEvent {
  id: string
  google_event_id: string
  calendar_id: string
  title: string
  start_at: string
  end_at: string
  company_id: string | null
  match_confidence: number | null
  attendees: CalendarAttendee[]
  description: string | null
  meet_link: string | null
  synced_at: string
  created_at: string
  // Joined fields
  company?: Pick<Company, 'id' | 'name' | 'tier' | 'health_score'>
}

// ─── Jobs & Queue ─────────────────────────────────────────────────────────────

export type JobType =
  | 'hubspot_import'
  | 'gong_collect'
  | 'gong_extract'
  | 'drive_organize'
  | 'calendar_sync'
  | 'index_rebuild'
  | 'scrub_process'

export type JobStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type JobTrigger = 'user' | 'scheduler' | 'dependency'
export type LogLevel = 'info' | 'ok' | 'warn' | 'error' | 'step' | 'data'

export interface Job {
  id: string
  type: JobType
  status: JobStatus
  triggered_by: JobTrigger
  parent_job_id: string | null
  payload: Record<string, unknown> | null
  result_summary: Record<string, unknown> | null
  error: string | null
  retries_remaining: number
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export interface JobLog {
  id: string
  job_id: string
  level: LogLevel
  message: string
  metadata: Record<string, unknown> | null
  timestamp: string
}

export interface Schedule {
  id: string
  name: string
  job_type: JobType
  cron_expression: string
  job_payload: Record<string, unknown> | null
  is_active: boolean
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  updated_at: string
}

// ─── Data Processing ──────────────────────────────────────────────────────────

export type ScrubJobStatus = 'uploaded' | 'mapped' | 'cleaned' | 'split' | 'exported'

export interface ScrubJob {
  id: string
  source_filename: string
  source_path: string
  row_count_original: number | null
  row_count_cleaned: number | null
  column_mapping: Record<string, string> | null
  split_config: {
    split_by_column: string | null
    output_format: 'csv' | 'xlsx'
    output_dir: string
  } | null
  status: ScrubJobStatus
  output_files: string[]
  created_at: string
  updated_at: string
}

// ─── Content ──────────────────────────────────────────────────────────────────

export type PageSize = 'letter' | 'a4' | 'custom'

export interface FlyerElement {
  id: string
  type: 'text' | 'image' | 'shape' | 'qr_code'
  x: number
  y: number
  width: number
  height: number
  z_index: number
  props: Record<string, unknown>
}

export interface FlyerTemplate {
  id: string
  name: string
  page_size: PageSize
  page_width_px: number
  page_height_px: number
  elements: FlyerElement[]
  data_bindings: Record<string, string>
  thumbnail_path: string | null
  created_at: string
  updated_at: string
}

export interface KnowledgePage {
  id: string
  source: 'internal' | 'customer'
  title: string
  url: string
  content: string
  section: string | null
  last_updated: string
  indexed_at: string
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthStatus {
  isAuthenticated: boolean
  email: string | null
  scopes: string[]
  expiresAt: number | null
}

// ─── IPC Response Wrappers ────────────────────────────────────────────────────

export interface IpcSuccess<T> {
  ok: true
  data: T
}

export interface IpcError {
  ok: false
  error: string
}

export type IpcResult<T> = IpcSuccess<T> | IpcError

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ListQuery {
  search?: string
  page?: number
  pageSize?: number
  sortBy?: string
  sortDir?: 'asc' | 'desc'
}

export interface CompanyListQuery extends ListQuery {
  tier?: CompanyTier
  csmOwner?: string
  minHealthScore?: number
  maxHealthScore?: number
}
