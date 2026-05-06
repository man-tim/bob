/**
 * HelpTooltip — global tooltip shown when "How-To Mode" is active.
 * Listens for mousemove and walks the DOM to find the nearest element
 * with a [data-help] attribute, then renders a floating tooltip near the cursor.
 *
 * AI integration: an "Ask BOB" button lets the user get a deeper AI explanation
 * of the hovered element. The AI response replaces the static tooltip text.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { Sparkles, X } from 'lucide-react'
import { useUIStore } from '../../store/ui.store'
import { localAiApi, push } from '../../lib/ipc'

let _reqCounter = 0
function newReqId() { return `help-ai-${++_reqCounter}` }

export function HelpTooltip() {
  const helpMode = useUIStore(s => s.helpMode)
  const [tip,         setTip]         = useState<string | null>(null)
  const [pos,         setPos]         = useState({ x: 0, y: 0 })
  const [aiText,      setAiText]      = useState<string | null>(null)
  const [aiRunning,   setAiRunning]   = useState(false)
  const rafRef    = useRef<number>(0)
  const unsubRef  = useRef<(() => void) | null>(null)
  const rawAccRef = useRef('')

  useEffect(() => {
    if (!helpMode) { setTip(null); setAiText(null); setAiRunning(false) }
  }, [helpMode])

  // When tip changes, clear previous AI response
  useEffect(() => { setAiText(null); setAiRunning(false); rawAccRef.current = '' }, [tip])

  useEffect(() => {
    if (!helpMode) return

    function onMove(e: MouseEvent) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        setPos({ x: e.clientX, y: e.clientY })
        let el = e.target as HTMLElement | null
        let found: string | null = null
        let depth = 0
        while (el && depth < 10) {
          const h = el.getAttribute?.('data-help')
          if (h) { found = h; break }
          el = el.parentElement
          depth++
        }
        setTip(found)
      })
    }

    document.addEventListener('mousemove', onMove)
    return () => {
      document.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(rafRef.current)
    }
  }, [helpMode])

  const askBOB = useCallback(async () => {
    if (!tip || aiRunning) return
    setAiRunning(true)
    setAiText('')
    rawAccRef.current = ''

    // Check if model is available
    const statusRes = await localAiApi.getStatus().catch(() => null)
    if (!statusRes?.ok || !statusRes.data?.downloaded) {
      setAiText('AI model not downloaded. Go to Settings → Local AI Model to download it.')
      setAiRunning(false)
      return
    }
    if (statusRes.data.loadState !== 'ready') {
      await localAiApi.load().catch(() => {})
      const after = await localAiApi.getStatus().catch(() => null)
      if (!after?.ok || after.data?.loadState !== 'ready') {
        setAiText('Model failed to load. Try again from Settings.')
        setAiRunning(false)
        return
      }
    }

    const requestId = newReqId()
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    unsubRef.current = (push as any).onAiChunk((payload: { requestId: string; chunk: string; done: boolean }) => {
      if (payload.requestId !== requestId) return
      if (payload.done) {
        const final = rawAccRef.current.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
        setAiText(final || rawAccRef.current.trim())
        setAiRunning(false)
        if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
        return
      }
      rawAccRef.current += payload.chunk
      // Live-update: strip think tags
      const display = rawAccRef.current.replace(/<think>[\s\S]*?<\/think>/gi, '')
      const lastOpen  = display.lastIndexOf('<think>')
      const lastClose = display.lastIndexOf('</think>')
      const visible = lastOpen !== -1 && lastOpen > lastClose
        ? display.slice(0, lastOpen).trim()
        : display.trim()
      setAiText(visible || null)
    })

    await localAiApi.complete({
      requestId,
      prompt: `In 2-3 sentences, explain this feature to a customer success manager: "${tip}"`,
      systemPrompt: 'You are B.O.B., a helpful customer success assistant built into the CSM tool. Give a concise, practical explanation. Plain text only.',
      maxTokens: 150,
    }).catch(() => { setAiRunning(false) })
  }, [tip, aiRunning])

  if (!helpMode || !tip) return null

  // Position tooltip so it doesn't overflow the right or bottom edge
  const OFFSET  = 16
  const tipW    = 280
  const tipMaxH = 200
  const x = Math.min(pos.x + OFFSET, window.innerWidth  - tipW   - 12)
  const y = pos.y + OFFSET + tipMaxH > window.innerHeight
    ? pos.y - tipMaxH - OFFSET
    : pos.y + OFFSET

  return (
    <div style={{
      position:     'fixed',
      left:         x,
      top:          y,
      zIndex:       99999,
      width:        tipW,
      padding:      '10px 13px',
      background:   'rgba(13,21,37,0.97)',
      border:       '1px solid rgba(155,109,255,0.4)',
      borderRadius: 8,
      boxShadow:    '0 8px 24px rgba(0,0,0,0.5)',
      pointerEvents: aiRunning || aiText !== null ? 'auto' : 'none',
      backdropFilter:'blur(4px)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ fontSize: 13, color: '#9B6DFF', fontWeight: 700 }}>?</span>
        <span style={{ fontSize: 11, color: '#9B6DFF', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', flex: 1 }}>How-To</span>
        {aiText !== null && (
          <button
            onClick={() => setAiText(null)}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 2, lineHeight: 1 }}
          >
            <X size={11} />
          </button>
        )}
      </div>

      {/* Static tip or AI response */}
      {aiText !== null ? (
        <p style={{ margin: 0, fontSize: 12, color: 'rgba(255,255,255,0.9)', lineHeight: 1.5 }}>
          {aiText || (aiRunning && <span style={{ color: 'rgba(255,255,255,0.4)', fontStyle: 'italic' }}>Thinking…</span>)}
          {aiRunning && aiText && (
            <span style={{ display: 'inline-block', width: 6, height: 12, background: 'var(--color-teal-500)', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'pulse 1s infinite' }} />
          )}
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: 'rgba(255,255,255,0.85)', lineHeight: 1.5 }}>{tip}</p>
      )}

      {/* Ask BOB button */}
      {aiText === null && !aiRunning && (
        <button
          onClick={askBOB}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            marginTop: 8, padding: '3px 8px',
            background: 'rgba(86,183,163,0.12)',
            border: '1px solid rgba(86,183,163,0.3)',
            borderRadius: 5,
            color: 'var(--color-teal-400)',
            fontSize: 10, fontWeight: 600,
            cursor: 'pointer',
            pointerEvents: 'auto',
          }}
        >
          <Sparkles size={9} /> Ask B.O.B. to explain
        </button>
      )}
    </div>
  )
}
