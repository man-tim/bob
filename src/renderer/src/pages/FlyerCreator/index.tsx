import { useState, useEffect, useRef } from 'react'
import {
  Upload,
  Plus,
  Trash2,
  Folder,
  FileText,
  CheckCircle2,
  ChevronRight,
  RefreshCw,
} from 'lucide-react'
import { Button, Card } from '../../components/ui'
import { flyerApi, fsApi } from '../../lib/ipc'
import type { FlyerLocation, FlyerGenerateResult, ElementPosition, ElementLayout } from '../../lib/ipc'
import { IPC } from '@shared/ipc-channels'

// ─── Template metadata ────────────────────────────────────────────────────────

type TemplateId = 'btm' | 'blue' | 'trucking'

interface TemplateMeta {
  id:          TemplateId
  label:       string
  description: string
  bg:          string
  accent:      string
  badgeBg:     string
  badgeText:   string
  headline:    string
}

const TEMPLATES: TemplateMeta[] = [
  {
    id:          'btm',
    label:       'BTM Opt-In',
    description: 'SMS opt-in flyer with navy background',
    bg:          '#131C2F',
    accent:      '#56B7A3',
    badgeBg:     '#56B7A3',
    badgeText:   '#131C2F',
    headline:    'Text Us to Opt In',
  },
  {
    id:          'blue',
    label:       'Text Us — Blue',
    description: 'Clean teal flyer for general use',
    bg:          '#2A7991',
    accent:      '#F4B74E',
    badgeBg:     '#F4B74E',
    badgeText:   '#2A7991',
    headline:    'Text Us',
  },
  {
    id:          'trucking',
    label:       'Text Us — VSN',
    description: 'Trucking/VSN number collection',
    bg:          '#0D1C30',
    accent:      '#469C6C',
    badgeBg:     '#469C6C',
    badgeText:   '#0D1C30',
    headline:    'Text Your VSN',
  },
]

// ─── Element positioning constants ───────────────────────────────────────────

const TMPL_W = 612
const TMPL_H = 792
const PREV_SCALE = 0.60  // display at ~60% → 367×475 px
const PREV_W = Math.round(TMPL_W * PREV_SCALE)
const PREV_H = Math.round(TMPL_H * PREV_SCALE)

type ElKey = 'logo' | 'logo2' | 'phone' | 'qr'

const EL_COLORS: Record<ElKey, string> = {
  logo:  '#4F8EF7',
  logo2: '#469C6C',
  phone: '#F4B74E',
  qr:    '#56B7A3',
}
const EL_LABELS: Record<ElKey, string> = {
  logo:  'Logo',
  logo2: 'Logo 2',
  phone: 'Phone',
  qr:    'QR',
}

const DEFAULT_LAYOUTS: Record<TemplateId, ElementLayout> = {
  btm:      { logo: {x:50,y:326,w:142,h:52}, logo2: {x:396,y:693,w:182,h:67}, phone: {x:228,y:348,w:365,h:75}, qr: {x:305,y:460,w:205,h:205} },
  blue:     { logo: {x:50,y:320,w:142,h:52}, logo2: {x:396,y:693,w:182,h:67}, phone: {x:228,y:345,w:365,h:78}, qr: {x:305,y:475,w:205,h:205} },
  trucking: { logo: {x:50,y:320,w:142,h:52}, logo2: {x:396,y:693,w:182,h:67}, phone: {x:228,y:345,w:365,h:78}, qr: {x:305,y:475,w:205,h:205} },
}

// ─── Draggable element overlay ────────────────────────────────────────────────

interface DragState {
  el: ElKey
  mode: 'move' | 'resize'
  startX: number
  startY: number
  startPos: ElementPosition
}

function ElementOverlay({
  elKey, pos, color, label,
  onMouseDown,
}: {
  elKey: ElKey
  pos: ElementPosition
  color: string
  label: string
  onMouseDown: (e: React.MouseEvent, el: ElKey, mode: 'move' | 'resize') => void
}) {
  return (
    <div
      style={{
        position:  'absolute',
        left:      pos.x * PREV_SCALE,
        top:       pos.y * PREV_SCALE,
        width:     pos.w * PREV_SCALE,
        height:    pos.h * PREV_SCALE,
        border:    `1.5px solid ${color}`,
        boxSizing: 'border-box',
        cursor:    'move',
        userSelect:'none',
      }}
      onMouseDown={e => { e.preventDefault(); onMouseDown(e, elKey, 'move') }}
    >
      {/* Label */}
      <div style={{
        position:   'absolute',
        top:        0,
        left:       0,
        fontSize:   8,
        lineHeight: '1',
        padding:    '1px 3px',
        background: color,
        color:      '#000',
        fontWeight: 700,
        pointerEvents: 'none',
      }}>
        {label}
      </div>
      {/* Resize handle */}
      <div
        style={{
          position:  'absolute',
          right:     -3,
          bottom:    -3,
          width:     7,
          height:    7,
          background: color,
          cursor:    'se-resize',
        }}
        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onMouseDown(e, elKey, 'resize') }}
      />
    </div>
  )
}

