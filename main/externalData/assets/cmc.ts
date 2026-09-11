/// <reference path="../../../@types/frame/index.d.ts" />
import log from 'electron-log'
import { AssetType } from '@framelabs/pylon-client'

import { getCmcMaxTokens, getCmcPollIntervalMs } from '../../env'
import { resolveCmcApiKey } from './cmcKey'
import { NATIVE_CURRENCY } from '../../../resources/constants'
import { fetchWithTimeout } from '../../../resources/utils/fetch'
import {
  cacheToRateUpdates,
  clearDead,
  emptyCache,
  getCmcCachePath,
  isDeadDue,
  loadCmcCache,
  markDead,
  planQuoteBatches,
  saveCmcCache,
  type CmcCacheFile
} from './cmcCache'

import type { AssetId } from '@framelabs/pylon-client/dist/assetId'
import type { Token, Balance, Chain } from '../../store/state'

// Quotes: GET /v3/cryptocurrency/quotes/latest (v1/v2 quotes/latest are deprecated).
// https://coinmarketcap.com/api/documentation/guides/get-latest-crypto-prices
// https://coinmarketcap.com/api/documentation/pro-api-reference/cryptocurrency
// Auth is header X-CMC_PRO_API_KEY only — never put the key in the query string.

export interface RateUpdate {
  id: AssetId
  data: {
    usd: number
    usd_24h_change: number
  }
}

export type RateTarget =
  | { type: 'native'; chainId: number }
  | {
      type: 'token'
      chainId: number
      address: string
      symbol?: string
      source?: 'held' | 'custom' | 'known'
    }

type TokenTarget = Extract<RateTarget, { type: 'token' }>

export type NormalizedQuote = {
  id?: number
  symbol?: string
  usd: number
  usd_24h_change: number
  addresses?: string[]
  chainIds?: number[]
}

const CMC_BASE_URL = 'https://pro-api.coinmarketcap.com'
const QUOTES_PATH = '/v3/cryptocurrency/quotes/latest'
const INFO_BATCH_SIZE = 20
const REQUEST_TIMEOUT_MS = 15_000
const MIN_POLL_GAP_MS = 60_000
const FIRST_POLL_DELAY_MS = 1_000
const EMPTY_TARGET_RETRY_MS = 2_000
const MAX_EMPTY_TARGET_RETRIES = 30
const MAX_BACKOFF_MS = 30 * 60_000

export { FIRST_POLL_DELAY_MS, EMPTY_TARGET_RETRY_MS, MAX_EMPTY_TARGET_RETRIES, MIN_POLL_GAP_MS }

type PollResult = 'empty' | 'ok' | 'skipped'

const CHAIN_PLATFORMS: Record<number, string[]> = {
  1: ['ethereum'],
  10: ['optimism', 'optimistic-ethereum', 'optimism-ethereum'],
  100: ['gnosis-chain', 'gnosis', 'xdai'],
  137: ['polygon', 'polygon-pos', 'matic-network'],
  8453: ['base'],
  42161: ['arbitrum', 'arbitrum-one']
}

const NATIVE_CMC_IDS: Record<number, number> = {
  1: 1027,
  10: 1027,
  137: 28321,
  8453: 1027,
  42161: 1027
}

const NATIVE_SYMBOLS: Record<number, string> = {
  1: 'ETH',
  10: 'ETH',
  137: 'POL',
  8453: 'ETH',
  42161: 'ETH'
}

interface CmcStatus {
  error_code?: number | string
  error_message?: string | null
  credit_count?: number
}

interface CmcPlatform {
  id?: number
  slug?: string
  name?: string
  token_address?: string
  coin?: { slug?: string; name?: string }
}

interface CmcContract {
  contract_address?: string
  address?: string
  platform?: CmcPlatform | null
}

interface CmcInfo {
  id?: number
  name?: string
  symbol?: string
  cmc_rank?: number
  rank?: number
  platform?: CmcPlatform | null
  contract_address?: CmcContract[]
  quote?: unknown
  quotes?: unknown
}

export function getNativeCmcId(chainId: number) {
  return NATIVE_CMC_IDS[chainId]
}

export function getNativeSymbol(chainId: number) {
  return NATIVE_SYMBOLS[chainId]
}

export function getChainPlatforms(chainId: number) {
  return CHAIN_PLATFORMS[chainId] || []
}

export function isPricedChain(chainId: number) {
  return Boolean(NATIVE_CMC_IDS[chainId] || CHAIN_PLATFORMS[chainId])
}

export function hasPositiveBalance(balance = '') {
  try {
    return BigInt(balance) > 0n
  } catch (e) {
    return false
  }
}

export function normalizeSymbol(symbol?: string) {
  const value = (symbol || '').trim().toUpperCase()
  return value || undefined
}

export function asChainId(value: unknown) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export function asAddress(value: unknown) {
  if (typeof value !== 'string') return
  const address = value.trim()
  return address || undefined
}

export function isCmcQuoteSymbol(symbol?: string) {
  return Boolean(symbol && /^[A-Z0-9]{1,20}$/.test(symbol))
}

function asTokenList<T>(value: T[] | undefined | null) {
  return Array.isArray(value) ? value : []
}

function asTokenRecord(value: unknown) {
  if (!value || typeof value !== 'object') return
  return value as { chainId?: unknown; address?: unknown; symbol?: string; balance?: string }
}

