import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { SCHEMA_SQL } from './schema'
import { DB_FILENAME } from '@shared/constants'

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  const userDataPath = app.getPath('userData')
  if (!existsSync(userDataPath)) {
    mkdirSync(userDataPath, { recursive: true })
  }

  const dbPath = join(userDataPath, DB_FILENAME)
  _db = new Database(dbPath)

  // Apply all PRAGMA settings and CREATE TABLE statements
  _db.exec(SCHEMA_SQL)

  // Additive migrations — safe to run on existing DBs
  _migrateCompanies(_db)
  _migrateScrubJobs(_db)
  _migrateFollowUps(_db)
  _migrateNotificationSettings(_db)

  console.log(`[DB] Opened: ${dbPath}`)
  return _db
}

function _migrateCompanies(db: Database.Database): void {
  const existing = (db.pragma('table_info(companies)') as Array<{ name: string }>).map(r => r.name)
  const toAdd: [string, string][] = [
    ['phone',                'TEXT'],
    ['city',                 'TEXT'],
    ['country',              'TEXT'],
    ['last_contacted',       'TEXT'],
    ['renewal_date',         'TEXT'],
    ['last_activity_date',   'TEXT'],
    ['subscribed_locations', 'TEXT'],
    ['potential_locations',  'TEXT'],
    ['subscription_state',   'TEXT'],
    ['hubspot_url',          'TEXT'],
  ]
  for (const [col, type] of toAdd) {
    if (!existing.includes(col)) {
      db.exec(`ALTER TABLE companies ADD COLUMN ${col} ${type}`)
    }
  }
}

function _migrateScrubJobs(db: Database.Database): void {
  const existing = (db.pragma('table_info(scrub_jobs)') as Array<{ name: string }>).map(r => r.name)
  if (!existing.includes('redaction_stats')) {
    db.exec('ALTER TABLE scrub_jobs ADD COLUMN redaction_stats TEXT')
  }
  if (!existing.includes('account_name')) {
    db.exec('ALTER TABLE scrub_jobs ADD COLUMN account_name TEXT')
  }
}

function _migrateFollowUps(db: Database.Database): void {
  const existing = (db.pragma('table_info(follow_ups)') as Array<{ name: string }>).map(r => r.name)
  if (!existing.includes('google_task_id')) {
    db.exec('ALTER TABLE follow_ups ADD COLUMN google_task_id TEXT')
  }
  if (!existing.includes('google_calendar_event_id')) {
    db.exec('ALTER TABLE follow_ups ADD COLUMN google_calendar_event_id TEXT')
  }
  if (!existing.includes('notified_at')) {
    db.exec('ALTER TABLE follow_ups ADD COLUMN notified_at TEXT')
  }
}

function _migrateNotificationSettings(db: Database.Database): void {
  // Key-value store for app settings (notifications, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
    console.log('[DB] Closed')
  }
}

/**
 * Run a function inside an explicit transaction.
 * Returns the function's return value, or throws on error (auto-rollback).
 */
export function withTransaction<T>(fn: (db: Database.Database) => T): T {
  const db = getDb()
  const txn = db.transaction(fn)
  return txn(db)
}
