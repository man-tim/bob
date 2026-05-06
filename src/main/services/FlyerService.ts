import { BrowserWindow, shell, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import QRCode from 'qrcode'
import JSZip from 'jszip'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FlyerLocation {
  name:     string
  phone:    string
  message?: string
}

export interface ElementPosition { x: number; y: number; w: number; h: number }
export interface ElementLayout {
  logo:  ElementPosition
  logo2: ElementPosition
  phone: ElementPosition
  qr:    ElementPosition
}

export interface FlyerGenerateInput {
  templateId:     'btm' | 'blue' | 'trucking'
  logoPath:       string | null
  locations:      FlyerLocation[]
  defaultKeyword: string
  outputDir:      string
  companyName?:   string
  layout?:        ElementLayout
}

export interface FlyerGenerateResult {
  files:   string[]
  zipPath: string | null
  errors:  string[]
}

// ─── Template PNG loader ──────────────────────────────────────────────────────

export function getTemplateDataUrl(templateId: string): string | null {
  const filename = `${templateId}.png`
  const dirs = app.isPackaged
    ? [path.join(process.resourcesPath, 'resources', 'flyer-templates')]
    : [
        path.join(app.getAppPath(), 'resources', 'flyer-templates'),
        path.join(__dirname, '../../../resources/flyer-templates'),
      ]

  for (const dir of dirs) {
    const p = path.join(dir, filename)
    if (fs.existsSync(p)) {
      return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`
    }
  }
  return null
}

// ─── HTML Builder ─────────────────────────────────────────────────────────────
// Element positions match the original Flyer Creator 2.html extension exactly.
// Template canvas is 612×792px. Coordinates are in template pixels.
// BTM:            logo(50,326,142×52)  phone(228,348,365×75)  qr(305,460,205×205)
// Blue/Trucking:  logo(50,320,142×52)  phone(228,345,365×78)  qr(305,475,205×205)

interface BuildFlyerHtmlOpts {
  templateId:   'btm' | 'blue' | 'trucking'
  logoDataUrl:  string | null
  qrDataUrl:    string
  phone:        string
  locationName: string | undefined
  keyword:      string
  layout?:      ElementLayout
}

const DEFAULT_POSITIONS: Record<string, ElementLayout> = {
  btm:      { logo: {x:50,y:326,w:142,h:52}, logo2: {x:396,y:693,w:182,h:67}, phone: {x:228,y:348,w:365,h:75}, qr: {x:305,y:460,w:205,h:205} },
  blue:     { logo: {x:50,y:320,w:142,h:52}, logo2: {x:396,y:693,w:182,h:67}, phone: {x:228,y:345,w:365,h:78}, qr: {x:305,y:475,w:205,h:205} },
  trucking: { logo: {x:50,y:320,w:142,h:52}, logo2: {x:396,y:693,w:182,h:67}, phone: {x:228,y:345,w:365,h:78}, qr: {x:305,y:475,w:205,h:205} },
}

// Scale factor: template coordinates are in 72dpi PDF points (612×792),
// but Chromium renders at 96dpi. Letter at 96dpi = 816×1056px.
const PT_TO_PX = 96 / 72  // 1.3333…

function buildFlyerHtml(opts: BuildFlyerHtmlOpts): string {
  const { templateId, logoDataUrl, qrDataUrl, phone, locationName, keyword, layout } = opts

  const templateBg = getTemplateDataUrl(templateId)

  // If no PNG found, fall back to CSS-generated background
  if (!templateBg) {
    return buildFlyerHtmlFallback(opts)
  }

  // Use custom layout if provided, otherwise fall back to hardcoded defaults
  // Scale all positions from 72dpi template coords → 96dpi CSS pixels
  const rawPos = layout ?? DEFAULT_POSITIONS[templateId] ?? DEFAULT_POSITIONS.blue
  const s = PT_TO_PX
  const logo2Raw = rawPos.logo2 ?? { x:396, y:693, w:182, h:67 }
  const pos = {
    logo:  { x: rawPos.logo.x * s,  y: rawPos.logo.y * s,  w: rawPos.logo.w * s,  h: rawPos.logo.h * s  },
    logo2: { x: logo2Raw.x * s,     y: logo2Raw.y * s,     w: logo2Raw.w * s,     h: logo2Raw.h * s     },
    phone: { x: rawPos.phone.x * s, y: rawPos.phone.y * s, w: rawPos.phone.w * s, h: rawPos.phone.h * s },
    qr:    { x: rawPos.qr.x * s,   y: rawPos.qr.y * s,   w: rawPos.qr.w * s,   h: rawPos.qr.h * s   },
  }

  const logoEl = logoDataUrl
    ? `<img src="${logoDataUrl}" style="position:absolute;left:${pos.logo.x}px;top:${pos.logo.y}px;width:${pos.logo.w}px;height:${pos.logo.h}px;object-fit:contain;" />`
    : ''

  const logo2El = logoDataUrl
    ? `<img src="${logoDataUrl}" style="position:absolute;left:${pos.logo2.x}px;top:${pos.logo2.y}px;width:${pos.logo2.w}px;height:${pos.logo2.h}px;object-fit:contain;" />`
    : ''

  const phoneFontSize = Math.round(pos.phone.h * 0.5)

  const locationEl = locationName
    ? `<div style="position:absolute;left:${pos.phone.x}px;top:${pos.phone.y + pos.phone.h + 5}px;width:${pos.phone.w}px;text-align:center;font-size:16px;color:rgba(255,255,255,0.6);">${escapeHtml(locationName)}</div>`
    : ''

  // Canvas size matches Letter at 96dpi (8.5" × 11")
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Flyer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 816px; height: 1056px; overflow: hidden; }
  .page {
    width: 816px; height: 1056px;
    position: relative; overflow: hidden;
    font-family: Arial, 'Helvetica Neue', sans-serif;
  }
  .bg { position: absolute; top: 0; left: 0; width: 816px; height: 1056px; }
</style>
</head>
<body>
<div class="page">
  <img class="bg" src="${templateBg}" />
  ${logoEl}
  ${logo2El}
  <div style="position:absolute;left:${pos.phone.x}px;top:${pos.phone.y}px;width:${pos.phone.w}px;height:${pos.phone.h}px;display:flex;align-items:center;justify-content:center;">
    <span style="font-size:${phoneFontSize}px;font-weight:800;color:#ffffff;text-align:center;letter-spacing:0.02em;">${escapeHtml(phone)}</span>
  </div>
  ${locationEl}
  <img src="${qrDataUrl}" style="position:absolute;left:${pos.qr.x}px;top:${pos.qr.y}px;width:${pos.qr.w}px;height:${pos.qr.h}px;" />
</div>
</body>
</html>`
}

// ─── Fallback HTML builder (no template PNG) ──────────────────────────────────

function buildFlyerHtmlFallback(opts: BuildFlyerHtmlOpts): string {
  const { templateId, logoDataUrl, qrDataUrl, phone, locationName, keyword } = opts

  type TemplateTheme = { bg: string; accent: string; accentText: string; headline: string; subline: string; badgeBg: string; badgeText: string }
  const themes: Record<string, TemplateTheme> = {
    btm:      { bg:'#131C2F', accent:'#56B7A3', accentText:'#56B7A3', headline:'Text Us to Opt In', subline:'Scan the QR code or text us directly', badgeBg:'#56B7A3', badgeText:'#131C2F' },
    blue:     { bg:'#2A7991', accent:'#F4B74E', accentText:'#F4B74E', headline:'Text Us',            subline:'Scan the QR code or text us directly', badgeBg:'#F4B74E', badgeText:'#2A7991' },
    trucking: { bg:'#0D1C30', accent:'#469C6C', accentText:'#469C6C', headline:'Text Your VSN',      subline:'Include your VSN in the message',      badgeBg:'#469C6C', badgeText:'#0D1C30' },
  }
  const t = themes[templateId] ?? themes.btm

  const logoHtml = logoDataUrl
    ? `<img src="${logoDataUrl}" alt="Logo" style="max-height:80px;max-width:300px;object-fit:contain;filter:brightness(0) invert(1);" />`
    : `<div style="height:80px;display:flex;align-items:center;justify-content:center;"><div style="width:160px;height:40px;background:rgba(255,255,255,0.15);border-radius:6px;"></div></div>`

  const locationNameHtml = locationName
    ? `<div style="color:rgba(255,255,255,0.6);font-size:13px;margin-top:10px;letter-spacing:0.03em;">${escapeHtml(locationName)}</div>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Flyer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 612px; height: 792px; overflow: hidden;
    background: ${t.bg}; font-family: 'Segoe UI', Arial, sans-serif; color: #ffffff;
  }
  .page { width: 612px; height: 792px; display: flex; flex-direction: column; align-items: center; position: relative; background: ${t.bg}; overflow: hidden; }
  .accent-bar-top { width: 100%; height: 8px; background: ${t.accent}; flex-shrink: 0; }
  .logo-area { margin-top: 28px; height: 80px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .headline { margin-top: 22px; font-size: 38px; font-weight: 800; color: #ffffff; text-align: center; line-height: 1.1; flex-shrink: 0; }
  .subline { margin-top: 8px; font-size: 16px; color: rgba(255,255,255,0.70); text-align: center; flex-shrink: 0; }
  .qr-card { margin-top: 22px; background: #ffffff; border-radius: 16px; padding: 18px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .qr-card img {
    display: block;
    width: 220px;
    height: 220px;
  }
  .scan-label {
    margin-top: 18px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: ${t.accentText};
    text-align: center;
    flex-shrink: 0;
  }
  .phone-number {
    margin-top: 6px;
    font-size: 36px; font-weight: 800; color: #ffffff;
    text-align: center; letter-spacing: 0.02em; flex-shrink: 0;
  }
  .keyword-badge {
    margin-top: 14px; background: ${t.badgeBg}; color: ${t.badgeText};
    font-size: 15px; font-weight: 700; padding: 7px 22px; border-radius: 20px;
    text-align: center; letter-spacing: 0.05em; flex-shrink: 0;
  }
  .spacer { flex: 1; }
  .accent-bar-bottom { width: 100%; height: 4px; background: ${t.accent}; opacity: 0.4; flex-shrink: 0; }
</style>
</head>
<body>
<div class="page">
  <div class="accent-bar-top"></div>
  <div class="logo-area">${logoHtml}</div>
  <div class="headline">${escapeHtml(t.headline)}</div>
  <div class="subline">${escapeHtml(t.subline)}</div>
  <div class="qr-card"><img src="${qrDataUrl}" alt="QR Code" /></div>
  <div class="scan-label">Text or Scan</div>
  <div class="phone-number">${escapeHtml(phone)}</div>
  <div class="keyword-badge">Keyword: ${escapeHtml(keyword)}</div>
  ${locationNameHtml}
  <div class="spacer"></div>
  <div class="accent-bar-bottom"></div>
</div>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _\-().]/g, '_').replace(/\s+/g, ' ').trim()
}

function formatPhone(digits: string): string {
  const d = digits.slice(-10)
  if (d.length !== 10) return digits
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

// ─── Core generate ────────────────────────────────────────────────────────────

async function generateFlyer(
  input: FlyerGenerateInput,
  onProgress?: (done: number, total: number, filename: string) => void
): Promise<FlyerGenerateResult> {
  const { templateId, logoPath, locations, defaultKeyword, outputDir, companyName } = input
  const files:  string[] = []
  const errors: string[] = []
  const total = locations.length

  // Pre-load logo once
  let logoDataUrl: string | null = null
  if (logoPath && fs.existsSync(logoPath)) {
    try {
      const ext = path.extname(logoPath).replace('.', '').toLowerCase() || 'png'
      const mimeMap: Record<string, string> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', svg: 'svg+xml', gif: 'gif', webp: 'webp' }
      const mime = mimeMap[ext] ?? ext
      const b64 = fs.readFileSync(logoPath).toString('base64')
      logoDataUrl = `data:image/${mime};base64,${b64}`
    } catch (e) {
      console.warn('[FlyerService] Could not read logo:', e)
    }
  }

  let done = 0

  for (const loc of locations) {
    const digits = loc.phone.replace(/\D/g, '').slice(-10)
    const keyword = loc.message ?? defaultKeyword

    try {
      if (!digits || digits.length < 7) {
        throw new Error(`Invalid phone number: "${loc.phone}"`)
      }

      const formattedPhone = formatPhone(digits)

      // Generate QR code
      const qrDataUrl = await QRCode.toDataURL(`SMSTO:${digits}:${keyword}`, {
        width: 260,
        margin: 1,
        color: { dark: '#0D1525', light: '#FFFFFF' },
      })

      // Build HTML
      const html = buildFlyerHtml({
        templateId,
        logoDataUrl,
        qrDataUrl,
        phone: formattedPhone,
        locationName: loc.name,
        keyword,
        layout: input.layout,
      })

      // Write HTML to temp file
      const tmpPath = path.join(os.tmpdir(), `flyer_${Date.now()}_${Math.random().toString(36).slice(2)}.html`)
      fs.writeFileSync(tmpPath, html, 'utf8')

      // Create hidden BrowserWindow matching Letter at 96dpi
      const win = new BrowserWindow({
        show: false,
        width: 816,
        height: 1056,
        frame: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      })

      await new Promise<void>((resolve, reject) => {
        win.webContents.once('did-finish-load', async () => {
          try {
            // Wait until all img elements report complete, then allow an extra paint tick
            await win.webContents.executeJavaScript(`
              new Promise(resolve => {
                const imgs = Array.from(document.images);
                const pending = imgs.filter(img => !img.complete);
                if (!pending.length) { setTimeout(resolve, 150); return; }
                let n = pending.length;
                pending.forEach(img => {
                  img.onload = img.onerror = () => { if (--n === 0) setTimeout(resolve, 150); };
                });
                // Safety timeout 3 s
                setTimeout(resolve, 3000);
              })
            `)
            resolve()
          } catch {
            // If JS execution fails, fall back to a fixed delay
            setTimeout(resolve, 800)
          }
        })
        win.webContents.once('did-fail-load', (_e, code, desc) => {
          reject(new Error(`Page load failed: ${desc} (${code})`))
        })
        win.loadFile(tmpPath).catch(reject)
      })

      const pdf = await win.webContents.printToPDF({
        pageSize: 'Letter',
        printBackground: true,
        margins: { marginType: 'none' as const },
      })

      win.destroy()

      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }

      // Build output filename
      const baseName = sanitizeFilename(`${companyName ? companyName + ' - ' : ''}${loc.name || digits}`)
      const filename = `${baseName}.pdf`
      const outPath  = path.join(outputDir, filename)
      fs.writeFileSync(outPath, pdf)
      files.push(outPath)

      done++
      onProgress?.(done, total, filename)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${loc.name || loc.phone}: ${msg}`)
      done++
      onProgress?.(done, total, '')
    }
  }

  // ZIP if more than 1 file
  let zipPath: string | null = null
  if (files.length > 1) {
    try {
      const zip = new JSZip()
      for (const filePath of files) {
        const filename = path.basename(filePath)
        zip.file(filename, fs.readFileSync(filePath))
      }
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
      const zipName = sanitizeFilename(`${companyName ? companyName + ' - ' : ''}Flyers`) + '.zip'
      zipPath = path.join(outputDir, zipName)
      fs.writeFileSync(zipPath, zipBuf)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`ZIP creation failed: ${msg}`)
    }
  }

  return { files, zipPath, errors }
}

// ─── Utility exports ──────────────────────────────────────────────────────────

async function generateQr(phone: string, keyword: string): Promise<string> {
  const digits = phone.replace(/\D/g, '').slice(-10)
  return QRCode.toDataURL(`SMSTO:${digits}:${keyword}`, {
    width: 260,
    margin: 1,
    color: { dark: '#0D1525', light: '#FFFFFF' },
  })
}

function openFolder(folderPath: string): void {
  shell.openPath(folderPath)
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const FlyerService = {
  generateFlyer,
  generateQr,
  openFolder,
  getTemplateDataUrl,
}
