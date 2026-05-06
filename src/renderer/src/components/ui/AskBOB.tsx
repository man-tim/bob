/**
 * AskBOB — global "Ask BOB Anything" modal overlay.
 *
 * Triggered from the Header button. If the AI model isn't downloaded,
 * shows a prompt to go to Settings instead of spinning indefinitely.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Sparkles, X, Send, Copy, Check, RefreshCw } from 'lucide-react'
import { localAiApi, push, companiesApi } from '../../lib/ipc'

let _counter = 0
function newId() { return `askbob-${++_counter}` }

/**
 * Fetch a COMPACT company context string for the system prompt.
 *
 * We deliberately keep this small — the local model has an 8k context window
 * shared between the system prompt, user message, chain-of-thought, and response.
 * Dumping 200 companies in full detail fills the context before the model can
 * even begin thinking, causing it to hang indefinitely.
 *
 * Budget target: ≤ 400 tokens (≈ 1,600 chars) for the entire context block.
 */
async function buildBookOfBusinessContext(): Promise<string> {
  try {
    const r = await companiesApi.list({ pageSize: 200 })
    if (!r.ok || !r.data?.items?.length) return ''
    const items = r.data.items
    const total = r.data.total ?? items.length

    // Compact one-liner per company — name, tier, health, renewal month only
    const lines = items.slice(0, 30).map(c => {
      const parts: string[] = [c.name]
      if (c.tier)                 parts.push(c.tier)
      if (c.health_score != null) parts.push(`health:${c.health_score}`)
      if (c.renewal_date)         parts.push(`renews:${String(c.renewal_date).slice(0, 7)}`)
      if (c.csm_owner)            parts.push(`CSM:${c.csm_owner}`)
      return parts.join(' | ')
    })

    const overflow = total > 30 ? ` (${total - 30} more not listed)` : ''
    return `\n\n[Book of business: ${total} companies total${overflow}]\n${lines.join('\n')}`
  } catch {
    return ''
  }
}

function processThinkTags(raw: string): string {
  let display = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const lastOpen  = display.lastIndexOf('<think>')
  const lastClose = display.lastIndexOf('</think>')
  if (lastOpen !== -1 && lastOpen > lastClose) {
    display = display.slice(0, lastOpen)
  }
  return display.trim()
}

interface AskBOBProps {
  open:    boolean
  onClose: () => void
}

// 90-second hard timeout — if the model hasn't finished by then it has
// deadlocked (usually due to context overflow) and we surface an error.
const TIMEOUT_MS = 90_000

