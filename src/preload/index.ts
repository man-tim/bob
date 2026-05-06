import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel } from '@shared/ipc-channels'

/**
 * Typed Electron API exposed to the renderer via contextBridge.
 * The renderer accesses this as window.electron.
 */
const electronAPI = {
  /**
   * Send a two-way IPC call and await the response.
   * All handlers return IpcResult<T> — check result.ok before using result.data.
   */
  invoke: <T = unknown>(channel: IpcChannel, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args),

  /**
   * Subscribe to a push event from the main process.
   * Returns an unsubscribe function.
   */
  on: (channel: IpcChannel, listener: (...args: unknown[]) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },

  /**
   * Subscribe once to a push event.
   */
  once: (channel: IpcChannel, listener: (...args: unknown[]) => void): void => {
    ipcRenderer.once(channel, (_event, ...args) => listener(...args))
  },
}

contextBridge.exposeInMainWorld('electron', electronAPI)

// ─── Type augmentation ────────────────────────────────────────────────────────
// Imported in renderer via src/renderer/src/lib/ipc.ts — no need to repeat here.

export type ElectronAPI = typeof electronAPI
