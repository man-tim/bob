/**
 * FeedbackLogger — Developer productivity tool for capturing UI corrections.
 *
 * When "Feedback Logger Mode" is active (toggled in Settings):
 *  1. A red "Logger Active" banner appears at the top of the screen.
 *  2. Any hovered element gets a red outline (like Chrome DevTools inspect mode).
 *  3. Clicking any element intercepts the click (prevents default navigation/actions),
 *     opens a modal asking "What should Claude fix here?", and on submit:
 *     - Captures tag name, id, className, innerText of the element.
 *     - Appends a formatted Markdown block to ~/Desktop/claude-corrections-log.md
 *       via Electron IPC.
 *
 * This is a dev-only tool and should not affect any production functionality.
 * The component renders null when the mode is off.
 */

import { useEffect, useRef, useState } from 'react'
import { Bug, X, Send, CheckCircle, LogOut } from 'lucide-react'
import { useUIStore } from '../../store/ui.store'
import { feedbackApi } from '../../lib/ipc'

// CSS class injected once to style the hover outline
const STYLE_ID = 'bob-feedback-outline-style'

function injectOutlineStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    [data-bob-fb-hover] {
      outline: 2px solid #DA5039 !important;
      outline-offset: 1px !important;
    }
  `
  document.head.appendChild(style)
}

function removeOutlineStyle() {
  document.getElementById(STYLE_ID)?.remove()
}

interface CapturedElement {
  tag:            string
  id:             string
  className:      string
  innerText:      string
  selectorPath:   string   // e.g. "div.page > table.data-table > thead > tr > th:nth-of-type(4)"
  attributes:     string   // meaningful non-class attrs: role, data-*, aria-label, type, etc.
  siblingContext: string   // "[1] col1  [→2] THIS  [3] col3"
  route:          string   // window.location.hash — identifies which page/view
}

// ─── DOM capture helpers ──────────────────────────────────────────────────────

/** Build a CSS selector path from the element up toward <body> (max 8 levels). */
function buildSelectorPath(el: HTMLElement): string {
  const parts: string[] = []
  let current: HTMLElement | null = el
  let depth = 0

  while (current && current.tagName !== 'BODY' && depth < 8) {
    let seg = current.tagName.toLowerCase()

    if (current.id) {
      seg += `#${current.id}`
      parts.unshift(seg)
      break // id is globally unique — stop climbing
    }

    // Keep up to 3 non-generated class names
    const classes = Array.from(current.classList)
      .filter(c => c.length < 40 && !c.match(/^(css-|sc-)[a-zA-Z0-9]+$/))
      .slice(0, 3)
    if (classes.length) {
      seg += '.' + classes.join('.')
    } else if (current.parentElement) {
      // No class — disambiguate with nth-of-type
      const sameTag = Array.from(current.parentElement.children).filter(
        s => s.tagName === current!.tagName
      )
      if (sameTag.length > 1) {
        seg += `:nth-of-type(${sameTag.indexOf(current) + 1})`
      }
    }

    parts.unshift(seg)
    current = current.parentElement
    depth++
  }

  return parts.join(' > ') || el.tagName.toLowerCase()
}

/** Capture meaningful non-class attributes (data-*, role, aria-*, type, etc.). */
function captureAttributes(el: HTMLElement): string {
  const keep = new Set(['role', 'type', 'aria-label', 'aria-labelledby', 'name', 'placeholder', 'title', 'href', 'for'])
  const parts: string[] = []
  for (const attr of Array.from(el.attributes)) {
    if (attr.name === 'class' || attr.name === 'id' || attr.name === 'style') continue
    if (attr.name === 'data-bob-fb-hover') continue
    if (keep.has(attr.name) || attr.name.startsWith('data-') || attr.name.startsWith('aria-')) {
      const val = attr.value.trim().slice(0, 60)
      parts.push(`${attr.name}="${val}"`)
    }
  }
  return parts.join('  ') || '(none)'
}

/** Build sibling context: show same-tag siblings in the parent with → marking this element. */
function buildSiblingContext(el: HTMLElement): string {
  if (!el.parentElement) return '(none)'
  const siblings = Array.from(el.parentElement.children).filter(
    s => s.tagName === el.tagName
  ) as HTMLElement[]
  if (siblings.length <= 1) return '(only child)'

  return siblings.map((s, i) => {
    const isCurrent = s === el
    const text = (s.innerText || s.textContent || '').trim().slice(0, 35)
    return `[${isCurrent ? '→' : ''}${i + 1}] ${text || s.tagName.toLowerCase()}`
  }).join('  ')
}

