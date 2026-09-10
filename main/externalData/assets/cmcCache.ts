import fs from 'fs'
import path from 'path'
import { AssetType } from '@framelabs/pylon-client'

// Last-good USD quotes + hopeless-symbol backoff live in userData/cmc-rates.json.
// They are not written into Conf/config: main.rates is initialized empty (the
// persist read is commented out) and nativeCurrency.usd is zeroed on every boot.
//
// Symbol backoff (user: "reverse exponential" = longer delay each miss):
// 2min → 4 → 8 → … cap 60min. Dead symbols stay out of the hot custom batch.
// Due symbols share at most one extra quotes/latest call per tick.

export const CMC_CACHE_FILENAME = 'cmc-rates.json'
export const CMC_CACHE_VERSION = 1

export const SYMBOL_BACKOFF_INITIAL_MS = 2 * 60_000
export const SYMBOL_BACKOFF_MAX_MS = 60 * 60_000
export const SYMBOL_BACKOFF_FACTOR = 2

export type CachedRate = {
  type: 'native' | 'token'
  usd: number
  usd_24h_change: number
  chainId: number
  symbol?: string
  address?: string
}

export type DeadSymbol = {
  symbol: string
  reason: string
  lastFailedAt: number
  nextRetryAt: number
  intervalMs: number
}

export type CmcCacheFile = {
  version: number
  updatedAt: number
  rates: Record<string, CachedRate>
  dead: Record<string, DeadSymbol>
}

export type HydratedRateUpdate = {
  id:
    | { type: typeof AssetType.NativeCurrency; chainId: number }
    | { type: typeof AssetType.Token; chainId: number; address: string }
  data: { usd: number; usd_24h_change: number }
}

const SECRET_KEYS = /api[_-]?key|cmc[_-]?api|secret|password|token[_-]?key/i

export function emptyCache(): CmcCacheFile {
  return { version: CMC_CACHE_VERSION, updatedAt: 0, rates: {}, dead: {} }
}

export function getCmcCachePath(userDataPath?: string) {
  if (userDataPath) return path.join(userDataPath, CMC_CACHE_FILENAME)

  // Same pattern as persist/hot signers: identity first, then Electron userData.
  // Lazy require so unit tests never construct frame-fork-nodejs Conf folders.
  require('../../identity')
  const electron = require('electron') as typeof import('electron')
  const userData = electron.app?.getPath?.('userData')
  if (!userData) {
    throw new Error('CMC cache requires Electron userData after identity init')
  }
  return path.join(userData, CMC_CACHE_FILENAME)
}

export function nextSymbolBackoffMs(previousIntervalMs?: number) {
  if (!previousIntervalMs || previousIntervalMs < SYMBOL_BACKOFF_INITIAL_MS) {
    return SYMBOL_BACKOFF_INITIAL_MS
  }
  return Math.min(SYMBOL_BACKOFF_MAX_MS, previousIntervalMs * SYMBOL_BACKOFF_FACTOR)
}

export function isDeadDue(entry: DeadSymbol | undefined, now = Date.now()) {
  return Boolean(entry && now >= entry.nextRetryAt)
}

export function markDead(
  dead: Record<string, DeadSymbol>,
  symbol: string,
  reason: string,
  now = Date.now()
): DeadSymbol {
  const key = symbol.trim().toUpperCase() || symbol
  const intervalMs = nextSymbolBackoffMs(dead[key]?.intervalMs)
  const entry: DeadSymbol = {
    symbol: key,
    reason,
    lastFailedAt: now,
    nextRetryAt: now + intervalMs,
    intervalMs
  }
  dead[key] = entry
  return entry
}

export function clearDead(dead: Record<string, DeadSymbol>, symbol: string) {
  const key = symbol.trim().toUpperCase() || symbol
  delete dead[key]
}

export function planQuoteBatches(opts: {
  nativeSymbols: string[]
  tokenSymbols: string[]
  dead: Record<string, DeadSymbol>
  now?: number
  maxRetrySymbols?: number
}) {
  const now = opts.now ?? Date.now()
  const hotTokenSymbols: string[] = []
  const retryTokenSymbols: string[] = []
  const maxRetry = opts.maxRetrySymbols ?? 40

  for (const symbol of opts.tokenSymbols) {
    const entry = opts.dead[symbol]
    if (!entry) {
      hotTokenSymbols.push(symbol)
      continue
    }
    if (isDeadDue(entry, now)) retryTokenSymbols.push(symbol)
  }

  return {
    nativeSymbols: [...opts.nativeSymbols],
    hotTokenSymbols,
    retryTokenSymbols: retryTokenSymbols.slice(0, maxRetry)
  }
}

