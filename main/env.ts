import fs from 'fs'
import path from 'path'
import log from 'electron-log'

const ENV_FILES = ['.env.local', '.env']

function parseEnvFile(contents: string) {
  const parsed: Record<string, string> = {}

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq <= 0) continue

    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    if (key) parsed[key] = value
  }

  return parsed
}

function candidateDirs() {
  return Array.from(new Set([process.cwd(), path.resolve(__dirname, '../..')].filter((dir) => Boolean(dir))))
}

export function loadLocalEnv() {
  for (const dir of candidateDirs()) {
    for (const file of ENV_FILES) {
      const fullPath = path.join(dir, file)

      try {
        if (!fs.existsSync(fullPath)) continue

        const parsed = parseEnvFile(fs.readFileSync(fullPath, 'utf8'))
        let applied = 0

        for (const [key, value] of Object.entries(parsed)) {
          if (process.env[key] === undefined) {
            process.env[key] = value
            applied += 1
          }
        }

        log.info('loaded local env file', { file, applied })
      } catch (e) {
        log.warn('failed to read local env file', { file })
      }
    }
  }
}

export function getCmcApiKey() {
  return (process.env.CMC_API_KEY || '').trim()
}

export function getCmcPollIntervalMs(fallback = 5 * 60_000, min = 60_000) {
  const parsed = parseInt(process.env.CMC_POLL_INTERVAL_MS || '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(min, parsed)
}

export function getCmcMaxTokens(fallback = 40, max = 200) {
  const parsed = parseInt(process.env.CMC_MAX_TOKENS || '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(max, parsed)
}

loadLocalEnv()
