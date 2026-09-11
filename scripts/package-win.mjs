import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isWindows = process.platform === 'win32'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dirOnly = process.argv.includes('--dir')
const skipBuild = process.argv.includes('--skip-build')

if (!isWindows) {
  console.error('package-win is for a local Windows install of Frame Fork.')
  process.exit(1)
}

function runNpm(scriptName) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', scriptName], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: true
    })

    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${scriptName} failed with exit code ${code}`))
    })
  })
}

function runElectronBuilder() {
  const cli = path.join(repoRoot, 'node_modules', 'electron-builder', 'cli.js')
  const args = [
    cli,
    '--config=build/electron-builder-win-local.js',
    '--win',
    '--x64',
    '--publish',
    'never'
  ]
  if (dirOnly) args.push('--dir')

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: 'false'
      }
    })

    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`electron-builder failed with exit code ${code}`))
    })
  })
}

if (!skipBuild) {
  await runNpm('compile')
  await runNpm('bundle')
}

await runElectronBuilder()

const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const unpacked = path.join(repoRoot, 'dist', 'win-unpacked', 'Frame Fork.exe')
const installer = path.join(repoRoot, 'dist', `Frame-Fork-Setup-${version}.exe`)

console.log('')
console.log('Frame Fork Windows package finished.')
console.log('Identity: sh.frame.fork / userData %APPDATA%\\frame-fork')
console.log('Quit official Frame first — only one app can use port 1248.')
if (dirOnly) {
  console.log(`Unpackaged app: ${unpacked}`)
} else {
  console.log(`NSIS installer: ${installer}`)
  console.log('Install per-user (not into official Frame at %LOCALAPPDATA%\\Programs\\frame).')
}
console.log('')
