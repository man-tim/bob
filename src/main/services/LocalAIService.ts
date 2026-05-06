/**
 * LocalAIService — wraps node-llama-cpp to run a local GGUF model.
 *
 * Model: DeepSeek-R1-Distill-Qwen-1.5B (Q5_K_M quantisation, ~1.24 GB)
 * Stored in: app.getPath('userData')/models/  (persists across updates)
 *
 * The service is lazy: the model is only loaded into memory the first time
 * a completion is requested (or when AI_LOAD is called explicitly).
 * Download must be triggered separately via startDownload().
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync, createWriteStream, mkdirSync } from 'fs'
import { unlink, stat } from 'fs/promises'
import https from 'https'
import http from 'http'

// ─── Model config ─────────────────────────────────────────────────────────────

const MODEL_FILENAME = 'DeepSeek-R1-Distill-Qwen-1.5B-Q5_K_M.gguf'
const MODEL_URL =
  'https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q5_K_M.gguf'

// Maximum tokens in the context window.
// DeepSeek-R1-Distill-Qwen-1.5B supports up to 32k; 8192 is safe on any
// modern machine (KV cache adds ~256 MB at this size) and gives the model
// plenty of room for its chain-of-thought <think> block AND a full response.
const CONTEXT_SIZE = 8192
// GPU layers to offload — 999 means "all" (Metal on Apple Silicon, CUDA on Nvidia)
const GPU_LAYERS   = 999

// ─── Types ───────────────────────────────────────────────────────────────────

export type AILoadState = 'idle' | 'loading' | 'ready' | 'error'
export type AIDownloadState = 'idle' | 'downloading' | 'done' | 'error' | 'cancelled'

export interface AIStatus {
  downloaded:    boolean
  loadState:     AILoadState
  loadError:     string | null
  downloadState: AIDownloadState
  downloadPct:   number          // 0–100
  mbDownloaded:  number
  mbTotal:       number
}

export type ProgressCallback = (pct: number, mbDownloaded: number, mbTotal: number) => void

// ─── Internals ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _llama:   any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _model:   any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _context: any = null

let loadState: AILoadState     = 'idle'
let loadError: string | null   = null
let loadPromise: Promise<void> | null = null

let downloadState: AIDownloadState = 'idle'
let downloadPct    = 0
let mbDownloaded   = 0
let mbTotal        = 0
let downloadAbort: (() => void) | null = null

export const LocalAIService = {
  // ── Paths ──────────────────────────────────────────────────────────────────

  getModelsDir(): string {
    return join(app.getPath('userData'), 'models')
  },

  getModelPath(): string {
    return join(this.getModelsDir(), MODEL_FILENAME)
  },

  isModelDownloaded(): boolean {
    return existsSync(this.getModelPath())
  },

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus(): AIStatus {
    return {
      downloaded:    this.isModelDownloaded(),
      loadState,
      loadError,
      downloadState,
      downloadPct,
      mbDownloaded,
      mbTotal,
    }
  },

  // ── Model loading ──────────────────────────────────────────────────────────

  async ensureLoaded(): Promise<void> {
    if (loadState === 'ready') return
    if (loadState === 'loading' && loadPromise) return loadPromise

    if (!this.isModelDownloaded()) {
      throw new Error('Model not downloaded yet. Download it in Settings → Local AI Model.')
    }

    loadState   = 'loading'
    loadError   = null
    loadPromise = (async () => {
      try {
        // Dynamic import — node-llama-cpp is ESM-only
        const { getLlama, LlamaChatSession: _LC } = await import('node-llama-cpp')
        void _LC // imported for type side-effects only; used per-completion

        _llama   = await getLlama()
        _model   = await _llama.loadModel({
          modelPath:  this.getModelPath(),
          gpuLayers:  GPU_LAYERS,
        })
        _context = await _model.createContext({ contextSize: CONTEXT_SIZE })
        loadState = 'ready'
      } catch (err) {
        loadState = 'error'
        loadError = err instanceof Error ? err.message : String(err)
        _llama = _model = _context = null
        throw err
      } finally {
        loadPromise = null
      }
    })()

    return loadPromise
  },

  unload(): void {
    try { _context?.dispose?.() } catch { /* ignore */ }
    try { _model?.dispose?.() }   catch { /* ignore */ }
    try { _llama?.dispose?.() }   catch { /* ignore */ }
    _llama = _model = _context = null
    loadState = 'idle'
    loadError = null
  },

  // ── Inference ─────────────────────────────────────────────────────────────

  /**
   * Run a one-shot completion. Streams chunks via onChunk as they are produced.
   * Returns the full generated text once complete.
   */
  async complete(opts: {
    requestId:    string
    prompt:       string
    systemPrompt?: string
    maxTokens?:   number
    onChunk:      (requestId: string, chunk: string, done: boolean) => void
  }): Promise<string> {
    await this.ensureLoaded()

    const { LlamaChatSession } = await import('node-llama-cpp')

    const seq     = _context.getSequence()
    const session = new LlamaChatSession({
      contextSequence: seq,
      systemPrompt:    opts.systemPrompt ?? defaultSystemPrompt,
    })

    let fullText = ''
    try {
      await session.prompt(opts.prompt, {
        // Default to 2048 — generous enough for any response, well within
        // the 8192 context window after accounting for prompts + thinking.
        maxTokens: opts.maxTokens ?? 2048,
        onTextChunk: (chunk: string) => {
          fullText += chunk
          opts.onChunk(opts.requestId, chunk, false)
        },
      })
    } finally {
      try { seq.dispose() } catch { /* ignore */ }
    }

    opts.onChunk(opts.requestId, '', true)
    return fullText
  },

  // ── Download ───────────────────────────────────────────────────────────────

  async startDownload(onProgress: ProgressCallback): Promise<void> {
    if (downloadState === 'downloading') return
    if (this.isModelDownloaded()) {
      downloadState = 'done'
      downloadPct   = 100
      return
    }

    mkdirSync(this.getModelsDir(), { recursive: true })

    downloadState = 'downloading'
    downloadPct   = 0
    mbDownloaded  = 0
    mbTotal       = 0

    return new Promise<void>((resolve, reject) => {
      const dest    = this.getModelPath()
      const tmpPath = dest + '.tmp'
      const stream  = createWriteStream(tmpPath)
      let aborted   = false

      downloadAbort = () => {
        aborted = true
        stream.destroy()
        req.destroy()
      }

      // Follows redirects (HuggingFace redirects to CDN)
      function doRequest(url: string): http.ClientRequest {
        const mod = url.startsWith('https') ? https : http
        return mod.get(url, { timeout: 30_000 }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
            const location = res.headers['location']
            if (!location) { reject(new Error('Redirect without location')); return }
            req = doRequest(location)
            return
          }

          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`))
            return
          }

          const total = parseInt(res.headers['content-length'] ?? '0', 10)
          mbTotal = total / 1_048_576

          let downloaded = 0
          res.on('data', (chunk: Buffer) => {
            downloaded   += chunk.length
            mbDownloaded  = downloaded / 1_048_576
            downloadPct   = total ? Math.round((downloaded / total) * 100) : 0
            onProgress(downloadPct, mbDownloaded, mbTotal)
          })

          res.pipe(stream)
        })
      }

      let req = doRequest(MODEL_URL)

      stream.on('finish', async () => {
        if (aborted) {
          unlink(tmpPath).catch(() => {})
          downloadState = 'cancelled'
          downloadAbort = null
          reject(new Error('Download cancelled'))
          return
        }
        try {
          const { rename } = await import('fs/promises')
          await rename(tmpPath, dest)
          downloadState = 'done'
          downloadPct   = 100
          downloadAbort = null
          resolve()
        } catch (err) {
          downloadState = 'error'
          reject(err)
        }
      })

      stream.on('error', (err) => {
        unlink(tmpPath).catch(() => {})
        if (aborted) {
          downloadState = 'cancelled'
          reject(new Error('Download cancelled'))
        } else {
          downloadState = 'error'
          reject(err)
        }
        downloadAbort = null
      })

      req.on('error', (err) => {
        stream.destroy()
        unlink(tmpPath).catch(() => {})
        if (aborted) {
          downloadState = 'cancelled'
          reject(new Error('Download cancelled'))
        } else {
          downloadState = 'error'
          reject(err)
        }
        downloadAbort = null
      })
    })
  },

  cancelDownload(): void {
    if (downloadAbort) {
      downloadAbort()
      downloadAbort = null
    }
  },

  async deleteModel(): Promise<void> {
    this.unload()
    const path = this.getModelPath()
    if (existsSync(path)) await unlink(path)
    downloadState = 'idle'
    downloadPct   = 0
    mbDownloaded  = 0
  },

  async getModelSizeMb(): Promise<number | null> {
    try {
      const s = await stat(this.getModelPath())
      return s.size / 1_048_576
    } catch {
      return null
    }
  },
}

// ─── Default system prompt ────────────────────────────────────────────────────

const defaultSystemPrompt = `You are B.O.B., a helpful customer success assistant for a B2B SaaS company called Prokeep. \
You help CSMs understand accounts, draft communications, identify risks, and spot expansion opportunities. \
Be concise, professional, and actionable. Respond in plain text without markdown unless asked.`
