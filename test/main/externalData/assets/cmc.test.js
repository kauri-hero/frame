import fs from 'fs'
import os from 'os'
import path from 'path'

import { fetchWithTimeout } from '../../../../resources/utils/fetch'
import {
  applySymbolQuotes,
  collectQuoteSymbols,
  createCmcPriceFeed,
  EMPTY_TARGET_RETRY_MS,
  extractUsdQuote,
  fingerprintTargets,
  FIRST_POLL_DELAY_MS,
  flattenCmcInfo,
  hasPositiveBalance,
  isCmcQuoteSymbol,
  matchCmcId,
  MAX_EMPTY_TARGET_RETRIES,
  normalizeQuoteAssets,
  platformMatches,
  selectRateTargets,
  targetKey
} from '../../../../main/externalData/assets/cmc'
import {
  CMC_CACHE_FILENAME,
  cacheToRateUpdates,
  getCmcCachePath,
  loadCmcCache,
  markDead,
  nextSymbolBackoffMs,
  planQuoteBatches,
  saveCmcCache,
  SYMBOL_BACKOFF_INITIAL_MS,
  SYMBOL_BACKOFF_MAX_MS
} from '../../../../main/externalData/assets/cmcCache'

jest.mock('../../../../resources/utils/fetch', () => ({
  fetchWithTimeout: jest.fn()
}))

const VVV = '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf'

describe('hasPositiveBalance', () => {
  it('treats hex zero as empty', () => {
    expect(hasPositiveBalance('0x0')).toBe(false)
    expect(hasPositiveBalance('0x00')).toBe(false)
  })

  it('treats a positive hex balance as held', () => {
    expect(hasPositiveBalance('0x1')).toBe(true)
  })
})

describe('selectRateTargets', () => {
  const isTestnet = (chainId) => chainId === 84532 || chainId === 11155111

  it('includes natives and held tokens, keeps custom, then caps known extras', () => {
    const selection = selectRateTargets({
      connectedChainIds: [1, 8453, 84532],
      isTestnet,
      maxTokens: 2,
      balances: [
        { chainId: 8453, address: VVV, balance: '0x10', symbol: 'VVV' },
        { chainId: 8453, address: '0x1111111111111111111111111111111111111111', balance: '0x0', symbol: 'DUST' }
      ],
      customTokens: [{ chainId: 8453, address: '0x2222222222222222222222222222222222222222', symbol: 'FOO' }],
      knownTokens: [{ chainId: 1, address: '0x3333333333333333333333333333333333333333', symbol: 'BAR' }]
    })

    expect(selection.natives).toBe(2)
    expect(selection.tokens).toBe(2)
    expect(selection.custom).toBe(1)
    expect(selection.customSymbols).toEqual(['FOO'])
    expect(selection.capped).toBe(true)
    expect(selection.skipped).toBe(1)
    expect(
      selection.targets.filter((target) => target.type === 'native').map((target) => target.chainId)
    ).toEqual([1, 8453])
    expect(selection.targets.find((target) => target.symbol === 'VVV').address).toBe(VVV)
    expect(collectQuoteSymbols(selection.targets)).toEqual(['ETH', 'VVV', 'FOO'])
  })

  it('reserves custom tokens inside the cap instead of appending past it', () => {
    const held = Array.from({ length: 40 }, (_, i) => ({
      chainId: 1,
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      balance: '0x10',
      symbol: `H${i}`
    }))

    const selection = selectRateTargets({
      connectedChainIds: [1, '8453'],
      isTestnet,
      maxTokens: 40,
      balances: held,
      customTokens: [{ chainId: '8453', address: VVV.toUpperCase(), symbol: 'vvv' }]
    })

    const tokenTargets = selection.targets.filter((target) => target.type === 'token')
    expect(tokenTargets).toHaveLength(40)
    expect(tokenTargets.filter((target) => target.source === 'held')).toHaveLength(39)
    expect(tokenTargets.some((target) => target.address === VVV && target.symbol === 'VVV')).toBe(true)
    expect(selection.customSymbols).toEqual(['VVV'])
    expect(collectQuoteSymbols(selection.targets)).toContain('VVV')
    expect(collectQuoteSymbols(selection.targets)).toContain('ETH')
  })

  it('skips sparse custom rows and non-string addresses without throwing', () => {
    const selection = selectRateTargets({
      connectedChainIds: ['8453', 1],
      isTestnet,
      customTokens: [
        null,
        { chainId: '8453', address: 12345, symbol: 'BAD' },
        { chainId: '8453', address: VVV, symbol: 'VVV' }
      ],
      knownTokens: undefined
    })

    expect(selection.customSymbols).toEqual(['VVV'])
    expect(collectQuoteSymbols(selection.targets)).toEqual(['ETH', 'VVV'])
  })

  it('keeps a custom token even when the known list far exceeds the cap', () => {
    const knownTokens = Array.from({ length: 60 }, (_, i) => ({
      chainId: 1,
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      symbol: `K${i}`
    }))

    const selection = selectRateTargets({
      connectedChainIds: ['8453', 1],
      isTestnet,
      maxTokens: 40,
      customTokens: [{ chainId: '8453', address: VVV.toUpperCase(), symbol: 'vvv' }],
      knownTokens
    })

    const tokenTargets = selection.targets.filter((target) => target.type === 'token')
    expect(tokenTargets).toHaveLength(40)
    expect(tokenTargets.some((target) => target.address === VVV && target.symbol === 'VVV')).toBe(true)
    expect(selection.customSymbols).toEqual(['VVV'])
    expect(collectQuoteSymbols(selection.targets)).toContain('VVV')
    expect(selection.capped).toBe(true)
    expect(selection.skipped).toBe(21)
  })

  it('skips unmapped and testnet chains', () => {
    const selection = selectRateTargets({
      connectedChainIds: [84532, 999999],
      isTestnet,
      balances: [{ chainId: 84532, address: VVV, balance: '0x10' }]
    })

    expect(selection.targets).toEqual([])
  })
})

