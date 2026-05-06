import { create } from 'zustand'
import { jobsApi, push } from '../lib/ipc'
import { MAX_LOG_ENTRIES } from '@shared/constants'
import type { Job, JobLog, JobStatus } from '@shared/types'

interface JobsStore {
  jobs:    Job[]
  logs:    Record<string, JobLog[]>   // jobId → log entries
  loading: boolean

  init:       () => void
  fetchJobs:  () => Promise<void>
  fetchLogs:  (jobId: string) => Promise<void>
  stopJob:    (jobId: string) => Promise<void>
  activeJobs: () => Job[]
}

export const useJobsStore = create<JobsStore>((set, get) => ({
  jobs:    [],
  logs:    {},
  loading: false,

  init() {
    // Subscribe to live pushes from main process
    push.onJobLog(({ jobId, log }) => {
      set(state => {
        const existing = state.logs[jobId] ?? []
        const updated  = [...existing, log].slice(-MAX_LOG_ENTRIES)
        return { logs: { ...state.logs, [jobId]: updated } }
      })
    })

    push.onJobStatus(({ jobId, status }) => {
      set(state => ({
        jobs: state.jobs.map(j =>
          j.id === jobId ? { ...j, status: status as JobStatus } : j
        ),
      }))
    })
  },

  async fetchJobs() {
    set({ loading: true })
    try {
      const result = await jobsApi.list({ })
      if (result.ok) set({ jobs: result.data })
    } finally {
      set({ loading: false })
    }
  },

  async fetchLogs(jobId) {
    const result = await jobsApi.logs(jobId)
    if (result.ok) {
      set(state => ({ logs: { ...state.logs, [jobId]: result.data } }))
    }
  },

  async stopJob(jobId) {
    await jobsApi.stop(jobId)
    await get().fetchJobs()
  },

  activeJobs() {
    return get().jobs.filter(j => j.status === 'running' || j.status === 'pending')
  },
}))