function inferSymbolFromKey(key: string) {
  const symbol = normalizeSymbol(key)
  if (!symbol || /^[0-9]+$/.test(symbol) || /^0X[0-9A-F]{40}$/.test(symbol)) return
  return symbol
}

export function chainIdFromPlatform(platform?: CmcPlatform | null) {
  if (!platform) return
  for (const [chainId, aliases] of Object.entries(CHAIN_PLATFORMS)) {
    if (platformMatches(Number(chainId), platform) || aliases.includes((platform.slug || '').toLowerCase())) {
      return Number(chainId)
    }
  }
}

export function isPositivePrice(value: unknown) {
  const n = asNumber(value)
  return n !== undefined && n > 0
}

export function targetKey(target: RateTarget) {
  if (target.type === 'native') return `n:${target.chainId}`
  const address = asAddress(target.address)?.toLowerCase() || ''
  return `t:${target.chainId}:${address}`
}

export function fingerprintTargets(targets: RateTarget[]) {
  return targets.map(targetKey).sort().join(',')
}

function isNativeAddress(address: unknown) {
  const value = asAddress(address)
  return Boolean(value && value.toLowerCase() === NATIVE_CURRENCY)
}

function tokenKey(chainId: number, address: string) {
  return `${chainId}:${address.toLowerCase()}`
}

function targetSymbol(target: RateTarget) {
  return target.type === 'native' ? getNativeSymbol(target.chainId) : normalizeSymbol(target.symbol)
}

export function collectQuoteSymbols(targets: RateTarget[]) {
  const natives: string[] = []
  const priority: string[] = []
  const rest: string[] = []

  for (const target of targets) {
    const symbol = targetSymbol(target)
    if (!symbol) continue
    if (!isCmcQuoteSymbol(symbol)) continue
    if (target.type === 'native') natives.push(symbol)
    else if (target.source === 'known') rest.push(symbol)
    else priority.push(symbol)
  }

  return Array.from(new Set([...natives, ...priority, ...rest]))
}

export function selectRateTargets(opts: {
  connectedChainIds: Array<number | string>
  isTestnet: (chainId: number) => boolean
  balances?: Array<Pick<Balance, 'chainId' | 'address' | 'balance' | 'symbol'>>
  customTokens?: Token[]
  knownTokens?: Token[]
  maxTokens?: number
}) {
  const maxTokens = opts.maxTokens ?? 40
  const pricedChains = [
    ...new Set(
      asTokenList(opts.connectedChainIds)
        .map(asChainId)
        .filter((chainId): chainId is number => Boolean(chainId && !opts.isTestnet(chainId) && isPricedChain(chainId)))
    )
  ]
  const priced = new Set(pricedChains)

  const natives: RateTarget[] = pricedChains
    .filter((chainId) => getNativeCmcId(chainId) || getNativeSymbol(chainId))
    .map((chainId) => ({ type: 'native' as const, chainId }))

  const held = new Map<string, TokenTarget>()
  const custom = new Map<string, TokenTarget>()
  const known = new Map<string, TokenTarget>()

  const upsert = (
    bucket: Map<string, TokenTarget>,
    chainId: number | undefined,
    address: unknown,
    symbol: string | undefined,
    source: TokenTarget['source']
  ) => {
    const resolved = asAddress(address)
    if (!chainId || !resolved || !priced.has(chainId) || isNativeAddress(resolved)) return
    const key = tokenKey(chainId, resolved)
    const existing = bucket.get(key)
    const normalized = normalizeSymbol(symbol)
    if (existing) {
      if (!existing.symbol && normalized) existing.symbol = normalized
      return
    }
    bucket.set(key, {
      type: 'token',
      chainId,
      address: resolved.toLowerCase(),
      symbol: normalized,
      source
    })
  }

  for (const balance of asTokenList(opts.balances)) {
    const row = asTokenRecord(balance)
    if (!row || !hasPositiveBalance(row.balance)) continue
    upsert(held, asChainId(row.chainId), row.address, row.symbol, 'held')
  }

  for (const token of asTokenList(opts.customTokens)) {
    const row = asTokenRecord(token)
    if (!row) continue
    upsert(custom, asChainId(row.chainId), row.address, row.symbol, 'custom')
  }

  for (const token of asTokenList(opts.knownTokens)) {
    const row = asTokenRecord(token)
    if (!row) continue
    upsert(known, asChainId(row.chainId), row.address, row.symbol, 'known')
  }

  const customTargets: TokenTarget[] = []
  const reserved = new Set<string>()

  for (const [key, target] of custom) {
    const heldHit = held.get(key)
    customTargets.push({
      ...target,
      symbol: target.symbol || heldHit?.symbol,
      source: 'custom'
    })
    reserved.add(key)
  }

  const heldTargets: TokenTarget[] = []
  for (const [key, target] of held) {
    if (reserved.has(key)) continue
    heldTargets.push(target)
    reserved.add(key)
  }

  const knownFiller: TokenTarget[] = []
  for (const [key, target] of known) {
    if (reserved.has(key)) continue
    knownFiller.push(target)
  }

  const customKept = customTargets.slice(0, maxTokens)
  const heldBudget = Math.max(0, maxTokens - customKept.length)
  const heldKept = heldTargets.slice(0, heldBudget)
  const knownBudget = Math.max(0, maxTokens - customKept.length - heldKept.length)
  const knownKept = knownFiller.slice(0, knownBudget)
  const selectedTokens = [...heldKept, ...customKept, ...knownKept]
  const skipped =
    customTargets.length - customKept.length + heldTargets.length - heldKept.length + knownFiller.length - knownKept.length

  return {
    targets: [...natives, ...selectedTokens],
    natives: natives.length,
    tokens: selectedTokens.length,
    custom: customKept.length,
    customSymbols: customKept.map((token) => token.symbol).filter((symbol): symbol is string => Boolean(symbol)),
    capped: skipped > 0,
    skipped
  }
}

