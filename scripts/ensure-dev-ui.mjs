import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const parcelTrayUrl = 'http://localhost:1234/tray/index.dev.html'
const bundleTray = path.join(repoRoot, 'bundle', 'tray.html')
const bundleBridge = path.join(repoRoot, 'bundle', 'bridge.js')

function canReachParcel() {
  return new Promise((resolve) => {
    const req = http.get(parcelTrayUrl, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1500, () => {
      req.destroy()
      resolve(false)
    })
  })
}

function hasBundledUi() {
  return fs.existsSync(bundleTray) && fs.existsSync(bundleBridge)
}

const parcelUp = await canReachParcel()

if (parcelUp) {
  process.exit(0)
}

if (hasBundledUi()) {
  console.warn(
    [
      '',
      'Parcel is not running on http://localhost:1234.',
      'Electron will load the existing bundle/ UI (no live reload).',
      'For compile + Parcel + Electron (verbose logs, including CMC):',
      '  npm run dev',
      ''
    ].join('\n')
  )
  process.exit(0)
}

console.error(
  [
    '',
    'Frame development UI is not available.',
    'launch:dev starts Electron only. Windows stay hidden until either:',
    '  • Parcel is serving http://localhost:1234/tray/index.dev.html, or',
    '  • bundle/tray.html and bundle/bridge.js exist.',
    '',
    'From the repo root, in PowerShell (quit production Frame first so port 1248 is free):',
    '',
    '  npm run dev',
    '',
    'Or without the live-reload server (info logs are enough for CMC):',
    '',
    '  npm run compile',
    '  npm run bundle',
    '  npm run launch',
    ''
  ].join('\n')
)
process.exit(1)
