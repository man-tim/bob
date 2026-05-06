#!/usr/bin/env node
/**
 * scripts/generate-icons.js
 * ─────────────────────────
 * Generates all platform icon formats from resources/icon.svg.
 *
 * Prerequisites:
 *   npm install --save-dev sharp          (raster rendering from SVG)
 *   macOS only: iconutil is built-in (part of Xcode command-line tools)
 *
 * Usage:
 *   node scripts/generate-icons.js
 *   npm run icons
 */

const sharp    = require('sharp')
const fs       = require('fs')
const path     = require('path')
const { execSync } = require('child_process')

const ROOT      = path.join(__dirname, '..')
const SRC_SVG   = path.join(ROOT, 'resources', 'icon.svg')
const RES_DIR   = path.join(ROOT, 'resources')
const ICONSET   = path.join(RES_DIR, 'icon.iconset')

// ─── macOS iconset sizes ──────────────────────────────────────────────────────
const MAC_SIZES = [
  { size: 16,   name: 'icon_16x16.png' },
  { size: 32,   name: 'icon_16x16@2x.png' },
  { size: 32,   name: 'icon_32x32.png' },
  { size: 64,   name: 'icon_32x32@2x.png' },
  { size: 128,  name: 'icon_128x128.png' },
  { size: 256,  name: 'icon_128x128@2x.png' },
  { size: 256,  name: 'icon_256x256.png' },
  { size: 512,  name: 'icon_256x256@2x.png' },
  { size: 512,  name: 'icon_512x512.png' },
  { size: 1024, name: 'icon_512x512@2x.png' },
]

// ─── Windows ICO sizes (embedded in one .ico file) ───────────────────────────
const WIN_SIZES = [16, 32, 48, 64, 128, 256]

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

async function renderPng(size, outPath) {
  await sharp(SRC_SVG)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath)
  console.log(`  ✓  ${path.relative(ROOT, outPath)}  (${size}×${size})`)
}

async function buildMacIconset() {
  console.log('\n── macOS .icns ──────────────────────────────────────────────')
  await ensureDir(ICONSET)

  for (const { size, name } of MAC_SIZES) {
    await renderPng(size, path.join(ICONSET, name))
  }

  const icnsPath = path.join(RES_DIR, 'icon.icns')
  execSync(`iconutil -c icns "${ICONSET}" -o "${icnsPath}"`)
  console.log(`  ✓  resources/icon.icns`)

  // Clean up temporary iconset directory
  fs.rmSync(ICONSET, { recursive: true, force: true })
}

async function buildWindowsIco() {
  console.log('\n── Windows .ico ─────────────────────────────────────────────')

  // Generate individual PNGs for embedding
  const pngBuffers = []
  for (const size of WIN_SIZES) {
    const buf = await sharp(SRC_SVG)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    pngBuffers.push({ size, buf })
    console.log(`  ✓  ico frame ${size}×${size}`)
  }

  // Write a simple multi-size ICO file
  // ICO format: ICONDIR + ICONDIRENTRY[] + image data
  const ICONDIR_SIZE  = 6
  const DIRENTRY_SIZE = 16
  const headerSize    = ICONDIR_SIZE + DIRENTRY_SIZE * pngBuffers.length

  let offset = headerSize
  const entries = pngBuffers.map(({ size, buf }) => {
    const entry = { size, buf, offset }
    offset += buf.length
    return entry
  })

  const totalSize = offset
  const ico       = Buffer.alloc(totalSize)

  // ICONDIR header
  ico.writeUInt16LE(0,                   0)  // reserved
  ico.writeUInt16LE(1,                   2)  // type: 1 = ICO
  ico.writeUInt16LE(pngBuffers.length,   4)  // count

  // ICONDIRENTRY for each image
  entries.forEach(({ size, buf, offset: imgOffset }, i) => {
    const base = ICONDIR_SIZE + i * DIRENTRY_SIZE
    ico.writeUInt8(size >= 256 ? 0 : size,  base + 0)   // width  (0 = 256+)
    ico.writeUInt8(size >= 256 ? 0 : size,  base + 1)   // height
    ico.writeUInt8(0,                        base + 2)   // color count
    ico.writeUInt8(0,                        base + 3)   // reserved
    ico.writeUInt16LE(1,                     base + 4)   // planes
    ico.writeUInt16LE(32,                    base + 6)   // bit count
    ico.writeUInt32LE(buf.length,            base + 8)   // size of image data
    ico.writeUInt32LE(imgOffset,             base + 12)  // offset of image data
  })

  // Image data
  entries.forEach(({ buf, offset: imgOffset }) => {
    buf.copy(ico, imgOffset)
  })

  const icoPath = path.join(RES_DIR, 'icon.ico')
  fs.writeFileSync(icoPath, ico)
  console.log(`  ✓  resources/icon.ico  (${WIN_SIZES.join(', ')}px)`)
}

async function buildLinuxPng() {
  console.log('\n── Linux .png (512×512) ─────────────────────────────────────')
  await renderPng(512, path.join(RES_DIR, 'icon.png'))
}

async function main() {
  if (!fs.existsSync(SRC_SVG)) {
    console.error(`ERROR: Source SVG not found: ${SRC_SVG}`)
    process.exit(1)
  }

  try {
    require('sharp')
  } catch {
    console.error('ERROR: sharp is not installed. Run: npm install --save-dev sharp')
    process.exit(1)
  }

  console.log('CSM Master Tool — Icon Generator')
  console.log(`Source: ${path.relative(ROOT, SRC_SVG)}\n`)

  await buildMacIconset()
  await buildWindowsIco()
  await buildLinuxPng()

  console.log('\n✅  All icons generated successfully.\n')
}

main().catch(err => {
  console.error('Icon generation failed:', err.message)
  process.exit(1)
})