export function platformMatches(chainId: number, platform?: CmcPlatform | null) {
  if (!platform) return false
  const aliases = new Set(getChainPlatforms(chainId).map((slug) => slug.toLowerCase()))
  const slug = (platform.slug || platform.coin?.slug || '').toLowerCase()
  const name = (platform.name || platform.coin?.name || '').toLowerCase().replace(/\s+/g, '-')
  return (slug && aliases.has(slug)) || (name && aliases.has(name))
}

export function flattenCmcInfo(data: unknown): CmcInfo[] {
  if (!data) return []
  if (Array.isArray(data)) return data.filter(Boolean)

  if (typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).flatMap(([key, value]) => {
      const rows = (Array.isArray(value) ? value : value ? [value] : []).filter(Boolean) as CmcInfo[]
      const inferred = inferSymbolFromKey(key)
      return rows
        .filter((row): row is CmcInfo => Boolean(row && typeof row === 'object'))
        .map((row) => (row.symbol || !inferred ? row : { ...row, symbol: inferred }))
    })
  }

  return []
}

function infoAddresses(info: CmcInfo) {
  const rows: Array<{ address: string; platform?: CmcPlatform | null }> = []
  const primary = asAddress(info.platform?.token_address)
  if (primary) {
    rows.push({ address: primary.toLowerCase(), platform: info.platform })
  }
  const deployments = Array.isArray(info.contract_address) ? info.contract_address : []
  for (const entry of deployments) {
    if (!entry || typeof entry !== 'object') continue
    const address = asAddress(entry.contract_address || entry.address)
    if (!address) continue
    rows.push({ address: address.toLowerCase(), platform: entry.platform || info.platform })
  }
  return rows
}

export function matchCmcId(infos: CmcInfo[], address: string, chainId: number) {
  const needle = address.toLowerCase()
  const byAddress = infos.filter((info) => infoAddresses(info).some((row) => row.address === needle))

  const byPlatform = byAddress.filter((info) =>
    infoAddresses(info).some((row) => row.address === needle && platformMatches(chainId, row.platform))
  )
  const pool = byPlatform.length > 0 ? byPlatform : byAddress

  const ranked = [...pool].sort((a, b) => (a.cmc_rank || a.rank || 999999) - (b.cmc_rank || b.rank || 999999))
  const id = ranked[0]?.id
  return typeof id === 'number' ? id : undefined
}

function asNumber(value: unknown) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function extractUsdQuote(asset: {
  id?: unknown
  quote?: unknown
  quotes?: unknown
}): { usd: number; usd_24h_change: number } | undefined {
  const quote = asset.quote ?? asset.quotes
  if (!quote) return

  const read = (entry: Record<string, unknown> | undefined) => {
    const price = asNumber(entry?.price)
    if (price === undefined || price <= 0) return
    return {
      usd: price,
      usd_24h_change:
        asNumber(entry?.percent_change_24h) ?? asNumber(entry?.percentChange24h) ?? 0
    }
  }

  if (Array.isArray(quote)) {
    const usd = quote.find((entry) => {
      const item = entry as { symbol?: string; name?: string }
      return [item.symbol, item.name].some((value) => String(value || '').toUpperCase() === 'USD')
    })
    const labeled = read(usd as Record<string, unknown> | undefined)
    if (labeled) return labeled

    for (const entry of quote) {
      if (!entry || typeof entry !== 'object') continue
      const nested = (entry as { quote?: unknown }).quote
      if (nested && nested !== quote) {
        const inner = extractUsdQuote({ quote: nested })
        if (inner) return inner
      }
      const unlabeled = read(entry as Record<string, unknown>)
      if (unlabeled) return unlabeled
    }
    return
  }

  if (typeof quote === 'object') {
    const record = quote as Record<string, Record<string, unknown>>
    return read(record.USD || record.usd)
  }
}

export function normalizeQuoteAssets(data: unknown): NormalizedQuote[] {
  return flattenCmcInfo(data).flatMap((asset) => {
    try {
      const quote = extractUsdQuote(asset)
      if (!quote) return []
      const id = asNumber(asset.id)
      const symbol = normalizeSymbol(asset.symbol)
      const deployments = infoAddresses(asset)
      const addresses = Array.from(new Set(deployments.map((row) => row.address)))
      const chainIds = Array.from(
        new Set(
          deployments
            .map((row) => chainIdFromPlatform(row.platform))
            .filter((chainId): chainId is number => Boolean(chainId))
        )
      )
      return [
        {
          ...quote,
          ...(id !== undefined ? { id } : {}),
          ...(symbol ? { symbol } : {}),
          ...(addresses.length ? { addresses } : {}),
          ...(chainIds.length ? { chainIds } : {})
        }
      ]
    } catch {
      return []
    }
  })
}