describe('CMC info matching', () => {
  it('flattens address-keyed and array payloads', () => {
    const infos = flattenCmcInfo({
      [VVV]: {
        id: 31848,
        platform: { slug: 'base', token_address: VVV }
      }
    })

    expect(infos[0].id).toBe(31848)
    expect(flattenCmcInfo([{ id: 1 }])).toEqual([{ id: 1 }])
  })

  it('prefers the Base listing when the same address is ambiguous', () => {
    const cmcId = matchCmcId(
      [
        {
          id: 1,
          cmc_rank: 1,
          platform: { slug: 'ethereum', token_address: VVV }
        },
        {
          id: 31848,
          cmc_rank: 200,
          platform: { slug: 'base', token_address: VVV }
        }
      ],
      VVV,
      8453
    )

    expect(cmcId).toBe(31848)
    expect(platformMatches(8453, { slug: 'base' })).toBe(true)
  })

  it('matches a contract_address deployment when the primary platform differs', () => {
    const cmcId = matchCmcId(
      [
        {
          id: 3408,
          symbol: 'USDC',
          platform: { slug: 'zksync', token_address: '0x1111111111111111111111111111111111111111' },
          contract_address: [
            { contract_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', platform: { slug: 'base' } }
          ]
        }
      ],
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      8453
    )

    expect(cmcId).toBe(3408)
  })
})

describe('CMC symbol filter', () => {
  it('keeps ETH/POL/VVV and drops junk tickers that would 400 a batch', () => {
    expect(isCmcQuoteSymbol('ETH')).toBe(true)
    expect(isCmcQuoteSymbol('POL')).toBe(true)
    expect(isCmcQuoteSymbol('VVV')).toBe(true)
    expect(isCmcQuoteSymbol('BASE.VULT')).toBe(false)
    expect(isCmcQuoteSymbol('USD COIN')).toBe(false)

    expect(
      collectQuoteSymbols([
        { type: 'native', chainId: 1 },
        { type: 'token', chainId: 8453, address: VVV, symbol: 'VVV', source: 'custom' },
        {
          type: 'token',
          chainId: 8453,
          address: '0x1111111111111111111111111111111111111111',
          symbol: 'BASE.VULT',
          source: 'custom'
        }
      ])
    ).toEqual(['ETH', 'VVV'])
  })
})

describe('quote parsing', () => {
  it('reads v3 array quotes and legacy USD objects', () => {
    expect(
      extractUsdQuote({
        quote: [{ symbol: 'USD', price: 22.4, percent_change_24h: 1.5 }]
      })
    ).toEqual({ usd: 22.4, usd_24h_change: 1.5 })

    expect(
      extractUsdQuote({
        quote: { USD: { price: 7.21, percent_change_24h: -2 } }
      })
    ).toEqual({ usd: 7.21, usd_24h_change: -2 })

    expect(extractUsdQuote({ quote: { USD: { price: 0, percent_change_24h: 0 } } })).toBeUndefined()

    expect(
      extractUsdQuote({
        quotes: [{ quote: { USD: { price: 2460, percent_change_24h: 1 } } }]
      })
    ).toEqual({ usd: 2460, usd_24h_change: 1 })
  })

  it('normalizes both array and id-keyed quote payloads', () => {
    const quotes = normalizeQuoteAssets({
      1027: { id: 1027, quote: { USD: { price: 3300, percent_change_24h: 0.2 } } }
    })

    expect(quotes).toEqual([{ id: 1027, usd: 3300, usd_24h_change: 0.2 }])
    expect(
      normalizeQuoteAssets([
        { id: 1027, symbol: 'ETH', quote: { USD: { price: 2460, percent_change_24h: 1 } } },
        { id: 28321, symbol: 'POL', quote: { USD: { price: 0.27, percent_change_24h: -1 } } }
      ]).map((quote) => quote.symbol)
    ).toEqual(['ETH', 'POL'])
  })
})

describe('symbol quote mapping', () => {
  it('applies one USDC quote to every matching held address and ETH to each ETH native', () => {
    const updates = applySymbolQuotes(
      [
        { type: 'native', chainId: 1 },
        { type: 'native', chainId: 8453 },
        { type: 'native', chainId: 137 },
        { type: 'token', chainId: 8453, address: VVV, symbol: 'VVV' },
        {
          type: 'token',
          chainId: 8453,
          address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          symbol: 'USDC'
        },
        {
          type: 'token',
          chainId: 1,
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          symbol: 'usdc'
        }
      ],
      [
        { symbol: 'ETH', usd: 2460, usd_24h_change: 1 },
        { symbol: 'POL', usd: 0.27, usd_24h_change: -1 },
        { symbol: 'VVV', usd: 22.4, usd_24h_change: 3 },
        { symbol: 'USDC', usd: 1, usd_24h_change: 0 }
      ]
    )

    expect(updates.filter((update) => update.id.type === 0).map((update) => update.id.chainId)).toEqual([
      1, 8453, 137
    ])
    expect(updates.find((update) => update.id.address === VVV).data.usd).toBe(22.4)
    expect(updates.filter((update) => update.data.usd === 1)).toHaveLength(2)
  })

  it('maps a checksummed Base custom address when CMC keys the quote by VVV', () => {
    const checksummed = '0xacFE6019Ed1A7Dc6f7B508C02d1b04EC88cC21bf'
    const quotes = normalizeQuoteAssets({
      VVV: {
        id: 31848,
        quote: { USD: { price: 22.4, percent_change_24h: 3 } },
        platform: { slug: 'base', token_address: checksummed }
      }
    })

    const updates = applySymbolQuotes(
      [{ type: 'token', chainId: 8453, address: checksummed, symbol: 'VVV' }],
      quotes
    )

    expect(quotes[0].symbol).toBe('VVV')
    expect(quotes[0].addresses).toEqual([VVV])
    expect(quotes[0].chainIds).toEqual([8453])
    expect(updates).toEqual([
      {
        id: { type: 1, chainId: 8453, address: VVV },
        data: { usd: 22.4, usd_24h_change: 3 }
      }
    ])
  })
})

describe('subscription fingerprint', () => {
  it('is stable regardless of target order', () => {
    const a = [
      { type: 'native', chainId: 8453 },
      { type: 'token', chainId: 8453, address: VVV }
    ]
    const b = [
      { type: 'token', chainId: 8453, address: VVV.toUpperCase() },
      { type: 'native', chainId: 8453 }
    ]

    expect(fingerprintTargets(a)).toBe(fingerprintTargets(b))
    expect(targetKey(b[0])).toBe(`t:8453:${VVV}`)
  })
})

describe('CMC disk cache', () => {
  let cacheDir

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-rates-'))
  })

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  it('writes under the given userData path as cmc-rates.json', () => {
    expect(getCmcCachePath(cacheDir)).toBe(path.join(cacheDir, CMC_CACHE_FILENAME))
  })

  it('hydrates only last-good positive quotes and never writes secrets or zero prices', () => {
    const file = path.join(cacheDir, CMC_CACHE_FILENAME)
    saveCmcCache(file, {
      version: 1,
      updatedAt: 1,
      apiKey: 'should-not-be-saved',
      CMC_API_KEY: 'also-secret',
      rates: {
        'n:1': { type: 'native', chainId: 1, symbol: 'ETH', usd: 2460, usd_24h_change: 1 },
        'n:137': { type: 'native', chainId: 137, symbol: 'POL', usd: 0, usd_24h_change: 0 },
        [`t:8453:${VVV}`]: {
          type: 'token',
          chainId: 8453,
          address: VVV,
          symbol: 'VVV',
          usd: 22.4,
          usd_24h_change: 3
        }
      },
      dead: {
        HOPELESS: {
          symbol: 'HOPELESS',
          reason: 'no-quote',
          lastFailedAt: 10,
          nextRetryAt: 20,
          intervalMs: SYMBOL_BACKOFF_INITIAL_MS
        }
      }
    })

    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toMatch(/should-not-be-saved|also-secret|CMC_API_KEY|apiKey/)

    const loaded = loadCmcCache(file)
    expect(loaded.rates['n:137']).toBeUndefined()
    expect(loaded.rates['n:1'].usd).toBe(2460)
    expect(loaded.dead.HOPELESS.reason).toBe('no-quote')

    const updates = cacheToRateUpdates(loaded)
    expect(updates.map((update) => [update.id.type, update.id.chainId, update.id.address, update.data.usd])).toEqual(
      [
        [0, 1, undefined, 2460],
        [1, 8453, VVV, 22.4]
      ]
    )
  })
})

