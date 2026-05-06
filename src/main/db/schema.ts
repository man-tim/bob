/**
 * SQLite schema DDL.
 * Applied once at startup via database.ts — each statement is idempotent.
 */
export const SCHEMA_SQL = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ─── Companies ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS companies (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  hubspot_id           TEXT UNIQUE,
  drive_folder_id      TEXT,
  tier                 TEXT NOT NULL DEFAULT 'smb'
                         CHECK(tier IN ('enterprise','mid_market','smb','trial','churned')),
  health_score         REAL,
  arr                  REAL,
  industry             TEXT,
  csm_owner            TEXT,
  phone                TEXT,
  city                 TEXT,
  country              TEXT,
  last_contacted       TEXT,
  renewal_date         TEXT,
  last_activity_date   TEXT,
  subscribed_locations TEXT,
  potential_locations  TEXT,
  subscription_state   TEXT,
  website              TEXT,
  notes                TEXT,
  hubspot_url          TEXT,
  hubspot_synced_at    TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_companies_name       ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_hubspot_id ON companies(hubspot_id);
CREATE INDEX IF NOT EXISTS idx_companies_tier       ON companies(tier);
CREATE INDEX IF NOT EXISTS idx_companies_csm_owner  ON companies(csm_owner);

-- ─── Contacts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contacts (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  email                TEXT,
  phone                TEXT,
  title                TEXT,
  role                 TEXT NOT NULL DEFAULT 'unknown'
                         CHECK(role IN ('champion','economic_buyer','user','blocker','unknown')),
  is_primary           INTEGER NOT NULL DEFAULT 0,
  hubspot_contact_id   TEXT UNIQUE,
  notes                TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email      ON contacts(email);

-- ─── Transcripts ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transcripts (
  id               TEXT PRIMARY KEY,
  company_id       TEXT REFERENCES companies(id) ON DELETE SET NULL,
  gong_call_url    TEXT NOT NULL UNIQUE,
  call_title       TEXT,
  called_at        TEXT NOT NULL,
  duration_seconds INTEGER,
  drive_file_id    TEXT,
  drive_folder_id  TEXT,
  match_status     TEXT NOT NULL DEFAULT 'unmatched'
                     CHECK(match_status IN ('matched','unmatched','archived')),
  summary          TEXT,
  action_items     TEXT,        -- JSON array of strings
  sentiment_score  REAL,
  processed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transcripts_company_id   ON transcripts(company_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_called_at    ON transcripts(called_at);
CREATE INDEX IF NOT EXISTS idx_transcripts_match_status ON transcripts(match_status);

-- ─── Speaker Turns ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS speaker_turns (
  id                 TEXT PRIMARY KEY,
  transcript_id      TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  speaker_name       TEXT NOT NULL,
  timestamp_seconds  REAL NOT NULL,
  text               TEXT NOT NULL,
  sequence           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_speaker_turns_transcript_id ON speaker_turns(transcript_id);

-- ─── Calendar Events ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_events (
  id               TEXT PRIMARY KEY,
  google_event_id  TEXT NOT NULL UNIQUE,
  calendar_id      TEXT NOT NULL,
  title            TEXT NOT NULL,
  start_at         TEXT NOT NULL,
  end_at           TEXT NOT NULL,
  company_id       TEXT REFERENCES companies(id) ON DELETE SET NULL,
  match_confidence REAL,
  attendees        TEXT,        -- JSON array
  description      TEXT,
  meet_link        TEXT,
  synced_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_company_id ON calendar_events(company_id);
CREATE INDEX IF NOT EXISTS idx_events_start_at   ON calendar_events(start_at);

-- ─── Jobs ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','running','paused','completed','failed','cancelled')),
  triggered_by      TEXT NOT NULL DEFAULT 'user'
                      CHECK(triggered_by IN ('user','scheduler','dependency')),
  parent_job_id     TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  payload           TEXT,        -- JSON
  result_summary    TEXT,        -- JSON
  error             TEXT,
  retries_remaining INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_type       ON jobs(type);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);

-- ─── Job Logs ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_logs (
  id        TEXT PRIMARY KEY,
  job_id    TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  level     TEXT NOT NULL DEFAULT 'info'
              CHECK(level IN ('info','ok','warn','error','step','data')),
  message   TEXT NOT NULL,
  metadata  TEXT,          -- JSON
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_logs_job_id    ON job_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_timestamp ON job_logs(timestamp DESC);

-- ─── Schedules ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schedules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  job_type        TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  job_payload     TEXT,          -- JSON
  is_active       INTEGER NOT NULL DEFAULT 1,
  last_run_at     TEXT,
  next_run_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Processed URLs ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS processed_urls (
  url          TEXT PRIMARY KEY,
  job_id       TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Scrub Jobs ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scrub_jobs (
  id                  TEXT PRIMARY KEY,
  source_filename     TEXT NOT NULL,
  source_path         TEXT NOT NULL,
  account_name        TEXT,      -- extracted company name
  row_count_original  INTEGER,
  row_count_cleaned   INTEGER,
  column_mapping      TEXT,      -- JSON
  split_config        TEXT,      -- JSON
  status              TEXT NOT NULL DEFAULT 'uploaded'
                        CHECK(status IN ('uploaded','mapped','cleaned','split','exported')),
  output_files        TEXT,      -- JSON array
  redaction_stats     TEXT,      -- JSON: {SSN,CC,Routing,Account,TaxID,PW,Keys,total}
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Company Notes ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS company_notes (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_company_notes_company_id ON company_notes(company_id);

-- ─── Flyer Templates ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS flyer_templates (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  page_size      TEXT NOT NULL DEFAULT 'letter'
                   CHECK(page_size IN ('letter','a4','custom')),
  page_width_px  INTEGER NOT NULL DEFAULT 816,
  page_height_px INTEGER NOT NULL DEFAULT 1056,
  elements       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  data_bindings  TEXT NOT NULL DEFAULT '{}',   -- JSON
  thumbnail_path TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Company Analyses ────────────────────────────────────────────────────────
-- Stores the most recent Risk/Expansion analysis result for each account.
-- account_name-keyed so it works even without a company_id match.

CREATE TABLE IF NOT EXISTS company_analyses (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES companies(id) ON DELETE SET NULL,
  account_name  TEXT NOT NULL,
  analyzed_at   TEXT NOT NULL,
  risk_data     TEXT NOT NULL,       -- JSON: RiskAnalysis
  expansion_data TEXT NOT NULL,      -- JSON: ExpansionAnalysis
  raw_stats     TEXT NOT NULL,       -- JSON: full AnalysisResult summary
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_analyses_account ON company_analyses(account_name);
CREATE INDEX IF NOT EXISTS idx_company_analyses_company_id ON company_analyses(company_id);

-- ─── Follow Ups ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS follow_ups (
  id               TEXT PRIMARY KEY,
  company_id       TEXT REFERENCES companies(id) ON DELETE SET NULL,
  company_name     TEXT NOT NULL,
  description      TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'manual'
                     CHECK(source IN ('manual','transcript')),
  source_url       TEXT,
  due_date         TEXT,
  calendar_event_id TEXT,
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK(status IN ('open','done','dismissed')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_company_id ON follow_ups(company_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_status     ON follow_ups(status);
CREATE INDEX IF NOT EXISTS idx_follow_ups_due_date   ON follow_ups(due_date);

-- ─── Knowledge Pages ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS knowledge_pages (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL CHECK(source IN ('internal','customer')),
  title        TEXT NOT NULL,
  url          TEXT NOT NULL UNIQUE,
  content      TEXT NOT NULL,
  section      TEXT,
  last_updated TEXT NOT NULL,
  indexed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_pages_source ON knowledge_pages(source);
`
