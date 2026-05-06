import { create } from 'zustand'
import type { QuickLink } from '../lib/ipc'
import { quickLinksApi } from '../lib/ipc'

interface Toast {
  id:      string
  title:   string
  body?:   string
  level:   'info' | 'ok' | 'warn' | 'error'
}

export interface GongLogEntry { msg: string; cls: string; ts: string }

interface UIStore {
  sidebarCollapsed:   boolean
  toasts:             Toast[]
  quickLinks:         QuickLink[]
  helpMode:           boolean
  feedbackLoggerMode: boolean
  /** Session-scoped Gong scraper log — survives navigation, resets on app close */
  gongLogs:           GongLogEntry[]
  /** Set when the scraper needs the user to reconnect an integration */
  reconnectService:   'hubspot' | 'gong' | null

  toggleSidebar:           () => void
  setSidebar:              (collapsed: boolean) => void
  addToast:                (toast: Omit<Toast, 'id'>) => void
  removeToast:             (id: string) => void
  loadQuickLinks:          () => Promise<void>
  setQuickLinks:           (links: QuickLink[]) => void
  toggleHelpMode:          () => void
  toggleFeedbackLoggerMode:() => void
  appendGongLog:           (entry: GongLogEntry) => void
  clearGongLogs:           () => void
  setReconnectService:     (service: 'hubspot' | 'gong' | null) => void
}

let _toastId = 0

export const useUIStore = create<UIStore>((set) => ({
  sidebarCollapsed:   false,
  toasts:             [],
  quickLinks:         [],
  helpMode:           false,
  feedbackLoggerMode: false,
  gongLogs:           [],
  reconnectService:   null,

  toggleSidebar() {
    set(s => ({ sidebarCollapsed: !s.sidebarCollapsed }))
  },

  setSidebar(collapsed) {
    set({ sidebarCollapsed: collapsed })
  },

  addToast(toast) {
    const id = String(++_toastId)
    set(s => ({ toasts: [...s.toasts, { ...toast, id }] }))
    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }))
    }, 4000)
  },

  removeToast(id) {
    set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }))
  },

  async loadQuickLinks() {
    const r = await quickLinksApi.get()
    if (r.ok) set({ quickLinks: r.data })
  },

  setQuickLinks(links) {
    set({ quickLinks: links })
  },

  toggleHelpMode() {
    set(s => ({ helpMode: !s.helpMode }))
  },

  toggleFeedbackLoggerMode() {
    set(s => ({ feedbackLoggerMode: !s.feedbackLoggerMode }))
  },

  appendGongLog(entry) {
    set(s => ({ gongLogs: [...s.gongLogs.slice(-1999), entry] }))
  },

  clearGongLogs() {
    set({ gongLogs: [] })
  },

  setReconnectService(service) {
    set({ reconnectService: service })
  },
}))
