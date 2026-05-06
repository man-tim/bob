/**
 * afterSign.js — Re-signs the macOS app bundle with correct identifiers.
 *
 * Electron-builder with identity:null skips signing, leaving the helpers
 * with the stock "Electron" / "Electron Helper" identifiers. On macOS 26+,
 * Electron 41 validates helpers and crashes with "Unable to find helper app"
 * if the identifiers don't match.  This script runs after packing and:
 *   1. Copies the app bundle to /tmp to escape iCloud Drive xattr interference
 *   2. Strips all iCloud / quarantine xattrs on the /tmp copy
 *   3. Re-signs each helper and the main bundle with the correct bundle IDs
 *   4. Copies the signed bundle back, replacing the original
 */

'use strict'

const path  = require('path')
const fs    = require('fs')
const os    = require('os')
const { execSync } = require('child_process')

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir, packager } = context
  if (electronPlatformName !== 'darwin') return

  const productName = packager.appInfo.productName
  const appPath = path.join(appOutDir, `${productName}.app`)
  if (!fs.existsSync(appPath)) return

  console.log('[afterSign] Re-signing', appPath)

  // ── Copy to /tmp to escape iCloud Drive xattr interference ────────────────
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'bob-sign-'))
  const tmpApp  = path.join(tmpDir, `${productName}.app`)

  console.log('[afterSign] Copying to', tmpApp)
  execSync(`cp -R "${appPath}" "${tmpDir}/"`, { stdio: 'inherit' })

  // ── Strip ALL xattrs recursively from the /tmp copy ───────────────────────
  execSync(`xattr -cr "${tmpApp}"`, { stdio: 'pipe' })

  const sign = (target, identifier) => {
    execSync(
      `codesign --sign - --force --identifier "${identifier}" "${target}"`,
      { stdio: 'inherit' }
    )
  }

  const fw    = path.join(tmpApp, 'Contents', 'Frameworks')
  const appId = packager.appInfo.id  // e.g. com.prokeep.bob

  // ── Sign helpers from most-nested outward ─────────────────────────────────
  const helpers = [
    { suffix: ' (GPU)',      id: `${appId}.helper.gpu` },
    { suffix: ' (Plugin)',   id: `${appId}.helper.plugin` },
    { suffix: ' (Renderer)', id: `${appId}.helper.renderer` },
    { suffix: '',            id: `${appId}.helper` },
  ]

  for (const { suffix, id } of helpers) {
    const helperApp = path.join(fw, `${productName} Helper${suffix}.app`)
    if (fs.existsSync(helperApp)) {
      sign(helperApp, id)
    }
  }

  // ── Sign frameworks ───────────────────────────────────────────────────────
  for (const fwName of ['Electron Framework', 'Mantle', 'Squirrel', 'ReactiveObjC']) {
    const fwPath = path.join(fw, `${fwName}.framework`)
    if (fs.existsSync(fwPath)) {
      execSync(`codesign --sign - --force "${fwPath}"`, { stdio: 'inherit' })
    }
  }

  // ── Sign the main bundle last ─────────────────────────────────────────────
  sign(tmpApp, appId)

  // ── Copy signed bundle back, replacing the original ───────────────────────
  console.log('[afterSign] Copying signed bundle back to', appPath)
  execSync(`rm -rf "${appPath}"`, { stdio: 'pipe' })
  execSync(`cp -R "${tmpApp}" "${appOutDir}/"`, { stdio: 'inherit' })

  // ── Clean up /tmp ─────────────────────────────────────────────────────────
  execSync(`rm -rf "${tmpDir}"`, { stdio: 'pipe' })

  console.log('[afterSign] Done — bundle is properly signed')
}
