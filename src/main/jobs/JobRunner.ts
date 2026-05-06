import { getDb } from '../db/database'
import { JobQueue } from './JobQueue'
import { JOB_CONCURRENCY_LIMIT, JOB_CONCURRENCY_BY_TYPE } from '@shared/constants'
import type { Job, JobType } from '@shared/types'

// ─── Handler registry ─────────────────────────────────────────────────────────
// Services register themselves here at startup to avoid circular imports.

type JobHandler = (job: Job) => Promise<void>
const _handlers = new Map<JobType, JobHandler>()

export function registerJobHandler(type: JobType, handler: JobHandler): void {
  _handlers.set(type, handler)
}

// ─── Runner state ─────────────────────────────────────────────────────────────
let _tickTimer: ReturnType<typeof setTimeout> | null = null
let _running = false

// ─── JobRunner ────────────────────────────────────────────────────────────────
export const JobRunner = {
  async tick(): Promise<void> {
    if (_running) return
    _running = true

    try {
      const db = getDb()

      // Count currently running jobs
      const runningCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM jobs WHERE status = 'running'"
      ).get() as { cnt: number }).cnt

      if (runningCount >= JOB_CONCURRENCY_LIMIT) return

      // Find the next pending job, respecting per-type concurrency
      const pendingJobs = db.prepare(
        "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20"
      ).all() as Record<string, unknown>[]

      for (const rawJob of pendingJobs) {
        const jobType = rawJob['type'] as JobType
        const limit   = JOB_CONCURRENCY_BY_TYPE[jobType] ?? 1

        const typeRunning = (db.prepare(
          "SELECT COUNT(*) as cnt FROM jobs WHERE status = 'running' AND type = ?"
        ).get(jobType) as { cnt: number }).cnt

        if (typeRunning >= limit) continue

        const job = JobQueue.get(rawJob['id'] as string)!
        await this._execute(job)
        break   // pick one at a time, reschedule for the rest
      }
    } finally {
      _running = false
    }

    // Schedule next check if there are still pending jobs
    const remaining = (getDb().prepare(
      "SELECT COUNT(*) as cnt FROM jobs WHERE status = 'pending'"
    ).get() as { cnt: number }).cnt

    if (remaining > 0) {
      if (_tickTimer) clearTimeout(_tickTimer)
      _tickTimer = setTimeout(() => JobRunner.tick(), 500)
    }
  },

  async _execute(job: Job): Promise<void> {
    const handler = _handlers.get(job.type)
    if (!handler) {
      JobQueue.markFailed(job.id, `No handler registered for job type: ${job.type}`)
      return
    }

    JobQueue.markRunning(job.id)
    JobQueue.log(job.id, 'step', `Starting job: ${job.type}`)

    try {
      await handler(job)
      JobQueue.markCompleted(job.id)
      JobQueue.log(job.id, 'ok', `Job completed: ${job.type}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const updated = JobQueue.markFailed(job.id, message)
      JobQueue.log(job.id, 'error', `Job failed: ${message}`)

      if (updated.status === 'pending') {
        JobQueue.log(job.id, 'warn', `Retrying (${updated.retries_remaining} remaining)`)
        setTimeout(() => JobRunner.tick(), 2000)
      }
    }
  },
}
