/// <reference types="vite/client" />

import type { IpcChannel } from '@shared/ipc-channels'

/**
 * Global type for the contextBridge API exposed by the preload script.
 */
interface Window {
  electron: {
    invoke: <T = unknown>(channel: IpcChannel, ...args: unknown[]) => Promise<T>
    on:   (channel: IpcChannel, listener: (...args: unknown[]) => void) => (() => void)
    once: (channel: IpcChannel, listener: (...args: unknown[]) => void) => void
  }
}