export function AskBOB({ open, onClose }: AskBOBProps) {
  const [query,      setQuery]      = useState('')
  const [response,   setResponse]   = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [running,    setRunning]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [copied,     setCopied]     = useState(false)
  const inputRef   = useRef<HTMLTextAreaElement>(null)
  const unsubRef   = useRef<(() => void) | null>(null)
  const rawAccRef  = useRef('')
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 60)
    else { setQuery(''); setResponse(''); setError(null); setRunning(false); setIsThinking(false) }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  function cleanupSub() {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
  }

  function cancelGeneration() {
    cleanupSub()
    setRunning(false)
    setIsThinking(false)
    if (!response) setError('Generation cancelled. Try a simpler question or try again.')
  }

  const submit = useCallback(async () => {
    if (!query.trim() || running) return
    setResponse('')
    setError(null)
    setRunning(true)
    setIsThinking(false)
    rawAccRef.current = ''

    const statusRes = await localAiApi.getStatus().catch(() => null)
    if (!statusRes?.ok || !statusRes.data?.downloaded) {
      setError('AI model not downloaded. Go to Settings → Local AI Model to download it first.')
      setRunning(false)
      return
    }
    if (statusRes.data.loadState !== 'ready') {
      setResponse('Loading model…')
      await localAiApi.load().catch(() => {})
      const after = await localAiApi.getStatus().catch(() => null)
      if (!after?.ok || after.data?.loadState !== 'ready') {
        setError('Model failed to load. Try again from Settings.')
        setRunning(false)
        setResponse('')
        return
      }
      setResponse('')
    }

    // Fetch company context so BOB can answer data questions
    const bobCtx = await buildBookOfBusinessContext()

    const requestId = newId()
    cleanupSub()

    // Hard timeout — kills the spinner if the model deadlocks
    timeoutRef.current = setTimeout(() => {
      cleanupSub()
      setRunning(false)
      setIsThinking(false)
      const partial = processThinkTags(rawAccRef.current)
      if (partial) {
        setResponse(partial)  // show whatever we got
      } else {
        setError('The model took too long — the question may have been too complex or the context too large. Try rephrasing or asking something simpler.')
      }
    }, TIMEOUT_MS)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unsubRef.current = (push as any).onAiChunk((payload: { requestId: string; chunk: string; done: boolean }) => {
      if (payload.requestId !== requestId) return
      if (payload.done) {
        const final = processThinkTags(rawAccRef.current)
        setResponse(final || rawAccRef.current.trim())
        setRunning(false)
        setIsThinking(false)
        cleanupSub()
        return
      }
      rawAccRef.current += payload.chunk
      const display = processThinkTags(rawAccRef.current)
      // Detect if still in a think block
      const raw = rawAccRef.current
      const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
      const lastOpen  = stripped.lastIndexOf('<think>')
      const lastClose = stripped.lastIndexOf('</think>')
      setIsThinking(lastOpen !== -1 && lastOpen > lastClose)
      setResponse(display)
    })

    await localAiApi.complete({
      requestId,
      prompt: query.trim(),
      systemPrompt: `You are B.O.B., a helpful B2B customer success assistant at Prokeep. Answer questions clearly and concisely. You have access to the CSM's book of business data provided below — always use it when answering questions about accounts, companies, or the book of business. If the user asks about a company by name, look it up in the data and answer based on what you find. If data is incomplete, say what you do know and what's missing. Plain text only — no markdown.${bobCtx}`,
    }).catch(err => {
      setError(err instanceof Error ? err.message : 'Request failed.')
      setRunning(false)
      cleanupSub()
    })
  }, [query, running])

  useEffect(() => () => cleanupSub(), [])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 100000,
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(3px)',
        }}
      />

      {/* Modal */}
      <div style={{
        position: 'fixed',
        top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 100001,
        width: 580, maxWidth: 'calc(100vw - 32px)',
        background: 'var(--color-bg-card)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(86,183,163,0.15)', border: '1px solid rgba(86,183,163,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Sparkles size={14} strokeWidth={2} style={{ color: 'var(--color-teal-400)' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>Ask B.O.B. Anything</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Your local AI assistant — runs on-device, no data leaves your computer</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {/* Input area */}
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <textarea
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
              placeholder="Ask anything about your accounts, Prokeep features, customer health…"
              rows={2}
              style={{
                flex: 1, padding: '9px 12px',
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--text-sm)',
                fontFamily: 'inherit',
                lineHeight: 1.5,
                resize: 'none',
                outline: 'none',
              }}
            />
            <button
              onClick={submit}
              disabled={!query.trim() || running}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 40, height: 40,
                borderRadius: 'var(--radius-md)',
                border: 'none',
                background: (!query.trim() || running) ? 'var(--color-bg-elevated)' : 'var(--color-teal-600)',
                color: (!query.trim() || running) ? 'var(--color-text-muted)' : 'white',
                cursor: (!query.trim() || running) ? 'not-allowed' : 'pointer',
                flexShrink: 0,
                alignSelf: 'flex-end',
              }}
            >
              {running
                ? <div style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                : <Send size={15} />
              }
            </button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 5 }}>
            Press Enter to send · Shift+Enter for new line
          </div>
        </div>

        {/* Response area */}
        {(response || error || running) && (
          <div style={{ padding: '14px 16px', maxHeight: 340, overflowY: 'auto' }}>
            {/* Status indicator + cancel */}
            {running && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-teal-500)', animation: 'pulse 1s infinite' }} />
                  {isThinking ? 'B.O.B. is thinking…' : 'B.O.B. is responding…'}
                </div>
                <button
                  onClick={cancelGeneration}
                  style={{ fontSize: 10, color: 'var(--color-text-muted)', background: 'none', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '2px 8px', cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Error */}
            {error && (
              <div style={{ color: '#DA5039', fontSize: 'var(--text-sm)', marginBottom: 8 }}>
                {error}
                {error.includes('not downloaded') && (
                  <button onClick={() => { onClose(); window.location.hash = '#/settings' }} style={{ display: 'block', marginTop: 6, color: 'var(--color-teal-400)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)', textDecoration: 'underline', padding: 0 }}>
                    Go to Settings →
                  </button>
                )}
              </div>
            )}

            {/* Response text */}
            {response && (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)', lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {response}
                {running && response && (
                  <span style={{ display: 'inline-block', width: 8, height: 14, background: 'var(--color-teal-500)', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'pulse 1s infinite' }} />
                )}
              </div>
            )}

            {/* Action buttons */}
            {!running && response && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button
                  onClick={() => navigator.clipboard.writeText(response).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) }).catch(() => {})}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)', fontSize: 'var(--text-xs)', cursor: 'pointer' }}
                >
                  {copied ? <Check size={11} style={{ color: '#34A853' }} /> : <Copy size={11} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  onClick={submit}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)', fontSize: 'var(--text-xs)', cursor: 'pointer' }}
                >
                  <RefreshCw size={11} /> Regenerate
                </button>
              </div>
            )}
          </div>
        )}

        {/* Empty state hint */}
        {!response && !error && !running && (
          <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
            Try: "Summarize the health of my at-risk accounts" · "How do I set up a QBR?" · "Draft a renewal email"
          </div>
        )}
      </div>
    </>
  )
}