export function FeedbackLogger() {
  const feedbackLoggerMode       = useUIStore(s => s.feedbackLoggerMode)
  const toggleFeedbackLoggerMode = useUIStore(s => s.toggleFeedbackLoggerMode)
  const [modalOpen,  setModalOpen]  = useState(false)
  const [note,       setNote]       = useState('')
  const [saved,      setSaved]      = useState(false)
  const [savedPath,  setSavedPath]  = useState<string | null>(null)
  const [saveError,  setSaveError]  = useState<string | null>(null)
  const [captured,   setCaptured]   = useState<CapturedElement | null>(null)
  const hoveredRef = useRef<HTMLElement | null>(null)
  const inputRef   = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!feedbackLoggerMode) {
      // Cleanup: remove outline from any leftover element
      hoveredRef.current?.removeAttribute('data-bob-fb-hover')
      hoveredRef.current = null
      removeOutlineStyle()
      return
    }

    injectOutlineStyle()

    // ── Mouse-over: add red outline to hovered element ──────────────────────
    function onMouseOver(e: MouseEvent) {
      const el = e.target as HTMLElement
      if (el === hoveredRef.current) return
      hoveredRef.current?.removeAttribute('data-bob-fb-hover')
      hoveredRef.current = el
      el.setAttribute('data-bob-fb-hover', '1')
    }

    function onMouseOut(e: MouseEvent) {
      const el = e.target as HTMLElement
      el.removeAttribute('data-bob-fb-hover')
      if (hoveredRef.current === el) hoveredRef.current = null
    }

    // ── Click: intercept, capture element info, open modal ─────────────────
    function onClick(e: MouseEvent) {
      // Don't intercept clicks inside our own modal/banner
      const target = e.target as HTMLElement
      if (target.closest('[data-bob-fb-ui]')) return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()

      const el = hoveredRef.current ?? target
      el.removeAttribute('data-bob-fb-hover')
      hoveredRef.current = null

      setCaptured({
        tag:            el.tagName.toLowerCase(),
        id:             el.id || '',
        className:      el.className || '',
        innerText:      (el.innerText || el.textContent || '').trim().slice(0, 120),
        selectorPath:   buildSelectorPath(el),
        attributes:     captureAttributes(el),
        siblingContext: buildSiblingContext(el),
        route:          window.location.hash || window.location.pathname,
      })
      setNote('')
      setSaved(false)
      setSavedPath(null)
      setSaveError(null)
      setModalOpen(true)
    }

    document.addEventListener('mouseover', onMouseOver, true)
    document.addEventListener('mouseout',  onMouseOut,  true)
    document.addEventListener('click',     onClick,     true)

    return () => {
      document.removeEventListener('mouseover', onMouseOver, true)
      document.removeEventListener('mouseout',  onMouseOut,  true)
      document.removeEventListener('click',     onClick,     true)
      hoveredRef.current?.removeAttribute('data-bob-fb-hover')
      hoveredRef.current = null
      removeOutlineStyle()
    }
  }, [feedbackLoggerMode])

  // Focus input when modal opens
  useEffect(() => {
    if (modalOpen) setTimeout(() => inputRef.current?.focus(), 60)
  }, [modalOpen])

  // Escape: close modal if open, otherwise exit feedback logger entirely
  useEffect(() => {
    if (!feedbackLoggerMode) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (modalOpen) {
          setModalOpen(false)
        } else {
          toggleFeedbackLoggerMode()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [feedbackLoggerMode, modalOpen, toggleFeedbackLoggerMode])

  async function handleSubmit() {
    if (!note.trim() || !captured) return
    setSaveError(null)
    const timestamp = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    const result = await feedbackApi.log({
      tag:            captured.tag,
      id:             captured.id,
      className:      captured.className,
      innerText:      captured.innerText,
      selectorPath:   captured.selectorPath,
      attributes:     captured.attributes,
      siblingContext: captured.siblingContext,
      route:          captured.route,
      note:           note.trim(),
      timestamp,
    })
    if (!result.ok) {
      const errMsg = (result as { error?: string }).error ?? 'Write failed — check Desktop permissions.'
      setSaveError(errMsg)
      return
    }
    setSavedPath(result.data?.path ?? null)
    setSaved(true)
    setNote('')
    setTimeout(() => setModalOpen(false), 1200)
  }

  if (!feedbackLoggerMode) return null

  return (
    <>
      {/* Sticky banner */}
      <div data-bob-fb-ui style={{
        position:   'fixed',
        top:        0,
        left:       0,
        right:      0,
        zIndex:     99998,
        height:     30,
        background: 'linear-gradient(90deg, #DA5039, #c03020)',
        display:    'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap:        8,
        fontSize:   11,
        fontWeight: 700,
        color:      'white',
        letterSpacing: '0.04em',
        userSelect: 'none',
      }}>
        <Bug size={12} />
        FEEDBACK LOGGER ACTIVE — Click any element to log a correction
        <span style={{ opacity: 0.7, fontSize: 10, fontWeight: 400 }}>(Esc to exit)</span>
        <button
          data-bob-fb-ui
          onClick={toggleFeedbackLoggerMode}
          title="Exit Feedback Logger"
          style={{
            position: 'absolute', right: 10,
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.4)',
            borderRadius: 4, color: 'white', cursor: 'pointer',
            padding: '2px 8px', fontSize: 10, fontWeight: 700,
          }}
        >
          <LogOut size={10} /> EXIT
        </button>
      </div>

      {/* Modal */}
      {modalOpen && (
        <>
          {/* Backdrop */}
          <div
            data-bob-fb-ui
            onClick={() => setModalOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(2px)' }}
          />

          <div data-bob-fb-ui style={{
            position:  'fixed',
            top:       '50%',
            left:      '50%',
            transform: 'translate(-50%, -50%)',
            zIndex:    100001,
            width:     480,
            maxWidth:  'calc(100vw - 32px)',
            background:'var(--color-bg-card)',
            border:    '2px solid #DA5039',
            borderRadius: 'var(--radius-xl)',
            boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
            overflow:  'hidden',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--color-border)', background: 'rgba(218,80,57,0.08)' }}>
              <Bug size={16} strokeWidth={2} style={{ color: '#DA5039', flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--color-text-primary)' }}>What should Claude fix here?</div>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 1 }}>
                  {captured?.tag}
                  {captured?.id && ` #${captured.id}`}
                  {captured?.innerText ? ` · "${captured.innerText.slice(0, 40)}${captured.innerText.length > 40 ? '…' : ''}"` : ''}
                </div>
              </div>
              <button onClick={() => setModalOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 4 }}>
                <X size={15} />
              </button>
            </div>

            {/* Input */}
            <div style={{ padding: '14px 16px' }}>
              <input
                ref={inputRef}
                value={note}
                onChange={e => setNote(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
                placeholder="Describe the issue or what needs to change…"
                style={{
                  width: '100%', padding: '9px 12px',
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--color-text-primary)',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'inherit',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />

              {/* Captured element info */}
              <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--color-bg-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)', lineHeight: 1.8 }}>
                {captured?.route     && <div><b>route:</b> {captured.route}</div>}
                <div><b>tag:</b> {captured?.tag}{captured?.id ? ` #${captured.id}` : ''}</div>
                {captured?.innerText && <div><b>text:</b> "{captured.innerText}"</div>}
                {captured?.selectorPath && (
                  <div style={{ marginTop: 3 }}>
                    <b>path:</b>
                    <div style={{ paddingLeft: 10, wordBreak: 'break-all', color: 'var(--color-teal-400)' }}>{captured.selectorPath}</div>
                  </div>
                )}
                {captured?.attributes !== '(none)' && <div style={{ marginTop: 2 }}><b>attrs:</b> {captured?.attributes}</div>}
                {captured?.siblingContext && captured.siblingContext !== '(only child)' && (
                  <div style={{ marginTop: 3 }}>
                    <b>siblings:</b>
                    <div style={{ paddingLeft: 10, wordBreak: 'break-word' }}>{captured.siblingContext}</div>
                  </div>
                )}
              </div>

              {/* Submit */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                {saveError && (
                  <div style={{ flex: 1, fontSize: 10, color: '#DA5039', marginRight: 8, alignSelf: 'center' }}>
                    ⚠ {saveError}
                  </div>
                )}
                {saved ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#34A853', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                      <CheckCircle size={16} /> Saved!
                    </div>
                    {savedPath && (
                      <div style={{ fontSize: 9, color: 'var(--color-text-muted)', maxWidth: 260, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {savedPath}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={handleSubmit}
                    disabled={!note.trim()}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '8px 18px',
                      background: note.trim() ? '#DA5039' : 'var(--color-bg-elevated)',
                      border: 'none',
                      borderRadius: 'var(--radius-md)',
                      color: note.trim() ? 'white' : 'var(--color-text-muted)',
                      fontWeight: 700, fontSize: 'var(--text-sm)',
                      cursor: note.trim() ? 'pointer' : 'not-allowed',
                    }}
                  >
                    <Send size={13} /> Log Correction
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