export function cacheToRateUpdates(cache: CmcCacheFile): HydratedRateUpdate[] {
  const updates: HydratedRateUpdate[] = []

  for (const [key, rate] of Object.entries(cache.rates || {})) {
    if (!rate || !isPositiveUsd(rate.usd)) continue

    if (rate.type === 'native' || key.startsWith('n:')) {
      const chainId = rate.chainId || Number(key.slice(2))
      if (!Number.isInteger(chainId) || chainId <= 0) continue
      updates.push({
        id: { type: AssetType.NativeCurrency, chainId },
        data: { usd: rate.usd, usd_24h_change: rate.usd_24h_change || 0 }
      })
      continue
    }

    const fromKey = key.startsWith('t:') ? key.split(':') : []
    const chainId = rate.chainId || Number(fromKey[1])
    const address = (rate.address || fromKey[2] || '').toLowerCase()
    if (!Number.isInteger(chainId) || chainId <= 0 || !address) continue

    updates.push({
      id: { type: AssetType.Token, chainId, address },
      data: { usd: rate.usd, usd_24h_change: rate.usd_24h_change || 0 }
    })
  }

  return updates
}

export function sanitizeCache(value: unknown): CmcCacheFile {
  const cache = emptyCache()
  if (!value || typeof value !== 'object') return cache

  const raw = value as Record<string, unknown>
  cache.updatedAt = asFiniteNumber(raw.updatedAt) || 0
  cache.version = asFiniteNumber(raw.version) || CMC_CACHE_VERSION

  const rates = raw.rates && typeof raw.rates === 'object' ? (raw.rates as Record<string, unknown>) : {}
  for (const [key, entry] of Object.entries(rates)) {
    if (SECRET_KEYS.test(key)) continue
    const rate = asCachedRate(entry)
    if (!rate) continue
    cache.rates[key] = rate
  }

  const dead = raw.dead && typeof raw.dead === 'object' ? (raw.dead as Record<string, unknown>) : {}
  for (const [key, entry] of Object.entries(dead)) {
    if (SECRET_KEYS.test(key)) continue
    const row = asDeadSymbol(key, entry)
    if (row) cache.dead[row.symbol] = row
  }

  return cache
}

export function loadCmcCache(filePath: string): CmcCacheFile {
  try {
    if (!fs.existsSync(filePath)) return emptyCache()
    return sanitizeCache(JSON.parse(fs.readFileSync(filePath, 'utf8')))
  } catch {
    return emptyCache()
  }
}

export function saveCmcCache(filePath: string, cache: CmcCacheFile) {
  const sanitized = sanitizeCache({ ...cache, updatedAt: Date.now() })
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(sanitized, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    fs.renameSync(tmp, filePath)
  } catch (e) {
    try {
      fs.copyFileSync(tmp, filePath)
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // ignore
      }
    }
    if (!fs.existsSync(filePath)) throw e
  }
}

function isPositiveUsd(value: unknown) {
  const n = asFiniteNumber(value)
  return n !== undefined && n > 0
}

function asFiniteNumber(value: unknown) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

function asCachedRate(value: unknown): CachedRate | undefined {
  if (!value || typeof value !== 'object') return
  const row = value as Record<string, unknown>
  if (Object.keys(row).some((key) => SECRET_KEYS.test(key))) return

  const usd = asFiniteNumber(row.usd)
  const change = asFiniteNumber(row.usd_24h_change) ?? 0
  const chainId = asFiniteNumber(row.chainId)
  if (usd === undefined || !isPositiveUsd(usd) || !chainId || chainId <= 0) return

  const type = row.type === 'token' ? 'token' : row.type === 'native' ? 'native' : undefined
  if (!type) return

  const symbol = typeof row.symbol === 'string' ? row.symbol.trim().toUpperCase() : undefined
  const address = typeof row.address === 'string' ? row.address.trim().toLowerCase() : undefined

  return {
    type,
    usd,
    usd_24h_change: change,
    chainId,
    ...(symbol ? { symbol } : {}),
    ...(address ? { address } : {})
  }
}

function asDeadSymbol(key: string, value: unknown): DeadSymbol | undefined {
  if (!value || typeof value !== 'object') return
  const row = value as Record<string, unknown>
  if (Object.keys(row).some((field) => SECRET_KEYS.test(field))) return

  const symbol = String(row.symbol || key)
    .trim()
    .toUpperCase()
  const reason = typeof row.reason === 'string' && row.reason.trim() ? row.reason.trim() : 'no-quote'
  const lastFailedAt = asFiniteNumber(row.lastFailedAt)
  const nextRetryAt = asFiniteNumber(row.nextRetryAt)
  const intervalMs = asFiniteNumber(row.intervalMs)
  if (!symbol || lastFailedAt === undefined || nextRetryAt === undefined || intervalMs === undefined) return

  return { symbol, reason, lastFailedAt, nextRetryAt, intervalMs }
}