describe('CMC symbol backoff', () => {
  it('grows 2min → 4 → 8 and caps at 60min', () => {
    expect(nextSymbolBackoffMs()).toBe(2 * 60_000)
    expect(nextSymbolBackoffMs(SYMBOL_BACKOFF_INITIAL_MS)).toBe(4 * 60_000)
    expect(nextSymbolBackoffMs(4 * 60_000)).toBe(8 * 60_000)
    expect(nextSymbolBackoffMs(32 * 60_000)).toBe(SYMBOL_BACKOFF_MAX_MS)
    expect(nextSymbolBackoffMs(SYMBOL_BACKOFF_MAX_MS)).toBe(SYMBOL_BACKOFF_MAX_MS)
  })

  it('records nextRetryAt and keeps not-due symbols out of the hot batch', () => {
    const now = 1_700_000_000_000
    const dead = {}
    markDead(dead, 'vvv', 'no-quote', now)

    expect(dead.VVV.intervalMs).toBe(SYMBOL_BACKOFF_INITIAL_MS)
    expect(dead.VVV.nextRetryAt).toBe(now + SYMBOL_BACKOFF_INITIAL_MS)

    const heldOut = planQuoteBatches({
      nativeSymbols: ['ETH'],
      tokenSymbols: ['VVV', 'USDC'],
      dead,
      now
    })
    expect(heldOut.hotTokenSymbols).toEqual(['USDC'])
    expect(heldOut.retryTokenSymbols).toEqual([])
    expect(heldOut.nativeSymbols).toEqual(['ETH'])

    const due = planQuoteBatches({
      nativeSymbols: ['ETH'],
      tokenSymbols: ['VVV', 'USDC'],
      dead,
      now: now + SYMBOL_BACKOFF_INITIAL_MS
    })
    expect(due.hotTokenSymbols).toEqual(['USDC'])
    expect(due.retryTokenSymbols).toEqual(['VVV'])
  })
})