function LayoutEditor({
  templateId,
  dataUrl,
  layout,
  onLayout,
  onReset,
}: {
  templateId: TemplateId | ''
  dataUrl:    string | undefined
  layout:     ElementLayout | null
  onLayout:   (l: ElementLayout) => void
  onReset:    () => void
}) {
  const dragRef = useRef<DragState | null>(null)

  function startDrag(e: React.MouseEvent, el: ElKey, mode: 'move' | 'resize') {
    if (!layout) return
    dragRef.current = {
      el, mode,
      startX: e.clientX,
      startY: e.clientY,
      startPos: { ...layout[el] },
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    const drag = dragRef.current
    if (!drag || !layout) return
    const dx = (e.clientX - drag.startX) / PREV_SCALE
    const dy = (e.clientY - drag.startY) / PREV_SCALE
    const p  = drag.startPos
    if (drag.mode === 'move') {
      onLayout({
        ...layout,
        [drag.el]: {
          ...p,
          x: Math.round(Math.max(0, Math.min(TMPL_W - p.w, p.x + dx))),
          y: Math.round(Math.max(0, Math.min(TMPL_H - p.h, p.y + dy))),
        },
      })
    } else {
      onLayout({
        ...layout,
        [drag.el]: {
          ...p,
          w: Math.round(Math.max(20, Math.min(TMPL_W - p.x, p.w + dx))),
          h: Math.round(Math.max(20, Math.min(TMPL_H - p.y, p.h + dy))),
        },
      })
    }
  }

  function handleMouseUp() {
    dragRef.current = null
  }

  if (!templateId || !dataUrl) {
    return (
      <div style={{
        width: PREV_W, height: PREV_H,
        background: 'var(--color-bg-elevated)',
        borderRadius: 8, border: '1px dashed var(--color-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'center', padding: 12 }}>
          {!templateId ? 'Select a template' : 'Loading…'}
        </span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
      <div
        style={{ position: 'relative', width: PREV_W, height: PREV_H, borderRadius: 6, overflow: 'hidden', boxShadow: '0 4px 16px rgba(0,0,0,0.4)', flexShrink: 0, cursor: 'default' }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <img src={dataUrl} style={{ width: PREV_W, height: PREV_H, display: 'block', pointerEvents: 'none' }} draggable={false} />
        {layout && (Object.keys(layout) as ElKey[]).map(key => (
          <ElementOverlay
            key={key}
            elKey={key}
            pos={layout[key]}
            color={EL_COLORS[key]}
            label={EL_LABELS[key]}
            onMouseDown={startDrag}
          />
        ))}
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {(Object.keys(EL_COLORS) as ElKey[]).map(k => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <div style={{ width: 8, height: 8, background: EL_COLORS[k], borderRadius: 1 }} />
            <span style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>{EL_LABELS[k]}</span>
          </div>
        ))}
      </div>
      <button
        onClick={onReset}
        style={{ fontSize: 10, color: 'var(--color-text-muted)', background: 'none', border: '1px solid var(--color-border)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
      >
        Reset positions
      </button>
    </div>
  )
}

// ─── Step header ──────────────────────────────────────────────────────────────

function StepHeader({ current }: { current: 1 | 2 | 3 | 4 }) {
  const steps = [
    { n: 1 as const, label: 'Setup' },
    { n: 2 as const, label: 'Arrange' },
    { n: 3 as const, label: 'Locations' },
    { n: 4 as const, label: 'Generate' },
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 'var(--space-6)' }}>
      {steps.map((s, i) => {
        const done   = current > s.n
        const active = current === s.n
        return (
          <div key={s.n} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width:           28,
                  height:          28,
                  borderRadius:    '50%',
                  display:         'flex',
                  alignItems:      'center',
                  justifyContent:  'center',
                  fontWeight:      'var(--weight-bold)',
                  fontSize:        'var(--text-sm)',
                  background:      done
                                     ? 'var(--color-green-400)'
                                     : active
                                       ? 'var(--color-teal-500)'
                                       : 'var(--color-bg-elevated)',
                  color:           done || active ? '#fff' : 'var(--color-text-muted)',
                  transition:      'var(--transition-fast)',
                }}
              >
                {done ? <CheckCircle2 size={14} /> : s.n}
              </div>
              <span
                style={{
                  fontSize:   'var(--text-sm)',
                  fontWeight: active ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                  color:      active ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                }}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <ChevronRight
                size={16}
                style={{ color: 'var(--color-text-muted)', margin: '0 10px' }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Section label ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize:      'var(--text-sm)',
      fontWeight:    'var(--weight-semibold)',
      color:         'var(--color-text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      marginBottom:  'var(--space-2)',
    }}>
      {children}
    </div>
  )
}

// ─── Input style helper ───────────────────────────────────────────────────────

function inputStyle(invalid = false): React.CSSProperties {
  return {
    background:   'var(--color-bg-elevated)',
    border:       `1px solid ${invalid ? 'var(--color-red-400)' : 'var(--color-border)'}`,
    borderRadius: 'var(--radius-md)',
    color:        'var(--color-text-primary)',
    fontSize:     'var(--text-sm)',
    padding:      '7px 10px',
    outline:      'none',
    width:        '100%',
    transition:   'var(--transition-fast)',
  }
}

// ─── Location row ─────────────────────────────────────────────────────────────

function LocationRow({
  loc,
  index,
  showErrors,
  onChange,
  onRemove,
}: {
  loc:        FlyerLocation
  index:      number
  showErrors: boolean
  onChange:   (index: number, field: keyof FlyerLocation, value: string) => void
  onRemove:   (index: number) => void
}) {
  const phoneInvalid = showErrors && loc.phone.replace(/\D/g, '').slice(-10).length < 7

  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start', marginBottom: 'var(--space-2)' }}>
      <div style={{ flex: 1 }}>
        <input
          style={inputStyle()}
          placeholder="Location name (optional)"
          value={loc.name}
          onChange={e => onChange(index, 'name', e.target.value)}
        />
      </div>
      <div style={{ flex: 1 }}>
        <input
          style={inputStyle(phoneInvalid)}
          placeholder="Phone number *"
          value={loc.phone}
          onChange={e => onChange(index, 'phone', e.target.value)}
        />
        {phoneInvalid && (
          <div style={{ fontSize: 11, color: 'var(--color-red-400)', marginTop: 2 }}>
            Phone is required
          </div>
        )}
      </div>
      <button
        onClick={() => onRemove(index)}
        style={{
          background:   'none',
          border:       '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          color:        'var(--color-text-muted)',
          cursor:       'pointer',
          padding:      '7px 8px',
          display:      'flex',
          alignItems:   'center',
          flexShrink:   0,
          transition:   'var(--transition-fast)',
        }}
        title="Remove location"
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

// ─── Main page component ──────────────────────────────────────────────────────

export function FlyerCreator() {
  const [templatePreviews, setTemplatePreviews] = useState<Record<string, string>>({})
  const [step,          setStep]          = useState<1 | 2 | 3 | 4>(1)
  const [templateId,    setTemplateId]    = useState<TemplateId | ''>('')
  const [layout,        setLayout]        = useState<ElementLayout | null>(null)
  const [companyName,   setCompanyName]   = useState('')
  const [logoPath,      setLogoPath]      = useState<string | null>(null)
  const [logoName,      setLogoName]      = useState('')
  const [keyword,       setKeyword]       = useState('')
  const [locations,     setLocations]     = useState<FlyerLocation[]>([{ name: '', phone: '' }])
  const [outputDir,     setOutputDir]     = useState<string | null>(null)
  const [generating,    setGenerating]    = useState(false)
  const [showLocErrors, setShowLocErrors] = useState(false)
  const [progress,      setProgress]      = useState<{ done: number; total: number; filename: string } | null>(null)
  const [result,        setResult]        = useState<FlyerGenerateResult | null>(null)

  const selectedTemplate = TEMPLATES.find(t => t.id === templateId) ?? null
  const validLocations   = locations.filter(l => l.phone.replace(/\D/g, '').slice(-10).length >= 7)

  useEffect(() => {
    const ids: TemplateId[] = ['btm', 'blue', 'trucking']
    for (const id of ids) {
      flyerApi.getTemplate(id).then(r => {
        if (r.ok && r.data?.dataUrl) {
          setTemplatePreviews(prev => ({ ...prev, [id]: r.data!.dataUrl }))
        }
      })
    }
  }, [])

  // ── Step 1 handlers ──────────────────────────────────────────────────────────

  async function handleSelectLogo() {
    const res = await fsApi.openDialog({
      title:      'Select Logo',
      filters:    [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'] }],
      properties: ['openFile'],
    })
    if (res.ok && !res.data?.canceled && res.data?.filePaths?.length) {
      const p = res.data.filePaths[0]
      setLogoPath(p)
      setLogoName(p.split('/').pop() ?? p.split('\\').pop() ?? p)
    }
  }

  function handleClearLogo() {
    setLogoPath(null)
    setLogoName('')
  }

  // ── Step 2 handlers ──────────────────────────────────────────────────────────

  function handleLocationChange(index: number, field: keyof FlyerLocation, value: string) {
    setLocations(prev => prev.map((loc, i) => i === index ? { ...loc, [field]: value } : loc))
  }

  function handleAddLocation() {
    setLocations(prev => [...prev, { name: '', phone: '' }])
  }

  function handleAddFive() {
    setLocations(prev => [...prev, ...Array.from({ length: 5 }, () => ({ name: '', phone: '' }))])
  }

  function handleRemoveLocation(index: number) {
    setLocations(prev => prev.length > 1 ? prev.filter((_, i) => i !== index) : prev)
  }

  // ── CSV Import ────────────────────────────────────────────────────────────────

  const [csvImporting, setCsvImporting] = useState(false)
  const [csvMsg,       setCsvMsg]       = useState<string | null>(null)

  /** Fuzzy header detection: returns column index or -1 */
  function detectCol(headers: string[], candidates: string[]): number {
    const h = headers.map(s => s.toLowerCase().trim())
    for (const c of candidates) {
      const i = h.findIndex(cell => cell.includes(c))
      if (i >= 0) return i
    }
    return -1
  }

  /** Simple CSV line parser (handles quoted fields) */
  function parseCsvLine(line: string): string[] {
    const cells: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = !inQ
      } else if (ch === ',' && !inQ) {
        cells.push(cur); cur = ''
      } else {
        cur += ch
      }
    }
    cells.push(cur)
    return cells.map(s => s.trim())
  }

  async function handleImportCsv() {
    const res = await fsApi.openDialog({
      title:      'Import Locations from CSV',
      filters:    [{ name: 'CSV Spreadsheets', extensions: ['csv', 'txt'] }],
      properties: ['openFile'],
    })
    if (!res.ok || res.data?.canceled || !res.data?.filePaths?.length) return

    setCsvImporting(true)
    setCsvMsg(null)

    try {
      const path   = res.data.filePaths[0]
      // Read via Electron fs
      const readRes = await window.electron.invoke<string>(IPC.FS_READ_TEXT_FILE, path)
      const text    = typeof readRes === 'string' ? readRes : (readRes as { data?: string })?.data ?? ''
      if (!text) { setCsvMsg('Could not read file.'); return }

      const lines   = text.split(/\r?\n/).filter(l => l.trim())
      if (lines.length < 2) { setCsvMsg('CSV must have at least a header row and one data row.'); return }

      const headers = parseCsvLine(lines[0])

      // Detect columns
      const nameCol    = detectCol(headers, ['location name', 'location', 'name', 'branch', 'site'])
      const companyCol = detectCol(headers, ['company name', 'company', 'account', 'customer'])
      const phoneCol   = detectCol(headers, ['phone', 'telephone', 'number', 'mobile', 'cell', 'contact'])

      if (phoneCol === -1) {
        setCsvMsg(`Could not detect a phone column. Found headers: ${headers.join(', ')}`)
        return
      }

      const imported: FlyerLocation[] = []
      for (let i = 1; i < lines.length; i++) {
        const cells = parseCsvLine(lines[i])
        const phone = cells[phoneCol]?.replace(/\D/g, '').slice(-10) ?? ''
        if (!phone) continue
        // Name: prefer location col, fall back to company col, fall back to empty
        const name = (nameCol >= 0 ? cells[nameCol] : '') ||
                     (companyCol >= 0 ? cells[companyCol] : '') || ''
        imported.push({ name, phone })
      }

      if (imported.length === 0) {
        setCsvMsg('No valid locations found (need at least one row with a phone number).')
        return
      }

      setLocations(prev => {
        // Replace blank rows, append rest
        const nonBlank = prev.filter(l => l.name || l.phone)
        return [...nonBlank, ...imported]
      })
      setCsvMsg(`Imported ${imported.length} location${imported.length !== 1 ? 's' : ''} from CSV.`)
    } catch (err) {
      setCsvMsg(`Error reading CSV: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCsvImporting(false)
    }
  }

  function handleStep3Next() {
    if (validLocations.length === 0) {
      setShowLocErrors(true)
      return
    }
    setStep(4)
  }

  // ── Step 4 handlers ──────────────────────────────────────────────────────────

  async function handleSelectOutputDir() {
    const res = await fsApi.openDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.ok && !res.data?.canceled && res.data?.filePaths?.length) {
      setOutputDir(res.data.filePaths[0])
    }
  }

  async function handleGenerate() {
    if (!outputDir || validLocations.length === 0 || !templateId) return
    setGenerating(true)
    setResult(null)
    setProgress({ done: 0, total: validLocations.length, filename: '' })

    const r = await flyerApi.generate({
      templateId: templateId as TemplateId,
      logoPath,
      locations: validLocations,
      defaultKeyword: keyword || (templateId === 'btm' ? 'START' : 'Text Us!'),
      outputDir,
      companyName: companyName || undefined,
      layout: layout ?? undefined,
    })

    setGenerating(false)
    if (r.ok) {
      setResult(r.data)
      setProgress(null)
    }
  }

  function handleOpenFolder() {
    if (outputDir) {
      fsApi.openExternal(outputDir)
    }
  }

  function handleReset() {
    setStep(1)
    setTemplateId('')
    setLayout(null)
    setCompanyName('')
    setLogoPath(null)
    setLogoName('')
    setKeyword('')
    setLocations([{ name: '', phone: '' }])
    setOutputDir(null)
    setGenerating(false)
    setProgress(null)
    setResult(null)
    setShowLocErrors(false)
  }

  // ─── Layout styles ────────────────────────────────────────────────────────────

  const twoCol: React.CSSProperties = {
    display:    'flex',
    gap:        'var(--space-6)',
    alignItems: 'flex-start',
  }

  const mainCol: React.CSSProperties = { flex: 1, minWidth: 0 }

  const sideCol: React.CSSProperties = {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    gap:            'var(--space-3)',
    paddingTop:     'var(--space-2)',
    flexShrink:     0,
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 'var(--space-6)', maxWidth: 960 }}>
      <div style={{ marginBottom: 'var(--space-2)' }}>
        <h1 style={{ fontSize: 22, fontWeight: 'var(--weight-bold)', color: 'var(--color-text-primary)', margin: 0 }}>
          Flyer Creator
        </h1>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginTop: 4 }}>
          Generate QR-code SMS flyers as print-ready PDFs
        </p>
      </div>

      <div style={{ marginBottom: 'var(--space-5)', marginTop: 'var(--space-5)' }}>
        <StepHeader current={step} />
      </div>

      <div style={twoCol}>
        {/* ── Main column ──────────────────────────────────────────────────────── */}
        <div style={mainCol}>

          {/* ══════════════════════════ STEP 1 — Setup ═════════════════════════ */}
          {step === 1 && (
            <Card style={{ padding: 'var(--space-5)' }}>

              {/* Template picker */}
              <div style={{ marginBottom: 'var(--space-5)' }}>
                <SectionLabel>Template</SectionLabel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  {TEMPLATES.map(tmpl => (
                    <div
                      key={tmpl.id}
                      onClick={() => {
                        setTemplateId(tmpl.id)
                        setLayout({ ...DEFAULT_LAYOUTS[tmpl.id] })
                        setKeyword(tmpl.id === 'btm' ? 'START' : 'Text Us!')
                      }}
                      style={{
                        display:      'flex',
                        alignItems:   'center',
                        gap:          'var(--space-3)',
                        padding:      'var(--space-3) var(--space-4)',
                        border:       `2px solid ${templateId === tmpl.id ? 'var(--color-teal-500)' : 'var(--color-border)'}`,
                        borderRadius: 'var(--radius-md)',
                        cursor:       'pointer',
                        background:   templateId === tmpl.id ? 'var(--color-bg-active)' : 'var(--color-bg-elevated)',
                        transition:   'var(--transition-fast)',
                      }}
                    >
                      {/* Color swatch */}
                      <div style={{
                        width:        32,
                        height:       32,
                        borderRadius: 6,
                        background:   tmpl.bg,
                        border:       `3px solid ${tmpl.accent}`,
                        flexShrink:   0,
                      }} />

                      <div style={{ flex: 1 }}>
                        <div style={{
                          fontWeight: 'var(--weight-semibold)',
                          fontSize:   'var(--text-sm)',
                          color:      'var(--color-text-primary)',
                        }}>
                          {tmpl.label}
                        </div>
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                          {tmpl.description}
                        </div>
                      </div>

                      {/* Radio dot */}
                      <div style={{
                        width:        18,
                        height:       18,
                        borderRadius: '50%',
                        border:       `2px solid ${templateId === tmpl.id ? 'var(--color-teal-500)' : 'var(--color-border)'}`,
                        background:   templateId === tmpl.id ? 'var(--color-teal-500)' : 'transparent',
                        transition:   'var(--transition-fast)',
                        flexShrink:   0,
                      }} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Company name */}
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <SectionLabel>Company Name</SectionLabel>
                <input
                  style={inputStyle()}
                  placeholder="e.g. Acme Logistics  (used in filenames)"
                  value={companyName}
                  onChange={e => setCompanyName(e.target.value)}
                />
              </div>

              {/* Logo */}
              <div style={{ marginBottom: 'var(--space-5)' }}>
                <SectionLabel>Logo (optional)</SectionLabel>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <Button variant="secondary" onClick={handleSelectLogo}>
                    <Upload size={14} style={{ marginRight: 6 }} />
                    Select Logo File
                  </Button>
                  {logoName
                    ? (
                      <>
                        <span style={{
                          fontSize:     'var(--text-sm)',
                          color:        'var(--color-text-secondary)',
                          maxWidth:     200,
                          overflow:     'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace:   'nowrap',
                        }}>
                          {logoName}
                        </span>
                        <button
                          onClick={handleClearLogo}
                          style={{
                            background:   'none',
                            border:       'none',
                            cursor:       'pointer',
                            color:        'var(--color-text-muted)',
                            fontSize:     'var(--text-sm)',
                            padding:      '2px 6px',
                          }}
                        >
                          Clear
                        </button>
                      </>
                    )
                    : (
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                        No file selected
                      </span>
                    )
                  }
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 6 }}>
                  PNG, JPG, SVG, WebP — displayed in white on the flyer
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  variant="primary"
                  onClick={() => setStep(2)}
                  disabled={!templateId}
                >
                  Next
                  <ChevronRight size={14} style={{ marginLeft: 4 }} />
                </Button>
              </div>
            </Card>
          )}

          {/* ══════════════════════════ STEP 2 — Arrange ═══════════════════════ */}
          {step === 2 && (
            <Card style={{ padding: 'var(--space-5)' }}>
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <SectionLabel>Position Elements</SectionLabel>
                <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-4)' }}>
                  Drag the colored boxes on the preview to position your logo, phone number, and QR code. Use the corner handle to resize.
                </p>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <LayoutEditor
                    templateId={templateId}
                    dataUrl={templateId ? templatePreviews[templateId] : undefined}
                    layout={layout}
                    onLayout={setLayout}
                    onReset={() => templateId && setLayout({ ...DEFAULT_LAYOUTS[templateId as TemplateId] })}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-4)' }}>
                <Button variant="secondary" onClick={() => setStep(1)}>← Back</Button>
                <Button variant="primary" onClick={() => setStep(3)}>
                  Next <ChevronRight size={14} style={{ marginLeft: 4 }} />
                </Button>
              </div>
            </Card>
          )}

          {/* ══════════════════════════ STEP 3 — Locations ══════════════════════ */}
          {step === 3 && (
            <Card style={{ padding: 'var(--space-5)' }}>

              {/* Default keyword */}
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <SectionLabel>Default Keyword</SectionLabel>
                <input
                  style={{ ...inputStyle(), maxWidth: 200 }}
                  placeholder="START"
                  value={keyword}
                  onChange={e => setKeyword(e.target.value.toUpperCase())}
                />
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                  The SMS keyword recipients will text. Uppercase recommended.
                </div>
              </div>

              {/* Location rows */}
              <div style={{ marginBottom: 'var(--space-3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--space-2)' }}>
                  <SectionLabel>Locations</SectionLabel>
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
                    ({validLocations.length} valid)
                  </span>
                </div>

                {/* Column headers */}
                <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-1)', paddingRight: 38 }}>
                  <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text-muted)' }}>Name</div>
                  <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text-muted)' }}>Phone *</div>
                </div>

                <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                  {locations.map((loc, i) => (
                    <LocationRow
                      key={i}
                      loc={loc}
                      index={i}
                      showErrors={showLocErrors}
                      onChange={handleLocationChange}
                      onRemove={handleRemoveLocation}
                    />
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button variant="secondary" onClick={handleAddLocation}>
                    <Plus size={14} style={{ marginRight: 4 }} />
                    Add Location
                  </Button>
                  <Button variant="secondary" onClick={handleAddFive}>
                    Add 5 More
                  </Button>
                  <div style={{ width: 1, height: 22, background: 'var(--color-border)', margin: '0 4px' }} />
                  <Button
                    variant="secondary"
                    icon={<Upload size={13} />}
                    loading={csvImporting}
                    onClick={handleImportCsv}
                    title="Import locations from a CSV or spreadsheet export"
                  >
                    Import from CSV
                  </Button>
                </div>

                {csvMsg && (
                  <div style={{ marginTop: 'var(--space-2)', padding: '6px 10px', background: 'rgba(86,183,163,0.08)', border: '1px solid rgba(86,183,163,0.2)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    {csvMsg}
                    <button onClick={() => setCsvMsg(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 0, fontSize: 12, lineHeight: 1 }}>✕</button>
                  </div>
                )}

                {showLocErrors && validLocations.length === 0 && (
                  <div style={{ color: 'var(--color-red-400)', fontSize: 'var(--text-sm)', marginTop: 8 }}>
                    At least one location with a valid phone number is required.
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-2)' }}>
                <Button variant="secondary" onClick={() => setStep(2)}>
                  ← Back
                </Button>
                <Button variant="primary" onClick={handleStep3Next}>
                  Next
                  <ChevronRight size={14} style={{ marginLeft: 4 }} />
                </Button>
              </div>
            </Card>
          )}

          {/* ══════════════════════════ STEP 4 — Generate ═══════════════════════ */}
          {step === 4 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>

              {/* Summary card */}
              <Card style={{ padding: 'var(--space-4)' }}>
                <div style={{
                  fontWeight:   'var(--weight-semibold)',
                  fontSize:     'var(--text-sm)',
                  marginBottom: 'var(--space-3)',
                  color:        'var(--color-text-primary)',
                }}>
                  Summary
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  {([
                    ['Template',   selectedTemplate?.label ?? '—'],
                    ['Company',    companyName || '—'],
                    ['Logo',       logoName || 'None'],
                    ['Locations',  `${validLocations.length} location${validLocations.length !== 1 ? 's' : ''}`],
                    ['Keyword',    keyword || (templateId === 'btm' ? 'START' : 'Text Us!')],
                  ] as [string, string][]).map(([label, value]) => (
                    <div key={label}>
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {label}
                      </div>
                      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-primary)', fontWeight: 'var(--weight-medium)' }}>
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Output folder */}
              <Card style={{ padding: 'var(--space-4)' }}>
                <SectionLabel>Output Folder</SectionLabel>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
                  <Button variant="secondary" onClick={handleSelectOutputDir}>
                    <Folder size={14} style={{ marginRight: 6 }} />
                    Select Output Folder
                  </Button>
                  {outputDir
                    ? (
                      <span style={{
                        fontSize:     'var(--text-sm)',
                        color:        'var(--color-text-secondary)',
                        overflow:     'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace:   'nowrap',
                        maxWidth:     320,
                        fontFamily:   'var(--font-mono)',
                      }}>
                        {outputDir}
                      </span>
                    )
                    : (
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                        No folder selected
                      </span>
                    )
                  }
                </div>
              </Card>

              {/* Generate + progress + result */}
              <Card style={{ padding: 'var(--space-4)' }}>
                {!result && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <Button
                        variant="primary"
                        onClick={handleGenerate}
                        disabled={!outputDir || generating}
                      >
                        {generating
                          ? (
                            <>
                              <RefreshCw size={14} style={{ marginRight: 6, animation: 'spin 1s linear infinite' }} />
                              Generating…
                            </>
                          )
                          : (
                            <>
                              <FileText size={14} style={{ marginRight: 6 }} />
                              Generate Flyers
                            </>
                          )
                        }
                      </Button>
                      <Button variant="secondary" onClick={() => setStep(3)} disabled={generating}>
                        ← Back
                      </Button>
                    </div>

                    {generating && progress && (
                      <div style={{ marginTop: 'var(--space-4)' }}>
                        <div style={{
                          display:        'flex',
                          justifyContent: 'space-between',
                          fontSize:       'var(--text-sm)',
                          color:          'var(--color-text-muted)',
                          marginBottom:   4,
                        }}>
                          <span>
                            {progress.filename
                              ? `Generating: ${progress.filename}`
                              : `Processing ${progress.done} of ${progress.total}…`}
                          </span>
                          <span>{progress.done} / {progress.total}</span>
                        </div>
                        <div style={{
                          height:       6,
                          background:   'var(--color-bg-elevated)',
                          borderRadius: 3,
                          overflow:     'hidden',
                        }}>
                          <div style={{
                            height:     '100%',
                            width:      `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
                            background: 'var(--color-teal-500)',
                            borderRadius: 3,
                            transition: 'width 0.3s ease',
                          }} />
                        </div>
                      </div>
                    )}
                  </>
                )}

                {result && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--space-3)' }}>
                      <CheckCircle2 size={20} style={{ color: 'var(--color-green-400)' }} />
                      <span style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--color-text-primary)' }}>
                        {result.files.length} flyer{result.files.length !== 1 ? 's' : ''} generated
                        {result.zipPath ? ' + ZIP' : ''}
                      </span>
                    </div>

                    {result.errors.length > 0 && (
                      <div style={{
                        background:   'rgba(218,80,57,0.1)',
                        border:       '1px solid var(--color-red-400)',
                        borderRadius: 'var(--radius-md)',
                        padding:      'var(--space-3)',
                        marginBottom: 'var(--space-3)',
                      }}>
                        <div style={{
                          fontSize:     'var(--text-sm)',
                          fontWeight:   'var(--weight-semibold)',
                          color:        'var(--color-red-400)',
                          marginBottom: 4,
                        }}>
                          {result.errors.length} error{result.errors.length !== 1 ? 's' : ''}:
                        </div>
                        {result.errors.map((e, i) => (
                          <div key={i} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-red-400)' }}>
                            • {e}
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 'var(--space-3)' }}>
                      {result.files.map((f, i) => (
                        <div key={i} style={{
                          display:    'flex',
                          alignItems: 'center',
                          gap:        8,
                          fontSize:   'var(--text-sm)',
                          color:      'var(--color-text-secondary)',
                          fontFamily: 'var(--font-mono)',
                        }}>
                          <FileText size={12} style={{ color: 'var(--color-teal-500)', flexShrink: 0 }} />
                          {f.split('/').pop() ?? f.split('\\').pop() ?? f}
                        </div>
                      ))}
                      {result.zipPath && (
                        <div style={{
                          display:    'flex',
                          alignItems: 'center',
                          gap:        8,
                          fontSize:   'var(--text-sm)',
                          color:      'var(--color-gold-500)',
                          fontFamily: 'var(--font-mono)',
                          marginTop:  4,
                        }}>
                          <Folder size={12} style={{ flexShrink: 0 }} />
                          {result.zipPath.split('/').pop() ?? result.zipPath.split('\\').pop() ?? result.zipPath}
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      <Button variant="primary" onClick={handleOpenFolder}>
                        <Folder size={14} style={{ marginRight: 6 }} />
                        Open Folder
                      </Button>
                      <Button variant="secondary" onClick={handleReset}>
                        <RefreshCw size={14} style={{ marginRight: 6 }} />
                        Start Over
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>

        {/* ── Side column: template preview (steps 1, 3, 4 — mini thumbnail) ─ */}
        {step !== 2 && (
          <div style={sideCol}>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', fontWeight: 'var(--weight-medium)' }}>
              Preview
            </div>
            {templateId && templatePreviews[templateId]
              ? <div style={{ width: 200, height: 259, borderRadius: 8, overflow: 'hidden', boxShadow: '0 4px 16px rgba(0,0,0,0.4)', flexShrink: 0 }}>
                  <img src={templatePreviews[templateId]} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                </div>
              : <div style={{ width: 200, height: 259, background: 'var(--color-bg-elevated)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--color-border)' }}>
                  <span style={{ fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'center', padding: 8 }}>
                    {templateId ? 'Loading…' : 'Select a template'}
                  </span>
                </div>
            }
          </div>
        )}
      </div>

      {/* Keyframe for spinner */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
