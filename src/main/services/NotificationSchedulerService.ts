/**
 * NotificationSchedulerService
 * ─────────────────────────────
 * Runs in the Electron main process.
 * Uses node-cron to poll the follow_ups table and fire native macOS
 * notifications for items whose due_date is approaching.
 *
 * Notification windows (configurable via app_settings):
 *   - 24 hours before due
 *   - 1 hour before due   (default)
 *   - At due time
 */
import { Notification, BrowserWindow } from 'electron'
import cron from 'node-cron'
import { getDb } from '../db/database'

// ─── Default notification windows (minutes before due) ───────────────────────

const DEFAULT_WINDOWS_MIN = [24 * 60, 60, 0]   // 24h, 1h, at-due

function getNotificationWindows(): number[] {
  try {
    const db  = getDb()
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'notification_windows_min'").get() as { value: string } | undefined
    if (row) return JSON.parse(row.value) as number[]
  } catch { /* use defaults */ }
  return DEFAULT_WINDOWS_MIN
}

export function getNotificationsEnabled(): boolean {
  try {
    const db  = getDb()
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'notifications_enabled'").get() as { value: string } | undefined
    return row ? row.value === 'true' : true   // enabled by default
  } catch { return true }
}

export function setNotificationsEnabled(enabled: boolean): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES ('notifications_enabled', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(enabled ? 'true' : 'false')
}

export function setNotificationWindows(windowsMin: number[]): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES ('notification_windows_min', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(windowsMin))
}

// ─── Notification fire helper ─────────────────────────────────────────────────

function fireNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => {
    // Bring app window to front
    const wins = BrowserWindow.getAllWindows()
    if (wins[0]) { wins[0].show(); wins[0].focus() }
  })
  n.show()
}

// ─── Check-and-notify ─────────────────────────────────────────────────────────

function checkAndNotify(): void {
  if (!getNotificationsEnabled()) return

  const windows = getNotificationWindows()
  const db      = getDb()
  const now     = Date.now()

  // Only open follow-ups with a due_date
  const rows = db.prepare(`
    SELECT id, company_name, description, due_date, notified_at
    FROM follow_ups
    WHERE status = 'open' AND due_date IS NOT NULL
  `).all() as Array<{
    id: string
    company_name: string
    description: string
    due_date: string
    notified_at: string | null
  }>

  for (const row of rows) {
    const dueMs   = new Date(row.due_date).getTime()
    const diffMin = (dueMs - now) / 60_000

    // Parse which windows have already fired
    let fired: number[] = []
    try { fired = row.notified_at ? JSON.parse(row.notified_at) : [] } catch { fired = [] }

    for (const windowMin of windows) {
      // Check if this window is "due" (within a 2-minute scheduling tolerance)
      if (diffMin <= windowMin + 1 && diffMin > windowMin - 2 && !fired.includes(windowMin)) {
        const label = windowMin === 0
          ? 'now'
          : windowMin < 60
          ? `in ${windowMin} minutes`
          : `in ${windowMin / 60} hour${windowMin / 60 !== 1 ? 's' : ''}`

        fireNotification(
          `Follow-up due ${label}`,
          `[${row.company_name}] ${row.description}`
        )

        fired.push(windowMin)
        db.prepare("UPDATE follow_ups SET notified_at = ? WHERE id = ?")
          .run(JSON.stringify(fired), row.id)
        break  // Only one notification per poll cycle per follow-up
      }
    }
  }
}

// ─── Start scheduler ──────────────────────────────────────────────────────────

let _task: cron.ScheduledTask | null = null

export function startNotificationScheduler(): void {
  if (_task) return   // already running

  // Run every 2 minutes
  _task = cron.schedule('*/2 * * * *', () => {
    try {
      checkAndNotify()
    } catch (err) {
      console.warn('[NotificationScheduler] Error:', err)
    }
  })

  console.log('[NotificationScheduler] Started (every 2 min)')
}

export function stopNotificationScheduler(): void {
  _task?.stop()
  _task = null
}
