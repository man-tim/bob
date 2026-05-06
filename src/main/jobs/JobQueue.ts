import { ulid } from 'ulid'
import { getDb } from '../db/database'
import { getMainWindow } from '../index'
import { IPC } from '@shared/ipc-channels'
import { JOB_RETRY_LIMITS } from '@shared/constants'
import type { Job, JobLog, JobStatus, JobTrigger, JobType, LogLevel } from '@shared/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JobLogEntry {
  jobId: string
  log: JobLog
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function row2job(row: Record<string, unknown>): Job {
  return {
    ...row,
    payload:        row['payload']        ? JSON.parse(row['payload'] as string) : null,
    result_summary: row['result_summary'] ? JSON.parse(row['result_summary'] as string) : null,
  } as Job
}

// ─── JobQueue ─────────────────────────────────────────────────────────────────

export const JobQueue = {
  enqueue(
    type: JobType,
    payload: Record<string, unknown>,
    triggeredBy: JobTrigger = 'user',
    parentJobId?: string
  ): Job {
    const db = getDb()
    const id = ulid()
    const retries = JOB_RETRY_LIMITS[type] ?? 0

    db.prepare(`
      INSERT INTO jobs (id, type, status, triggered_by, parent_job_id, payload, retries_remaining)
      VALUES (?, ?, 'pending', ?, ?, ?, ?)
    `).run(id, type, triggeredBy, parentJobId ?? null, JSON.stringify(payload), retries)

    const job = this.get(id)!
    this._pushStatus(job)

    // Import lazily to avoid circular dependency
    import('../jobs/JobRunner').then(({ JobRunner }) => JobRunner.tick())

    return job
  },

  get(id: string): Job | null {
    const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? row2job(row) : null
  },

  list(opts?: { status?: JobStatus; type?: JobType; limit?: number }): Job[] {
    let sql = 'SELECT * FROM jobs WHERE 1=1'
    const params: unknown[] = []
    if (opts?.status) { sql += ' AND status = ?'; params.push(opts.status) }
    if (opts?.type)   { sql += ' AND type = ?';   params.push(opts.type) }
    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(opts?.limit ?? 100)
    const rows = getDb().prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map(row2job)
  },

  cancel(id: string): void {
    getDb().prepare(`
      UPDATE jobs SET status = 'cancelled', completed_at = datetime('now')
      WHERE id = ? AND status IN ('pending','running','paused')
    `).run(id)
    const job = this.get(id)
    if (job) this._pushStatus(job)
  },

  // ── Log helpers (called by JobRunner/services) ─────────────────────────────

  log(jobId: string, level: LogLevel, message: string, metadata?: Record<string, unknown>): JobLog {
    const entry: JobLog = {
      id:        ulid(),
      job_id:    jobId,
      level,
      message,
      metadata:  metadata ?? null,
      timestamp: new Date().toISOString(),
    }
    getDb().prepare(`
      INSERT INTO job_logs (id, job_id, level, message, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entry.id, entry.job_id, entry.level, entry.message,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.timestamp
    )
    // Push to renderer
    getMainWindow()?.webContents.send(IPC.PUSH_JOB_LOG, { jobId, log: entry } satisfies JobLogEntry)
    return entry
  },

  getLogs(jobId: string, limit = 500): JobLog[] {
    const rows = getDb()
      .prepare('SELECT * FROM job_logs WHERE job_id = ? ORDER BY timestamp ASC LIMIT ?')
      .all(jobId, limit) as Record<string, unknown>[]
    return rows.map(r => ({
      ...r,
      metadata: r['metadata'] ? JSON.parse(r['metadata'] as string) : null,
    })) as JobLog[]
  },

  // ── Status mutation helpers ────────────────────────────────────────────────

  markRunning(id: string): void {
    getDb().prepare(`
      UPDATE jobs SET status = 'running', started_at = datetime('now') WHERE id = ?
    `).run(id)
    this._pushStatus(this.get(id)!)
  },

  markCompleted(id: string, summary?: Record<string, unknown>): void {
    getDb().prepare(`
      UPDATE jobs SET status = 'completed', completed_at = datetime('now'), result_summary = ?
      WHERE id = ?
    `).run(summary ? JSON.stringify(summary) : null, id)
    this._pushStatus(this.get(id)!)
  },

  markFailed(id: string, error: string): Job {
    const job = this.get(id)!
    if (job.retries_remaining > 0) {
      getDb().prepare(`
        UPDATE jobs SET status = 'pending', retries_remaining = retries_remaining - 1, error = ?
        WHERE id = ?
      `).run(error, id)
    } else {
      getDb().prepare(`
        UPDATE jobs SET status = 'failed', completed_at = datetime('now'), error = ?
        WHERE id = ?
      `).run(error, id)
    }
    const updated = this.get(id)!
    this._pushStatus(updated)
    return updated
  },

  pushProgress(jobId: string, step: number, total: number, label: string): void {
    getMainWindow()?.webContents.send(IPC.PUSH_JOB_PROGRESS, { jobId, step, total, label })
  },

  _pushStatus(job: Job): void {
    getMainWindow()?.webContents.send(IPC.PUSH_JOB_STATUS, { jobId: job.id, status: job.status })
  },
}