export function applySymbolQuotes(targets: RateTarget[], quotes: NormalizedQuote[]): RateUpdate[] {
  const bySymbol = new Map<string, NormalizedQuote>()

  for (const quote of quotes) {
    const symbol = normalizeSymbol(quote.symbol)
    if (!symbol || !isPositivePrice(quote.usd) || bySymbol.has(symbol)) continue
    bySymbol.set(symbol, quote)
  }

  const updates: RateUpdate[] = []

  for (const target of targets) {
    const address = target.type === 'token' ? asAddress(target.address)?.toLowerCase() : undefined
    const matchedByAddress =
      address &&
      quotes.find((quote) => {
        if (!isPositivePrice(quote.usd) || !(quote.addresses || []).includes(address)) return false
        return !quote.chainIds?.length || quote.chainIds.includes(target.chainId)
      })

    const symbol = targetSymbol(target)
    const quote = matchedByAddress || (symbol ? bySymbol.get(symbol) : undefined)
    if (!quote) continue

    updates.push({
      id:
        target.type === 'native'
          ? { type: AssetType.NativeCurrency, chainId: target.chainId }
          : { type: AssetType.Token, chainId: target.chainId, address },
      data: { usd: quote.usd, usd_24h_change: quote.usd_24h_change }
    })
  }

  return updates
}

export function applyIdQuotes(targets: RateTarget[], quotes: NormalizedQuote[]): RateUpdate[] {
  const byId = new Map<number, { usd: number; usd_24h_change: number }>()

  for (const quote of quotes) {
    if (quote.id === undefined || !isPositivePrice(quote.usd) || byId.has(quote.id)) continue
    byId.set(quote.id, { usd: quote.usd, usd_24h_change: quote.usd_24h_change })
  }

  const updates: RateUpdate[] = []

  for (const target of targets) {
    const cmcId = target.type === 'native' ? getNativeCmcId(target.chainId) : undefined
    const quote = cmcId ? byId.get(cmcId) : undefined
    if (!quote) continue

    updates.push({
      id: { type: AssetType.NativeCurrency, chainId: target.chainId },
      data: quote
    })
  }

  return updates
}

function chunk<T>(items: T[], size: number) {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches
}

class CmcHttpError extends Error {
  status: number
  errorCode?: number | string

  constructor(message: string, status: number, errorCode?: number | string) {
    super(message)
    this.status = status
    this.errorCode = errorCode
  }
}

async function cmcRequest<T>(
  apiKey: string,
  pathname: string,
  query: Record<string, string>
): Promise<{ data: T; status: CmcStatus }> {
  const url = new URL(pathname, CMC_BASE_URL)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value)
  }

  const response = await fetchWithTimeout(
    url.toString(),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-CMC_PRO_API_KEY': apiKey
      }
    },
    REQUEST_TIMEOUT_MS
  )

  let body: { data?: T; status?: CmcStatus } = {}
  try {
    body = (await response.json()) as { data?: T; status?: CmcStatus }
  } catch (e) {
    body = {}
  }

  const errorCode = body.status?.error_code
  const numericError = asNumber(errorCode)
  const data = body.data as T
  const hasData =
    data != null && (Array.isArray(data) ? data.length > 0 : typeof data === 'object' && Object.keys(data).length > 0)
  const failed = (!response.ok || (numericError !== undefined && numericError !== 0)) && !hasData

  if (failed) {
    throw new CmcHttpError(
      body.status?.error_message || `CMC HTTP ${response.status}`,
      response.status,
      errorCode
    )
  }

  return { data, status: body.status || {} }
}

