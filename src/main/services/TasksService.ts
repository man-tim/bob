/**
 * Google Tasks API integration.
 * Creates / updates / deletes tasks in the user's default task list.
 */
import { google } from 'googleapis'
import { AuthService } from '../auth/AuthService'

export interface GTaskInput {
  title: string
  notes?: string        // multi-line details shown in Google Tasks
  due?: string          // RFC 3339 date-only "2026-05-15T00:00:00.000Z"
}

export const TasksService = {
  /**
   * Get (or create) the default task list ID.
   * "@default" always resolves but using the real ID avoids ambiguity.
   */
  async _defaultListId(): Promise<string> {
    const auth  = await AuthService.getAuthClient()
    const tasks = google.tasks({ version: 'v1', auth })
    const res   = await tasks.tasklists.list({ maxResults: 1 })
    return res.data.items?.[0]?.id ?? '@default'
  },

  /**
   * Create a task and return its Google Tasks ID.
   */
  async createTask(input: GTaskInput): Promise<string> {
    const auth    = await AuthService.getAuthClient()
    const tasks   = google.tasks({ version: 'v1', auth })
    const listId  = await this._defaultListId()

    const res = await tasks.tasks.insert({
      tasklist: listId,
      requestBody: {
        title: input.title,
        notes: input.notes ?? undefined,
        due:   input.due   ?? undefined,
      },
    })

    return res.data.id ?? ''
  },

  /**
   * Update an existing task by ID.
   */
  async updateTask(taskId: string, patch: Partial<GTaskInput>): Promise<void> {
    const auth   = await AuthService.getAuthClient()
    const tasks  = google.tasks({ version: 'v1', auth })
    const listId = await this._defaultListId()

    // tasks.patch requires the task ID in the body
    await tasks.tasks.patch({
      tasklist: listId,
      task:     taskId,
      requestBody: {
        id:    taskId,
        title: patch.title ?? undefined,
        notes: patch.notes ?? undefined,
        due:   patch.due   ?? undefined,
      },
    })
  },

  /**
   * Mark a task complete.
   */
  async completeTask(taskId: string): Promise<void> {
    const auth   = await AuthService.getAuthClient()
    const tasks  = google.tasks({ version: 'v1', auth })
    const listId = await this._defaultListId()

    await tasks.tasks.patch({
      tasklist: listId,
      task:     taskId,
      requestBody: { id: taskId, status: 'completed' },
    })
  },

  /**
   * Delete a task.
   */
  async deleteTask(taskId: string): Promise<void> {
    try {
      const auth   = await AuthService.getAuthClient()
      const tasks  = google.tasks({ version: 'v1', auth })
      const listId = await this._defaultListId()
      await tasks.tasks.delete({ tasklist: listId, task: taskId })
    } catch { /* ignore 404 / already deleted */ }
  },
}
