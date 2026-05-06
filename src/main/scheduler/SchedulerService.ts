import cron from 'node-cron'
import { getDb } from '../db/database'
import { JobQueue } from '../jobs/JobQueue'
import type { Schedule, JobType } from '@shared/types'

type CronTask = ReturnType<typeof cron.schedule>

const _tasks = new Map<string, CronTask>()

function rowToSchedule(row: Record<string, unknown>): Schedule {
  return {
    ...row,
    is_active:   Boolean(row['is_active']),
    job_payload: row['job_payload'] ? JSON.parse(row['job_payload'] as string) : null,
  } as Schedule
}

export const SchedulerService = {
  init(): void {
    const db = getDb()
    const schedules = db
      .prepare("SELECT * FROM schedules WHERE is_active = 1")
      .all() as Record<string, unknown>[]

    for (const row of schedules) {
      const s = rowToSchedule(row)
      this._register(s)
    }

    console.log(`[Scheduler] Registered ${schedules.length} active schedules`)
  },

  _register(schedule: Schedule): void {
    if (!cron.validate(schedule.cron_expression)) {
      console.warn(`[Scheduler] Invalid cron expression for "${schedule.name}": ${schedule.cron_expression}`)
      return
    }

    const task = cron.schedule(schedule.cron_expression, () => {
      console.log(`[Scheduler] Firing schedule "${schedule.name}"`)
      JobQueue.enqueue(
        schedule.job_type as JobType,
        schedule.job_payload ?? {},
        'scheduler'
      )
      // Update last_run_at
      getDb().prepare(
        "UPDATE schedules SET last_run_at = datetime('now') WHERE id = ?"
      ).run(schedule.id)
    })

    _tasks.set(schedule.id, task)
  },

  _unregister(scheduleId: string): void {
    const task = _tasks.get(scheduleId)
    if (task) {
      task.stop()
      _tasks.delete(scheduleId)
    }
  },

  reload(scheduleId: string): void {
    this._unregister(scheduleId)
    const row = getDb()
      .prepare("SELECT * FROM schedules WHERE id = ? AND is_active = 1")
      .get(scheduleId) as Record<string, unknown> | undefined
    if (row) this._register(rowToSchedule(row))
  },

  destroy(): void {
    for (const task of _tasks.values()) {
      task.stop()
    }
    _tasks.clear()
    console.log('[Scheduler] All tasks stopped')
  },
}
