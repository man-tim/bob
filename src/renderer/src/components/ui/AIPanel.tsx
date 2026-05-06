/**
 * AIPanel — reusable component for in-page local AI completions.
 *
 * Shows a trigger button. On click:
 *  - If model not downloaded → navigates to Settings automatically
 *  - If model not loaded    → shows "Loading model…" state
 *  - If ready               → streams generated text in an expandable panel
 *
 * Think-tag filtering: DeepSeek-R1 outputs <think>…</think> blocks before
 * the actual answer. These are stripped in real-time so only the final
 * response is shown to the user. A "Thinking…" indicator is shown while
 * the model reasons.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Sparkles, X, Copy, Check, AlertCircle, RefreshCw } from 'lucide-react'
import { localAiApi, push } from '../../lib/ipc'
import type { AIStatus } from '../../lib/ipc'

// Unique ID generator for request tracking
let _reqCounter = 0
function newRequestId() { return `ai-req-${++_reqCounter}` }

/**
 * Strip <think>…</think> blocks from streamed AI output.
 * Returns the displayable text and whether a think block is still open.
 */
function processThinkTags(raw: string): { display: string; isThinking: boolean } {
  // Remove completed think blocks entirely
  let display = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  // Check if we're mid-way through a think block (opened but not closed)
  const lastOpen  = display.lastIndexOf('<think>')
  const lastClose = display.lastIndexOf('</think>')
  const isThinking = lastOpen !== -1 && lastOpen > lastClose
  if (isThinking) {
    // Hide everything from the unclosed <think> onwards
    display = display.slice(0, lastOpen)
  }
  return { display: display.trim(), isThinking }
}

interface AIPanelProps {
  label?:        string
  prompt:        string
  systemPrompt?: string
  maxTokens?:    number
  /** Extra inline style on the trigger button */
  buttonStyle?:  React.CSSProperties
  /** Called when generation completes with the final (think-stripped) text */
  onComplete?:   (text: string) => void
}