describe('CMC price feed cache and concurrency', () => {
  const ACCOUNT = '0x1111111111111111111111111111111111111111'
  const previousKey = process.env.CMC_API_KEY
  let cacheDir
  let cachePath
  let feed

  function createStore() {
    const state = {
      main: {
        tokens: {
          custom: [{ chainId: 8453, address: VVV, symbol: 'VVV' }],
          known: {}
        },
        balances: {},
        networks: {
          ethereum: {
            1: { isTestnet: false },
            8453: { isTestnet: false }
          }
        }
      }
    }

    return (...parts) =>
      parts.flatMap((part) => String(part).split('.')).reduce((acc, key) => acc?.[key], state)
  }

  function quoteBody(rows) {
    const data = {}
    for (const row of rows) {
      data[row.symbol] = {
        id: row.id,
        symbol: row.symbol,
        quote: { USD: { price: row.usd, percent_change_24h: row.change || 0 } },
        ...(row.address ? { platform: { slug: row.platform || 'base', token_address: row.address } } : {})
      }
    }
    return { data, status: { error_code: 0, credit_count: 1 } }
  }

  async function waitUntil(predicate) {
    for (let i = 0; i < 30; i++) {
      if (predicate()) return
      await Promise.resolve()
    }
    throw new Error('timed out waiting for CMC feed')
  }

  function pendingFetch() {
    const started = []
    fetchWithTimeout.mockImplementation((url) => {
      const href = String(url)
      const symbols = new URL(href, 'https://pro-api.coinmarketcap.com').searchParams.get('symbol') || ''
      if (!href.includes('/v3/cryptocurrency/quotes/latest') || !symbols) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: {}, status: { error_code: 0, credit_count: 0 } })
        })
      }

      return new Promise((resolve) => {
        started.push({
          url: href,
          symbols,
          resolve: (body, status = 200) =>
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: async () => body
            })
        })
      })
    })
    return started
  }

  beforeEach(() => {
    process.env.CMC_API_KEY = 'test-cmc-key'
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-feed-'))
    cachePath = path.join(cacheDir, CMC_CACHE_FILENAME)
    jest.setSystemTime(1_700_000_000_000)
  })

  afterEach(() => {
    feed?.stop()
    feed = undefined
    if (previousKey === undefined) delete process.env.CMC_API_KEY
    else process.env.CMC_API_KEY = previousKey
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  it('hydrates main.rates-bound updates from disk before the first network poll', async () => {
    saveCmcCache(cachePath, {
      version: 1,
      updatedAt: 1,
      rates: {
        'n:1': { type: 'native', chainId: 1, symbol: 'ETH', usd: 2460, usd_24h_change: 1 },
        [`t:8453:${VVV}`]: {
          type: 'token',
          chainId: 8453,
          address: VVV,
          symbol: 'VVV',
          usd: 22.4,
          usd_24h_change: 3
        }
      },
      dead: {}
    })

    const onUpdates = jest.fn()
    const started = pendingFetch()
    feed = createCmcPriceFeed(createStore(), onUpdates, undefined, { cachePath })
    feed.start()

    expect(onUpdates).toHaveBeenCalledTimes(1)
    const hydrated = onUpdates.mock.calls[0][0]
    expect(hydrated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: { type: 0, chainId: 1 }, data: { usd: 2460, usd_24h_change: 1 } }),
        expect.objectContaining({
          id: { type: 1, chainId: 8453, address: VVV },
          data: { usd: 22.4, usd_24h_change: 3 }
        })
      ])
    )
    expect(started).toHaveLength(0)
    expect(fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('fires native and custom symbol batches in the same tick', async () => {
    const onUpdates = jest.fn()
    const started = pendingFetch()
    feed = createCmcPriceFeed(createStore(), onUpdates, undefined, { cachePath })
    feed.updateSubscription([1, 8453], ACCOUNT)
    feed.start()

    await jest.advanceTimersByTimeAsync(1000)

    const quoteCalls = started.filter((call) => call.url.includes('/v3/cryptocurrency/quotes/latest'))
    expect(quoteCalls).toHaveLength(2)
    const symbolSets = quoteCalls.map((call) => call.symbols.split(',').filter(Boolean).sort())
    expect(symbolSets).toEqual(expect.arrayContaining([['ETH'], ['VVV']]))

    for (const call of quoteCalls) {
      if (call.symbols.includes('ETH')) {
        call.resolve(quoteBody([{ symbol: 'ETH', id: 1027, usd: 2460, change: 1 }]))
      } else {
        call.resolve(quoteBody([{ symbol: 'VVV', id: 31848, usd: 22.4, change: 3, address: VVV }]))
      }
    }

    await waitUntil(() => {
      const live = onUpdates.mock.calls.flatMap((call) => call[0])
      const cached = loadCmcCache(cachePath)
      return (
        live.some((update) => update.id.type === 0 && update.data.usd === 2460) &&
        live.some((update) => update.id.address === VVV && update.data.usd === 22.4) &&
        cached.rates['n:1']?.usd === 2460 &&
        cached.rates[`t:8453:${VVV}`]?.usd === 22.4
      )
    })

    const cached = loadCmcCache(cachePath)
    expect(cached.rates['n:1'].usd).toBe(2460)
    expect(cached.rates[`t:8453:${VVV}`].usd).toBe(22.4)
    expect(JSON.stringify(cached)).not.toMatch(/test-cmc-key/)
  })

  it('keeps not-due failed symbols out of the hot batch and retries them separately when due', async () => {
    const now = Date.now()
    saveCmcCache(cachePath, {
      version: 1,
      updatedAt: now,
      rates: {},
      dead: {
        VVV: {
          symbol: 'VVV',
          reason: 'http-500',
          lastFailedAt: now - 1000,
          nextRetryAt: now + 10 * 60_000,
          intervalMs: SYMBOL_BACKOFF_INITIAL_MS
        }
      }
    })

    const started = pendingFetch()
    feed = createCmcPriceFeed(createStore(), jest.fn(), undefined, { cachePath })
    feed.updateSubscription([1, 8453], ACCOUNT)
    feed.start()
    await jest.advanceTimersByTimeAsync(1000)

    const quoteCalls = started.filter((call) => call.url.includes('/v3/cryptocurrency/quotes/latest'))
    expect(quoteCalls).toHaveLength(1)
    expect(quoteCalls[0].symbols).toBe('ETH')
    expect(quoteCalls[0].symbols).not.toContain('VVV')

    quoteCalls[0].resolve(quoteBody([{ symbol: 'ETH', id: 1027, usd: 2460 }]))
    await waitUntil(() => loadCmcCache(cachePath).rates['n:1']?.usd === 2460)

    expect(loadCmcCache(cachePath).dead.VVV.reason).toBe('http-500')

    feed.stop()
    jest.setSystemTime(now + 10 * 60_000)

    const retryStarted = pendingFetch()
    feed = createCmcPriceFeed(createStore(), jest.fn(), undefined, { cachePath })
    feed.updateSubscription([1, 8453], ACCOUNT)
    feed.start()
    await jest.advanceTimersByTimeAsync(1000)

    const retryCalls = retryStarted.filter((call) => call.url.includes('/v3/cryptocurrency/quotes/latest'))
    const retrySymbols = retryCalls.map((call) => call.symbols)
    expect(retrySymbols.some((symbols) => symbols.split(',').includes('VVV'))).toBe(true)
    expect(retrySymbols.some((symbols) => symbols === 'ETH' || symbols.split(',').includes('ETH'))).toBe(true)

    for (const call of retryCalls) {
      if (call.symbols.includes('VVV')) {
        call.resolve(quoteBody([{ symbol: 'VVV', id: 31848, usd: 22.4, address: VVV }]))
      } else {
        call.resolve(quoteBody([{ symbol: 'ETH', id: 1027, usd: 2460 }]))
      }
    }
    await waitUntil(
      () => !loadCmcCache(cachePath).dead.VVV && loadCmcCache(cachePath).rates[`t:8453:${VVV}`]?.usd === 22.4
    )

    expect(loadCmcCache(cachePath).dead.VVV).toBeUndefined()
    expect(loadCmcCache(cachePath).rates[`t:8453:${VVV}`].usd).toBe(22.4)
  })

  it('does not wait the full poll interval after an empty first poll', async () => {
    const started = pendingFetch()
    feed = createCmcPriceFeed(createStore(), jest.fn(), undefined, { cachePath })
    feed.start()

    await jest.advanceTimersByTimeAsync(FIRST_POLL_DELAY_MS)
    expect(fetchWithTimeout).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(EMPTY_TARGET_RETRY_MS)
    expect(fetchWithTimeout).not.toHaveBeenCalled()

    feed.updateSubscription([1, 8453], ACCOUNT)
    await jest.advanceTimersByTimeAsync(FIRST_POLL_DELAY_MS)

    const quoteCalls = started.filter((call) => call.url.includes('/v3/cryptocurrency/quotes/latest'))
    expect(quoteCalls).toHaveLength(2)
    const symbolSets = quoteCalls.map((call) => call.symbols.split(',').filter(Boolean).sort())
    expect(symbolSets).toEqual(expect.arrayContaining([['ETH'], ['VVV']]))
  })

  it('catches up within seconds when more chains appear during a partial first poll', async () => {
    const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    const state = {
      main: {
        tokens: {
          custom: [
            { chainId: 1, address: USDC, symbol: 'USDC' },
            { chainId: 8453, address: VVV, symbol: 'VVV' }
          ],
          known: {}
        },
        balances: {},
        networks: {
          ethereum: {
            1: { isTestnet: false },
            8453: { isTestnet: false }
          }
        }
      }
    }
    const store = (...parts) =>
      parts.flatMap((part) => String(part).split('.')).reduce((acc, key) => acc?.[key], state)

    const started = pendingFetch()
    feed = createCmcPriceFeed(store, jest.fn(), undefined, { cachePath })
    feed.updateSubscription([1], ACCOUNT)
    feed.start()
    await jest.advanceTimersByTimeAsync(FIRST_POLL_DELAY_MS)

    const firstCalls = started.filter((call) => call.url.includes('/v3/cryptocurrency/quotes/latest'))
    expect(firstCalls.length).toBeGreaterThan(0)
    expect(firstCalls.every((call) => !call.symbols.split(',').includes('VVV'))).toBe(true)
    expect(firstCalls.some((call) => call.symbols.split(',').includes('ETH'))).toBe(true)

    feed.updateSubscription([1, 8453], ACCOUNT)

    for (const call of firstCalls) {
      if (call.symbols.includes('ETH')) {
        call.resolve(quoteBody([{ symbol: 'ETH', id: 1027, usd: 2460 }]))
      } else {
        call.resolve(quoteBody([{ symbol: 'USDC', id: 3408, usd: 1, address: USDC }]))
      }
    }
    await waitUntil(() => loadCmcCache(cachePath).rates['n:1']?.usd === 2460)
    expect(loadCmcCache(cachePath).rates[`t:8453:${VVV}`]).toBeUndefined()

    await jest.advanceTimersByTimeAsync(EMPTY_TARGET_RETRY_MS)

    const catchUpCalls = started
      .filter((call) => call.url.includes('/v3/cryptocurrency/quotes/latest'))
      .slice(firstCalls.length)
    expect(catchUpCalls.some((call) => call.symbols.split(',').includes('VVV'))).toBe(true)

    for (const call of catchUpCalls) {
      if (call.symbols.includes('VVV')) {
        call.resolve(quoteBody([{ symbol: 'VVV', id: 31848, usd: 22.4, address: VVV }]))
      } else if (call.symbols.includes('ETH')) {
        call.resolve(quoteBody([{ symbol: 'ETH', id: 1027, usd: 2460 }]))
      } else {
        call.resolve(quoteBody([{ symbol: 'USDC', id: 3408, usd: 1, address: USDC }]))
      }
    }
    await waitUntil(() => loadCmcCache(cachePath).rates[`t:8453:${VVV}`]?.usd === 22.4)
    expect(loadCmcCache(cachePath).rates[`t:8453:${VVV}`].usd).toBe(22.4)
  })

  it('polls within seconds when chains appear after empty-target retries fall back', async () => {
    const started = pendingFetch()
    feed = createCmcPriceFeed(createStore(), jest.fn(), undefined, { cachePath })
    feed.start()

    await jest.advanceTimersByTimeAsync(FIRST_POLL_DELAY_MS)
    for (let i = 0; i < MAX_EMPTY_TARGET_RETRIES; i++) {
      await jest.advanceTimersByTimeAsync(EMPTY_TARGET_RETRY_MS)
    }

    await jest.advanceTimersByTimeAsync(EMPTY_TARGET_RETRY_MS)
    expect(fetchWithTimeout).not.toHaveBeenCalled()

    feed.updateSubscription([1, 8453], ACCOUNT)
    await jest.advanceTimersByTimeAsync(FIRST_POLL_DELAY_MS)

    const quoteCalls = started.filter((call) => call.url.includes('/v3/cryptocurrency/quotes/latest'))
    expect(quoteCalls.length).toBeGreaterThan(0)
    expect(quoteCalls.some((call) => call.symbols.split(',').includes('VVV'))).toBe(true)
  })

  it('writes cmc-rates.json as soon as the first quotes land', async () => {
    const leftover = '0x3333333333333333333333333333333333333333'
    const state = {
      main: {
        tokens: {
          custom: [
            { chainId: 8453, address: VVV, symbol: 'VVV' },
            { chainId: 8453, address: leftover }
          ],
          known: {}
        },
        balances: {},
        networks: {
          ethereum: {
            1: { isTestnet: false },
            8453: { isTestnet: false }
          }
        }
      }
    }
    const store = (...parts) =>
      parts.flatMap((part) => String(part).split('.')).reduce((acc, key) => acc?.[key], state)

    const started = []
    let resolveInfo
    fetchWithTimeout.mockImplementation((url) => {
      const href = String(url)
      if (href.includes('/v2/cryptocurrency/info')) {
        return new Promise((resolve) => {
          resolveInfo = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({ data: {}, status: { error_code: 0, credit_count: 0 } })
            })
        })
      }

      const symbols = new URL(href, 'https://pro-api.coinmarketcap.com').searchParams.get('symbol') || ''
      if (!href.includes('/v3/cryptocurrency/quotes/latest') || !symbols) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: {}, status: { error_code: 0, credit_count: 0 } })
        })
      }

      return new Promise((resolve) => {
        started.push({
          url: href,
          symbols,
          resolve: (body, status = 200) =>
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: async () => body
            })
        })
      })
    })

    const onUpdates = jest.fn()
    feed = createCmcPriceFeed(store, onUpdates, undefined, { cachePath })
    feed.updateSubscription([1, 8453], ACCOUNT)
    feed.start()
    await jest.advanceTimersByTimeAsync(FIRST_POLL_DELAY_MS)

    const quoteCalls = started.filter((call) => call.url.includes('/v3/cryptocurrency/quotes/latest'))
    expect(quoteCalls).toHaveLength(2)
    for (const call of quoteCalls) {
      if (call.symbols.includes('ETH')) {
        call.resolve(quoteBody([{ symbol: 'ETH', id: 1027, usd: 2460, change: 1 }]))
      } else {
        call.resolve(quoteBody([{ symbol: 'VVV', id: 31848, usd: 22.4, change: 3, address: VVV }]))
      }
    }

    await waitUntil(() => {
      const cached = loadCmcCache(cachePath)
      const live = onUpdates.mock.calls.flatMap((call) => call[0])
      return (
        cached.rates['n:1']?.usd === 2460 &&
        cached.rates[`t:8453:${VVV}`]?.usd === 22.4 &&
        live.some((update) => update.id.address === VVV && update.data.usd === 22.4)
      )
    })

    expect(loadCmcCache(cachePath).rates[`t:8453:${VVV}`].usd).toBe(22.4)
    expect(JSON.stringify(loadCmcCache(cachePath))).not.toMatch(/test-cmc-key/)

    await waitUntil(() => typeof resolveInfo === 'function')
    resolveInfo()
  })
})
