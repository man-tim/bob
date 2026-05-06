# Building CSM Master Tool — Mac App

This guide walks you from a fresh checkout to a signed `.app` / `.dmg` that you can drag to `/Applications`.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20 LTS | [nodejs.org](https://nodejs.org) |
| npm | 10+ | bundled with Node |
| Xcode Command Line Tools | latest | `xcode-select --install` |
| Python 3 | 3.9+ | bundled with macOS or `brew install python` |

> **Apple Silicon note:** the build produces a universal binary (`x64` + `arm64`) by default via `--universal`. If you only need one arch, use `package:mac:arm64` or `package:mac:x64`.

---

## 1 — Install dependencies

```bash
npm install
```

`postinstall` automatically runs `electron-rebuild` to compile `better-sqlite3` for the exact Electron Node ABI. You'll see output like:

```
✓  Rebuilding better-sqlite3 native module
```

If it fails (missing Python / Xcode tools), fix those first, then re-run `npm install`.

---

## 2 — Generate app icons

Icons are **not** committed to source control (they're generated from `resources/icon.svg`).

```bash
npm run icons
```

This creates:
- `resources/icon.icns` — macOS (all retina sizes)
- `resources/icon.ico`  — Windows
- `resources/icon.png`  — Linux (512 × 512)

You only need to run this once (or whenever you change `icon.svg`).

### Troubleshooting icons
- **`sharp` not found:** `npm install --save-dev sharp`
- **`iconutil` not found:** Install Xcode CLT: `xcode-select --install`

---

## 3 — Development build

Starts Electron with hot-reload (Vite HMR for the renderer, auto-restart for main):

```bash
npm run dev
```

Changes to renderer code reload instantly. Changes to `src/main/` restart the Electron process.

---

## 4 — Production build (no packaging)

Compiles TypeScript + bundles everything into `out/`:

```bash
npm run build
```

Inspect `out/` to verify the three targets compiled without errors:
- `out/main/index.js`
- `out/preload/index.js`
- `out/renderer/index.html` + chunks

---

## 5 — Package the Mac app

```bash
# Universal binary (x64 + arm64) — recommended for distribution
npm run package:mac

# Or the full pipeline including icon generation:
npm run dist
```

Output in `dist/`:
```
dist/
  mac-universal/
    CSM Master Tool.app        ← drag this to /Applications
  CSM Master Tool-1.0.0-universal.dmg
  CSM Master Tool-1.0.0-universal-mac.zip
```

### Build flags

| Script | What it does |
|--------|-------------|
| `npm run dist` | Icons → build → universal DMG (recommended) |
| `npm run package:mac` | Build → universal DMG (skip icon step) |
| `npm run package:mac:arm64` | Build → arm64-only DMG |
| `npm run package:mac:x64` | Build → Intel-only DMG |

---

## 6 — Verify the packaged app

```bash
# Open the .app directly
open "dist/mac-universal/CSM Master Tool.app"

# Check it signed correctly (ad-hoc, unsigned)
codesign -dv --verbose=4 "dist/mac-universal/CSM Master Tool.app"

# Check asar contains the app code
npx asar list "dist/mac-universal/CSM Master Tool.app/Contents/Resources/app.asar" | head -20

# Verify native module is OUTSIDE the asar (should show .node file path)
ls "dist/mac-universal/CSM Master Tool.app/Contents/Resources/app.asar.unpacked/"
```

---

## 7 — Notarization (optional, for distribution outside your machine)

> Skip this if you're only running the app on your own Mac with SIP disabled or developer mode.

1. **Create an App-Specific Password** at [appleid.apple.com](https://appleid.apple.com) → Security → App-Specific Passwords.

2. **Store credentials in keychain:**
   ```bash
   xcrun notarytool store-credentials "CSM-NOTARY" \
     --apple-id "you@example.com" \
     --team-id "XXXXXXXXXX" \
     --password "xxxx-xxxx-xxxx-xxxx"
   ```

3. **Add signing config to `electron-builder.yml`:**
   ```yaml
   mac:
     identity: "Developer ID Application: Your Name (XXXXXXXXXX)"
   afterSign: scripts/notarize.js
   ```

4. **Create `scripts/notarize.js`:**
   ```js
   const { notarize } = require('@electron/notarize')
   exports.default = async (context) => {
     if (context.electronPlatformName !== 'darwin') return
     await notarize({
       tool: 'notarytool',
       appBundleId: 'com.prokeep.csm-master-tool',
       appPath: context.appOutDir + '/CSM Master Tool.app',
       keychainProfile: 'CSM-NOTARY',
     })
   }
   ```

5. **Install:** `npm install --save-dev @electron/notarize`

6. **Build:** `npm run dist`

---

## 8 — Environment variables

Create a `.env` file in the project root (never commit this):

```env
# Google OAuth (from Google Cloud Console)
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret

# HubSpot (optional — Private App token)
HUBSPOT_PRIVATE_APP_TOKEN=pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Gong API (optional)
GONG_API_KEY=your_gong_api_key
GONG_API_SECRET=your_gong_api_secret
```

In production the app reads these from the process environment. For distribution, set them in your CI/CD pipeline or use Electron's `app.setPath` to store credentials in the user's keychain.

---

## 9 — Troubleshooting

### App crashes immediately on launch
**Symptom:** Electron window flashes and closes; no UI appears.

**Likely cause:** `better-sqlite3` native module wasn't compiled for this Electron version.

**Fix:**
```bash
npm run rebuild
npm run package:mac
```

### "Cannot find module 'better-sqlite3'"
The `asarUnpack` configuration in `electron-builder.yml` ensures `.node` files land in `app.asar.unpacked/`. If this error appears after packaging:
1. Verify `asarUnpack: ["**/*.node", "**/better-sqlite3/**"]` is in `electron-builder.yml`
2. Run `npm run package:mac` fresh (delete `dist/` first)

### Gatekeeper blocks the app ("damaged or can't be opened")
For local ad-hoc builds only:
```bash
xattr -cr "dist/mac-universal/CSM Master Tool.app"
```
For real distribution, complete notarization (Step 7).

### Icons missing / wrong size
```bash
# Re-generate from SVG source
npm run icons

# Verify ICNS was created
file resources/icon.icns
```

### Build fails: "cannot find module sharp"
```bash
npm install --save-dev sharp
```

---

## Project structure (relevant to packaging)

```
csm-master-tool/
├── electron-builder.yml          # Packaging config
├── electron.vite.config.ts       # Build + code-splitting config
├── resources/
│   ├── icon.svg                  # Master icon source
│   ├── icon.icns                 # Generated — macOS
│   ├── icon.ico                  # Generated — Windows
│   ├── icon.png                  # Generated — Linux
│   ├── entitlements.mac.plist    # Hardened runtime entitlements
│   └── data/
│       ├── internal.json         # Prokeep internal knowledge base
│       └── customer.json         # Customer-facing knowledge base
├── scripts/
│   └── generate-icons.js         # Icon generation pipeline
├── src/
│   ├── main/                     # Electron main process
│   ├── preload/                  # contextBridge
│   └── renderer/                 # React app
└── out/                          # Build output (gitignored)
    ├── main/
    ├── preload/
    └── renderer/
```

---

*Last updated: 2024 — CSM Master Tool v1.0.0*