export function createCmcPriceFeed(
  store: Store,
  onUpdates: (updates: RateUpdate[]) => void,
  opts?: { cachePath?: string }
) {
  const storeApi = {
    getKnownTokens: (address?: Address) =>
      asTokenList((address && store('main.tokens.known', address)) as Token[]),
    getCustomTokens: () => asTokenList(store('main.tokens.custom') as Token[]),
    getBalances: (address?: Address) =>
      asTokenList((address && store('main.balances', address)) as Balance[]),
    isTestnet: (chainId: number) => {
      const chain = store('main.networks.ethereum', chainId) as Chain | undefined
      return Boolean(chain?.isTestnet || chain?.layer === 'testnet')
    }
  }

  const idCache = new Map<string, number>()
  const missCache = new Set<string>()
  const deadTouched = new Set<string>()

  let cacheState: CmcCacheFile = emptyCache()
  let pollTimer: NodeJS.Timeout | undefined
  let targets: RateTarget[] = []
  let subscribedChains: number[] = []
  let subscribedAddress: Address | undefined
  let currentFingerprint = ''
  let inflight = false
  let lastPollAt = 0
  let backoffUntil = 0
  let backoffMs = MIN_POLL_GAP_MS
  let started = false
  let emptyTargetRetries = 0
  let catchUpRetries = 0
  let completedTargetPoll = false
  let pendingCatchUp = false
  let lastPolledFingerprint = ''

  function resolveCachePath() {
    return opts?.cachePath || getCmcCachePath()
  }

  function persistCache() {
    try {
      saveCmcCache(resolveCachePath(), cacheState)
    } catch (e) {
      log.warn('CMC cache write failed', { message: e instanceof Error ? e.message : 'unknown' })
    }
  }

  function rememberUpdates(updates: RateUpdate[]) {
    for (const update of updates) {
      if (!isPositivePrice(update.data.usd)) continue

      if (update.id.type === AssetType.NativeCurrency) {
        const chainId = update.id.chainId
        cacheState.rates[`n:${chainId}`] = {
          type: 'native',
          chainId,
          symbol: getNativeSymbol(chainId),
          usd: update.data.usd,
          usd_24h_change: update.data.usd_24h_change
        }
        continue
      }

      const address = String(update.id.address || '').toLowerCase()
      const chainId = update.id.chainId
      const matched = targets.find(
        (target) =>
          target.type === 'token' && target.chainId === chainId && target.address.toLowerCase() === address
      )
      const symbol = matched && matched.type === 'token' ? matched.symbol : undefined
      cacheState.rates[`t:${chainId}:${address}`] = {
        type: 'token',
        chainId,
        address,
        usd: update.data.usd,
        usd_24h_change: update.data.usd_24h_change,
        ...(symbol ? { symbol } : {})
      }
      if (symbol) {
        clearDead(cacheState.dead, symbol)
      }
    }
  }

  function markDeadOnce(symbol: string, reason: string) {
    const key = normalizeSymbol(symbol) || symbol
    if (!key || deadTouched.has(key)) return
    markDead(cacheState.dead, key, reason)
    deadTouched.add(key)
  }

  function onSubscribedChain(chainId: unknown) {
    const id = asChainId(chainId)
    return id !== undefined && subscribedChains.some((chain) => asChainId(chain) === id)
  }

  function selectFromStore() {
    return selectRateTargets({
      connectedChainIds: subscribedChains,
      isTestnet: storeApi.isTestnet,
      balances: storeApi.getBalances(subscribedAddress),
      customTokens: storeApi
        .getCustomTokens()
        .filter((token) => Boolean(asTokenRecord(token) && onSubscribedChain(token.chainId))),
      knownTokens: storeApi
        .getKnownTokens(subscribedAddress)
        .filter((token) => Boolean(asTokenRecord(token) && onSubscribedChain(token.chainId))),
      maxTokens: getCmcMaxTokens()
    })
  }

  function applySelection(selection: ReturnType<typeof selectRateTargets>) {
    targets = selection.targets
    currentFingerprint = fingerprintTargets(targets)

    if (selection.capped) {
      log.warn('CMC token list capped', {
        maxTokens: getCmcMaxTokens(),
        kept: selection.tokens,
        skipped: selection.skipped,
        custom: selection.custom
      })
    }

    return selection
  }

  function apiKey() {
    return resolveCmcApiKey()
  }

  function isEnabled() {
    return Boolean(apiKey())
  }

  function pollInterval() {
    return getCmcPollIntervalMs()
  }

  function clearTimer() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = undefined
  }

  function schedule(delay: number) {
    clearTimer()
    if (!started) return
    pollTimer = setTimeout(() => {
      void tick()
    }, Math.max(0, delay))
  }

  function nextDelay() {
    const now = Date.now()
    if (!lastPollAt) return Math.max(FIRST_POLL_DELAY_MS, backoffUntil - now)
    const dueIn = Math.max(0, lastPollAt + pollInterval() - now)
    const backoffIn = Math.max(0, backoffUntil - now)
    const minGap = Math.max(0, lastPollAt + MIN_POLL_GAP_MS - now)
    return Math.max(dueIn, backoffIn, minGap)
  }

  function scheduleAfterPoll(result: PollResult) {
    if (result === 'empty') {
      emptyTargetRetries += 1
      if (emptyTargetRetries <= MAX_EMPTY_TARGET_RETRIES) {
        log.info('CMC retrying soon, no priced targets yet', {
          attempt: emptyTargetRetries,
          delayMs: EMPTY_TARGET_RETRY_MS
        })
        schedule(EMPTY_TARGET_RETRY_MS)
        return
      }
      log.info('CMC empty-target retries exhausted, falling back to poll interval', {
        pollIntervalMs: pollInterval()
      })
      schedule(pollInterval())
      return
    }

    emptyTargetRetries = 0

    if (pendingCatchUp || currentFingerprint !== lastPolledFingerprint) {
      catchUpRetries += 1
      if (catchUpRetries <= MAX_EMPTY_TARGET_RETRIES) {
        pendingCatchUp = false
        log.info('CMC catch-up poll scheduled, priced targets grew', {
          attempt: catchUpRetries,
          delayMs: EMPTY_TARGET_RETRY_MS
        })
        schedule(Math.max(EMPTY_TARGET_RETRY_MS, backoffUntil - Date.now()))
        return
      }
      pendingCatchUp = false
      log.info('CMC catch-up retries exhausted, falling back to poll interval', {
        pollIntervalMs: pollInterval()
      })
    }

    catchUpRetries = 0
    schedule(nextDelay())
  }

  function emit(updates: RateUpdate[], persist = true) {
    const priced = updates.filter((update) => isPositivePrice(update.data.usd))
    if (priced.length > 0) {
      if (persist) {
        rememberUpdates(priced)
        persistCache()
      }
      onUpdates(priced)
    }
    return priced.length
  }

  async function fetchQuotes(key: string, query: Record<string, string>) {
    return cmcRequest<unknown>(key, QUOTES_PATH, {
      convert: 'USD',
      skip_invalid: 'true',
      ...query
    })
  }

  async function resolveUnpricedTokenIds(
    tokens: Extract<RateTarget, { type: 'token' }>[],
    key: string
  ) {
    const unresolved = tokens.filter((token) => {
      const cacheKey = tokenKey(token.chainId, token.address)
      return !idCache.has(cacheKey) && !missCache.has(cacheKey)
    })

    if (unresolved.length === 0) return

    log.info('CMC resolving leftover contract addresses', { count: unresolved.length })

    for (const batch of chunk(unresolved, INFO_BATCH_SIZE)) {
      const uniqueAddresses = Array.from(new Set(batch.map((token) => token.address)))

      try {
        const { data, status } = await cmcRequest<unknown>(key, '/v2/cryptocurrency/info', {
          address: uniqueAddresses.join(','),
          skip_invalid: 'true'
        })

        log.info('CMC info response', {
          requested: uniqueAddresses.length,
          credit_count: status.credit_count,
          error_code: status.error_code || 0
        })

        const infos = flattenCmcInfo(data)

        for (const token of batch) {
          const cacheKey = tokenKey(token.chainId, token.address)
          const cmcId = matchCmcId(infos, token.address, token.chainId)
          if (cmcId) {
            idCache.set(cacheKey, cmcId)
          } else {
            missCache.add(cacheKey)
            log.warn('CMC no id for token', { chainId: token.chainId, address: token.address })
          }
        }
      } catch (e) {
        const status = e instanceof CmcHttpError ? e.status : undefined
        log.warn('CMC address lookup skipped', {
          status,
          count: uniqueAddresses.length,
          message: e instanceof Error ? e.message : 'unknown'
        })
      }
    }
  }

  async function poll(): Promise<PollResult> {
    const key = apiKey()
    if (!key) return 'skipped'

    deadTouched.clear()

    if (Date.now() < backoffUntil) {
      log.warn('CMC skip-due-to-rate-limit', { retryInMs: backoffUntil - Date.now() })
      return 'skipped'
    }

    try {
      if (subscribedChains.length > 0) {
        applySelection(selectFromStore())
      }
    } catch (e) {
      log.error('CMC target selection failed', { message: e instanceof Error ? e.message : 'unknown' })
    }

    if (targets.length === 0 && subscribedChains.length > 0) {
      const natives = subscribedChains
        .map(asChainId)
        .filter((chainId): chainId is number => Boolean(chainId && isPricedChain(chainId)))
        .map((chainId) => ({ type: 'native' as const, chainId }))
      if (natives.length > 0) applySelection({
        targets: natives,
        natives: natives.length,
        tokens: 0,
        custom: 0,
        customSymbols: [],
        capped: false,
        skipped: 0
      })
    }

    const tokenTargets = targets.filter(
      (target): target is Extract<RateTarget, { type: 'token' }> => target.type === 'token'
    )
    const customTargets = tokenTargets.filter((token) => token.source === 'custom')
    const symbols = collectQuoteSymbols(targets)
    const nativeSymbols = Array.from(
      new Set(
        targets
          .filter((target) => target.type === 'native')
          .map((target) => getNativeSymbol(target.chainId))
          .filter((symbol): symbol is string => Boolean(symbol && isCmcQuoteSymbol(symbol)))
      )
    )
    const tokenSymbols = symbols.filter((symbol) => !nativeSymbols.includes(symbol))
    const plan = planQuoteBatches({
      nativeSymbols,
      tokenSymbols,
      dead: cacheState.dead,
      maxRetrySymbols: getCmcMaxTokens()
    })

    log.info('CMC poll start', {
      natives: targets.filter((target) => target.type === 'native').length,
      tokens: tokenTargets.length,
      symbols: symbols.length,
      symbolList: symbols,
      custom: customTargets.length,
      customSymbols: customTargets.map((token) => token.symbol).filter((symbol): symbol is string => Boolean(symbol)),
      hotTokenSymbols: plan.hotTokenSymbols,
      retryTokenSymbols: plan.retryTokenSymbols,
      dead: Object.keys(cacheState.dead).length
    })

    if (targets.length === 0) {
      log.info('CMC poll skipped, no priced assets in scope', {
        subscribedChains: subscribedChains.length,
        emptyRetries: emptyTargetRetries
      })
      return 'empty'
    }

    const polledFingerprint = currentFingerprint
    lastPolledFingerprint = polledFingerprint

    let quoted = 0
    let applied = 0
    let credits = 0
    const pricedKeys = new Set<string>()

    const noteApplied = (updates: RateUpdate[]) => {
      const count = emit(updates)
      applied += count
      for (const update of updates) {
        if (!isPositivePrice(update.data.usd)) continue
        pricedKeys.add(
          update.id.type === AssetType.NativeCurrency
            ? `n:${update.id.chainId}`
            : `t:${update.id.chainId}:${String(update.id.address || '').toLowerCase()}`
        )
      }
      return count
    }

    const rethrowFatal = (e: unknown) => {
      const status = e instanceof CmcHttpError ? e.status : undefined
      const errorCode = e instanceof CmcHttpError ? e.errorCode : undefined
      if (status === 401 || status === 403 || status === 429 || asNumber(errorCode) === 1006 || asNumber(errorCode) === 1008) {
        throw e
      }
      return { status, errorCode }
    }

    const quoteBySymbol = async (batch: string[], kind: 'native' | 'hot' | 'retry') => {
      if (batch.length === 0) return
      try {
        const { data, status } = await fetchQuotes(key, { symbol: batch.join(',') })
        credits += status.credit_count || 0
        const quotes = normalizeQuoteAssets(data)
        quoted += quotes.length
        const batchApplied = noteApplied(applySymbolQuotes(targets, quotes))

        log.info('CMC quotes response', {
          path: QUOTES_PATH,
          by: 'symbol',
          kind,
          requested: batch.length,
          symbols: batch,
          quoted: quotes.length,
          quotedSymbols: quotes.map((quote) => quote.symbol).filter((symbol): symbol is string => Boolean(symbol)),
          applied: batchApplied,
          credit_count: status.credit_count,
          error_code: status.error_code || 0
        })
      } catch (e) {
        const { status, errorCode } = rethrowFatal(e)
        log.error('CMC symbol quotes failed', {
          status,
          errorCode,
          kind,
          symbols: batch,
          message: e instanceof Error ? e.message : 'unknown'
        })
        if (kind !== 'native' && (status === 400 || status === 404 || status === 500)) {
          for (const symbol of batch) {
            markDeadOnce(symbol, status === 500 ? 'http-500' : 'invalid')
          }
        }
      }
    }

    // One tick: natives + hot custom/held in parallel. Due dead symbols add at most
    // one extra concurrent quotes/latest (never one HTTP call per failed token).
    const quoteJobs = [quoteBySymbol(plan.nativeSymbols, 'native'), quoteBySymbol(plan.hotTokenSymbols, 'hot')]
    if (plan.retryTokenSymbols.length > 0) {
      quoteJobs.push(quoteBySymbol(plan.retryTokenSymbols, 'retry'))
    }
    await Promise.all(quoteJobs)
    if (!started) return 'skipped'
    if (applied > 0) persistCache()

    const missingNatives = targets.filter(
      (target) => target.type === 'native' && !pricedKeys.has(targetKey(target))
    )
    const missingNativeIds = Array.from(
      new Set(missingNatives.map((target) => getNativeCmcId(target.chainId)).filter((id): id is number => Boolean(id)))
    )

    if (missingNativeIds.length > 0) {
      try {
        const { data, status } = await fetchQuotes(key, { id: missingNativeIds.join(',') })
        credits += status.credit_count || 0
        const quotes = normalizeQuoteAssets(data)
        quoted += quotes.length
        const batchApplied = noteApplied(applyIdQuotes(missingNatives, quotes))

        log.info('CMC quotes response', {
          path: QUOTES_PATH,
          by: 'id',
          requested: missingNativeIds.length,
          quoted: quotes.length,
          applied: batchApplied,
          credit_count: status.credit_count,
          error_code: status.error_code || 0
        })
      } catch (e) {
        const { status, errorCode } = rethrowFatal(e)
        log.error('CMC native id quotes failed', {
          status,
          errorCode,
          message: e instanceof Error ? e.message : 'unknown'
        })
      }
    }

    if (!started) return 'skipped'

    const leftoverTokens = tokenTargets.filter((token) => {
      if (pricedKeys.has(targetKey(token))) return false
      if (!(token.source === 'custom' || token.source === 'held' || !token.symbol)) return false
      const symbol = normalizeSymbol(token.symbol)
      const dead = symbol ? cacheState.dead[symbol] : cacheState.dead[targetKey(token)]
      return !dead || isDeadDue(dead)
    })
    if (leftoverTokens.length > 0) {
      await resolveUnpricedTokenIds(leftoverTokens, key)
      const leftoverIds = leftoverTokens
        .map((token) => idCache.get(tokenKey(token.chainId, token.address)))
        .filter((id): id is number => Boolean(id))

      if (leftoverIds.length > 0) {
        try {
          const { data, status } = await fetchQuotes(key, { id: leftoverIds.join(',') })
          credits += status.credit_count || 0
          const quotes = normalizeQuoteAssets(data)
          quoted += quotes.length
          const byId = new Map(quotes.filter((quote) => quote.id !== undefined).map((quote) => [quote.id, quote]))
          const updates: RateUpdate[] = []

          for (const token of leftoverTokens) {
            const cmcId = idCache.get(tokenKey(token.chainId, token.address))
            const quote = cmcId ? byId.get(cmcId) : undefined
            if (!quote || !isPositivePrice(quote.usd)) continue
            updates.push({
              id: { type: AssetType.Token, chainId: token.chainId, address: token.address.toLowerCase() },
              data: { usd: quote.usd, usd_24h_change: quote.usd_24h_change }
            })
          }

          noteApplied(updates)
        } catch (e) {
          const { status, errorCode } = rethrowFatal(e)
          log.warn('CMC leftover id quotes skipped', {
            status,
            errorCode,
            message: e instanceof Error ? e.message : 'unknown'
          })
        }
      }
    }

    if (!started) return 'skipped'

    for (const token of tokenTargets) {
      if (token.source !== 'custom' && token.source !== 'held') continue
      if (pricedKeys.has(targetKey(token))) {
        if (token.symbol) clearDead(cacheState.dead, token.symbol)
        continue
      }
      const key = token.symbol && isCmcQuoteSymbol(token.symbol) ? token.symbol : targetKey(token)
      if (deadTouched.has(key) || cacheState.dead[key]) {
        if (cacheState.dead[key] && !deadTouched.has(key) && isDeadDue(cacheState.dead[key])) {
          markDeadOnce(key, cacheState.dead[key].reason || 'no-quote')
        }
        continue
      }
      markDeadOnce(key, 'no-quote')
    }

    persistCache()
    lastPollAt = Date.now()
    completedTargetPoll = true
    emptyTargetRetries = 0
    backoffMs = MIN_POLL_GAP_MS
    if (currentFingerprint !== polledFingerprint) pendingCatchUp = true
    log.info('CMC poll complete', { quoted, applied, credit_count: credits, symbols: symbols.length })
    return 'ok'
  }

  function noteRateLimit(status?: number) {
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(pollInterval(), backoffMs * 2))
    backoffUntil = Date.now() + backoffMs
    log.warn('CMC skip-due-to-rate-limit', { status, retryInMs: backoffMs })
  }

  async function tick() {
    if (inflight) {
      schedule(5_000)
      return
    }

    inflight = true
    try {
      const result = await poll()
      if (result === 'empty' && targets.length > 0) {
        emptyTargetRetries = 0
        schedule(FIRST_POLL_DELAY_MS)
        return
      }
      scheduleAfterPoll(result)
    } catch (e) {
      const status = e instanceof CmcHttpError ? e.status : undefined
      const errorCode = e instanceof CmcHttpError ? e.errorCode : undefined

      if (status === 429 || asNumber(errorCode) === 1006 || asNumber(errorCode) === 1008) {
        noteRateLimit(status)
        schedule(nextDelay())
        return
      }

      if (status === 401 || status === 403) {
        log.error(
          'CMC authentication failed; Pylon rates will not start. Last-good cached prices will be kept. Check CMC_API_KEY or the Settings key.'
        )
        clearTimer()
        return
      }

      log.error('CMC poll failed', { status, errorCode, message: e instanceof Error ? e.message : 'unknown' })
      schedule(pollInterval())
    } finally {
      inflight = false
    }
  }

  function updateSubscription(chains: number[], address?: Address) {
    subscribedChains = asTokenList(chains)
      .map(asChainId)
      .filter((chainId): chainId is number => Boolean(chainId))
    subscribedAddress = address

    const previousFingerprint = currentFingerprint
    let selection: ReturnType<typeof selectRateTargets>
    try {
      selection = applySelection(selectFromStore())
    } catch (e) {
      log.error('CMC subscription failed', { message: e instanceof Error ? e.message : 'unknown' })
      if (!started) return
      schedule(FIRST_POLL_DELAY_MS)
      return
    }
    const changed = currentFingerprint !== previousFingerprint

    log.info('CMC subscription', {
      natives: selection.natives,
      tokens: selection.tokens,
      custom: selection.custom,
      customSymbols: selection.customSymbols,
      symbols: collectQuoteSymbols(targets),
      changed
    })

    if (!started) return

    if (!changed) return

    const now = Date.now()
    const backoffIn = Math.max(0, backoffUntil - now)

    // A poll is already quoting a stale snapshot. Mark catch-up and do not
    // reschedule here — scheduleAfterPoll would overwrite a 1s retry with 5 min.
    if (inflight) {
      pendingCatchUp = true
      return
    }

    // Cold start / first priced targets: do not wait MIN_POLL_GAP or the 5 min interval.
    if (!completedTargetPoll) {
      emptyTargetRetries = 0
      schedule(Math.max(backoffIn, FIRST_POLL_DELAY_MS))
      return
    }

    pendingCatchUp = true
    schedule(Math.max(backoffIn, EMPTY_TARGET_RETRY_MS))
  }

  function start() {
    started = true
    try {
      cacheState = loadCmcCache(resolveCachePath())
      const hydrated = cacheToRateUpdates(cacheState)
      const applied = emit(hydrated as RateUpdate[], false)
      log.info('CMC cache hydrated', {
        rates: Object.keys(cacheState.rates).length,
        dead: Object.keys(cacheState.dead).length,
        applied,
        path: resolveCachePath()
      })
    } catch (e) {
      cacheState = emptyCache()
      log.warn('CMC cache hydrate failed', { message: e instanceof Error ? e.message : 'unknown' })
    }
    if (!isEnabled()) {
      log.info('CMC key missing; using last-good cache only; Pylon rates stay unused')
      clearTimer()
      return
    }

    log.info('starting CMC price feed', {
      path: QUOTES_PATH,
      pollIntervalMs: pollInterval(),
      maxTokens: getCmcMaxTokens()
    })
    schedule(FIRST_POLL_DELAY_MS)
  }

  function stop() {
    started = false
    clearTimer()
    targets = []
    subscribedChains = []
    subscribedAddress = undefined
    currentFingerprint = ''
    emptyTargetRetries = 0
    catchUpRetries = 0
    completedTargetPoll = false
    pendingCatchUp = false
    lastPolledFingerprint = ''
    lastPollAt = 0
    log.verbose('stopping CMC price feed')
  }

  return {
    isEnabled,
    start,
    stop,
    updateSubscription
  }
}
