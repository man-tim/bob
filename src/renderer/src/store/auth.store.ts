import { create } from 'zustand'
import { authApi, push } from '../lib/ipc'
import { useUIStore } from './ui.store'
import type { AuthStatus } from '@shared/types'

interface AuthStore {
  status:  AuthStatus | null
  loading: boolean
  error:   string | null
  init:    () => Promise<void>
  login:   () => Promise<void>
  logout:  () => Promise<void>
}

export const useAuthStore = create<AuthStore>((set) => ({
  status:  null,
  loading: false,
  error:   null,

  async init() {
    const result = await authApi.getStatus()
    if (result.ok) set({ status: result.data })
    push.onAuthChanged(status => set({ status }))
  },

  async login() {
    set({ loading: true, error: null })
    try {
      const result = await authApi.login()
      if (result.ok) {
        set({ status: result.data })
      } else {
        const msg = result.error ?? 'Google sign-in failed.'
        set({ error: msg })
        useUIStore.getState().addToast({ title: 'Sign-in failed', body: msg, level: 'error' })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unexpected error during sign-in.'
      set({ error: msg })
      useUIStore.getState().addToast({ title: 'Sign-in failed', body: msg, level: 'error' })
    } finally {
      set({ loading: false })
    }
  },

  async logout() {
    await authApi.logout()
    set({ status: { isAuthenticated: false, email: null, scopes: [], expiresAt: null } })
  },
}))
