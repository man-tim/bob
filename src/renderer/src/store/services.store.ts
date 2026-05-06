import { create } from 'zustand'
import { servicesApi, push } from '../lib/ipc'
import type { ServicesStatus } from '../lib/ipc'

const DEFAULT_STATUS: ServicesStatus = {
  hubspot: { connected: false, connectedAt: null },
  gong:    { connected: false, connectedAt: null },
}

interface ServicesStore {
  status:          ServicesStatus
  connectingHS:    boolean
  connectingGong:  boolean

  init:           () => Promise<void>
  connectHubSpot: () => Promise<void>
  connectGong:    () => Promise<void>
}

export const useServicesStore = create<ServicesStore>((set) => ({
  status:         DEFAULT_STATUS,
  connectingHS:   false,
  connectingGong: false,

  async init() {
    const r = await servicesApi.getStatus()
    if (r.ok) set({ status: r.data })
    // Live updates from main when a connection is confirmed
    push.onServicesStatus(status => set({ status }))
  },

  async connectHubSpot() {
    set({ connectingHS: true })
    const r = await servicesApi.connectHubSpot()
    if (r.ok) set({ status: r.data })
    set({ connectingHS: false })
  },

  async connectGong() {
    set({ connectingGong: true })
    const r = await servicesApi.connectGong()
    if (r.ok) set({ status: r.data })
    set({ connectingGong: false })
  },
}))