export function AIPanel({
  label = 'AI Assist', prompt, systemPrompt, maxTokens = 2048, buttonStyle, onComplete,
}: AIPanelProps) {
  const [status,      setStatus]      = useState<AIStatus | null>(null)
  const [open,        setOpen]        = useState(false)
  const [text,        setText]        = useState('')
  const [isThinking,  setIsThinking]  = useState(false)
  const [running,     setRunning]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [copied,      setCopied]      = useState(false)
  const reqIdRef   = useRef<string | null>(null)
  const unsubRef   = useRef<(() => void) | null>(null)
  const rawAccRef  = useRef('')   // raw accumulated text (includes think tags)

  // Poll status once on mount
  useEffect(() => {
    localAiApi.getStatus().then(r => { if (r.ok && r.data) setStatus(r.data) }).catch(() => {})
  }, [])

  function cleanupSub() {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
  }

  const runCompletion = useCallback(async () => {
    setOpen(true)
    setText('')
    setError(null)
    setRunning(true)
    setIsThinking(false)
    rawAccRef.current = ''

    // Refresh status
    const statusRes = await localAiApi.getStatus().catch(() => null)
    if (statusRes && statusRes.ok) setStatus(statusRes.data ?? null)

    const currentStatus = (statusRes && statusRes.ok) ? statusRes.data : status

    // If model not downloaded, navigate to Settings automatically
    if (!currentStatus?.downloaded) {
      setRunning(false)
      setOpen(false)
      window.location.hash = '#/settings'
      return
    }

    // If not loaded, trigger load and wait
    if (currentStatus.loadState !== 'ready') {
      setText('Loading model into memory…')
      await localAiApi.load().catch(() => {})
      const afterLoad = await localAiApi.getStatus().catch(() => null)
      if (afterLoad && afterLoad.ok) setStatus(afterLoad.data ?? null)
      const afterData = afterLoad && afterLoad.ok ? afterLoad.data : null
      if (!afterData || afterData.loadState !== 'ready') {
        setError(afterData?.loadError ?? 'Failed to load model. Try downloading it again in Settings.')
        setRunning(false)
        setText('')
        return
      }
      setText('')
    }

    const requestId = newRequestId()
    reqIdRef.current = requestId

    // Subscribe to streaming chunks — filter think tags in real-time
    cleanupSub()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unsubRef.current = (push as any).onAiChunk((payload: { requestId: string; chunk: string; done: boolean }) => {
      if (payload.requestId !== requestId) return
      if (payload.done) {
        setRunning(false)
        setIsThinking(false)
        const finalText = processThinkTags(rawAccRef.current).display
        setText(finalText)
        onComplete?.(finalText)
        cleanupSub()
        return
      }
      rawAccRef.current += payload.chunk
      const { display, isThinking: thinking } = processThinkTags(rawAccRef.current)
      setIsThinking(thinking)
      setText(display)
    })

    const result = await localAiApi.complete({ requestId, prompt, systemPrompt, maxTokens })
    if (!result.ok) {
      setError(result.error ?? 'Generation failed.')
      setRunning(false)
      setIsThinking(false)
      cleanupSub()
    }
    // Success path: running state cleared by onAiChunk done handler
  }, [prompt, systemPrompt, maxTokens, status, onComplete])

  // Cleanup on unmount
  useEffect(() => () => cleanupSub(), [])

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }).catch(() => {})
  }

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
      {/* Trigger button */}
      <button
        onClick={runCompletion}
        disabled={running}
        title={label}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '4px 10px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border)',
          background: running ? 'var(--color-bg-surface)' : 'rgba(86,183,163,0.08)',
          color: 'var(--color-teal-400)',
          fontSize: 'var(--text-xs)',
          fontWeight: 600,
          cursor: running ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap',
          ...buttonStyle,
        }}
      >
        {running
          ? <div style={{ width: 11, height: 11, border: '2px solid var(--color-teal-700)', borderTopColor: 'var(--color-teal-400)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          : <Sparkles size={12} strokeWidth={2} />
        }
        {label}
      </button>

      {/* Output panel */}
      {open && (
        <div style={{
          background: 'var(--color-bg-card)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          padding: '10px 12px',
          maxWidth: 520,
          width: '100%',
          position: 'relative',
        }}>
          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-xs)', color: 'var(--color-teal-400)', fontWeight: 700 }}>
              <Sparkles size={11} strokeWidth={2} />
              B.O.B. AI
              {running && isThinking && <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}> · thinking…</span>}
              {running && !isThinking && text === '' && <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}> · starting…</span>}
              {running && !isThinking && text !== '' && <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}> · generating…</span>}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              {text && !running && (
                <button onClick={handleCopy} title="Copy" style={iconBtnStyle}>
                  {copied ? <Check size={12} style={{ color: '#34A853' }} /> : <Copy size={12} />}
                </button>
              )}
              <button onClick={() => { setOpen(false); cleanupSub() }} title="Close" style={iconBtnStyle}>
                <X size={12} />
              </button>
            </div>
          </div>

          {/* Error state */}
          {error && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color: '#DA5039', fontSize: 'var(--text-xs)' }}>
              <AlertCircle size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>{error}</div>
            </div>
          )}

          {/* Generated text */}
          {!error && (
            <div style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--color-text-primary)',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              minHeight: (running && !text) ? 32 : undefined,
            }}>
              {text || (running && (
                <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                  {isThinking ? 'Reasoning through your request…' : 'Generating…'}
                </span>
              ))}
              {running && text && (
                <span style={{ display: 'inline-block', width: 8, height: 14, background: 'var(--color-teal-500)', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'pulse 1s infinite' }} />
              )}
            </div>
          )}

          {/* Re-run button */}
          {!running && !error && text && (
            <button
              onClick={runCompletion}
              style={{ ...iconBtnStyle, marginTop: 8, fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-muted)' }}
            >
              <RefreshCw size={10} /> Regenerate
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Lightweight "not downloaded" indicator — shown where AI buttons would be
 * when the model hasn't been downloaded yet. Clicking navigates to Settings.
 */
export function AIUnavailableBadge() {
  return (
    <button
      onClick={() => { window.location.hash = '#/settings' }}
      title="Download the local AI model in Settings to enable AI features"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', borderRadius: 'var(--radius-sm)',
        border: '1px dashed var(--color-border)',
        color: 'var(--color-text-muted)',
        fontSize: 'var(--text-xs)',
        background: 'none',
        cursor: 'pointer',
      }}
    >
      <Sparkles size={10} />
      Get AI
    </button>
  )
}

// ─── Style helpers ────────────────────────────────────────────────────────────

const iconBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 22, height: 22,
  borderRadius: 'var(--radius-sm)',
  border: 'none',
  background: 'none',
  color: 'var(--color-text-muted)',
  cursor: 'pointer',
  padding: 0,
}
